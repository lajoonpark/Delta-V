/**
 * Orbit-view layout for the 3D solar system: world-space placement of repo
 * "planets" on Keplerian ellipses around a sun at the origin, plus the shared
 * pinhole camera the three.js scene mirrors, so screen-space callout geometry
 * (JPL schematic leader lines) can be computed without the renderer.
 *
 * Deterministic — same inputs produce the same opening picture. Bodies then
 * drift along their orbits and spin in place (see orbitScene.ts): the scene
 * owns the live mean anomaly, `orbitPoint()` maps orbit elements + anomaly to
 * a world position, and `solveCallouts()` re-slots the live label plates every
 * frame so plates never collide and leader lines never sweep across the
 * system the way they did when the label column was fixed at layout time.
 */
import type { RepoTile } from '@shared/types'
import { hashSeed } from './planetGen'

/** Ring is earned at 50 launches (mirrors MiniPlanet.RING_AT_LAUNCHES). */
export const RING_AT_LAUNCHES = 50

// ── Shared camera (the scene builds its THREE camera from these) ──────────
// Looking down at the orbital plane (XZ, sun at origin) at a lazy elevation so
// orbits read as tilted ellipses with real depth (front passes below, back
// above), with the look-target pushed left of the sun so the sun sits right of
// center — the reference composition. The base distance is fitted to the
// viewport by `cameraDistance()` so the outer orbit always lands between the
// callout columns, never under a label plate or off-frame.
export const CAM = {
  fovDeg: 38,
  elevationDeg: 40,
  /** Base distance at the reference viewport; see `cameraDistance()`. */
  distance: 150,
  targetX: -11,
  targetY: 0,
  targetZ: 0
}

export const SUN_RADIUS = 4.6
/** Sun glow sprite radius as a multiple of SUN_RADIUS (kept inside ORBIT_INNER). */
export const SUN_GLOW = 2.5
export const ORBIT_INNER = 19
export const ORBIT_OUTER = 44
/** Envelope radius used when fitting the camera: the outermost aphelion
 *  (ORBIT_OUTER × 1.10) plus a hair of margin. */
const ORBIT_FIT = ORBIT_OUTER * 1.12
/** Fraction of the width the sun sits right of the center line. */
const SUN_BIAS = 0.04
/**
 * Half the callout plate's box height (px). The layout keeps plates — and the
 * outer orbit — clear of the HUD chrome using the same estimate the renderer
 * lays out (two HUD text lines plus padding and border).
 */
export const PLATE_HALF_H = 17
/** One revolution: innermost ≈ 8 min, outermost ≈ 28 min (Keplerian-ish). */
const PERIOD_BASE_SEC = 480
const PERIOD_EXPONENT = 1.4

const ELEV = (CAM.elevationDeg * Math.PI) / 180
const TAN_HALF = Math.tan((CAM.fovDeg * Math.PI) / 360)
const TWO_PI = Math.PI * 2

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Width of one callout label column (plates hang off the outer edges). */
export function calloutColumnWidth(width: number): number {
  return clamp(width * 0.2, 150, 260)
}

/**
 * Vertical band (px) that plates — and the outer orbit — stay inside: clear of
 * the DELTA-V title above and the HUD hint bars below.
 */
export function plateBand(height: number): { top: number; bottom: number } {
  const h = Math.max(2, height)
  return {
    top: clamp(h * 0.08, 48, 72) + PLATE_HALF_H,
    bottom: h - (clamp(h * 0.062, 38, 56) + PLATE_HALF_H)
  }
}

/** Project a world point at an explicit camera distance (fit helper). */
function projectAt(
  w: number,
  h: number,
  dist: number,
  px: number,
  py: number,
  pz: number
): { x: number; y: number } {
  const s = Math.sin(ELEV)
  const c = Math.cos(ELEV)
  const dx = px - CAM.targetX
  const dy = py - dist * s
  const dz = pz - dist * c
  const depth = -dy * s - dz * c
  const vx = dx
  const vy = dy * c - dz * s
  const aspect = w / h
  return {
    x: w / 2 + (vx / Math.max(1e-3, depth) / TAN_HALF / aspect) * (w / 2),
    y: h / 2 - (vy / Math.max(1e-3, depth) / TAN_HALF) * (h / 2)
  }
}

