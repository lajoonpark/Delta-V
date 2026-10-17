import type { RemoteBufferSnapshot, RemoteSessionInfo, RemoteWsMessage } from '@shared/types'
import {
  REMOTE_SESSIONS_PATH,
  REMOTE_WS_PATH,
  REMOTE_WS_SUBPROTOCOL,
  REMOTE_WS_TOKEN_PREFIX,
  remoteBufferPath
} from '@shared/ipc'
import {
  BACKOFF_CAP_MS,
  backoffDelayMs,
  browserEnv,
  CONNECT_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  FORCE_RECONNECT_AFTER_HIDDEN_MS,
  HEARTBEAT_STALE_MS,
  PILL_DELAY_MS,
  PING_TIMEOUT_MS,
  UNREACHABLE_AFTER
} from './env'
import type { RemoteEnv, WebSocketLike } from './env'
import { extractToken, TOKEN_STORAGE_KEY } from './pairing'
import { ViewerSync } from './viewerSync'

export type ConnectionPhase = 'pairing' | 'connecting' | 'live' | 'reconnecting' | 'unreachable'

export interface ConnectionState {
  phase: ConnectionPhase
  /** Why the pairing screen is shown when it is not simply "first run" (e.g. the stored token was rejected). */
  pairingNotice?: string
  /** All known sessions (live + recently exited), newest first. */
  sessions: RemoteSessionInfo[]
  /** Consecutive failed connection attempts in the current outage (0 when live). */
  attempt: number
  /** True when the small transient "reconnecting…" pill should be visible. */
  showPill: boolean
}

/** Callbacks of the terminal that is currently being viewed. */
export interface Viewer {
  /** Replace the terminal contents: reset it, resize to cols/rows, write `data` (raw ANSI). */
  reset(snapshot: { data: string; cols: number; rows: number; truncated: boolean }): void
  /** Append live output. */
  write(data: string): void
  /** The session no longer exists on the bridge (purged). */
  gone(): void
}

/**
 * Read-only remote client: the only thing it ever sends to the bridge is a
 * liveness ping (`{"type":"ping","t":<number>}`); all other traffic is inbound.
 */
export class RemoteConnection {
  private env: RemoteEnv | null
  private started = false
  private token: string | null = null
  private generation = 0
  private phase: ConnectionPhase = 'connecting'
  private pairingNotice?: string
  private failures = 0
  private everLive = false
  private sessions = new Map<string, RemoteSessionInfo>()
  private viewer: Viewer | null = null
  private viewerId: string | null = null
  private viewerSync = new ViewerSync()
  private listeners = new Set<() => void>()
  private state: ConnectionState = { phase: 'connecting', sessions: [], attempt: 0, showPill: false }
  private pill = false
  private pillTimer: unknown = null
  private lastMessageAt = 0
  private hiddenSince: number | null = null
  private ws: WebSocketLike | null = null
  private connectTimer: unknown = null
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  private watchdog: unknown = null
  private graceTimer: unknown = null
  private resyncing = false
  private viewerResyncing = false
  private forcing = false
  private viewerSeq = 0
  private queue: RemoteWsMessage[] = []
  /** Unsubscribe fns for the env listeners; they live for the page lifetime. */
  private offHash: (() => void) | null = null
  private offVisibility: (() => void) | null = null

  constructor(env?: RemoteEnv) {
    this.env = env ?? null
  }

  /** Current state. The returned object is referentially stable between changes (for useSyncExternalStore). */
  getState(): ConnectionState {
    return this.state
  }

  /** Subscribe to state changes; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Read the token from the URL hash / localStorage and connect, or enter 'pairing'. */
  start(): void {
    if (this.started) {
      // Env listeners live for the page lifetime; nothing to re-attach.
      void this.offHash
      void this.offVisibility
      return
    }
    this.started = true
    const env = (this.env ??= browserEnv())
    const fromHash = extractToken(env.location.hash)
    if (fromHash) {
      this.token = fromHash
      try {
        env.storage.setItem(TOKEN_STORAGE_KEY, fromHash)
      } catch {
        // Persistence is best-effort (private mode / quota).
      }
      env.replaceUrl(env.location.pathname + env.location.search)
    } else {
      const stored = env.storage.getItem(TOKEN_STORAGE_KEY)
      this.token = stored ? extractToken(stored) : null
    }
    this.offHash = env.onHashChange(() => this.onHash())
    this.offVisibility = env.onVisibility((v) => this.handleVisibility(v))
    if (!this.token) {
      this.setPhase('pairing')
      return
    }
    this.setPhase('connecting')
    this.connect()
  }

