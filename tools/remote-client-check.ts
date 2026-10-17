/**
 * Deterministic simulation checks for the Delta-V Remote connection engine.
 * No browser, no real sockets/timers: virtual clock + fake bridge.
 *
 * Run: npx esbuild tools/remote-client-check.ts --bundle --format=cjs --platform=node --alias:@shared=./src/shared --outfile=/tmp/remote-client-check.cjs && node /tmp/remote-client-check.cjs
 */
import { REMOTE_SESSIONS_PATH } from '@shared/ipc'
import type {
  RemoteBufferSnapshot,
  RemoteExitInfo,
  RemoteSessionInfo,
  RemoteWsMessage
} from '@shared/types'
import { RemoteConnection } from '../src/renderer/src/remote/connection'
import type { ConnectionPhase, Viewer } from '../src/renderer/src/remote/connection'
import { PING_TIMEOUT_MS } from '../src/renderer/src/remote/env'
import type { FetchResponseLike, RemoteEnv, WebSocketLike } from '../src/renderer/src/remote/env'
import { TOKEN_STORAGE_KEY } from '../src/renderer/src/remote/pairing'

let failures = 0
/** Engine console output recorded while the spy is installed (must stay empty). */
const engineConsole: string[] = []
let inCheck = false
const realConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}
/** Record every console.* call made outside check() (i.e. by the engine). Returns a restore fn. */
function installConsoleSpy(): () => void {
  const spy =
    (level: keyof typeof realConsole) =>
    (...args: unknown[]): void => {
      if (!inCheck) engineConsole.push(`${level} ${args.map((a) => String(a)).join(' ')}`)
      realConsole[level](...args)
    }
  console.log = spy('log')
  console.info = spy('info')
  console.warn = spy('warn')
  console.error = spy('error')
  console.debug = spy('debug')
  return () => {
    console.log = realConsole.log
    console.info = realConsole.info
    console.warn = realConsole.warn
    console.error = realConsole.error
    console.debug = realConsole.debug
  }
}
function check(name: string, ok: boolean, detail = ''): void {
  inCheck = true
  try {
    if (ok) console.log(`  PASS ${name}`)
    else {
      failures++
      console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
    }
  } finally {
    inCheck = false
  }
}

// ── Virtual clock ───────────────────────────────────────────────────────────

interface TimerEntry {
  id: number
  at: number
  every: number | null
  seq: number
  fn: () => void
}