/** Projected bounding box of a circle of `r` around the origin. */
function ringBBox(
  w: number,
  h: number,
  dist: number,
  r: number
): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < 128; i++) {
    const a = (i / 128) * Math.PI * 2
    const p = projectAt(w, h, dist, Math.cos(a) * r, 0, Math.sin(a) * r)
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, maxX, minY, maxY }
}

/**
 * Camera distance fitted so the outer orbit's projected ellipse stays inside
 * the safe area between the callout columns (and clear of the HUD chrome),
 * whatever the window size. The outer orbit is measured through the real
 * projection — perspective magnifies the near half of an orbit, so a formula
 * would guess wrong — and the distance is binary-searched to the largest
 * system that still fits on every side.
 */
export function cameraDistance(width: number, height: number): number {
  const w = Math.max(2, width)
  const h = Math.max(2, height)
  const key = w + 'x' + h
  if (key === fitKey) return fitValue

  const col = calloutColumnWidth(w)
  const band = plateBand(h)
  const sunX = w / 2 + w * SUN_BIAS
  const loX = col + 8
  const hiX = w - col - 8
  const leftRoom = Math.max(120, sunX - loX)
  const rightRoom = Math.max(120, hiX - sunX)

  const fits = (d: number): boolean => {
    const b = ringBBox(w, h, d, ORBIT_FIT)
    return (
      b.minX >= sunX - leftRoom - 0.5 &&
      b.maxX <= sunX + rightRoom + 0.5 &&
      b.minY >= band.top - 0.5 &&
      b.maxY <= band.bottom + 0.5
    )
  }
  // Larger distance = smaller system = always fits; find the smallest that does.
  let lo = 60
  let hi = 460
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) hi = mid
    else lo = mid
  }
  fitKey = key
  fitValue = hi
  return hi
}

let fitKey = ''
let fitValue = 150

/** Camera position derived from the look target + elevation + fitted distance. */
export function cameraPosition(width: number, height: number): [number, number, number] {
  const d = cameraDistance(width, height)
  return [
    CAM.targetX,
    CAM.targetY + d * Math.sin(ELEV),
    CAM.targetZ + d * Math.cos(ELEV)
  ]
}

export interface Projection {
  x: number
  y: number
  /** Depth from the camera (world units) — larger is farther. */
  depth: number
  /** World unit → screen px at this depth (for radii). */
  scale: number
}

/** Project a world point into content-box pixels (y-down). */
export function projectPoint(
  width: number,
  height: number,
  px: number,
  py: number,
  pz: number
): Projection {
  const w = Math.max(2, width)
  const h = Math.max(2, height)
  const [cx0, cy0, cz0] = cameraPosition(w, h)
  const dx = px - cx0
  const dy = py - cy0
  const dz = pz - cz0
  // View basis: forward looks at the target from above; right stays +X.
  const s = Math.sin(ELEV)
  const c = Math.cos(ELEV)
  const depth = -dy * s - dz * c
  const vx = dx
  const vy = dy * c - dz * s
  const aspect = w / h
  const ndcY = vy / Math.max(1e-3, depth) / TAN_HALF
  const ndcX = vx / Math.max(1e-3, depth) / TAN_HALF / aspect
  return {
    x: w / 2 + (ndcX * w) / 2,
    y: h / 2 - (ndcY * h) / 2,
    depth,
    scale: h / 2 / TAN_HALF / Math.max(1e-3, depth)
  }
}

/** Planet radius in world units — growth-scaled like the sidebar. */
export function orbitPlanetRadius(openCount: number): number {
  return 1.0 + orbitGrowth(openCount) * 1.2
}

// ── Kepler helpers ────────────────────────────────────────────────────────

/** Wrap an angle to [-π, π] so Kepler's equation converges fast. */
function wrapPi(a: number): number {
  let x = (a + Math.PI) % TWO_PI
  if (x < 0) x += TWO_PI
  return x - Math.PI
}

