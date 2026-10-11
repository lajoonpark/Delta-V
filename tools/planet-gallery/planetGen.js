// Procedural planet generator: deterministic artwork from a seed string (repo name).
// Plain script (no modules) so the gallery works over file://. Port by adding exports.
;(function (global) {
  'use strict'

  function hashSeed(str) {
    let h = 2166136261 >>> 0
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }

  function mulberry32(a) {
    return function () {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function hsl(h, s, l, a) {
    return (
      'hsla(' +
      Math.round(h) + ',' +
      Math.round(s * 100) + '%,' +
      Math.round(l * 100) + '%,' +
      (a == null ? 1 : a) +
      ')'
    )
  }

  // Shared color recipe: one ramp per seed, used by planets and landers.
  function colorRamp(seed, opts) {
    opts = opts || {}
    const rnd = mulberry32(hashSeed(seed))
    const baseHue = rnd() * 360
    const spread = 25 + rnd() * 35
    const sat = opts.sat != null ? opts.sat : 0.45 + rnd() * 0.2

    const scale = []
    for (let i = 0; i < 4; i++) {
      const t = i / 3
      scale.push({
        h: (baseHue + (t - 0.5) * spread + 360) % 360,
        s: sat * (1 - t * 0.12),
        l: 0.3 + t * 0.4
      })
    }
    return { rnd, baseHue, spread, sat, scale }
  }

  // Recipe, in unit space (0..1 across the planet diameter).
  function planetSpec(seed, opts) {
    opts = opts || {}
    const { rnd, baseHue, scale } = colorRamp(seed, opts)

    const bandCount = opts.bands != null ? opts.bands : 2 + Math.floor(rnd() * 3)
    const bandYs = []
    for (let i = 1; i < bandCount; i++) {
      bandYs.push((i + (rnd() - 0.5) * 0.5) / bandCount)
    }

    const blobCount = opts.blobs != null ? opts.blobs : 1 + Math.floor(rnd() * 3)
    const blobs = []
    for (let i = 0; i < blobCount; i++) {
      const cx = 0.18 + rnd() * 0.64
      const cy = 0.18 + rnd() * 0.64
      const r = 0.1 + rnd() * 0.16
      const n = 7 + Math.floor(rnd() * 4)
      const pts = []
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2
        const rad = r * (0.55 + rnd() * 0.75)
        pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad * 0.82])
      }
      blobs.push({ pts, tone: Math.floor(rnd() * scale.length) })
    }

    const streakCount = opts.streaks != null ? opts.streaks : Math.floor(rnd() * 3)
    const streaks = []
    for (let i = 0; i < streakCount; i++) {
      // Each streak owns a latitude slot so clouds never bunch in one spot.
      const slotH = 0.62 / Math.max(1, streakCount)
      const y = 0.19 + (i + 0.15 + rnd() * 0.7) * slotH
      streaks.push({
        x: 0.15 + rnd() * 0.7,
        y,
        w: 0.16 + rnd() * 0.26,
        h: 0.045 + rnd() * 0.05,
        angle: (rnd() - 0.5) * 0.6
      })
    }

    return {
      seed,
      baseHue,
      scale,
      bandYs,
      blobs,
      streaks,
      ring: opts.ring != null ? opts.ring : rnd() < (opts.ringChance != null ? opts.ringChance : 0.35),
      ringAngle: -0.35 + rnd() * 0.7,
      glossAngle: -0.3 + rnd() * 0.35
    }
  }

  function blobPath(ctx, pts, cx, cy, R) {
    const p = pts.map(([x, y]) => [cx + (x - 0.5) * 2 * R, cy + (y - 0.5) * 2 * R])
    ctx.beginPath()
    ctx.moveTo((p[0][0] + p[p.length - 1][0]) / 2, (p[0][1] + p[p.length - 1][1]) / 2)
    for (let i = 0; i < p.length; i++) {
      const cur = p[i]
      const next = p[(i + 1) % p.length]
      ctx.quadraticCurveTo(cur[0], cur[1], (cur[0] + next[0]) / 2, (cur[1] + next[1]) / 2)
    }
    ctx.closePath()
  }

  function drawRing(ctx, spec, cx, cy, R, front) {
    const tone = spec.scale[2]
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(spec.ringAngle)
    ctx.beginPath()
    ctx.ellipse(0, 0, R * 1.5, R * 0.4, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2)
    ctx.lineWidth = Math.max(1, R * 0.14)
    ctx.strokeStyle = hsl(tone.h, tone.s, front ? tone.l + 0.12 : tone.l, 0.9)
    ctx.stroke()
    ctx.restore()
  }

  function drawPlanet(canvas, seed, opts) {
    const ctx = canvas.getContext('2d')
    const size = canvas.width
    const spec = planetSpec(seed, opts)
    const cx = size / 2
    const cy = size / 2
    const R = size / 2 - 1
    const detail = size >= 56
    const tiny = size < 32

    ctx.clearRect(0, 0, size, size)

    if (spec.ring && !tiny) drawRing(ctx, spec, cx, cy, R, false)

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.clip()

    const ramp = spec.scale
    ctx.fillStyle = hsl(ramp[1].h, ramp[1].s, ramp[1].l)
    ctx.fillRect(0, 0, size, size)

    const bounds = [0].concat(spec.bandYs).concat([1])
    for (let i = 0; i < bounds.length - 1; i++) {
      const t0 = bounds[i]
      const t1 = bounds[i + 1]
      const yTop = cy + (t0 - 0.5) * 2 * R
      const yBot = cy + (t1 - 0.5) * 2 * R
      const wave = (i % 2 === 0 ? 1 : -1) * R * 0.06
      const tone = ramp[Math.min(ramp.length - 1, Math.floor(((t0 + t1) / 2) * ramp.length))]
      ctx.fillStyle = hsl(tone.h, tone.s, tone.l)
      ctx.beginPath()
      ctx.moveTo(cx - R * 1.1, yTop)
      ctx.quadraticCurveTo(cx, yTop + wave, cx + R * 1.1, yTop)
      ctx.lineTo(cx + R * 1.1, yBot)
      ctx.quadraticCurveTo(cx, yBot + wave, cx - R * 1.1, yBot)
      ctx.closePath()
      ctx.fill()
    }

    for (const blob of spec.blobs) {
      const tone = ramp[blob.tone]
      ctx.fillStyle = hsl(tone.h, tone.s, tone.l + 0.06)
      blobPath(ctx, blob.pts, cx, cy, R)
      ctx.fill()
    }

    if (detail) {
      const cloud = hsl(spec.baseHue, spec.scale[2].s * 0.35, 0.92, 0.85)
      for (const st of spec.streaks) {
        ctx.save()
        ctx.translate(cx + (st.x - 0.5) * 2 * R, cy + (st.y - 0.5) * 2 * R)
        ctx.rotate(st.angle)
        ctx.fillStyle = cloud
        const w = st.w * 2 * R
        const h = Math.max(1.5, st.h * 2 * R)
        ctx.beginPath()
        ctx.roundRect(-w / 2, -h / 2, w, h, h / 2)
        ctx.fill()
        if (st.w > 0.28) {
          ctx.beginPath()
          ctx.roundRect(-w * 0.18, -h * 1.6, w * 0.42, h, h / 2)
          ctx.fill()
        }
        ctx.restore()
      }
    }

    const shade = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.45, R * 0.15, cx, cy, R * 1.35)
    shade.addColorStop(0, 'rgba(255,255,255,0.12)')
    shade.addColorStop(0.55, 'rgba(0,0,0,0)')
    shade.addColorStop(1, 'rgba(4,6,12,0.5)')
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, size, size)

    if (!tiny) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(spec.glossAngle)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      const w = R * 0.34
      const h = Math.max(2, R * 0.11)
      ctx.beginPath()
      ctx.roundRect(-R * 0.42, -R * 0.58, w, h, h / 2)
      ctx.fill()
      ctx.restore()
    }

    ctx.restore()

    if (spec.ring && !tiny) drawRing(ctx, spec, cx, cy, R, true)

    if (!tiny) {
      ctx.beginPath()
      ctx.arc(cx, cy, R - 0.5, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  global.PlanetGen = { hashSeed, mulberry32, hsl, colorRamp, planetSpec, drawPlanet }
})(window)
