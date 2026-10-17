/** Minimal WebSocket surface the connection engine depends on (browser WebSocket or a test double). */
export interface WebSocketLike {
  readyState: number // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
  send(data: string): void
  close(): void
}

/** Minimal fetch response surface used by the connection engine. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

/** Ambient browser capabilities, injected so the engine is testable in plain node. */
export interface RemoteEnv {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(id: unknown): void
  createWebSocket(url: string, protocols: string[]): WebSocketLike
  fetch(
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal }
  ): Promise<FetchResponseLike>
  storage: {
    getItem(k: string): string | null
    setItem(k: string, v: string): void
    removeItem(k: string): void
  }
  location: { hash: string; protocol: string; host: string; pathname: string; search: string }
  replaceUrl(url: string): void
  isVisible(): boolean
  /** Fires on visibilitychange, pageshow, focus and online (passes the current visibility). Returns unsubscribe. */
  onVisibility(cb: (visible: boolean) => void): () => void
  onHashChange(cb: () => void): () => void
}

/** Reconnect backoff steps (ms) before the cap applies. */
export const BACKOFF_MS = [500, 1000, 2000] as const
/** Longest reconnect backoff step (ms). */
export const BACKOFF_CAP_MS = 5000
/** Consecutive failed attempts before the connection is declared unreachable. */
export const UNREACHABLE_AFTER = 6
/** Max time a WebSocket handshake may take before it is aborted (ms). */
export const CONNECT_TIMEOUT_MS = 4000
/** Max time a buffer/session fetch may take before it is aborted (ms). */
export const FETCH_TIMEOUT_MS = 4000
/** No heartbeat/pong within this window means the socket is stale (ms). */
export const HEARTBEAT_STALE_MS = 15000
/** Max time to wait for a pong after sending a ping (ms). */
export const PING_TIMEOUT_MS = 1000
/** Hidden-this-long before coming back forces a fresh connection (ms). */
export const FORCE_RECONNECT_AFTER_HIDDEN_MS = 3000
/** Delay before the transient "reconnecting…" pill appears (ms). */
export const PILL_DELAY_MS = 400

/** failures ≥ 1: 500, 1000, 2000, then 5000 forever. */
export function backoffDelayMs(failures: number): number {
  const idx = Math.max(0, Math.floor(failures) - 1)
  return idx < BACKOFF_MS.length ? BACKOFF_MS[idx] : BACKOFF_CAP_MS
}

/** Real browser environment. Only touches globals when called. */
export function browserEnv(): RemoteEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    createWebSocket: (u, p) => new WebSocket(u, p) as unknown as WebSocketLike,
    fetch: (u, init) => fetch(u, { ...init, cache: 'no-store' }),
    storage: {
      getItem(k) {
        try {
          return localStorage.getItem(k)
        } catch {
          // Safari private mode can throw on access.
          return null
        }
      },
      setItem(k, v) {
        try {
          localStorage.setItem(k, v)
        } catch {
          // ignore quota/private-mode failures
        }
      },
      removeItem(k) {
        try {
          localStorage.removeItem(k)
        } catch {
          // ignore quota/private-mode failures
        }
      }
    },
    // Getters so `hash` (and friends) always reflect the current URL.
    location: {
      get hash() {
        return window.location.hash
      },
      get protocol() {
        return window.location.protocol
      },
      get host() {
        return window.location.host
      },
      get pathname() {
        return window.location.pathname
      },
      get search() {
        return window.location.search
      }
    },
    replaceUrl: (u) => history.replaceState(null, '', u),
    isVisible: () => document.visibilityState === 'visible',
    onVisibility: (cb) => {
      const handler = (): void => cb(document.visibilityState === 'visible')
      document.addEventListener('visibilitychange', handler)
      window.addEventListener('pageshow', handler)
      window.addEventListener('focus', handler)
      window.addEventListener('online', handler)
      return () => {
        document.removeEventListener('visibilitychange', handler)
        window.removeEventListener('pageshow', handler)
        window.removeEventListener('focus', handler)
        window.removeEventListener('online', handler)
      }
    },
    onHashChange: (cb) => {
      const handler = (): void => cb()
      window.addEventListener('hashchange', handler)
      return () => window.removeEventListener('hashchange', handler)
    }
  }
}