/**
 * World position on an orbit: elements (semi-major `a`, eccentricity `ecc`,
 * longitude of perihelion `peri`) at mean anomaly `M`. Kepler's equation is
 * solved by Newton iteration (4 passes is exact at these eccentricities).
 */
export function orbitPoint(
  a: number,
  ecc: number,
  peri: number,
  M: number
): [number, number] {
  const m = wrapPi(M)
  let e = m
  for (let i = 0; i < 4; i++) {
    e -= (e - ecc * Math.sin(e) - m) / (1 - ecc * Math.cos(e))
  }
  const x = a * (Math.cos(e) - ecc)
  const z = a * Math.sqrt(1 - ecc * ecc) * Math.sin(e)
  const cp = Math.cos(peri)
  const sp = Math.sin(peri)
  return [x * cp - z * sp, x * sp + z * cp]
}

/** Angular speed (rad/s) for a semi-major axis — inner planets swing faster. */
export function orbitMeanMotion(a: number): number {
  return TWO_PI / (PERIOD_BASE_SEC * Math.pow(a / ORBIT_INNER, PERIOD_EXPONENT))
}

/** Orbital period in seconds (display/debug). */
export function orbitPeriodSec(a: number): number {
  return PERIOD_BASE_SEC * Math.pow(a / ORBIT_INNER, PERIOD_EXPONENT)
}

// ── Bodies ────────────────────────────────────────────────────────────────

export interface OrbitBody {
  tile: RepoTile
  /** Orbit elements (world units). Co-orbital bodies share them. */
  a: number
  ecc: number
  peri: number
  /** Angular speed (rad/s) from Kepler's third law. */
  meanMotion: number
  spinPeriod: number
  radius: number
  /** Live mean anomaly — advanced by the scene, read back for projection. */
  meanAnomaly: number
  /** Live projected center (px) + projected radius (px). */
  cx: number
  cy: number
  r: number
  /** Distance rank for the callout plate (1 = innermost). */
  au: number
  /** Label side: the column the plate hangs in (solved live). */
  side: 'left' | 'right'
  /** False when the callout columns are full — the planet stays clickable. */
  hasPlate: boolean
  /** Sort rank by distance from the center line (0 = most central). Central
   *  planets are the cheapest to re-aim when a column fills up. */
  platePriority: number
  /** Leader line: live planet rim → fixed knee → fixed end tick. */
  startX: number
  startY: number
  kneeX: number
  kneeY: number
  endX: number
  endY: number
  /** Label box anchor: x of the label's inner edge + alignment. */
  labelX: number
  align: 'left' | 'right'
  /** Smoothed leader-line fade (1 = full, lower near the sun / off-frame). */
  leaderOpacity: number
  /** Smoothed label-plate fade (blinks when the plate changes columns). */
  labelOpacity: number
}

export interface OrbitLayout {
  width: number
  height: number
  /** Projected sun center (px) + projected radius (px). */
  sunX: number
  sunY: number
  sunR: number
  /** Orbit rings (world units), innermost first — one per body on that ring. */
  rings: { a: number; ecc: number; peri: number }[]
  bodies: OrbitBody[]
}

/** Log-scaled growth 0..1 from the open counter (same curve as the sidebar). */
export function orbitGrowth(openCount: number): number {
  return Math.min(1, Math.log1p(Math.max(0, openCount)) / Math.log1p(150))
}

/** How many bodies share each ring before a new one is opened. */
function ringCountFor(n: number): number {
  if (n <= 3) return Math.max(1, n)
  return Math.min(6, Math.max(4, Math.ceil(n / 3.2)))
}

