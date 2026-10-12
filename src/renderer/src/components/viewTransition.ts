/**
 * Cross-view transition primitives: the shared "flying planet" that carries
 * the eye between views, plus a viewport-coordinate rect registry for planets
 * that live in the DOM (sidebar mini-planets).
 *
 * All rects are viewport coordinates (top-left + diameter) so the flight can
 * bridge any two layers regardless of their positioning context.
 */
import { renderPlanet } from '@renderer/art/planetGen'

export interface PlanetRect {
  x: number
  y: number
  size: number
}

/** Damped settle, matching the lander scene's `1-(1-t)^4`. */
export function easeDamped(t: number): number {
  return 1 - Math.pow(1 - t, 4)
}

// ── DOM planet registry (sidebar mini-planets) ──────────────────────────

const domPlanets = new Map<string, HTMLElement>()

export function registerDomPlanet(id: string, el: HTMLElement | null): void {
  if (el) domPlanets.set(id, el)
  else domPlanets.delete(id)
}

export function domPlanetRect(id: string): PlanetRect | null {
  const el = domPlanets.get(id)
  if (!el || !el.isConnected) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0) return null
  return { x: r.left, y: r.top, size: r.width }
}

// ── Flying planet ───────────────────────────────────────────────────────

export interface FlightSpec {
  seed: string
  ring: boolean
  from: PlanetRect
  to: PlanetRect
  durationMs: number
}

export interface FlightHandle {
  /** Jump to the end state immediately. */
  skip(): void
  /** Resolves when the flight is finished or skipped. */
  finished: Promise<void>
}

/**
 * Runs the shared-element flight: one planet canvas glides from `from` to `to`
 * on the damped curve, fading out over the last stretch so the destination
 * view's own planet takes over at the same spot.
 */
export function runPlanetFlight(spec: FlightSpec): FlightHandle {
  const { seed, ring, from, to } = spec
  const durationMs = Math.max(0, spec.durationMs)

  let resolveDone: () => void = () => undefined
  const finished = new Promise<void>((r) => {
    resolveDone = r
  })

  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:60;overflow:hidden'
  const canvas = document.createElement('canvas')
  host.appendChild(canvas)
  document.body.appendChild(host)

  const maxSize = Math.max(from.size, to.size)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(maxSize * dpr)
  canvas.height = Math.round(maxSize * dpr)
  canvas.style.cssText = 'position:absolute;display:block'
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    renderPlanet(ctx, maxSize, seed, { ring })
  }

  let raf = 0
  let settled = false
  const startedAt = performance.now()

  const apply = (t: number): void => {
    const e = easeDamped(t)
    const size = from.size + (to.size - from.size) * e
    const x = from.x + (to.x - from.x) * e
    const y = from.y + (to.y - from.y) * e
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    canvas.style.left = `${x}px`
    canvas.style.top = `${y}px`
    canvas.style.opacity = t < 0.55 ? '1' : `${Math.max(0, 1 - (t - 0.55) / 0.45)}`
  }

  const finish = (): void => {
    if (settled) return
    settled = true
    cancelAnimationFrame(raf)
    host.remove()
    resolveDone()
  }

  const frame = (now: number): void => {
    if (settled) return
    const t = durationMs <= 0 ? 1 : Math.min(1, (now - startedAt) / durationMs)
    apply(t)
    if (t >= 1) finish()
    else raf = requestAnimationFrame(frame)
  }

  if (durationMs <= 0) {
    // Motion off: no flight at all — the end states are already on screen.
    finish()
  } else {
    apply(0)
    raf = requestAnimationFrame(frame)
  }

  return {
    skip() {
      apply(1)
      finish()
    },
    finished
  }
}

// ── Layer cross-fade styles ─────────────────────────────────────────────
// Keyframes `layer-in` / `layer-out` live in styles/index.css; each layer
// animates opacity + a damped scale around the transition's focal point.

const LAYER_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

export function layerEnterStyle(
  durationMs: number,
  fromScale: number,
  origin: PlanetRect
): React.CSSProperties {
  return {
    animation: `layer-in ${durationMs}ms ${LAYER_EASE} both`,
    transformOrigin: `${origin.x + origin.size / 2}px ${origin.y + origin.size / 2}px`,
    ['--layer-scale' as string]: String(fromScale)
  } as React.CSSProperties
}

export function layerExitStyle(
  durationMs: number,
  toScale: number,
  origin: PlanetRect
): React.CSSProperties {
  return {
    animation: `layer-out ${durationMs}ms ${LAYER_EASE} both`,
    transformOrigin: `${origin.x + origin.size / 2}px ${origin.y + origin.size / 2}px`,
    ['--layer-scale' as string]: String(toScale)
  } as React.CSSProperties
}
