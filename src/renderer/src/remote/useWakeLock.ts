import { useSyncExternalStore } from 'react'
import NoSleep from 'nosleep.js'

export type WakeMethod = 'native' | 'video' | 'none'

export interface WakeLockInfo {
  method: WakeMethod
  enabled: boolean
  active: boolean
  needsTap: boolean
}

// Module-level store so the toggle survives navigating between list and view.
let state: WakeLockInfo = { method: 'none', enabled: false, active: false, needsTap: false }
let initialized = false
const listeners = new Set<() => void>()
let noSleep: NoSleep | null = null
let sentinel: WakeLockSentinel | null = null
let bound = false

function detectMethod(): WakeMethod {
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && navigator.wakeLock) {
    return 'native'
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return 'video'
  }
  return 'none'
}

function ensureInit(): void {
  if (initialized) return
  initialized = true
  state = { ...state, method: detectMethod() }
}

function notify(): void {
  listeners.forEach((l) => l())
}

function patch(next: Partial<WakeLockInfo>): void {
  const merged = { ...state, ...next }
  if (
    merged.method === state.method &&
    merged.enabled === state.enabled &&
    merged.active === state.active &&
    merged.needsTap === state.needsTap
  ) {
    return
  }
  state = merged
  notify()
}

async function acquire(): Promise<void> {
  if (state.method === 'native') {
    // Drop any previously held lock first so repeated visibilitychange
    // re-acquires can't leak multiple sentinels.
    if (sentinel) {
      const prev = sentinel
      sentinel = null
      prev.release().catch(() => undefined)
    }
    try {
      const lock = await navigator.wakeLock.request('screen')
      sentinel = lock
      lock.addEventListener('release', () => {
        if (sentinel === lock) {
          sentinel = null
          patch({ active: false })
        }
      })
      patch({ active: true, needsTap: false })
    } catch {
      // NotAllowedError (low battery, hidden tab…) — keep enabled, mark inactive.
      patch({ active: false })
    }
    return
  }
  if (state.method === 'video') {
    try {
      if (!noSleep) noSleep = new NoSleep()
      await noSleep.enable()
      patch({ active: true, needsTap: false })
    } catch {
      // Video play was blocked (needs a user gesture) — prompt for a tap.
      patch({ active: false, needsTap: true })
    }
  }
}

function release(): void {
  if (sentinel) {
    const lock = sentinel
    sentinel = null
    lock.release().catch(() => undefined)
  }
  if (noSleep) {
    try {
      noSleep.disable()
    } catch {
      // ignore
    }
  }
  patch({ active: false, needsTap: false })
}

function bindGlobal(): void {
  if (bound || typeof document === 'undefined') return
  bound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (state.enabled) void acquire()
  })
}

async function toggle(): Promise<void> {
  ensureInit()
  if (state.enabled) {
    // A tap can be the user gesture that unblocks the video fallback
    // (needsTap) or retries an acquire that failed (e.g. low battery). Treat
    // it as a re-acquire rather than a disable in those cases.
    if (state.needsTap || !state.active) {
      await acquire()
      return
    }
    release()
    patch({ enabled: false })
    return
  }
  patch({ enabled: true, needsTap: false })
  await acquire()
}

const subscribe = (listener: () => void): (() => void) => {
  ensureInit()
  bindGlobal()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): WakeLockInfo => {
  ensureInit()
  return state
}

export interface WakeLockState extends WakeLockInfo {
  toggle(): Promise<void>
}

/** Screen wake-lock store: native Wake Lock API where available, else nosleep.js. */
export function useWakeLock(): WakeLockState {
  const info = useSyncExternalStore(subscribe, getSnapshot)
  return { ...info, toggle }
}