class Clock {
  now = 1_000_000
  private nextId = 1
  private timers = new Map<number, TimerEntry>()

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.timers.set(id, { id, at: this.now + Math.max(0, ms), every: null, seq: id, fn })
    return id
  }

  clearTimeout(id: unknown): void {
    this.timers.delete(id as number)
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++
    const every = Math.max(1, ms)
    this.timers.set(id, { id, at: this.now + every, every, seq: id, fn })
    return id
  }

  clearInterval(id: unknown): void {
    this.timers.delete(id as number)
  }

  /** Let pending promise chains settle. */
  async flush(): Promise<void> {
    for (let i = 0; i < 25; i++) await Promise.resolve()
  }

  private nextDue(target: number): TimerEntry | null {
    let best: TimerEntry | null = null
    for (const t of this.timers.values()) {
      if (t.at > target) continue
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t
    }
    return best
  }

  /** Fire every due timer in time order (ties by insertion), then land exactly on target. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      const t = this.nextDue(target)
      if (!t) break
      const fireAt = t.at
      if (t.every === null) this.timers.delete(t.id)
      else t.at = fireAt + t.every
      this.now = fireAt
      t.fn()
      await this.flush()
    }
    this.now = target
    await this.flush()
  }
}

// ── Fake WebSocket / bridge server ─────────────────────────────────────────

class FakeSocket implements WebSocketLike {
  readyState = 0
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  sent: string[] = []
  dead = false

  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {}

  open(): void {
    if (this.dead) return
    this.readyState = 1
    this.onopen?.()
  }

  push(msg: RemoteWsMessage): void {
    if (this.dead) return
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  closeClean(): void {
    this.readyState = 3
    this.onclose?.()
  }

  fail(): void {
    this.readyState = 3
    this.onerror?.()
  }

  send(data: string): void {
    if (this.dead) return
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }
}

interface BufferEntry {
  data: string
  end: number
  cols: number
  rows: number
  exit?: RemoteExitInfo
}

function response(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

class FakeServer {
  reachable = true
  token: string
  sessions: RemoteSessionInfo[] = []
  buffers: Record<string, BufferEntry> = {}
  autoOpen = true
  fetchToken: string | null = null
  onSocket: ((sock: FakeSocket, at: number) => void) | null = null
  sockets: FakeSocket[] = []
  fetched: string[] = []

  constructor(
    private clock: Clock,
    token: string
  ) {
    this.token = token
  }

  createWebSocket(url: string, protocols: string[]): FakeSocket {
    const sock = new FakeSocket(url, protocols)
    this.sockets.push(sock)
    this.onSocket?.(sock, this.clock.now)
    this.clock.setTimeout(() => {
      if (!this.autoOpen) return
      if (this.reachable && protocols.includes('auth.' + this.token)) sock.open()
      else {
        sock.fail()
        sock.closeClean()
      }
    }, 20)
    return sock
  }

  fetch(
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal }
  ): Promise<FetchResponseLike> {
    this.fetched.push(url)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = this.clock.setTimeout(() => {
        if (settled) return
        settled = true
        if (init.signal.aborted) {
          reject(abortError())
          return
        }
        if (!this.reachable) {
          reject(new TypeError('Failed to fetch'))
          return
        }
        const expected = this.fetchToken ?? this.token
        if (init.headers.Authorization !== 'Bearer ' + expected) {
          resolve(response(401, { ok: false, status: 401 }))
          return
        }
        if (url === REMOTE_SESSIONS_PATH) {
          resolve(response(200, this.sessions))
          return
        }
        const m = /^\/api\/sessions\/([^/]+)\/buffer$/.exec(url)
        if (m) {
          const id = decodeURIComponent(m[1])
          const b = this.buffers[id]
          if (!b) {
            resolve(response(404, { ok: false, status: 404 }))
            return
          }
          const snapshot: RemoteBufferSnapshot = {
            sessionId: id,
            data: b.data,
            end: b.end,
            truncated: false,
            cols: b.cols,
            rows: b.rows,
            exit: b.exit
          }
          resolve(response(200, snapshot))
          return
        }
        resolve(response(404, { ok: false, status: 404 }))
      }, 10)
      init.signal.addEventListener('abort', () => {
        if (settled) return
        settled = true
        this.clock.clearTimeout(timer)
        reject(abortError())
      })
    })
  }
}

// ── Fake environment / viewer / harness ────────────────────────────────────

class FakeEnv implements RemoteEnv {
  readonly clock = new Clock()
  readonly storageData = new Map<string, string>()
  readonly storage = {
    getItem: (k: string): string | null => this.storageData.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      this.storageData.set(k, v)
    },
    removeItem: (k: string): void => {
      this.storageData.delete(k)
    }
  }
  readonly location = {
    hash: '',
    protocol: 'http:',
    host: '192.168.1.5:4137',
    pathname: '/',
    search: ''
  }
  readonly replaceCalls: string[] = []
  readonly server: FakeServer
  private visible = true
  private visibilityCbs: Array<(v: boolean) => void> = []
  private hashCbs: Array<() => void> = []

  constructor(token: string) {
    this.server = new FakeServer(this.clock, token)
  }

  now(): number {
    return this.clock.now
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return this.clock.setTimeout(fn, ms)
  }

  clearTimeout(id: unknown): void {
    this.clock.clearTimeout(id)
  }

  setInterval(fn: () => void, ms: number): unknown {
    return this.clock.setInterval(fn, ms)
  }

  clearInterval(id: unknown): void {
    this.clock.clearInterval(id)
  }

  createWebSocket(url: string, protocols: string[]): WebSocketLike {
    return this.server.createWebSocket(url, protocols)
  }

  fetch(
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal }
  ): Promise<FetchResponseLike> {
    return this.server.fetch(url, init)
  }

  replaceUrl(url: string): void {
    this.replaceCalls.push(url)
    if (!url.includes('#')) this.location.hash = ''
  }

  isVisible(): boolean {
    return this.visible
  }

  onVisibility(cb: (visible: boolean) => void): () => void {
    this.visibilityCbs.push(cb)
    return () => {
      this.visibilityCbs = this.visibilityCbs.filter((f) => f !== cb)
    }
  }

  onHashChange(cb: () => void): () => void {
    this.hashCbs.push(cb)
    return () => {
      this.hashCbs = this.hashCbs.filter((f) => f !== cb)
    }
  }

  setVisible(v: boolean): void {
    this.visible = v
    for (const cb of [...this.visibilityCbs]) cb(v)
  }

  fireHashChange(): void {
    for (const cb of [...this.hashCbs]) cb()
  }
}

class FakeViewer implements Viewer {
  resets: Array<{ data: string; cols: number; rows: number }> = []
  writes: string[] = []
  goneCount = 0

  reset(snapshot: { data: string; cols: number; rows: number; truncated: boolean }): void {
    this.resets.push({ data: snapshot.data, cols: snapshot.cols, rows: snapshot.rows })
    this.writes = []
  }

  write(data: string): void {
    this.writes.push(data)
  }

  gone(): void {
    this.goneCount++
  }

  text(): string {
    const reset = this.resets.length > 0 ? this.resets[this.resets.length - 1].data : ''
    return reset + this.writes.join('')
  }
}

interface Harness {
  env: FakeEnv
  server: FakeServer
  conn: RemoteConnection
  clock: Clock
  viewer: FakeViewer
}

function makeHarness(token: string, sessions: RemoteSessionInfo[] = []): Harness {
  tokensUsed.push(token)
  const env = new FakeEnv(token)
  env.server.sessions = sessions
  const conn = new RemoteConnection(env)
  return { env, server: env.server, conn, clock: env.clock, viewer: new FakeViewer() }
}

function session(id: string, createdAt: number): RemoteSessionInfo {
  return {
    id,
    repoTileId: 'tile',
    agentId: 'agent',
    title: id,
    cwd: '/tmp',
    createdAt,
    cols: 80,
    rows: 24
  }
}

function buffer(data: string, cols = 80, rows = 24): BufferEntry {
  return { data, end: data.length, cols, rows }
}

function dataMsg(sessionId: string, offset: number, data: string): RemoteWsMessage {
  return { channel: 'terminal:data', payload: { sessionId, data, offset } }
}

function pongMsg(t = 0): RemoteWsMessage {
  return { channel: 'remote:pong', payload: { t } }
}

function heartbeatMsg(t = 0): RemoteWsMessage {
  return { channel: 'remote:heartbeat', payload: { t } }
}

function goneMsg(sessionId: string): RemoteWsMessage {
  return { channel: 'remote:gone', payload: { sessionId } }
}

function exitMsg(sessionId: string, exitCode: number): RemoteWsMessage {
  return { channel: 'terminal:exit', payload: { sessionId, exitCode } }
}

function titleMsg(sessionId: string, title: string): RemoteWsMessage {
  return { channel: 'terminal:title', payload: { sessionId, title } }
}

function statusMsg(sessionId: string, status: 'booting' | 'stalled' | 'ready'): RemoteWsMessage {
  return { channel: 'terminal:status', payload: { sessionId, status } }
}

function sessionMsg(s: RemoteSessionInfo): RemoteWsMessage {
  return { channel: 'remote:session', payload: s }
}

/** Phase transitions observed through the public subscribe API. */
function phaseLog(conn: RemoteConnection): ConnectionPhase[] {
  const seen: ConnectionPhase[] = []
  const record = (): void => {
    const p = conn.getState().phase
    if (seen[seen.length - 1] !== p) seen.push(p)
  }
  conn.subscribe(record)
  record()
  return seen
}