export function layoutOrbit(tiles: RepoTile[], width: number, height: number): OrbitLayout {
  const w = Math.max(2, width)
  const h = Math.max(2, height)
  const n = tiles.length

  // Planets share a handful of orbit rings — a real solar system reads as a
  // few clean ellipses, not one ring per repo. Log-spread inner → outer so
  // every ring clears the sun's glow and its neighbours on screen.
  const ringCount = ringCountFor(n)
  const rings: { a: number; ecc: number; peri: number }[] = []
  for (let k = 0; k < ringCount; k++) {
    const t = ringCount === 1 ? 0.35 : k / (ringCount - 1)
    const a = ORBIT_INNER * Math.pow(ORBIT_OUTER / ORBIT_INNER, t)
    rings.push({
      a,
      // A touch of eccentricity: orbits bunch at perihelion and stretch at
      // aphelion — the tell that says "orbiting", not "rotating on a disc".
      ecc: 0.04 + ((hashSeed('ecc:' + k) % 1000) / 1000) * 0.06,
      peri: ((hashSeed('peri:' + k) % 1000) / 1000) * TWO_PI
    })
  }

  // Even phase spread per ring: co-orbital planets can never clump, and with
  // shared elements they sweep their ring like beads, compressing at
  // perihelion and opening up at aphelion.
  const perRing = new Array(ringCount).fill(0)
  for (let i = 0; i < n; i++) perRing[i % ringCount]++

  const bodies: OrbitBody[] = tiles.map((tile, i) => {
    const ringIndex = i % ringCount
    const ring = rings[ringIndex]
    const slot = perRing[ringIndex] === 1 ? 0.25 : (i / ringCount) / perRing[ringIndex]
    const jitter = ((hashSeed('phase:' + tile.id) % 1000) / 1000 - 0.5) * 0.22
    const meanAnomaly = wrapPi(slot * TWO_PI + jitter)

    const radius = orbitPlanetRadius(tile.openCount)
    const [wx, wz] = orbitPoint(ring.a, ring.ecc, ring.peri, meanAnomaly)
    const proj = projectPoint(w, h, wx, 0, wz)

    return {
      tile,
      a: ring.a,
      ecc: ring.ecc,
      peri: ring.peri,
      meanMotion: orbitMeanMotion(ring.a),
      spinPeriod: 65 + (hashSeed('spin:' + tile.id) % 45),
      radius,
      meanAnomaly,
      cx: proj.x,
      cy: proj.y,
      r: radius * proj.scale,
      au: ring.a / ORBIT_INNER,
      side: proj.x < w / 2 ? 'left' : 'right',
      hasPlate: true,
      platePriority: 0,
      startX: proj.x,
      startY: proj.y,
      kneeX: proj.x,
      kneeY: proj.y,
      endX: proj.x,
      endY: proj.y,
      labelX: 0,
      align: proj.x < w / 2 ? 'right' : 'left',
      leaderOpacity: 1,
      labelOpacity: 1
    }
  })

  // Plate priority: rank by how far a planet sits from the center line. When a
  // callout column fills up, the most central planets are the cheapest to
  // re-aim into the other column, so they are asked first.
  const ranked = [...bodies].sort(
    (a, b) => Math.abs(a.cx - w / 2) - Math.abs(b.cx - w / 2)
  )
  ranked.forEach((b, i) => {
    b.platePriority = i
  })

  const sun = projectPoint(w, h, 0, 0, 0)
  solveCallouts(bodies, w, h, new Map(), 0, { x: sun.x, y: sun.y, r: SUN_RADIUS * sun.scale })

  return {
    width: w,
    height: h,
    sunX: sun.x,
    sunY: sun.y,
    sunR: SUN_RADIUS * sun.scale,
    rings,
    bodies
  }
}

// ── Live callouts ─────────────────────────────────────────────────────────
// Solved every frame from each planet's live screen position:
//
//  1. Column assignment. Each plate goes in the column on its planet's side
//     of the center line, so leaders stay short. A column can only hold so
//     many plates; when one fills, the most central planets (the cheapest to
//     re-aim) are nudged to the other column, and beyond a hard capacity some
//     planets go unlabelled — their planets stay clickable and name themselves
//     on hover, which beats plates that sweep across the system or pile up.
//  2. Slot solving. Each column's plates are re-slotted with a minimal-
//     displacement separation pass, so they never collide and stay near their
//     planet's height.
//  3. Smoothing. Plates ease toward their slot and the eased positions are
//     then re-separated, so plates flow around each other on reorder instead
//     of passing through each other.

