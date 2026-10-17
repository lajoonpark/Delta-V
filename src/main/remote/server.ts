/**
 * Delta-V Remote HTTP + WebSocket server.
 *
 * Injected-dependency design: it knows nothing about pty sessions or settings —
 * everything comes from the deps passed by the remote bridge. It is a READ-ONLY
 * mirror: the only client message it understands is a liveness ping.
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import type { Duplex } from 'stream'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { REMOTE_SESSIONS_PATH, REMOTE_WS_PATH, REMOTE_WS_SUBPROTOCOL } from '@shared/ipc'
import type {
  RemoteBufferSnapshot,
  RemoteSessionInfo,
  RemoteWsMessage
} from '@shared/types'
import { isLanAddress, parseBearer, parseWsTokenFromProtocols, tokensEqual } from './net'

export interface RemoteServerDeps {
  getToken(): string
  listSessions(): RemoteSessionInfo[]
  getSnapshot(sessionId: string): RemoteBufferSnapshot | undefined
  /** Production: dir containing remote.html, manifest.webmanifest, assets/, remote-icons/. */
  staticRoot?: string
  /** Dev: Vite dev-server base URL (e.g. http://localhost:5173). */
  devProxyTarget?: string
  onClientsChanged?(count: number): void
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade'
])

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8'
}

const STATIC_ALLOW =
  /^\/(remote\.html|manifest\.webmanifest|remote-icons\/[\w.\-]+|assets\/[\w.\-@]+)$/

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; media-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' ws: wss:; manifest-src 'self'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'"

/** Max buffered bytes per client before we drop it (it will resync on reconnect). */
const MAX_BUFFERED = 4 * 1024 * 1024
/** Invalid client messages tolerated before the connection is terminated. */
const MAX_INVALID = 20

function friendlyError(port: number, err: NodeJS.ErrnoException): Error {
  if (err.code === 'EADDRINUSE') return new Error(`Port ${port} is already in use`)
  if (err.code === 'EACCES') return new Error(`Permission denied for port ${port}`)
  return new Error(err.message)
}

