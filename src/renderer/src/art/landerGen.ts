/**
 * Procedural lander generator: same color recipe as the planets, simple vehicle shapes.
 * Typed port of tools/planet-gallery/landerGen.js — behavior is identical, so the
 * same seed renders the same artwork as the tuning gallery.
 */
import { colorRamp, hsl, type RampColor, type RampOptions } from './planetGen'

export interface LanderSpec {
  seed: string
  baseHue: number
  sat: number
  scale: RampColor[]
  antenna: boolean
  windowRound: boolean
  sidePanel: boolean
  exhaust: number
  legSpread: number
}

// Recipe, in unit space (0..1 across the canvas).
export function landerSpec(seed: string, opts: RampOptions = {}): LanderSpec {
  const { rnd, baseHue, sat, scale } = colorRamp(seed, opts)
  return {
    seed,
    baseHue,
    sat,
    scale,
    antenna: rnd() < 0.55,
    windowRound: rnd() < 0.5,
    sidePanel: rnd() < 0.6,
    exhaust: rnd() < 0.5 ? 2 : 0,
    legSpread: 0.08 + rnd() * 0.05
  }
}

/**
 * Draw into a context at a logical size. The context may already be scaled
 * (e.g. devicePixelRatio), so all geometry derives from `size`, not canvas
 * dimensions — including the tiny/detail tier cutoffs.
 */
export function renderLander(
  ctx: CanvasRenderingContext2D,
  size: number,
  seed: string,
  opts: RampOptions = {}
): void {
  const spec = landerSpec(seed, opts)
  const u = (v: number): number => v * size
  const ramp = spec.scale
  const tiny = size < 32
  const detail = size >= 56

  const dark = ramp[0]
  const mid = ramp[1]
  const light = ramp[2]

  ctx.clearRect(0, 0, size, size)

  // Legs and foot pads
  ctx.strokeStyle = hsl(dark.h, dark.s, dark.l)
  ctx.lineWidth = Math.max(1, u(0.045))
  ctx.lineCap = 'round'
  for (const side of [-1, 1]) {
    const footX = u(0.5 + side * (0.2 + spec.legSpread))
    ctx.beginPath()
    ctx.moveTo(u(0.5 + side * 0.18), u(0.6))
    ctx.lineTo(footX, u(0.82))
    ctx.stroke()
    ctx.fillStyle = hsl(dark.h, dark.s, dark.l + 0.06)
    ctx.beginPath()
    ctx.roundRect(footX - u(0.075), u(0.81), u(0.15), u(0.045), u(0.022))
    ctx.fill()
  }

  // Engine nozzle
  ctx.fillStyle = hsl(dark.h, dark.s, dark.l - 0.04)
  ctx.beginPath()
  ctx.moveTo(u(0.43), u(0.58))
  ctx.lineTo(u(0.57), u(0.58))
  ctx.lineTo(u(0.63), u(0.7))
  ctx.lineTo(u(0.37), u(0.7))
  ctx.closePath()
  ctx.fill()

  // Body
  ctx.fillStyle = hsl(mid.h, mid.s, mid.l)
  ctx.beginPath()
  ctx.roundRect(u(0.26), u(0.37), u(0.48), u(0.23), u(0.05))
  ctx.fill()

  if (spec.sidePanel) {
    ctx.fillStyle = hsl(dark.h, dark.s, dark.l + 0.05)
    ctx.beginPath()
    ctx.roundRect(u(0.58), u(0.41), u(0.11), u(0.13), u(0.03))
    ctx.fill()
  }

  // White pill accent — the same stroke of paint as the planet cloud streaks
  if (!tiny) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.beginPath()
    ctx.roundRect(u(0.31), u(0.41), u(0.13), u(0.032), u(0.016))
    ctx.fill()
  }

  // Dome
  ctx.fillStyle = hsl(light.h, light.s, light.l)
  ctx.beginPath()
  ctx.roundRect(u(0.36), u(0.17), u(0.28), u(0.21), [u(0.14), u(0.14), u(0.03), u(0.03)])
  ctx.fill()

  // Window
  ctx.fillStyle = hsl(spec.baseHue, spec.sat * 0.35, 0.93, 0.95)
  if (spec.windowRound) {
    ctx.beginPath()
    ctx.arc(u(0.5), u(0.28), u(0.052), 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.roundRect(u(0.42), u(0.25), u(0.16), u(0.055), u(0.027))
    ctx.fill()
  }

  // Antenna
  if (spec.antenna && !tiny) {
    ctx.strokeStyle = hsl(dark.h, dark.s, dark.l)
    ctx.lineWidth = Math.max(1, u(0.018))
    ctx.beginPath()
    ctx.moveTo(u(0.5), u(0.17))
    ctx.lineTo(u(0.5), u(0.09))
    ctx.stroke()
    ctx.fillStyle = hsl(light.h, light.s, light.l + 0.08)
    ctx.beginPath()
    ctx.arc(u(0.5), u(0.078), u(0.022), 0, Math.PI * 2)
    ctx.fill()
  }

  // Exhaust puffs echo the cloud-streak pills
  if (detail) {
    for (let i = 0; i < spec.exhaust; i++) {
      const w = u(0.16 - i * 0.05)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.beginPath()
      ctx.roundRect(u(0.5) - w / 2, u(0.735 + i * 0.06), w, u(0.03), u(0.015))
      ctx.fill()
    }
  }
}

/** Draw at the canvas's own pixel size (gallery behavior). */
export function drawLander(
  canvas: HTMLCanvasElement,
  seed: string,
  opts: RampOptions = {}
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  renderLander(ctx, canvas.width, seed, opts)
}