export interface CalloutSmooth {
  side: 'left' | 'right'
  labelY: number
  opacity: number
  labelFade: number
}

/** Per-plate spacing (px) and leader geometry constants. */
const PLATE_GAP_MIN = 38
const PLATE_GAP_MAX = 48
const RUN_MIN = 34
const RUN_MAX = 54
/** Ease time constants (s) for slot + fade smoothing. */
const SLOT_TAU = 0.16
const FADE_TAU = 0.12
/** Angle the leader leaves the planet's rim (rad off the axis). */
const EXIT_ANGLE = 0.5

/**
 * Separate a column of plate heights with minimal displacement: push apart to
 * the minimum gap (both directions, iterated) then shift the whole column back
 * inside the safe band. `ys` is ordered top → bottom and separated in place.
 */
function separateColumn(ys: number[], gap: number, padTop: number, padBottom: number, h: number): void {
  const n = ys.length
  if (n < 2) {
    if (n === 1) ys[0] = clamp(ys[0], padTop, h - padBottom)
    return
  }
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 1; i < n; i++) if (ys[i] < ys[i - 1] + gap) ys[i] = ys[i - 1] + gap
    for (let i = n - 2; i >= 0; i--) if (ys[i] > ys[i + 1] - gap) ys[i] = ys[i + 1] - gap
  }
  const overTop = padTop - ys[0]
  if (overTop > 0) for (let i = 0; i < n; i++) ys[i] += overTop
  const overBottom = ys[n - 1] - (h - padBottom)
  if (overBottom > 0) for (let i = 0; i < n; i++) ys[i] -= overBottom
}

/**
 * Solve callout geometry for `bodies` (which must already carry live `cx`,
 * `cy` and `r`). `smooth` persists per-tile state across frames; `dt` is the
 * frame delta in seconds (0 = snap, used for the initial layout).
 */