  /** Accept a raw token or a full pairing URL; returns false when invalid. */
  pair(input: string): boolean {
    const t = extractToken(input)
    if (!t) return false
    this.env ??= browserEnv()
    this.adoptToken(t)
    return true
  }

  /** Forget the stored token and return to 'pairing'. */
  unpair(): void {
    const env = this.requireEnv()
    this.teardown()
    env.storage.removeItem(TOKEN_STORAGE_KEY)
    this.token = null
    this.setSessions([])
    this.everLive = false
    this.pairingNotice = undefined
    this.setPhase('pairing')
  }

  /** Manual Retry button. */
  retryNow(): void {
    if (!this.token) return
    this.setPhase(this.everLive ? 'reconnecting' : 'connecting')
    this.attemptNow()
  }

  /** Attach a viewer; returns a detach fn. Replays the buffer now (if live) and after every resync. */
  attachViewer(sessionId: string, viewer: Viewer): () => void {
    this.viewer = viewer
    this.viewerId = sessionId
    this.viewerSync.reset()
    if (this.phase === 'live') this.syncViewerNow()
    return () => {
      if (this.viewer === viewer) {
        this.viewer = null
        this.viewerId = null
        this.viewerSync.reset()
      }
    }
  }

  /** The active socket, if any; its lifecycle is owned by the transport. */
  getSocket(): WebSocketLike | null {
    return this.ws
  }

  /** Replace the whole session store from a snapshot. Callers emit. */
  private setSessions(list: RemoteSessionInfo[]): void {
    this.sessions.clear()
    for (const s of list) this.sessions.set(s.id, s)
  }

  private onHash(): void {
    const t = extractToken(this.requireEnv().location.hash)
    if (t !== null && t !== this.token) this.adoptToken(t)
  }

  private adoptToken(t: string): void {
    const env = this.requireEnv()
    try {
      env.storage.setItem(TOKEN_STORAGE_KEY, t)
    } catch {
      // Persistence is best-effort (private mode / quota).
    }
    this.token = t
    this.pairingNotice = undefined
    this.failures = 0
    this.teardown()
    env.replaceUrl(env.location.pathname + env.location.search)
    this.setPhase(this.everLive ? 'reconnecting' : 'connecting')
    this.connect()
  }

  private rejectToken(): void {
    const env = this.requireEnv()
    this.teardown()
    env.storage.removeItem(TOKEN_STORAGE_KEY)
    this.token = null
    this.setSessions([])
    this.pairingNotice = 'This pairing is no longer valid. Scan the QR code in Delta-V settings again.'
    this.setPhase('pairing')
  }

  private applyMessage(msg: RemoteWsMessage): void {
    switch (msg.channel) {
      case 'terminal:exit': {
        const cur = this.sessions.get(msg.payload.sessionId)
        if (cur) {
          this.sessions.set(msg.payload.sessionId, {
            ...cur,
            exit: { exitCode: msg.payload.exitCode, signal: msg.payload.signal, at: this.requireEnv().now() }
          })
        }
        break
      }
      case 'terminal:title': {
        const cur = this.sessions.get(msg.payload.sessionId)
        if (cur) this.sessions.set(msg.payload.sessionId, { ...cur, title: msg.payload.title })
        break
      }
      case 'terminal:status': {
        const cur = this.sessions.get(msg.payload.sessionId)
        if (cur) this.sessions.set(msg.payload.sessionId, { ...cur, status: msg.payload.status })
        break
      }
      case 'remote:session': {
        const incoming = msg.payload
        const cur = this.sessions.get(incoming.id)
        let next: RemoteSessionInfo = incoming
        if (incoming.exit === undefined && cur && cur.exit !== undefined) {
          next = { ...incoming, exit: cur.exit }
        }
        this.sessions.set(incoming.id, next)
        break
      }
      case 'remote:gone':
        this.sessions.delete(msg.payload.sessionId)
        break
      case 'remote:heartbeat':
      case 'remote:pong':
        // Liveness is tracked by the transport, not here.
        break
      case 'terminal:data':
        // Routed through dispatch() before it can reach applyMessage.
        break
    }
    this.emit()
  }

