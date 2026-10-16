/**
 * Lander-stage layout: the chosen planet anchored at left, lander slots in the
 * right half, and ticked hairline leader-line callout geometry (JPL schematic,
 * same recipe as orbitLayout). Pure + deterministic — the 3D scene and the DOM
 * callouts both read from this one layout.
 */

export interface LanderSlot {
  /** Lander center + box size (px). */
  x: number
  y: number
  size: number
  /** Leader line: lander rim → knee → end tick. */
  startX: number
  startY: number
  kneeX: number
  kneeY: number
  endX: number
  endY: number
  /** Label box left edge (labels are left-aligned in the right column). */
  labelX: number
}

export interface LanderStageLayout {
  width: number
  height: number
  planet: { x: number; y: number; radius: number }
  /** Leader line from the planet's bottom rim straight down to the plate. */
  planetCallout: { startY: number; endY: number }
  /** Plate anchor under the planet (centered). */
  planetLabelY: number
  slots: LanderSlot[]
}

export function layoutLanderStage(
  count: number,
  width: number,
  height: number
): LanderStageLayout {
  const minDim = Math.min(width, height)
  const margin = 24

  const planetX = width * 0.235
  const planetY = height * 0.5
  const radius = Math.max(
    40,
    Math.min(minDim * 0.26, height * 0.34, planetX - width * 0.04)
  )

  // Callout geometry — same constants as the orbit view.
  const labelCol = Math.max(150, Math.min(260, width * 0.22))
  const labelX = width - labelCol
  const out = Math.max(22, minDim * 0.045)

  const size = Math.max(56, Math.min(132, minDim * 0.12))
  const top = height * 0.16
  const bottom = height * 0.84

  const slots: LanderSlot[] = []
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5
    const x = width * (0.475 + (i % 2) * 0.085)
    const y = top + t * (bottom - top)
    const startX = x + size * 0.32
    const startY = y - size * 0.1
    const endY = startY - out * 0.8
    slots.push({
      x,
      y,
      size,
      startX,
      startY,
      kneeX: startX + out,
      kneeY: endY,
      endX: labelX - 12,
      endY,
      labelX
    })
  }

  // De-overlap label heights so plates never collide (same recipe as orbitLayout).
  const gap = Math.max(30, minDim * 0.055)
  const group = [...slots].sort((a, b) => a.endY - b.endY)
  let prev = margin
  for (const s of group) {
    const y = Math.max(s.endY, prev)
    s.endY = y
    s.kneeY = y
    prev = y + gap
  }
  const overflow = prev - gap - (height - margin)
  if (overflow > 0) {
    for (const s of group) {
      s.endY -= overflow
      s.kneeY -= overflow
    }
  }

  const planetCallout = {
    startY: planetY + radius + 2,
    endY: planetY + radius + 30
  }

  return {
    width,
    height,
    planet: { x: planetX, y: planetY, radius },
    planetCallout,
    planetLabelY: planetCallout.endY + 14,
    slots
  }
}