export function solveCallouts(
  bodies: OrbitBody[],
  width: number,
  height: number,
  smooth: Map<string, CalloutSmooth>,
  dt: number,
  sun: { x: number; y: number; r: number }
): void {
  const w = Math.max(2, width)
  const h = Math.max(2, height)
  if (bodies.length === 0) return

  const labelCol = calloutColumnWidth(w)
  const gap = clamp(h * 0.048, PLATE_GAP_MIN, PLATE_GAP_MAX)
  // Column limits: clear of the DELTA-V title (top-left) and the HUD bars.
  const padTop = clamp(h * 0.08, 48, 72)
  const padBottom = clamp(h * 0.062, 38, 56)
  const available = h - padTop - padBottom
  const run = clamp(labelCol * 0.22, RUN_MIN, RUN_MAX)
  const ease = dt > 0 ? Math.min(1, dt / SLOT_TAU) : 1
  const fadeEase = dt > 0 ? Math.min(1, dt / FADE_TAU) : 1

  // Per-tile smoothing state, seeded from the deterministic layout solve so
  // re-mounting the view (or a newly scanned repo) never slides plates around.
  const states = new Map<string, CalloutSmooth>()
  for (const b of bodies) {
    let st = smooth.get(b.tile.id)
    if (!st) {
      st = { side: b.side, labelY: b.endY, opacity: b.leaderOpacity, labelFade: b.labelOpacity }
      smooth.set(b.tile.id, st)
    }
    states.set(b.tile.id, st)
  }

  // ── 1. Column assignment (capacity aware, cheapest re-aims first) ──
  const cap = Math.max(1, Math.floor(available / gap))
  const order = [...bodies].sort((a, b) => a.platePriority - b.platePriority)
  const counts = { left: 0, right: 0 }
  for (const b of order) {
    const natural: 'left' | 'right' = b.cx < w / 2 ? 'left' : 'right'
    const other: 'left' | 'right' = natural === 'left' ? 'right' : 'left'
    const side = counts[natural] < cap ? natural : counts[other] < cap ? other : null
    b.hasPlate = side !== null
    if (side) {
      b.side = side
      b.align = side === 'right' ? 'left' : 'right'
      b.labelX = side === 'right' ? w - labelCol : labelCol
      b.endX = side === 'right' ? b.labelX - 14 : b.labelX + 14
      counts[side]++
    }
  }
  const plated = bodies.filter((b) => b.hasPlate)

  // ── 2. Target slots per column, then ease + re-separate the live positions ──
  for (const side of ['left', 'right'] as const) {
    const group = plated.filter((b) => b.side === side)
    const n = group.length
    if (n === 0) continue

    // Targets: each plate at its planet's height, separated minimally.
    const targets = group.map((b) => b.cy).sort((a, b) => a - b)
    if (n * gap > available) {
      // Safety net (capacity normally prevents this): even distribution.
      const step = available / (n - 1 || 1)
      for (let i = 0; i < n; i++) targets[i] = padTop + i * step
    } else {
      separateColumn(targets, gap, padTop, padBottom, h)
    }

    // Live positions: ease toward the target, then re-separate so reordering
    // plates flow around each other rather than passing through. The
    // separation runs over the plates' *current* heights (sorted, so the array
    // is monotonic) and its result is eased in too: snapping straight to a
    // freshly separated column made a plate jump a whole slot in a single frame
    // whenever two planets crossed and swapped slot order — the label flicker.
    const sorted = [...group].sort((a, b) => a.cy - b.cy)
    for (let i = 0; i < n; i++) {
      const st = states.get(sorted[i].tile.id) as CalloutSmooth
      st.labelY += (targets[i] - st.labelY) * ease
    }
    const pairs = sorted.map((b) => ({ b, st: states.get(b.tile.id) as CalloutSmooth }))
    pairs.sort((p, q) => p.st.labelY - q.st.labelY)
    const live = pairs.map((p) => p.st.labelY)
    separateColumn(live, gap, padTop, padBottom, h)
    for (let i = 0; i < n; i++) {
      const { b, st } = pairs[i]
      st.labelY += (live[i] - st.labelY) * ease
      b.endY = st.labelY
    }
  }

  // ── 3. Leader lines + fades ──
  const pad = 8
  for (const b of plated) {
    const st = states.get(b.tile.id) as CalloutSmooth

    // Leave the rim toward the column (horizontally) and toward the plate
    // (vertically), so the leader never doubles back over its own planet.
    const hx = b.labelX >= b.cx ? 1 : -1
    const vy = b.endY >= b.cy ? 1 : -1
    b.startX = b.cx + hx * Math.cos(EXIT_ANGLE) * b.r
    b.startY = b.cy + vy * Math.sin(EXIT_ANGLE) * b.r
    b.kneeX = b.side === 'right' ? b.endX - run : b.endX + run
    b.kneeY = b.endY

    // Clamp the leader's far end to the frame if a planet has drifted (or a
    // window resize pushed it) out of view.
    const offX = b.startX < pad || b.startX > w - pad
    const offY = b.startY < pad || b.startY > h - pad
    if (offX || offY) {
      b.startX = clamp(b.startX, pad, w - pad)
      b.startY = clamp(b.startY, pad, h - pad)
    }

    // Calm the sun's neighbourhood: leaders fade while a planet crosses the
    // glow, plates dim for planets outside the frame, and a plate that has to
    // change columns blinks out and back in instead of flying across.
    if (st.side !== b.side) {
      st.side = b.side
      st.opacity = 0
      st.labelFade = 0
    }
    const dx = b.cx - sun.x
    const dy = b.cy - sun.y
    const nearSun = Math.sqrt(dx * dx + dy * dy) < sun.r * 1.05 + b.r + 10
    const offscreen = offX || offY
    const target = offscreen ? 0.3 : nearSun ? 0.25 : 1
    st.opacity += (target - st.opacity) * fadeEase
    b.leaderOpacity = st.opacity
    const labelTarget = offscreen ? 0.45 : nearSun ? 0.75 : 1
    st.labelFade += (labelTarget - st.labelFade) * fadeEase
    b.labelOpacity = st.labelFade
  }
}
