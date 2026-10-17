/**
 * Integration check for the Delta-V Remote main-process half.
 *
 *  - ring.ts: OutputRing offsets/trimming/`end`/`truncated` and snapshot mode
 *    restore; ModeTracker across chunk boundaries.
 *  - net.ts: isLanAddress table, constant-time tokensEqual, bearer + WS token
 *    parsing, lanAddresses shape.
 *  - server.ts: a real RemoteServer on port 0 — auth gate, session + buffer
 *    API, static serving with traversal defense, WebSocket auth/heartbeat/pong,
 *    read-only message handling, drop/stop lifecycle.
 *
 * Run: npx esbuild tools/remote-bridge-check.ts --bundle --format=cjs --platform=node \
 *        --alias:@shared=./src/shared --outfile=/tmp/remote-bridge-check.cjs \
 *        && node /tmp/remote-bridge-check.cjs
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { ModeTracker, OutputRing, RING_CAP } from '../src/main/remote/ring'
import {
  isLanAddress,
  lanAddresses,
  parseBearer,
  parseWsTokenFromProtocols,
  tokensEqual
} from '../src/main/remote/net'
import { RemoteServer } from '../src/main/remote/server'
import type {
  RemoteBufferSnapshot,
  RemoteSessionInfo,
  RemoteWsMessage
} from '../src/shared/types'

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++
    console.log(`  PASS ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── 1. OutputRing ─────────────────────────────────────────────────────────
console.log('OutputRing')
{
  check('RING_CAP is 256 KiB', RING_CAP === 256 * 1024)

  const ring = new OutputRing(10)
  const o0 = ring.append('aaaa')
  const o1 = ring.append('bbbb')
  const o2 = ring.append('cccc')
  check('offsets contiguous', o0 === 0 && o1 === 4 && o2 === 8, `${o0},${o1},${o2}`)
  check('end is total appended', ring.end === 12, String(ring.end))
  check('truncated flag set on drop', ring.truncated === true)
  const snap = ring.snapshot()
  check('drops whole oldest chunk', snap.data.endsWith('bbbbcccc'), JSON.stringify(snap.data))
  check('snapshot end', snap.end === 12)
  check('snapshot truncated', snap.truncated === true)

  const big = new OutputRing(5)
  const offBig = big.append('abcdefghij')
  check('single oversized chunk offset 0', offBig === 0)
  check('single oversized keeps last cap chars', big.snapshot().data.endsWith('fghij'))
  check('single oversized end', big.end === 10)
  check('single oversized truncated', big.truncated === true)

  const alt = new OutputRing(10)
  alt.append('\x1b[?1049h')
  alt.append('AB')
  alt.append('CD')
  const altSnap = alt.snapshot()
  check(
    'alt entered then dropped → restore prefix',
    altSnap.truncated && altSnap.data.startsWith('\x1b[0m\x1b[?1049h'),
    JSON.stringify(altSnap.data)
  )

  const clean = new OutputRing(100)
  clean.append('\x1b[?1049h')
  check('no prefix when not truncated', clean.snapshot().data === '\x1b[?1049h')
}

// ── 2. ModeTracker ────────────────────────────────────────────────────────
console.log('ModeTracker')
{
  const mt = new ModeTracker()
  mt.feed('\x1b[?10')
  mt.feed('49h\x1b[?25l')
  check(
    'sequence split across chunks',
    mt.prefix() === '\x1b[?1049h\x1b[?25l',
    JSON.stringify(mt.prefix())
  )

  const mt2 = new ModeTracker()
  mt2.feed('\x1b[?1049h\x1b[?25l\x1b[?7l')
  mt2.feed('\x1b[?1049l')
  check('leaving alt screen clears it', mt2.prefix() === '\x1b[?25l\x1b[?7l', JSON.stringify(mt2.prefix()))

  const mt3 = new ModeTracker()
  mt3.feed('\x1b[?1049h\x1b[?25l')
  mt3.feed('\x1bc')
  check('RIS resets to defaults', mt3.prefix() === '', JSON.stringify(mt3.prefix()))
}

// ── 3. net helpers ────────────────────────────────────────────────────────
console.log('net helpers')
{
  const table: [string | undefined, boolean][] = [
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.5', true],
    ['169.254.10.1', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['8.8.8.8', false],
    ['::ffff:192.168.0.2', true],
    ['::1', true],
    ['fe80::1', true],
    ['fd12::1', true],
    ['fc00::1', true],
    ['2001:db8::1', false],
    [undefined, false]
  ]
  for (const [ip, want] of table) {
    check(`isLanAddress(${ip}) === ${want}`, isLanAddress(ip) === want)
  }

  check('tokensEqual equal', tokensEqual('abc', 'abc') === true)
  check('tokensEqual unequal', tokensEqual('abc', 'abd') === false)
  check('tokensEqual different lengths', tokensEqual('abc', 'abcd') === false)
  check('tokensEqual both empty', tokensEqual('', '') === false)
  check('tokensEqual one empty', tokensEqual('', 'abc') === false)

  check('parseBearer basic', parseBearer('Bearer tok123') === 'tok123')
  check('parseBearer case-insensitive scheme', parseBearer('bearer tok123') === 'tok123')
  check('parseBearer undefined', parseBearer(undefined) === undefined)
  check('parseBearer scheme only', parseBearer('Bearer') === undefined)

  check(
    'parseWsTokenFromProtocols finds token',
    parseWsTokenFromProtocols('deltav.v1, auth.S3CRET') === 'S3CRET'
  )
  check('parseWsTokenFromProtocols none', parseWsTokenFromProtocols('deltav.v1') === undefined)
  check('parseWsTokenFromProtocols empty', parseWsTokenFromProtocols('auth.') === undefined)
  check('parseWsTokenFromProtocols undefined', parseWsTokenFromProtocols(undefined) === undefined)

  const lan = lanAddresses()
  check(
    'lanAddresses returns {iface,address}[]',
    Array.isArray(lan) &&
      lan.every((a) => typeof a.iface === 'string' && typeof a.address === 'string')
  )
}

// ── 4. RemoteServer ───────────────────────────────────────────────────────
async function serverChecks(): Promise<void> {
  const token = 'tok-test-123'
  const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deltav-remote-'))
  fs.mkdirSync(path.join(staticRoot, 'assets'))
  fs.writeFileSync(path.join(staticRoot, 'remote.html'), '<!doctype html><title>remote</title>')
  fs.writeFileSync(path.join(staticRoot, 'manifest.webmanifest'), '{}')
  fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>app</title>')
  fs.writeFileSync(path.join(staticRoot, 'assets', 'a.js'), 'console.log(1)')

  const sessions: RemoteSessionInfo[] = [
    {
      id: 'sess-a',
      repoTileId: 't1',
      agentId: 'kilo',
      title: 'A',
      cwd: '/tmp',
      createdAt: 200,
      cols: 80,
      rows: 24,
      status: 'ready'
    },
    {
      id: 'sess-b',
      repoTileId: 't2',
      agentId: 'kilo',
      title: 'B',
      cwd: '/tmp',
      createdAt: 100,
      cols: 100,
      rows: 30,
      status: 'ready'
    }
  ]
  const snapshots: Record<string, RemoteBufferSnapshot> = {
    'sess-a': { sessionId: 'sess-a', data: 'hello\x1b[0m', end: 10, truncated: false, cols: 80, rows: 24 }
  }

  const server = new RemoteServer({
    getToken: () => token,
    listSessions: () => sessions,
    getSnapshot: (id) => snapshots[id],
    staticRoot
  })
  await server.start(0)
  const port = server.port
  check('bound to a real port', typeof port === 'number' && port > 0, String(port))
  const base = `http://127.0.0.1:${port}`
  const auth = { Authorization: `Bearer ${token}` }

  console.log('server: auth gate')
  for (const p of ['/api/sessions', '/api/sessions/sess-a/buffer', '/api/nope']) {
    const res = await fetch(base + p)
    const text = await res.text()
    check(`no token ${p} → 401`, res.status === 401, String(res.status))
    check(`no token ${p} body exact`, text === '{"error":"unauthorized"}', text)
    check(`no token ${p} leaks no session ids`, !text.includes('sess-a') && !text.includes('sess-b'))
  }
  const wrongToken = await fetch(base + '/api/sessions', {
    headers: { Authorization: 'Bearer wrong' }
  })
  check('wrong token → 401', wrongToken.status === 401)

  console.log('server: API with token')
  const okRes = await fetch(base + '/api/sessions', { headers: auth })
  check('GET /api/sessions → 200', okRes.status === 200)
  check('GET /api/sessions cache-control', okRes.headers.get('cache-control') === 'no-store')
  const body = (await okRes.json()) as RemoteSessionInfo[]
  check(
    'GET /api/sessions returns the sessions',
    Array.isArray(body) && body.length === 2 && body[0].id === 'sess-a'
  )

  const buf = await fetch(base + '/api/sessions/sess-a/buffer', { headers: auth })
  check('buffer 200', buf.status === 200)
  const bufBody = (await buf.json()) as RemoteBufferSnapshot
  check('buffer body', bufBody.sessionId === 'sess-a' && bufBody.data.startsWith('hello'))
  const bufMiss = await fetch(base + '/api/sessions/nope/buffer', { headers: auth })
  check('buffer 404 for unknown id', bufMiss.status === 404)
  const bufNoAuth = await fetch(base + '/api/sessions/sess-a/buffer')
  check('buffer 401 without token', bufNoAuth.status === 401)

  console.log('server: method gating')
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await fetch(base + '/api/sessions', { method, headers: auth })
    check(`${method} with token → 405`, res.status === 405, String(res.status))
    check(`${method} sets Allow: GET`, res.headers.get('allow') === 'GET')
  }
  const postNoAuth = await fetch(base + '/api/sessions', { method: 'POST' })
  check('POST without token → 401', postNoAuth.status === 401)

  console.log('server: static')
  const rootRes = await fetch(base + '/')
  check('GET / → 200', rootRes.status === 200)
  check(
    'GET / is html',
    (rootRes.headers.get('content-type') ?? '').includes('text/html')
  )
  check(
    'GET / carries CSP',
    (rootRes.headers.get('content-security-policy') ?? '').includes("default-src 'self'")
  )
  check('GET / sets nosniff', rootRes.headers.get('x-content-type-options') === 'nosniff')
  const indexRes = await fetch(base + '/index.html')
  check('GET /index.html → 404', indexRes.status === 404)
  const assetRes = await fetch(base + '/assets/a.js')
  check('GET /assets/a.js → 200', assetRes.status === 200)
  check(
    'assets are immutable-cached',
    (assetRes.headers.get('cache-control') ?? '').includes('immutable')
  )
  const trav1 = await fetch(base + '/assets/../index.html')
  check('GET /assets/../index.html → 404', trav1.status === 404)
  const trav2 = await fetch(base + '/%2e%2e/secret')
  check('GET /%2e%2e/secret → 404', trav2.status === 404)
  const headRes = await fetch(base + '/', { method: 'HEAD' })
  check('HEAD / → 200', headRes.status === 200)

  console.log('server: WebSocket')
  interface ConnectResult {
    ws: WebSocket
    messages: string[]
    send: (obj: unknown) => void
  }
  function openClient(protocols: string[]): Promise<ConnectResult> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols)
      const messages: string[] = []
      ws.on('message', (data: WebSocket.RawData) => messages.push(data.toString()))
      ws.on('open', () => resolve({ ws, messages, send: (o) => ws.send(JSON.stringify(o)) }))
      ws.on('error', reject)
    })
  }
  function rejected(protocols?: string[]): Promise<number | undefined> {
    return new Promise((resolve) => {
      const ws = protocols
        ? new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols)
        : new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('open', () => {
        ws.terminate()
        resolve(undefined)
      })
      ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number; resume(): void }) => {
        resolve(res.statusCode)
        res.resume()
      })
      ws.on('error', () => resolve(undefined))
    })
  }

  check('WS without token rejected 401', (await rejected()) === 401)
  check('WS with wrong token rejected 401', (await rejected(['deltav.v1', 'auth.wrong'])) === 401)

  const client = await openClient(['deltav.v1', `auth.${token}`])
  check('WS with correct token accepted', true)
  check('WS negotiated subprotocol', client.ws.protocol === 'deltav.v1', client.ws.protocol)
  check('clientCount tracks connection', server.clientCount === 1, String(server.clientCount))

  await delay(60)
  const first = JSON.parse(client.messages[0] ?? '{}') as RemoteWsMessage
  check('heartbeat on connect', first.channel === 'remote:heartbeat')

  const payload: RemoteWsMessage = { channel: 'remote:heartbeat', payload: { t: 12345 } }
  const beforeBroadcast = client.messages.length
  server.broadcast(payload)
  await delay(60)
  check('broadcast reaches client', client.messages.length === beforeBroadcast + 1)
  check(
    'broadcast is the exact JSON',
    client.messages[client.messages.length - 1] === JSON.stringify(payload),
    client.messages[client.messages.length - 1]
  )

  client.send({ type: 'ping', t: 5 })
  await delay(60)
  const pong = JSON.parse(client.messages[client.messages.length - 1]) as RemoteWsMessage
  check(
    'ping → pong echoing t',
    pong.channel === 'remote:pong' && pong.payload.t === 5,
    JSON.stringify(pong)
  )

  const before = client.messages.length
  client.send({ type: 'input', data: 'rm -rf' })
  client.ws.send('{not json')
  client.ws.send(Buffer.from([0, 1, 2, 3, 255]))
  await delay(100)
  check('read-only: no reply to non-ping/invalid messages', client.messages.length === before)

  client.send({ type: 'ping', t: 7 })
  await delay(60)
  const after = JSON.parse(client.messages[client.messages.length - 1]) as RemoteWsMessage
  check(
    'server survives garbage input',
    after.channel === 'remote:pong' && after.payload.t === 7
  )
  const stillUp = await fetch(base + '/api/sessions', { headers: auth })
  check('HTTP still serving after garbage', stillUp.status === 200)

  const closedCode = new Promise<number>((resolve) => client.ws.on('close', (code) => resolve(code)))
  server.dropClients(1008, 'x')
  check('dropClients closes with 1008', (await closedCode) === 1008)
  await delay(60)
  check('clientCount drops after close', server.clientCount === 0, String(server.clientCount))

  console.log('server: shutdown')
  const second = await openClient(['deltav.v1', `auth.${token}`])
  const secondClosed = new Promise<number>((resolve) =>
    second.ws.on('close', (code) => resolve(code))
  )
  const t0 = Date.now()
  await server.stop()
  const elapsed = Date.now() - t0
  check('stop() resolves quickly', elapsed < 1000, `${elapsed}ms`)
  check('stop() closes client with 1001', (await secondClosed) === 1001)
  check('port is null after stop', server.port === null)
  let refused = false
  try {
    await fetch(base + '/api/sessions')
  } catch {
    refused = true
  }
  check('port refused after stop', refused)

  console.log('server: idempotent stop')

  const makeServer = (): RemoteServer =>
    new RemoteServer({
      getToken: () => token,
      listSessions: () => sessions,
      getSnapshot: (id) => snapshots[id],
      staticRoot
    })

  const settledWithin = (p: Promise<void>, ms: number): Promise<boolean> =>
    Promise.race([p.then(() => true, () => false), delay(ms).then(() => false)])

  // (a) stop() on a server that was never started resolves promptly.
  const neverStarted = makeServer()
  const tNever = Date.now()
  const neverOk = await settledWithin(neverStarted.stop(), 200)
  const neverElapsed = Date.now() - tNever
  check('never-started stop() resolves within 200ms', neverOk, `${neverElapsed}ms`)
  check('never-started second stop() resolves', await settledWithin(neverStarted.stop(), 200))

  // (b) two sequential stop() calls on a started server both resolve.
  const sequential = makeServer()
  await sequential.start(0)
  check('sequential stop() #1 resolves', await settledWithin(sequential.stop(), 1000))
  check('sequential stop() #2 resolves', await settledWithin(sequential.stop(), 200))

  // (c) two concurrent stop() calls both resolve.
  const concurrent = makeServer()
  await concurrent.start(0)
  const [c1, c2] = await Promise.all([
    settledWithin(concurrent.stop(), 1000),
    settledWithin(concurrent.stop(), 1000)
  ])
  check('concurrent stop() calls both resolve', c1 && c2, `${c1},${c2}`)

  // (d) start() after stop() on the same instance works; a final stop resolves.
  await concurrent.start(0)
  const port2 = concurrent.port
  const restartRes = await fetch(`http://127.0.0.1:${port2}/api/sessions`, { headers: auth })
  check(
    'start() after stop() serves /api/sessions → 200',
    restartRes.status === 200,
    String(restartRes.status)
  )
  check('final stop() after restart resolves', await settledWithin(concurrent.stop(), 1000))
}

void serverChecks()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`)
      process.exit(1)
    }
    console.log(`\nall ${passes} remote-bridge checks passed`)
    process.exit(0)
  })
  .catch((err) => {
    console.error('check script crashed:', err)
    process.exit(1)
  })
