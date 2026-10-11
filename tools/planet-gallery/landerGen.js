// Procedural lander generator: same color recipe as the planets, simple vehicle shapes.
// Plain script (no modules) so the gallery works over file://. Requires planetGen.js.
;(function (global) {
  'use strict'
  const P = global.PlanetGen

  // Recipe, in unit space (0..1 across the canvas).
  function landerSpec(seed, opts) {
    opts = opts || {}
    const { rnd, baseHue, sat, scale } = P.colorRamp(seed, opts)
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

  function drawLander(canvas, seed, opts) {
    const ctx = canvas.getContext('2d')
    const size = canvas.width
    const spec = landerSpec(seed, opts)
    const u = (v) => v * size
    const ramp = spec.scale
    const tiny = size < 32
    const detail = size >= 56

    const dark = ramp[0]
    const mid = ramp[1]
    const light = ramp[2]

    ctx.clearRect(0, 0, size, size)

    // Legs and foot pads
    ctx.strokeStyle = P.hsl(dark.h, dark.s, dark.l)
    ctx.lineWidth = Math.max(1, u(0.045))
    ctx.lineCap = 'round'
    for (const side of [-1, 1]) {
      const footX = u(0.5 + side * (0.2 + spec.legSpread))
      ctx.beginPath()
      ctx.moveTo(u(0.5 + side * 0.18), u(0.6))
      ctx.lineTo(footX, u(0.82))
      ctx.stroke()
      ctx.fillStyle = P.hsl(dark.h, dark.s, dark.l + 0.06)
      ctx.beginPath()
      ctx.roundRect(footX - u(0.075), u(0.81), u(0.15), u(0.045), u(0.022))
      ctx.fill()
    }

    // Engine nozzle
    ctx.fillStyle = P.hsl(dark.h, dark.s, dark.l - 0.04)
    ctx.beginPath()
    ctx.moveTo(u(0.43), u(0.58))
    ctx.lineTo(u(0.57), u(0.58))
    ctx.lineTo(u(0.63), u(0.7))
    ctx.lineTo(u(0.37), u(0.7))
    ctx.closePath()
    ctx.fill()

    // Body
    ctx.fillStyle = P.hsl(mid.h, mid.s, mid.l)
    ctx.beginPath()
    ctx.roundRect(u(0.26), u(0.37), u(0.48), u(0.23), u(0.05))
    ctx.fill()

    if (spec.sidePanel) {
      ctx.fillStyle = P.hsl(dark.h, dark.s, dark.l + 0.05)
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
    ctx.fillStyle = P.hsl(light.h, light.s, light.l)
    ctx.beginPath()
    ctx.roundRect(u(0.36), u(0.17), u(0.28), u(0.21), [u(0.14), u(0.14), u(0.03), u(0.03)])
    ctx.fill()

    // Window
    ctx.fillStyle = P.hsl(spec.baseHue, spec.sat * 0.35, 0.93, 0.95)
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
      ctx.strokeStyle = P.hsl(dark.h, dark.s, dark.l)
      ctx.lineWidth = Math.max(1, u(0.018))
      ctx.beginPath()
      ctx.moveTo(u(0.5), u(0.17))
      ctx.lineTo(u(0.5), u(0.09))
      ctx.stroke()
      ctx.fillStyle = P.hsl(light.h, light.s, light.l + 0.08)
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

  global.LanderGen = { landerSpec, drawLander }
})(window)
