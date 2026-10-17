/**
 * Delta-V Remote bridge — the Electron-integrated singleton.
 *
 * READ-ONLY INVARIANT: the bridge never spawns, kills, writes to or resizes a
 * PTY. It only reads { list, on('broadcast'), on('resized') } from ptyManager and
 * republishes terminal output to LAN viewers. It stores no settings, repo-index
 * or agent-env data: when it reads an agent for its display name it copies ONLY
 * the name and tab label (agentService.byId carries full env including secrets).
 */
import { app } from 'electron'
import path from 'path'
import QRCode from 'qrcode'
import { IPC } from '@shared/ipc'
import type {
  RemoteAddress,
  RemoteBufferSnapshot,
  RemoteExitInfo,
  RemoteSessionInfo,
  RemoteStatus,
  RemoteWsMessage,
  TerminalExitEvent,
  TerminalSessionInfo,
  TerminalStatusEvent,
  TerminalTitleEvent
} from '@shared/types'
import { effectiveTabLabel } from '@shared/types'
import { agentService } from './agents'
import { ptyManager } from './pty'
import { settingsService } from './settings'
import { lanAddresses } from './remote/net'
import { OutputRing } from './remote/ring'
import { RemoteServer } from './remote/server'

const EXIT_RETENTION_MS = 5 * 60_000
const STATUS_DEBOUNCE_MS = 250
const MAX_QR_CACHE = 16

interface SessionRecord {
  info: RemoteSessionInfo
  ring: OutputRing
  exit?: RemoteExitInfo
  purgeTimer?: NodeJS.Timeout
}

class RemoteBridge {
  private broadcast: (channel: string, payload: unknown) => void = () => {}
  private records = new Map<string, SessionRecord>()
  private server: RemoteServer | null = null
  private attached = false
  private chain: Promise<void> = Promise.resolve()
  private error: string | undefined
  private qrCache = new Map<string, string>()
  private statusDebounce: NodeJS.Timeout | null = null

  setBroadcast(fn: (channel: string, payload: unknown) => void): void {
    this.broadcast = fn
  }

  /**
   * Start recording PTY output into per-session rings. Runs from app start and
   * is idempotent. Output is recorded even while the server is off, so enabling
   * the feature mid-session still has history in memory.
   */
  attach(): void {
    if (this.attached) return
    this.attached = true
    ptyManager.on('broadcast', (channel: string, payload: unknown) =>
      this.onPtyEvent(channel, payload)
    )
    ptyManager.on('resized', (info: TerminalSessionInfo) => this.onResized(info))
    for (const info of ptyManager.list()) this.ensureRecord(info.id, info)
  }

  private toRemoteInfo(info: TerminalSessionInfo): RemoteSessionInfo {
    const out: RemoteSessionInfo = { ...info }
    const agent = agentService.byId(info.agentId)
    if (agent) {
      // Copy ONLY the display strings — byId's env may hold secrets.
      out.agentName = agent.name
      out.tabLabel = effectiveTabLabel(
        agent.id,
        agent.name,
        settingsService.get().agentTabLabels
      )
    }
    return out
  }

  private ensureRecord(sessionId: string, provided?: TerminalSessionInfo): SessionRecord | undefined {
    const existing = this.records.get(sessionId)
    if (existing) return existing
    const info = provided ?? ptyManager.list().find((s) => s.id === sessionId)
    if (!info) return undefined
    const record: SessionRecord = { info: this.toRemoteInfo(info), ring: new OutputRing() }
    this.records.set(sessionId, record)
    this.push({ channel: 'remote:session', payload: record.info })
    return record
  }

  private onPtyEvent(channel: string, payload: unknown): void {
    try {
      switch (channel) {
        case IPC.terminalStatus: {
          const p = payload as TerminalStatusEvent
          const record = this.ensureRecord(p.sessionId)
          if (!record) return
          record.info.status = p.status
          this.push({ channel: 'terminal:status', payload: p })
          return
        }
        case IPC.terminalData: {
          const p = payload as { sessionId: string; data: string }
          const record = this.ensureRecord(p.sessionId)
          if (!record) return
          const offset = record.ring.append(p.data)
          this.push({
            channel: 'terminal:data',
            payload: { sessionId: p.sessionId, data: p.data, offset }
          })
          return
        }
        case IPC.terminalTitle: {
          const p = payload as TerminalTitleEvent
          const record = this.ensureRecord(p.sessionId)
          if (!record) return
          record.info.title = p.title
          this.push({ channel: 'terminal:title', payload: p })
          return
        }
        case IPC.terminalExit: {
          const p = payload as TerminalExitEvent
          const record = this.ensureRecord(p.sessionId)
          if (!record) return
          record.exit = { exitCode: p.exitCode, signal: p.signal, at: Date.now() }
          record.info.exit = record.exit
          this.push({ channel: 'terminal:exit', payload: p })
          if (record.purgeTimer) clearTimeout(record.purgeTimer)
          record.purgeTimer = setTimeout(() => this.purge(p.sessionId), EXIT_RETENTION_MS)
          record.purgeTimer.unref()
          return
        }
        default:
          return
      }
    } catch {
      console.error('[remote] failed to handle pty event')
    }
  }