/** Every socket/fetch/token seen across the scenarios (for the global assertions). */
const allSockets: FakeSocket[] = []
const allFetched: string[] = []
const tokensUsed: string[] = []
function collect(h: Harness): void {
  allSockets.push(...h.server.sockets)
  allFetched.push(...h.server.fetched)
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function scenarios(): Promise<void> {
  const restoreConsole = installConsoleSpy()
  // 1. Fresh start from the URL hash.
  {
    const token = 'a'.repeat(32)
    const h = makeHarness(token, [session('old', 100), session('new', 200)])
    h.env.location.hash = '#' + token
    const phases = phaseLog(h.conn)
    h.conn.start()
    check('1 token stored from hash', h.env.storage.getItem(TOKEN_STORAGE_KEY) === token)
    check(
      '1 URL cleared',
      h.env.replaceCalls[h.env.replaceCalls.length - 1] === '/',
      JSON.stringify(h.env.replaceCalls)
    )
    check('1 connecting immediately', h.conn.getState().phase === 'connecting', h.conn.getState().phase)
    await h.clock.advance(100)
    check('1 live after handshake + resync', h.conn.getState().phase === 'live', phases.join(' → '))
    check('1 phase went connecting → live', phases.join(',') === 'connecting,live', phases.join(','))
    check(
      '1 sessions newest first',
      JSON.stringify(h.conn.getState().sessions.map((s) => s.id)) === JSON.stringify(['new', 'old']),
      JSON.stringify(h.conn.getState().sessions.map((s) => s.id))
    )
    const sock = h.server.sockets[0]
    check('1 exactly one socket', h.server.sockets.length === 1, String(h.server.sockets.length))
    check('1 socket URL', sock?.url === 'ws://192.168.1.5:4137/ws', sock?.url)
    check(
      '1 socket protocols',
      JSON.stringify(sock?.protocols) === JSON.stringify(['deltav.v1', 'auth.' + token]),
      JSON.stringify(sock?.protocols)
    )
    check(
      '1 no token in fetch URLs',
      h.server.fetched.every((u) => !u.includes(token)),
      h.server.fetched.join(',')
    )
    check(
      '1 no token in ws URLs',
      h.server.sockets.every((s) => !s.url.includes(token)),
      h.server.sockets.map((s) => s.url).join(',')
    )
    collect(h)
  }

  // 2. Pairing flow with no token.
  {
    const token = 'b'.repeat(32)
    const h = makeHarness(token)
    h.env.location.hash = ''
    const phases = phaseLog(h.conn)
    h.conn.start()
    check('2 pairing with no token', h.conn.getState().phase === 'pairing', h.conn.getState().phase)
    check(
      '2 no pairing notice',
      h.conn.getState().pairingNotice === undefined,
      String(h.conn.getState().pairingNotice)
    )
    check('2 no socket while pairing', h.server.sockets.length === 0, String(h.server.sockets.length))
    check('2 garbage token rejected', h.conn.pair('garbage') === false)
    check('2 still pairing after garbage', h.conn.getState().phase === 'pairing', h.conn.getState().phase)
    const url = 'http://192.168.1.5:4137/#' + token
    check('2 full pairing URL accepted', h.conn.pair(url) === true)
    check('2 token adopted', h.env.storage.getItem(TOKEN_STORAGE_KEY) === token)
    check(
      '2 URL cleared on pair',
      h.env.replaceCalls[h.env.replaceCalls.length - 1] === '/',
      JSON.stringify(h.env.replaceCalls)
    )
    check('2 connecting after pair', h.conn.getState().phase === 'connecting', h.conn.getState().phase)
    await h.clock.advance(100)
    check('2 live after pair', h.conn.getState().phase === 'live', phases.join(' → '))
    check('2 one socket', h.server.sockets.length === 1, String(h.server.sockets.length))
    collect(h)
  }

  // 3. Viewer attach, live chunks, duplicate, overlap and gap resync.
  {
    const token = 'c'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('hello')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    check('3 live before attach', h.conn.getState().phase === 'live')
    check(
      '3 one reset with snapshot',
      h.viewer.resets.length === 1 && h.viewer.resets[0].data === 'hello',
      JSON.stringify(h.viewer.resets)
    )
    const sock = h.server.sockets[0]
    sock.push(dataMsg('s1', 5, 'a'))
    sock.push(dataMsg('s1', 6, 'b'))
    check('3 contiguous live data appended', h.viewer.text() === 'helloab', h.viewer.text())
    check(
      '3 writes in order',
      JSON.stringify(h.viewer.writes) === JSON.stringify(['a', 'b']),
      JSON.stringify(h.viewer.writes)
    )
    sock.push(dataMsg('s1', 5, 'ab'))
    check(
      '3 duplicate skipped',
      h.viewer.text() === 'helloab' && h.viewer.writes.length === 2,
      h.viewer.text()
    )
    sock.push(dataMsg('s1', 6, 'bZ'))
    check('3 overlap sliced', h.viewer.text() === 'helloabZ', h.viewer.text())
    // Move the server snapshot forward, then push a gap: refetch + fresh reset.
    h.server.buffers.s1 = buffer('helloabZPQ')
    sock.push(dataMsg('s1', 10, 'Q'))
    await h.clock.advance(50)
    check(
      '3 gap triggered fresh reset',
      h.viewer.resets.length === 2 && h.viewer.resets[1].data === 'helloabZPQ',
      JSON.stringify(h.viewer.resets)
    )
    sock.push(dataMsg('s1', 10, 'R'))
    check('3 contiguous data works after resync', h.viewer.text() === 'helloabZPQR', h.viewer.text())
    check('3 no duplicated snapshot prefix', h.viewer.text().indexOf('hello', 1) === -1, h.viewer.text())
    collect(h)
  }

  // 4. Live events during an in-flight resync are queued, never lost or duplicated.
  {
    const token = 'd'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('0123456789')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    h.conn.attachViewer('s1', h.viewer)
    const sock = h.server.sockets[0]
    // The buffer fetch resolves after 10 virtual ms; these arrive while pending.
    sock.push(dataMsg('s1', 5, 'abcde')) // fully contained in the snapshot
    sock.push(dataMsg('s1', 10, 'ab')) // past the snapshot end
    check('4 no writes before snapshot', h.viewer.writes.length === 0, JSON.stringify(h.viewer.writes))
    await h.clock.advance(50)
    check(
      '4 one reset with snapshot',
      h.viewer.resets.length === 1 && h.viewer.resets[0].data === '0123456789',
      JSON.stringify(h.viewer.resets)
    )
    check('4 queued continuation applied once', h.viewer.text() === '0123456789ab', h.viewer.text())
    check(
      '4 contained event skipped',
      JSON.stringify(h.viewer.writes) === JSON.stringify(['ab']),
      JSON.stringify(h.viewer.writes)
    )
    collect(h)
  }

  // 5. Silent death while hidden: returning reconnects cleanly (no unreachable/pairing).
  {
    const token = 'e'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('start')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    const before = h.server.sockets[0]
    const resetsBefore = h.viewer.resets.length
    const phases = phaseLog(h.conn)
    before.dead = true
    h.env.setVisible(false)
    await h.clock.advance(10_000)
    h.server.buffers.s1 = buffer('startNEW')
    h.env.setVisible(true)
    check('5 force reconnect on visible', h.server.sockets.length === 2, String(h.server.sockets.length))
    await h.clock.advance(1000)
    const fresh = h.server.sockets[h.server.sockets.length - 1]
    check('5 new socket is not the dead one', fresh !== before)
    check('5 phase live', h.conn.getState().phase === 'live', h.conn.getState().phase)
    check(
      '5 exactly one additional reset',
      h.viewer.resets.length === resetsBefore + 1,
      JSON.stringify(h.viewer.resets)
    )
    check(
      '5 reset has fresh snapshot',
      h.viewer.resets[h.viewer.resets.length - 1]?.data === 'startNEW',
      JSON.stringify(h.viewer.resets)
    )
    check('5 text equals server content', h.viewer.text() === 'startNEW', h.viewer.text())
    check('5 never unreachable', !phases.includes('unreachable'), phases.join(','))
    check('5 never pairing', !phases.includes('pairing'), phases.join(','))
    collect(h)
  }

  // 6a. Short hide with a healthy socket: ping/pong probe, no reconnect.
  {
    const token = 'f'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('hello')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    const sock = h.server.sockets[0]
    const resetsBefore = h.viewer.resets.length
    h.env.setVisible(false)
    await h.clock.advance(1000)
    h.env.setVisible(true)
    const pings = sock.sent.map((s) => JSON.parse(s) as { type?: string })
    check(
      '6a ping on existing socket',
      pings.length === 1 && pings[0].type === 'ping',
      JSON.stringify(sock.sent)
    )
    sock.push(pongMsg(h.clock.now))
    await h.clock.advance(PING_TIMEOUT_MS + 500)
    check('6a no new socket after pong', h.server.sockets.length === 1, String(h.server.sockets.length))
    check(
      '6a no viewer reset after pong',
      h.viewer.resets.length === resetsBefore,
      JSON.stringify(h.viewer.resets)
    )
    check('6a still live', h.conn.getState().phase === 'live', h.conn.getState().phase)
    collect(h)
  }

  // 6b. Short hide with no pong: ping timeout forces one reconnect and one reset.
  {
    const token = 'g'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('hello')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    const sock = h.server.sockets[0]
    const resetsBefore = h.viewer.resets.length
    h.env.setVisible(false)
    await h.clock.advance(1000)
    h.env.setVisible(true)
    check('6b ping sent before timeout', sock.sent.length === 1, JSON.stringify(sock.sent))
    await h.clock.advance(PING_TIMEOUT_MS + 100)
    check(
      '6b new socket after ping timeout',
      h.server.sockets.length === 2,
      String(h.server.sockets.length)
    )
    check(
      '6b exactly one viewer reset',
      h.viewer.resets.length === resetsBefore + 1,
      JSON.stringify(h.viewer.resets)
    )
    check('6b phase live', h.conn.getState().phase === 'live', h.conn.getState().phase)
    collect(h)
  }

  // 7. Across every socket created in scenarios 1–6, only liveness pings were sent.
  {
    const offenders: string[] = []
    let total = 0
    for (const sock of allSockets) {
      for (const raw of sock.sent) {
        total++
        let parsed: { type?: string } | null = null
        try {
          parsed = JSON.parse(raw) as { type?: string }
        } catch {
          parsed = null
        }
        if (!parsed || parsed.type !== 'ping') offenders.push(raw)
      }
    }
    check('7 sockets recorded', allSockets.length >= 9, String(allSockets.length))
    check('7 pings were sent', total >= 2, String(total))
    check('7 only ping messages ever sent', offenders.length === 0, offenders.join(' | '))
  }

  // 8. Unreachable timeline: backoff ladder, unreachable, background retries, manual recovery.
  {
    const token = 'h'.repeat(32)
    const h = makeHarness(token)
    h.env.location.hash = '#' + token
    h.server.reachable = false
    const socketTimes: number[] = []
    h.server.onSocket = (_s, at) => socketTimes.push(at)
    const phases = phaseLog(h.conn)
    h.conn.start()
    check('8 connecting immediately', h.conn.getState().phase === 'connecting', h.conn.getState().phase)
    check('8 initial connecting shows no pill', h.conn.getState().showPill === false)
    check('8 first socket created', h.server.sockets.length === 1, String(h.server.sockets.length))
    const t0 = h.clock.now
    // Advance only until the 6th failure flips the phase to unreachable.
    await h.clock.advance(14_000)
    check(
      '8 phase unreachable after UNREACHABLE_AFTER (6)',
      h.conn.getState().phase === 'unreachable',
      phases.join(',')
    )
    check('8 attempt is 6', h.conn.getState().attempt === 6, String(h.conn.getState().attempt))
    check('8 no pill while unreachable', h.conn.getState().showPill === false)
    const expectedDiffs = [500, 1000, 2000, 5000, 5000]
    let timingOk = true
    let timingDetail = ''
    for (let i = 0; i < expectedDiffs.length; i++) {
      const diff = socketTimes[i + 1] - socketTimes[i]
      const want = expectedDiffs[i] + 30
      if (diff < want - 40 || diff > want + 70) {
        timingOk = false
        timingDetail += `[${i}] ${diff} want≈${want}; `
      }
    }
    check(
      '8 backoff ladder ~500/1000/2000/5000/5000',
      timingOk,
      timingDetail || JSON.stringify(socketTimes.map((t) => t - t0))
    )
    const beforeRetries = h.server.sockets.length
    await h.clock.advance(11_000)
    const afterRetries = h.server.sockets.length
    check(
      '8 background retries continue every ~5000 ms',
      afterRetries - beforeRetries >= 2,
      `${beforeRetries}→${afterRetries}`
    )
    check(
      '8 still unreachable during background retries',
      h.conn.getState().phase === 'unreachable',
      h.conn.getState().phase
    )
    h.server.reachable = true
    h.conn.retryNow()
    check(
      '8 retryNow gives connecting feedback immediately',
      h.conn.getState().phase === 'connecting',
      h.conn.getState().phase
    )
    await h.clock.advance(500)
    check('8 live within 500 ms of retryNow', h.conn.getState().phase === 'live', phases.join(','))
    check('8 attempt reset to 0', h.conn.getState().attempt === 0, String(h.conn.getState().attempt))
    collect(h)
  }

  // 9. Reconnect after having been live: pill timing, fresh reset, silent quick recovery.
  {
    const token = 'i'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('one')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    check('9 live before drop', h.conn.getState().phase === 'live', h.conn.getState().phase)
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    check(
      '9 initial viewer reset',
      h.viewer.resets.length === 1 && h.viewer.resets[0].data === 'one',
      JSON.stringify(h.viewer.resets)
    )
    const sock = h.server.sockets[0]
    h.server.reachable = false
    sock.closeClean()
    check('9 reconnecting after drop', h.conn.getState().phase === 'reconnecting', h.conn.getState().phase)
    await h.clock.advance(200)
    check('9 no pill at +200 ms', h.conn.getState().showPill === false, String(h.conn.getState().showPill))
    await h.clock.advance(250)
    check('9 pill visible at +450 ms', h.conn.getState().showPill === true, String(h.conn.getState().showPill))
    await h.clock.advance(3300)
    check(
      '9 still not live after 3 failed retries',
      h.conn.getState().phase === 'reconnecting',
      h.conn.getState().phase
    )
    h.server.buffers.s1 = buffer('oneNEW')
    h.server.reachable = true
    const resetsBefore = h.viewer.resets.length
    await h.clock.advance(6000)
    check('9 live after recovery', h.conn.getState().phase === 'live', h.conn.getState().phase)
    check('9 exactly one fresh reset', h.viewer.resets.length === resetsBefore + 1, JSON.stringify(h.viewer.resets))
    check(
      '9 reset has fresh snapshot',
      h.viewer.resets[h.viewer.resets.length - 1]?.data === 'oneNEW',
      JSON.stringify(h.viewer.resets)
    )
    check('9 pill hidden when live', h.conn.getState().showPill === false)
    // A quick drop + recovery under PILL_DELAY_MS must never surface the pill.
    const pills: boolean[] = []
    const unsub = h.conn.subscribe(() => pills.push(h.conn.getState().showPill))
    const sock2 = h.server.sockets[h.server.sockets.length - 1]
    sock2.closeClean()
    h.conn.retryNow()
    await h.clock.advance(300)
    unsub()
    check('9 quick recovery is live', h.conn.getState().phase === 'live', h.conn.getState().phase)
    check('9 quick recovery never showed the pill', !pills.includes(true), JSON.stringify(pills))
    collect(h)
  }

  // 10. Visibility while unreachable stays honest: the silent retry never flips the phase.
  {
    const token = 'j'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('x')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    check('10 live first', h.conn.getState().phase === 'live', h.conn.getState().phase)
    const states: ConnectionPhase[] = []
    h.conn.subscribe(() => states.push(h.conn.getState().phase))
    h.server.reachable = false
    h.server.sockets[0].closeClean()
    await h.clock.advance(14_000)
    check('10 unreachable after repeated failures', h.conn.getState().phase === 'unreachable', h.conn.getState().phase)
    h.env.setVisible(false)
    await h.clock.advance(1000)
    const before = h.server.sockets.length
    h.env.setVisible(true)
    await h.clock.advance(100)
    check(
      '10 a new attempt starts immediately on visible',
      h.server.sockets.length === before + 1,
      `${before}→${h.server.sockets.length}`
    )
    check('10 phase still unreachable after silent retry', h.conn.getState().phase === 'unreachable', h.conn.getState().phase)
    const firstUnreachable = states.indexOf('unreachable')
    check('10 unreachable was observed', firstUnreachable >= 0, states.join(','))
    check(
      '10 never reconnecting during the silent retry',
      states.slice(firstUnreachable).every((ph) => ph === 'unreachable'),
      states.join(',')
    )
    h.conn.retryNow()
    check('10 retryNow flips to reconnecting', h.conn.getState().phase === 'reconnecting', h.conn.getState().phase)
    collect(h)
  }

  // 11. 401 handling: rejected token drops to pairing; re-pair recovers; resync 401 too.
  {
    const token = 'k'.repeat(32)
    const newToken = 'L'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    check('11a live first', h.conn.getState().phase === 'live', h.conn.getState().phase)
    h.server.token = newToken
    h.server.sockets[0].closeClean()
    await h.clock.advance(1000)
    check('11a phase pairing after 401', h.conn.getState().phase === 'pairing', h.conn.getState().phase)
    check(
      '11a pairing notice set',
      h.conn.getState().pairingNotice ===
        'This pairing is no longer valid. Scan the QR code in Delta-V settings again.',
      String(h.conn.getState().pairingNotice)
    )
    check('11a stored token removed', h.env.storage.getItem(TOKEN_STORAGE_KEY) === null)
    const sockCount = h.server.sockets.length
    await h.clock.advance(30_000)
    check(
      '11a no further sockets for 30 s',
      h.server.sockets.length === sockCount,
      `${sockCount}→${h.server.sockets.length}`
    )
    // (b) Re-pair with the server's new token recovers cleanly.
    const url = 'http://192.168.1.5:4137/#' + newToken
    check('11b pair accepted', h.conn.pair(url) === true)
    check('11b notice cleared', h.conn.getState().pairingNotice === undefined, String(h.conn.getState().pairingNotice))
    await h.clock.advance(100)
    check('11b live after re-pair', h.conn.getState().phase === 'live', h.conn.getState().phase)
    check('11b stored new token', h.env.storage.getItem(TOKEN_STORAGE_KEY) === newToken)
    collect(h)
  }

  // 11c. A 401 on the resync fetch (socket still opens) also drops to pairing.
  {
    const token = 'm'.repeat(32)
    const hc = makeHarness(token)
    hc.env.location.hash = '#' + token
    hc.server.fetchToken = 'wrong'.repeat(4)
    hc.conn.start()
    await hc.clock.advance(100)
    check('11c pairing after resync 401', hc.conn.getState().phase === 'pairing', hc.conn.getState().phase)
    check('11c notice set', hc.conn.getState().pairingNotice !== undefined, String(hc.conn.getState().pairingNotice))
    check('11c stored token removed', hc.env.storage.getItem(TOKEN_STORAGE_KEY) === null)
    collect(hc)
  }

  // 12. Heartbeat watchdog: 16 s of silence forces a reconnect; regular beats keep the socket.
  {
    const token = 'n'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('hi')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    const resetsBefore = h.viewer.resets.length
    const socketsBefore = h.server.sockets.length
    await h.clock.advance(16_000)
    check(
      '12 watchdog forced a reconnect',
      h.server.sockets.length === socketsBefore + 1,
      String(h.server.sockets.length)
    )
    check('12 viewer reset once', h.viewer.resets.length === resetsBefore + 1, JSON.stringify(h.viewer.resets))
    check('12 live after watchdog reconnect', h.conn.getState().phase === 'live', h.conn.getState().phase)
    // Regular heartbeats keep the same socket alive for a further 60 s.
    const sock = h.server.sockets[h.server.sockets.length - 1]
    const socketsAfterRecovery = h.server.sockets.length
    const resetsAfterRecovery = h.viewer.resets.length
    for (let i = 0; i < 12; i++) {
      await h.clock.advance(5000)
      sock.push(heartbeatMsg(h.clock.now))
    }
    check(
      '12 no reconnect while heartbeats flow',
      h.server.sockets.length === socketsAfterRecovery,
      String(h.server.sockets.length)
    )
    check(
      '12 no extra reset while heartbeats flow',
      h.viewer.resets.length === resetsAfterRecovery,
      JSON.stringify(h.viewer.resets)
    )
    check('12 still live', h.conn.getState().phase === 'live', h.conn.getState().phase)
    collect(h)
  }

  // 13. Exit while viewing: exit recorded, no viewer reset, survives a reconnect resync.
  {
    const token = 'o'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.server.buffers.s1 = buffer('hi')
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    const sock = h.server.sockets[0]
    const resetsBefore = h.viewer.resets.length
    sock.push(exitMsg('s1', 3))
    const rec = h.conn.getState().sessions.find((x) => x.id === 's1')
    check('13 exit recorded on the resident record', rec?.exit?.exitCode === 3, JSON.stringify(rec))
    check(
      '13 exit push caused no viewer reset',
      h.viewer.resets.length === resetsBefore,
      JSON.stringify(h.viewer.resets)
    )
    check('13 exit push caused no gone()', h.viewer.goneCount === 0, String(h.viewer.goneCount))
    const writesBefore = h.viewer.writes.length
    let threw = false
    try {
      sock.push(dataMsg('s1', 2, 'X'))
    } catch {
      threw = true
    }
    check('13 post-exit data does not throw', !threw)
    check('13 post-exit data still flows', h.viewer.writes.length === writesBefore + 1, h.viewer.text())
    // Reconnect: the fresh snapshot carries the exit and the viewer resets once.
    h.server.buffers.s1 = { data: 'hiX', end: 3, cols: 80, rows: 24, exit: { exitCode: 3, at: 0 } }
    const resetsAtReconnect = h.viewer.resets.length
    sock.closeClean()
    await h.clock.advance(1000)
    check('13 live after reconnect', h.conn.getState().phase === 'live', h.conn.getState().phase)
    check(
      '13 exactly one reset from resync',
      h.viewer.resets.length === resetsAtReconnect + 1,
      JSON.stringify(h.viewer.resets)
    )
    check(
      '13 snapshot reset applied',
      h.viewer.resets[h.viewer.resets.length - 1]?.data === 'hiX',
      JSON.stringify(h.viewer.resets)
    )
    const rec2 = h.conn.getState().sessions.find((x) => x.id === 's1')
    check('13 exit survives resync', rec2?.exit?.exitCode === 3, JSON.stringify(rec2))
    const up = session('s1', 1)
    up.title = 'renamed'
    h.server.sockets[h.server.sockets.length - 1].push(sessionMsg(up))
    const rec3 = h.conn.getState().sessions.find((x) => x.id === 's1')
    check('13 upsert keeps existing exit', rec3?.exit?.exitCode === 3, JSON.stringify(rec3))
    check('13 upsert applied title', rec3?.title === 'renamed', JSON.stringify(rec3))
    collect(h)
  }

  // 14. Gone: remote:gone removes a session; a 404 buffer calls viewer.gone() once per resync.
  {
    const token = 'p'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    check('14 live', h.conn.getState().phase === 'live', h.conn.getState().phase)
    h.server.sockets[0].push(goneMsg('s1'))
    check(
      '14 remote:gone removes the session',
      h.conn.getState().sessions.length === 0,
      JSON.stringify(h.conn.getState().sessions)
    )
    // Attach a viewer for a session with no buffer (404): gone() once, no reset.
    h.conn.attachViewer('s1', h.viewer)
    await h.clock.advance(50)
    check('14 gone() once on attach 404', h.viewer.goneCount === 1, String(h.viewer.goneCount))
    check('14 no reset on 404', h.viewer.resets.length === 0, JSON.stringify(h.viewer.resets))
    // Reconnect: the resync fetch 404s again → exactly one more gone().
    h.server.sockets[0].closeClean()
    await h.clock.advance(1000)
    check('14 gone() once on resync 404', h.viewer.goneCount === 2, String(h.viewer.goneCount))
    check('14 still no reset', h.viewer.resets.length === 0, JSON.stringify(h.viewer.resets))
    check('14 live after reconnect', h.conn.getState().phase === 'live', h.conn.getState().phase)
    collect(h)
  }

  // 15. Session events: newest-first upsert and immutable title/status updates.
  {
    const token = 'q'.repeat(32)
    const h = makeHarness(token, [session('sA', 100), session('sB', 200)])
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    check(
      '15 initial order newest first',
      JSON.stringify(h.conn.getState().sessions.map((x) => x.id)) === JSON.stringify(['sB', 'sA']),
      JSON.stringify(h.conn.getState().sessions.map((x) => x.id))
    )
    const stable = h.conn.getState()
    check('15 getState is referentially stable', h.conn.getState() === stable)
    const sock = h.server.sockets[0]
    sock.push(sessionMsg(session('sC', 300)))
    check(
      '15 new session added newest first',
      JSON.stringify(h.conn.getState().sessions.map((x) => x.id)) === JSON.stringify(['sC', 'sB', 'sA']),
      JSON.stringify(h.conn.getState().sessions.map((x) => x.id))
    )
    const before = h.conn.getState()
    const sA = before.sessions.find((x) => x.id === 'sA')
    const sC = before.sessions.find((x) => x.id === 'sC')
    sock.push(titleMsg('sB', 'renamed B'))
    const after = h.conn.getState()
    check('15 state object identity changes', after !== before)
    check('15 sessions array identity changes', after.sessions !== before.sessions)
    check('15 untouched session keeps identity (sA)', after.sessions.find((x) => x.id === 'sA') === sA, 'sA')
    check('15 untouched session keeps identity (sC)', after.sessions.find((x) => x.id === 'sC') === sC, 'sC')
    check(
      '15 title updated',
      after.sessions.find((x) => x.id === 'sB')?.title === 'renamed B',
      JSON.stringify(after.sessions.find((x) => x.id === 'sB'))
    )
    const base = h.conn.getState()
    const sB = base.sessions.find((x) => x.id === 'sB')
    sock.push(statusMsg('sA', 'ready'))
    const afterStatus = h.conn.getState()
    check(
      '15 status updated',
      afterStatus.sessions.find((x) => x.id === 'sA')?.status === 'ready',
      JSON.stringify(afterStatus.sessions.find((x) => x.id === 'sA'))
    )
    check('15 other session keeps identity on status change', afterStatus.sessions.find((x) => x.id === 'sB') === sB, 'sB')
    check('15 getState stable after status', h.conn.getState() === afterStatus)
    collect(h)
  }

  // 16. Re-pair on hashchange: the old socket dies, the new token is adopted, the hash is stripped.
  {
    const token = 'r'.repeat(32)
    const other = 'S'.repeat(32)
    const h = makeHarness(token, [session('s1', 1)])
    h.env.location.hash = '#' + token
    h.conn.start()
    await h.clock.advance(100)
    check('16 live before hashchange', h.conn.getState().phase === 'live', h.conn.getState().phase)
    const oldSocket = h.server.sockets[0]
    h.server.token = other
    h.env.location.hash = '#' + other
    const replaceBefore = h.env.replaceCalls.length
    h.env.fireHashChange()
    check('16 old socket closed', oldSocket.readyState === 3, String(oldSocket.readyState))
    check(
      '16 new socket uses the new token',
      h.server.sockets.length === 2 && h.server.sockets[1].protocols.includes('auth.' + other),
      JSON.stringify(h.server.sockets.map((x) => x.protocols))
    )
    check('16 hash stripped', h.env.location.hash === '', JSON.stringify(h.env.location.hash))
    check('16 replaceUrl called', h.env.replaceCalls.length === replaceBefore + 1, JSON.stringify(h.env.replaceCalls))
    check('16 token stored', h.env.storage.getItem(TOKEN_STORAGE_KEY) === other)
    await h.clock.advance(100)
    check('16 live on the new pairing', h.conn.getState().phase === 'live', h.conn.getState().phase)
    collect(h)
  }

  // 17. Global: only pings were ever sent, no token in any URL, the engine never logged.
  {
    const offenders: string[] = []
    let total = 0
    for (const sock of allSockets) {
      for (const raw of sock.sent) {
        total++
        let parsed: { type?: string } | null = null
        try {
          parsed = JSON.parse(raw) as { type?: string }
        } catch {
          parsed = null
        }
        if (!parsed || parsed.type !== 'ping') offenders.push(raw)
      }
    }
    check('17 only ping messages ever sent (all scenarios)', offenders.length === 0, offenders.join(' | '))
    const badFetch = allFetched.filter((u) => tokensUsed.some((t) => u.includes(t)))
    check('17 no fetch URL contains a token', badFetch.length === 0, badFetch.join(','))
    const badWs = allSockets.filter((x) => tokensUsed.some((t) => x.url.includes(t)))
    check('17 no ws URL contains a token', badWs.length === 0, badWs.map((x) => x.url).join(','))
    check('17 sockets recorded across all scenarios', allSockets.length >= 20, String(allSockets.length))
    check('17 pings were sent', total >= 2, String(total))
    check('17 engine never logged to console', engineConsole.length === 0, engineConsole.join(' | '))
  }

  // __SCENARIOS__
  restoreConsole()
}

async function main(): Promise<void> {
  await scenarios()
}

main().then(
  () => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`)
      process.exit(1)
    }
    console.log('\nall remote-client checks passed')
    process.exit(0)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