  private dispatch(msg: RemoteWsMessage): void {
    if (msg.channel === 'terminal:data') {
      const p = msg.payload
      if (p.sessionId === this.viewerId && this.viewer) {
        const a = this.viewerSync.live(p.offset, p.data)
        if (a.kind === 'write') {
          try {
            this.viewer.write(a.data)
          } catch {
            // A throwing viewer must not break the message pipeline.
          }
        } else if (a.kind === 'resync') {
          this.syncViewerNow()
        }
        // 'skip' and 'wait' need no action.
      }
      return
    }
    this.applyMessage(msg)
  }

  private noteMessage(): void {
    this.lastMessageAt = this.requireEnv().now()
  }

  private parseMessage(data: unknown): RemoteWsMessage | null {
    if (typeof data !== 'string') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof (parsed as { channel?: unknown }).channel !== 'string') return null
    return parsed as RemoteWsMessage
  }

  /**
   * Set the phase, drive the transient "reconnecting…" pill and notify listeners.
   * `live` marks the connection as having been up (resets the failure count).
   */
  private setPhase(next: ConnectionPhase): void {
    const env = this.requireEnv()
    // Any phase change resolves a pending forced-reconnect grace window.
    if (this.graceTimer !== null) {
      env.clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    this.phase = next
    if (next === 'live') {
      this.everLive = true
      this.failures = 0
      this.pill = false
    }
    const wantsPill = next === 'reconnecting' || (next === 'connecting' && this.everLive)
    if (wantsPill) {
      // Arm once; never reset an already-pending timer (avoids flicker).
      if (this.pillTimer === null) {
        this.pillTimer = env.setTimeout(() => {
          this.pillTimer = null
          this.pill = true
          this.emit()
        }, PILL_DELAY_MS)
      }
    } else {
      if (this.pillTimer !== null) {
        env.clearTimeout(this.pillTimer)
        this.pillTimer = null
      }
      this.pill = false
    }
    this.emit()
  }

  /** Rebuild the immutable state object and notify every listener synchronously. */
  private emit(): void {
    const sessions = Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt)
    this.state = {
      phase: this.phase,
      pairingNotice: this.pairingNotice,
      sessions,
      attempt: this.failures,
      showPill: this.pill
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener()
      } catch {
        // A misbehaving subscriber must not break the others.
      }
    }
  }

  /** GET a same-origin path, bearer-authenticated and time-boxed. Throws on network error/abort. */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const env = this.requireEnv()
    const ac = new AbortController()
    const timer = env.setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await env.fetch(path, {
        headers: { Authorization: 'Bearer ' + this.token },
        signal: ac.signal
      })
      let body: unknown = null
      if (res.ok) {
        try {
          body = await res.json()
        } catch {
          body = null
        }
      }
      return { status: res.status, body }
    } finally {
      env.clearTimeout(timer)
    }
  }

  /** Detach and close the current socket, if any. */
  private closeSocket(): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    try {
      ws.close()
    } catch {
      // A closing or already-closed socket may throw; that's fine.
    }
  }

  private requireEnv(): RemoteEnv {
    if (!this.env) throw new Error('RemoteConnection.start() must be called before use')
    return this.env
  }

  // ── Transport: connect / resync / retry ─────────────────────

  /** Open the WebSocket, resync sessions/buffer, then go live. */
  private connect(): void {
    const token = this.token
    if (!token) return
    const env = this.requireEnv()
    const gen = ++this.generation
    if (this.connectTimer !== null) {
      env.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.retryTimer !== null) {
      env.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.resyncing = false
    this.viewerResyncing = false
    this.queue = []
    const scheme = env.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${scheme}://${env.location.host}${REMOTE_WS_PATH}`
    let ws: WebSocketLike
    try {
      ws = env.createWebSocket(url, [REMOTE_WS_SUBPROTOCOL, REMOTE_WS_TOKEN_PREFIX + token])
    } catch {
      this.onAttemptFailed(gen)
      return
    }
    this.ws = ws
    // Abort the handshake if it has not opened in time.
    this.connectTimer = env.setTimeout(() => {
      if (gen !== this.generation) return
      this.connectTimer = null
      this.closeSocket()
      this.onAttemptFailed(gen)
    }, CONNECT_TIMEOUT_MS)
    let opened = false
    ws.onopen = (): void => {
      if (gen !== this.generation) return
      opened = true
      if (this.connectTimer !== null) {
        env.clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      this.lastMessageAt = env.now()
      this.resyncing = true
      this.queue = []
      void this.resync(gen)
    }
    ws.onmessage = (ev: { data: unknown }): void => {
      if (gen !== this.generation) return
      this.noteMessage()
      const msg = this.parseMessage(ev.data)
      if (!msg) return
      if (msg.channel === 'remote:pong') {
        this.onPong()
        return
      }
      if (this.resyncing || this.viewerResyncing) {
        // Heartbeats are liveness-only and never queued.
        if (msg.channel !== 'remote:heartbeat') this.queue.push(msg)
        return
      }
      this.dispatch(msg)
    }
    const onClose = (): void => {
      if (gen !== this.generation) return
      if (this.connectTimer !== null) {
        env.clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      if (!opened) {
        this.onAttemptFailed(gen)
      } else if (this.phase === 'live' || this.resyncing) {
        this.onSocketLost(gen)
      }
    }
    ws.onclose = onClose
    ws.onerror = onClose
  }

  /** Fetch the session list and (if attached) the viewer buffer, replay and go live. */
  private async resync(gen: number): Promise<void> {
    try {
      const viewerId = this.viewerId
      const [list, buf] = await Promise.all([
        this.get(REMOTE_SESSIONS_PATH),
        viewerId ? this.get(remoteBufferPath(viewerId)) : Promise.resolve(null)
      ])
      if (gen !== this.generation) return
      if (list.status === 401 || buf?.status === 401) {
        this.rejectToken()
        return
      }
      if (list.status !== 200 || !Array.isArray(list.body)) throw new Error('sessions')
      if (buf && buf.status !== 200 && buf.status !== 404) throw new Error('buffer')
      this.setSessions(list.body as RemoteSessionInfo[])
      this.applyBuffer(viewerId, buf)
      // Replay everything that arrived while the snapshot was in flight.
      this.resyncing = false
      const queued = this.queue
      this.queue = []
      for (const m of queued) this.dispatch(m)
      this.failures = 0
      this.setPhase('live')
      // A viewer opened while the snapshot was in flight was not covered by the fetch above.
      if (this.viewer && this.viewerId !== viewerId) this.syncViewerNow()
      this.startWatchdog()
    } catch {
      if (gen !== this.generation) return
      this.onAttemptFailed(gen)
    }
  }

  /** Apply a fetched buffer snapshot to the attached viewer (or reset when it is absent/gone). */
  private applyBuffer(viewerId: string | null, buf: { status: number; body: unknown } | null): void {
    if (!this.viewer || !this.viewerId || this.viewerId !== viewerId || !buf) {
      this.viewerSync.reset()
      return
    }
    const viewer = this.viewer
    if (buf.status === 404) {
      this.viewerSync.reset()
      try {
        viewer.gone()
      } catch {
        // A throwing viewer must not break the resync.
      }
      return
    }
    if (buf.status !== 200) return
    const snapshot = buf.body as RemoteBufferSnapshot
    const cur = this.sessions.get(snapshot.sessionId)
    if (cur && snapshot.exit) {
      this.sessions.set(cur.id, { ...cur, exit: snapshot.exit })
    }
    try {
      viewer.reset({
        data: snapshot.data,
        cols: snapshot.cols,
        rows: snapshot.rows,
        truncated: snapshot.truncated
      })
    } catch {
      // A throwing viewer must not break the resync.
    }
    this.viewerSync.applySnapshot(snapshot.end)
  }

  /** Refetch and apply the attached viewer's buffer now (single-flight, latest wins). */
  private syncViewerNow(): void {
    if (!this.viewer || !this.viewerId || !this.token) return
    // An initial resync is already fetching the buffer; applyBuffer will pick this viewer up.
    if (this.resyncing) return
    const id = this.viewerId
    const seq = ++this.viewerSeq
    this.viewerResyncing = true
    this.viewerSync.reset()
    void (async () => {
      try {
        const res = await this.get(remoteBufferPath(id))
        if (seq !== this.viewerSeq || this.viewerId !== id) return
        if (res.status === 401) {
          this.rejectToken()
          return
        }
        if (res.status !== 200 && res.status !== 404) {
          this.onAttemptFailed(this.generation)
          return
        }
        const viewer = this.viewer
        if (!viewer) return
        if (res.status === 404) {
          try {
            viewer.gone()
          } catch {
            // A throwing viewer must not break the pipeline.
          }
          return
        }
        const snapshot = res.body as RemoteBufferSnapshot
        try {
          viewer.reset({
            data: snapshot.data,
            cols: snapshot.cols,
            rows: snapshot.rows,
            truncated: snapshot.truncated
          })
        } catch {
          // A throwing viewer must not break the pipeline.
        }
        this.viewerSync.applySnapshot(snapshot.end)
        const cur = this.sessions.get(snapshot.sessionId)
        if (cur && snapshot.exit) {
          this.sessions.set(cur.id, { ...cur, exit: snapshot.exit })
        }
      } catch {
        if (seq !== this.viewerSeq || this.viewerId !== id) return
        this.onAttemptFailed(this.generation)
      } finally {
        if (seq === this.viewerSeq) {
          this.viewerResyncing = false
          const q = this.queue
          this.queue = []
          for (const m of q) this.dispatch(m)
        }
      }
    })()
  }

  /** Count a failed attempt, probe reachability and schedule the retry. */
  private onAttemptFailed(gen: number): void {
    if (gen !== this.generation) return
    const env = this.requireEnv()
    // Teardown-lite: drop the socket and any in-flight resync state.
    if (this.connectTimer !== null) {
      env.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    this.closeSocket()
    this.resyncing = false
    this.viewerResyncing = false
    this.queue = []
    void (async () => {
      let status = 0
      try {
        status = (await this.get(REMOTE_SESSIONS_PATH)).status
      } catch {
        // A network error means "unreachable"; count it like any non-401 status.
      }
      if (gen !== this.generation) return
      if (status === 401) {
        this.rejectToken()
        return
      }
      this.failures += 1
      if (this.failures >= UNREACHABLE_AFTER || this.phase === 'unreachable') {
        this.setPhase('unreachable')
      } else {
        this.setPhase(this.everLive ? 'reconnecting' : 'connecting')
      }
      this.scheduleRetry()
    })()
  }

  /** (Re)arm the reconnect timer at the current backoff step. */
  private scheduleRetry(): void {
    const env = this.requireEnv()
    if (this.retryTimer !== null) {
      env.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const delay =
      this.failures >= UNREACHABLE_AFTER ? BACKOFF_CAP_MS : backoffDelayMs(Math.max(1, this.failures))
    this.retryTimer = env.setTimeout(() => this.connect(), delay)
  }

  /** The live socket dropped; count it, schedule a retry and stop the watchdog. */
  private onSocketLost(gen: number): void {
    if (gen !== this.generation) return
    this.generation += 1
    this.closeSocket()
    this.failures = 1
    this.setPhase('reconnecting')
    this.scheduleRetry()
    this.stopWatchdog()
  }

  /**
   * Disconnect and immediately re-connect without changing the phase (the UI
   * stays "live" until the fresh resync completes). Keeps `sessions` for a
   * seamless hand-off; if we were live, a grace window shows the pill.
   */
  private forceReconnect(): void {
    if (this.forcing) return
    this.forcing = true
    const env = this.requireEnv()
    // Invalidate the old socket/attempt exactly like teardown(), but keep phase and sessions.
    this.generation += 1
    this.closeSocket()
    if (this.connectTimer !== null) {
      env.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.retryTimer !== null) {
      env.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.pingTimer !== null) {
      env.clearTimeout(this.pingTimer)
      this.pingTimer = null
    }
    this.stopWatchdog()
    this.resyncing = false
    this.viewerResyncing = false
    this.queue = []
    this.failures = 0
    if (this.phase === 'live') {
      // If the fresh attempt does not finish within the grace window, surface the pill.
      this.graceTimer = env.setTimeout(() => {
        this.graceTimer = null
        if (this.phase !== 'live') return
        this.setPhase('reconnecting')
        // The PILL_DELAY_MS grace already elapsed: show the pill immediately.
        if (this.pillTimer !== null) {
          env.clearTimeout(this.pillTimer)
          this.pillTimer = null
        }
        this.pill = true
        this.emit()
      }, PILL_DELAY_MS)
    }
    this.connect()
    this.forcing = false
  }

  /** Start the liveness watchdog (periodic stale-socket detection). */
  private startWatchdog(): void {
    const env = this.requireEnv()
    this.stopWatchdog()
    this.watchdog = env.setInterval(() => this.watchdogTick(), 1000)
  }

  /** One watchdog tick: force a reconnect when a visible live socket goes quiet. */
  private watchdogTick(): void {
    if (this.phase !== 'live') return
    const env = this.requireEnv()
    if (!env.isVisible()) return
    if (env.now() - this.lastMessageAt > HEARTBEAT_STALE_MS) this.forceReconnect()
  }

  /** Stop the liveness watchdog. */
  private stopWatchdog(): void {
    if (this.watchdog === null) return
    this.requireEnv().clearInterval(this.watchdog)
    this.watchdog = null
  }

  /** Handle a pong reply: a pending liveness ping succeeded. */
  private onPong(): void {
    if (this.pingTimer === null) return
    this.requireEnv().clearTimeout(this.pingTimer)
    this.pingTimer = null
  }

  /** Cancel any backoff timer, reset failures and attempt immediately. */
  private attemptNow(): void {
    const env = this.requireEnv()
    if (this.graceTimer !== null) {
      env.clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    // Non-live phases never arm the grace window, so forceReconnect reconnects at once.
    this.forcing = false
    this.forceReconnect()
  }

  /** React to visibility changes (force a fresh connect after long hiding). */
  private handleVisibility(visible: boolean): void {
    const env = this.requireEnv()
    if (!visible) {
      if (this.hiddenSince === null) this.hiddenSince = env.now()
      return
    }
    const hiddenFor = this.hiddenSince === null ? 0 : env.now() - this.hiddenSince
    this.hiddenSince = null
    if (!this.token || this.phase === 'pairing') return
    if (this.phase === 'connecting' || this.phase === 'reconnecting' || this.phase === 'unreachable') {
      this.attemptNow()
      return
    }
    // phase === 'live': reconnect outright when this socket may be dead…
    const ws = this.ws
    if (hiddenFor >= FORCE_RECONNECT_AFTER_HIDDEN_MS || ws === null || ws.readyState !== 1) {
      this.forceReconnect()
      return
    }
    // …otherwise probe liveness with a ping and do not trust the socket close event.
    if (this.pingTimer !== null) return
    try {
      ws.send(JSON.stringify({ type: 'ping', t: env.now() }))
    } catch {
      this.forceReconnect()
      return
    }
    this.pingTimer = env.setTimeout(() => {
      this.pingTimer = null
      if (this.phase === 'live') this.forceReconnect()
    }, PING_TIMEOUT_MS)
  }

  /** Close the socket, bump generation and clear all timers (token/sessions untouched). */
  private teardown(): void {
    const env = this.requireEnv()
    // Invalidate every callback of the current socket/attempt.
    this.generation += 1
    this.closeSocket()
    if (this.connectTimer !== null) {
      env.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.retryTimer !== null) {
      env.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.pingTimer !== null) {
      env.clearTimeout(this.pingTimer)
      this.pingTimer = null
    }
    this.stopWatchdog()
    if (this.pillTimer !== null) {
      env.clearTimeout(this.pillTimer)
      this.pillTimer = null
    }
    this.pill = false
    this.resyncing = false
    this.viewerResyncing = false
    this.queue = []
    this.forcing = false
  }
}

export const remoteConnection = new RemoteConnection()