  private onResized(info: TerminalSessionInfo): void {
    try {
      const record = this.ensureRecord(info.id, info)
      if (!record) return
      record.info.cols = info.cols
      record.info.rows = info.rows
      this.push({ channel: 'remote:session', payload: record.info })
    } catch {
      console.error('[remote] failed to handle resize')
    }
  }

  private purge(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (!record) return
    if (record.purgeTimer) clearTimeout(record.purgeTimer)
    this.records.delete(sessionId)
    this.push({ channel: 'remote:gone', payload: { sessionId } })
  }

  /** Send to every viewer when a server is running. */
  private push(msg: RemoteWsMessage): void {
    this.server?.broadcast(msg)
  }

  getSessions(): RemoteSessionInfo[] {
    return [...this.records.values()]
      .map((r) => ({ ...r.info, exit: r.exit }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  getSnapshot(sessionId: string): RemoteBufferSnapshot | undefined {
    const record = this.records.get(sessionId)
    if (!record) return undefined
    const snap = record.ring.snapshot()
    return {
      sessionId,
      data: snap.data,
      end: snap.end,
      truncated: snap.truncated,
      cols: record.info.cols,
      rows: record.info.rows,
      exit: record.exit
    }
  }

  /** Reconcile the server with the current settings. Never throws. */
  apply(): Promise<void> {
    this.chain = this.chain.then(() => this.doApply()).catch(() => undefined)
    return this.chain
  }

  private async doApply(): Promise<void> {
    const settings = settingsService.get()
    if (!settings.remoteEnabled) {
      await this.stopServer()
      this.error = undefined
      await this.emitStatus()
      return
    }
    if (this.server && this.server.port === settings.remotePort) {
      await this.emitStatus()
      return
    }
    await this.stopServer()
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
    const server = new RemoteServer({
      getToken: () => settingsService.ensureRemoteToken(),
      listSessions: () => this.getSessions(),
      getSnapshot: (id) => this.getSnapshot(id),
      ...(devUrl
        ? { devProxyTarget: devUrl }
        : { staticRoot: path.join(__dirname, '../renderer') }),
      onClientsChanged: () => this.scheduleStatus()
    })
    try {
      await server.start(settings.remotePort)
      this.server = server
      this.error = undefined
      console.log(`[remote] listening on port ${server.port}`)
    } catch (err) {
      this.server = null
      this.error = err instanceof Error ? err.message : String(err)
    }
    await this.emitStatus()
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    try {
      await server.stop()
    } catch {
      /* ignore */
    }
  }

  async regenerateToken(): Promise<void> {
    settingsService.regenerateRemoteToken()
    this.server?.dropClients(1008, 'token changed')
    await this.emitStatus()
  }

  /** Stop the server (used on app quit). Never throws. */
  async stop(): Promise<void> {
    await this.stopServer()
  }

  async getStatus(): Promise<RemoteStatus> {
    const settings = settingsService.get()
    const running = !!this.server && this.server.port !== null
    let addresses: RemoteAddress[] = []
    if (running && this.server) {
      const actual = this.server.port ?? settings.remotePort
      const token = settingsService.ensureRemoteToken()
      const found = lanAddresses()
      addresses = await Promise.all(
        found.map(async (entry) => {
          const url = `http://${entry.address}:${actual}/#${token}`
          return { iface: entry.iface, address: entry.address, url, qrSvg: await this.qr(url) }
        })
      )
    }
    return {
      enabled: settings.remoteEnabled,
      running,
      port: settings.remotePort,
      addresses,
      clients: this.server?.clientCount ?? 0,
      error: this.error
    }
  }

  private async qr(url: string): Promise<string> {
    const cached = this.qrCache.get(url)
    if (cached !== undefined) return cached
    const svg = await QRCode.toString(url, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' }
    })
    if (this.qrCache.size >= MAX_QR_CACHE) {
      const oldest = this.qrCache.keys().next().value
      if (oldest !== undefined) this.qrCache.delete(oldest)
    }
    this.qrCache.set(url, svg)
    return svg
  }

  private async emitStatus(): Promise<void> {
    try {
      const status = await this.getStatus()
      this.broadcast(IPC.remoteStatusChanged, status)
    } catch {
      /* never throw from status emission */
    }
  }

  private scheduleStatus(): void {
    if (this.statusDebounce) clearTimeout(this.statusDebounce)
    this.statusDebounce = setTimeout(() => {
      this.statusDebounce = null
      void this.emitStatus()
    }, STATUS_DEBOUNCE_MS)
    this.statusDebounce.unref()
  }
}

export const remoteBridge = new RemoteBridge()
