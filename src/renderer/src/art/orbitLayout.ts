/**
 * Orbit-view layout: places repo "planets" on concentric orbit rings and
 * computes the ticked hairline leader-line callout geometry (JPL schematic)
 * for each one. Pure + deterministic — orbit radius is layout only (no
 * physics, no 3D). Same inputs always produce the same picture.
 */
import type { RepoTile } from '@shared/types'
import { hashSeed } from './planetGen'

/** Ring is earned at 50 launches (mirrors MiniPlanet.RING_AT_LAUNCHES). */
export const RING_AT_LAUNCHES = 50

/** Planet diameter band (px) — dramatic here; the sidebar stays small. */
const GROWTH_SATURATION = 150

export interface OrbitBody {
  tile: RepoTile
  /** Planet center + radius (px). */
  cx: number
  cy: number
  r: number
  /** Orbit ring index (0 = innermost). */
  ring: number
  /** Label side: the half of the view the planet sits in. */
  side: 'left' | 'right'
  /** Leader line: planet rim → knee → end tick. */
  startX: number
  startY: number
  kneeX: number
  kneeY: number
  endX: number
  endY: number
  /** Label box anchor: x of the label's inner edge + alignment. */
  labelX: number
  align: 'left' | 'right'
}

export interface OrbitLayout {
  width: number
  height: number
  sunX: number
  sunY: number
  /** Orbit ring radii (px), innermost first. */
  rings: number[]
  bodies: OrbitBody[]
}

/** Log-scaled growth 0..1 from the open counter (same curve as the sidebar). */
export function orbitGrowth(openCount: number): number {
  return Math.min(1, Math.log1p(Math.max(0, openCount)) / Math.log1p(GROWTH_SATURATION))
}

/** Planet diameter in px for the orbit view (dramatic, growth-scaled). */
export function orbitDiameter(openCount: number, minDim: number): number {
  const dMin = minDim * 0.055
  const dMax = minDim * 0.15
  return dMin + orbitGrowth(openCount) * (dMax - dMin)
}

export function layoutOrbit(tiles: RepoTile[], width: number, height: number): OrbitLayout {
  const sunX = width / 2
  const sunY = height / 2
  const minDim = Math.min(width, height)

  const n = tiles.length
  // Keep planets within a central disc so the edge columns stay free for labels.
  const ringOuter = Math.min(minDim * 0.34, width * 0.3)
  const ringInner = Math.min(minDim * 0.13, ringOuter * 0.5)
  const ringCount = n <= 1 ? 1 : Math.min(5, Math.max(2, Math.ceil(n / 4)))
  const rings: number[] = []
  for (let k = 0; k < ringCount; k++) {
    const t = ringCount === 1 ? 0 : k / (ringCount - 1)
    rings.push(ringInner + (ringOuter - ringInner) * t)
  }

  // Distribute planets round-robin over rings; even angular spacing within a
  // ring, with a seeded per-ring phase so rings never line up.
  const perRing: number[] = new Array(ringCount).fill(0)
  for (let i = 0; i < n; i++) perRing[i % ringCount]++
  const slotOn: number[] = new Array(ringCount).fill(0)

  const bodies: OrbitBody[] = tiles.map((tile, i) => {
    const ring = i % ringCount
    const count = perRing[ring]
    const slot = slotOn[ring]++
    const phase = (hashSeed('ring:' + ring) % 360) / 360 * Math.PI * 2
    const angle = phase + (slot / Math.max(1, count)) * Math.PI * 2
    const rr = rings[ring]
    const r = orbitDiameter(tile.openCount, minDim) / 2
    const cx = sunX + Math.cos(angle) * rr
    const cy = sunY + Math.sin(angle) * rr

    const side: 'left' | 'right' = cx < sunX ? 'left' : 'right'
    return {
      tile,
      cx,
      cy,
      r,
      ring,
      side,
      startX: cx,
      startY: cy,
      kneeX: cx,
      kneeY: cy,
      endX: cx,
      endY: cy,
      labelX: 0,
      align: side
    }
  })

  // ── Callout geometry ──────────────────────────────────────────────────
  const margin = 24
  const labelCol = Math.max(150, Math.min(260, width * 0.22))
  const out = 30 // short diagonal before the horizontal run

  for (const b of bodies) {
    const dir = b.side === 'right' ? 1 : -1
    // Leave the rim toward the label side, slightly above the equator.
    const exitAngle = b.side === 'right' ? -0.5 : Math.PI + 0.5
    b.startX = b.cx + Math.cos(exitAngle) * b.r
    b.startY = b.cy + Math.sin(exitAngle) * b.r
    b.kneeX = b.startX + dir * out

    if (b.side === 'right') {
      b.labelX = width - labelCol
      b.align = 'left'
      b.endX = b.labelX - 12
    } else {
      b.labelX = labelCol
      b.align = 'right'
      b.endX = b.labelX + 12
    }
    b.endY = b.startY - out * 0.8
    b.kneeY = b.endY
  }

  // De-overlap label heights per side so plates never collide.
  const gap = Math.max(30, minDim * 0.05)
  for (const side of ['left', 'right'] as const) {
    const group = bodies.filter((b) => b.side === side).sort((a, b) => a.endY - b.endY)
    let prev = margin
    for (const b of group) {
      const y = Math.max(b.endY, prev)
      b.endY = y
      b.kneeY = y
      prev = y + gap
    }
    // If the stack overflowed the bottom, shift the whole group up.
    const overflow = prev - gap - (height - margin)
    if (overflow > 0) {
      for (const b of group) {
        b.endY -= overflow
        b.kneeY -= overflow
      }
    }
  }

  return { width, height, sunX, sunY, rings, bodies }
}