function rejectUpgrade(socket: Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export class RemoteServer {
  private deps: RemoteServerDeps
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private invalid = new WeakMap<WebSocket, number>()
  private boundPort: number | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private stoppingPromise: Promise<void> | null = null
  private shuttingDown = false

  constructor(deps: RemoteServerDeps) {
    this.deps = deps
  }

  get port(): number | null {
    return this.boundPort
  }

  get clientCount(): number {
    return this.clients.size
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res))
      const wss = new WebSocketServer({
        noServer: true,
        maxPayload: 1024,
        perMessageDeflate: false,
        handleProtocols: (protocols) =>
          protocols.has(REMOTE_WS_SUBPROTOCOL) ? REMOTE_WS_SUBPROTOCOL : false
      })
      this.server = server
      this.wss = wss
      this.clients = new Set()
      this.shuttingDown = false

      server.on('upgrade', (req, socket, head) =>
        this.handleUpgrade(req, socket as Duplex, head)
      )
      server.on('clientError', (_err, socket) => socket.destroy())
      wss.on('connection', (ws) => this.handleConnection(ws))

      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError)
        this.detach()
        reject(friendlyError(port, err))
      }
      server.once('error', onError)

      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', onError)
        // Keep a persistent handler so late errors never throw unhandled.
        server.on('error', () => undefined)
        const addr = server.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : port
        this.heartbeat = setInterval(() => {
          this.broadcast({ channel: 'remote:heartbeat', payload: { t: Date.now() } })
        }, 5000)
        this.heartbeat.unref()
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise
    const host = this.server
    const wss = this.wss
    if (!host && !wss) return Promise.resolve()
    this.shuttingDown = true
    this.stoppingPromise = new Promise<void>((resolve) => {
      if (this.heartbeat) {
        clearInterval(this.heartbeat)
        this.heartbeat = null
      }
      // Ask well-behaved viewers to leave, then terminate stragglers.
      for (const ws of [...this.clients]) {
        try {
          ws.close(1001, 'server shutting down')
        } catch {
          try {
            ws.terminate()
          } catch {
            /* ignore */
          }
        }
      }
      const stragglers = setTimeout(() => {
        for (const ws of [...this.clients]) {
          try {
            ws.terminate()
          } catch {
            /* ignore */
          }
        }
      }, 200)
      stragglers.unref()

      let pending = (host ? 1 : 0) + (wss ? 1 : 0)
      const done = (): void => {
        if (--pending > 0) return
        clearTimeout(stragglers)
        this.clients.clear()
        this.boundPort = null
        this.server = null
        this.wss = null
        resolve()
      }
      if (wss) {
        try {
          wss.close(() => done())
        } catch {
          done()
        }
      }
      if (host) {
        try {
          host.close(() => done())
        } catch {
          done()
        }
        try {
          host.closeAllConnections()
        } catch {
          /* ignore */
        }
      }
    })
    void this.stoppingPromise.then(() => {
      this.stoppingPromise = null
    })
    return this.stoppingPromise
  }

  private detach(): void {
    this.server = null
    this.wss = null
    this.boundPort = null
    this.clients.clear()
  }

  broadcast(msg: RemoteWsMessage): void {
    if (this.shuttingDown) return
    const json = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (ws.bufferedAmount > MAX_BUFFERED) {
        ws.terminate()
        continue
      }
      ws.send(json)
    }
  }

  dropClients(code: number, reason: string): void {
    for (const ws of [...this.clients]) {
      try {
        ws.close(code, reason)
      } catch {
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!isLanAddress(req.socket.remoteAddress)) {
      req.socket.destroy()
      return
    }
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      this.sendText(res, 400, 'Bad Request')
      return
    }
    const method = req.method ?? 'GET'
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      this.handleApi(req, res, pathname, method)
      return
    }
    this.handleStatic(req, res, pathname, method)
  }

  private baseHeaders(res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    this.baseHeaders(res)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.statusCode = status
    res.end(JSON.stringify(body))
  }

  private sendText(res: http.ServerResponse, status: number, text: string): void {
    this.baseHeaders(res)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.statusCode = status
    res.end(text)
  }

  private handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string
  ): void {
    const token = parseBearer(req.headers.authorization)
    if (!token || !tokensEqual(token, this.deps.getToken())) {
      this.sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      this.sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (pathname === REMOTE_SESSIONS_PATH) {
      this.sendJson(res, 200, this.deps.listSessions())
      return
    }
    const m = /^\/api\/sessions\/([^/]+)\/buffer$/.exec(pathname)
    if (m) {
      let id: string
      try {
        id = decodeURIComponent(m[1])
      } catch {
        this.sendJson(res, 400, { error: 'bad request' })
        return
      }
      const snapshot = this.deps.getSnapshot(id)
      if (!snapshot) {
        this.sendJson(res, 404, { error: 'not found' })
        return
      }
      this.sendJson(res, 200, snapshot)
      return
    }
    this.sendJson(res, 404, { error: 'not found' })
  }

  private handleStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string
  ): void {
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD')
      this.sendText(res, 405, 'Method Not Allowed')
      return
    }
    if (this.deps.devProxyTarget && !this.deps.staticRoot) {
      this.handleDevProxy(req, res, pathname, method)
      return
    }
    this.handleProdStatic(req, res, pathname, method)
  }

  private handleProdStatic(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string
  ): void {
    const root = this.deps.staticRoot
    if (!root) {
      this.sendText(res, 404, 'Not Found')
      return
    }
    let rel: string
    if (pathname === '/') {
      rel = 'remote.html'
    } else if (STATIC_ALLOW.test(pathname)) {
      rel = pathname.slice(1)
    } else {
      this.sendText(res, 404, 'Not Found')
      return
    }
    const full = path.join(root, rel)
    if (!full.startsWith(root + path.sep)) {
      this.sendText(res, 404, 'Not Found')
      return
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        this.sendText(res, 404, 'Not Found')
        return
      }
      const ext = path.extname(full).slice(1).toLowerCase()
      this.baseHeaders(res)
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
      res.setHeader(
        'Cache-Control',
        pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      )
      if (ext === 'html') res.setHeader('Content-Security-Policy', CSP)
      res.statusCode = 200
      if (method === 'HEAD') res.end()
      else res.end(data)
    })
  }

  private handleDevProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string
  ): void {
    const target = this.deps.devProxyTarget
    if (!target) {
      this.sendText(res, 502, 'Bad Gateway')
      return
    }
    if (pathname === '/index.html') {
      this.sendText(res, 404, 'Not Found')
      return
    }
    let base: URL
    try {
      base = new URL(target)
    } catch {
      this.sendText(res, 502, 'Bad Gateway')
      return
    }
    const upstreamPath = pathname === '/' || pathname === '/remote.html' ? '/remote.html' : pathname
    let search = ''
    try {
      search = new URL(req.url ?? '/', 'http://x').search
    } catch {
      search = ''
    }
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    for (const name of ['accept', 'accept-language', 'if-none-match', 'if-modified-since', 'user-agent']) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const upstream = http.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        path: upstreamPath + search,
        method,
        headers
      },
      (up) => {
        res.statusCode = up.statusCode ?? 502
        for (const [key, value] of Object.entries(up.headers)) {
          if (value === undefined) continue
          const lower = key.toLowerCase()
          if (HOP_BY_HOP.has(lower) || lower.startsWith('proxy-')) continue
          res.setHeader(key, value)
        }
        this.baseHeaders(res)
        up.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (res.headersSent) res.destroy()
      else this.sendText(res, 502, 'Bad Gateway')
    })
    upstream.end()
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isLanAddress(req.socket.remoteAddress)) {
      socket.destroy()
      return
    }
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (pathname !== REMOTE_WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    const token = parseWsTokenFromProtocols(req.headers['sec-websocket-protocol'])
    if (!token || !tokensEqual(token, this.deps.getToken())) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    this.wss?.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit('connection', ws, req)
    })
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws)
    this.deps.onClientsChanged?.(this.clients.size)
    ws.on('message', (data) => this.handleMessage(ws, data))
    ws.on('close', () => this.removeClient(ws))
    ws.on('error', () => this.removeClient(ws))
    this.sendTo(ws, { channel: 'remote:heartbeat', payload: { t: Date.now() } })
  }

  private removeClient(ws: WebSocket): void {
    if (this.clients.delete(ws)) {
      this.deps.onClientsChanged?.(this.clients.size)
    }
  }

  private handleMessage(ws: WebSocket, data: unknown): void {
    let valid = false
    try {
      const text = typeof data === 'string' ? data : String(data)
      const parsed = JSON.parse(text) as unknown
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as { type?: unknown }).type === 'ping' &&
        typeof (parsed as { t?: unknown }).t === 'number'
      ) {
        this.sendTo(ws, {
          channel: 'remote:pong',
          payload: { t: (parsed as { t: number }).t }
        })
        valid = true
      }
    } catch {
      valid = false
    }
    if (valid) return
    const count = (this.invalid.get(ws) ?? 0) + 1
    this.invalid.set(ws, count)
    if (count >= MAX_INVALID) ws.terminate()
  }

  private sendTo(ws: WebSocket, msg: RemoteWsMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(msg))
  }
}
