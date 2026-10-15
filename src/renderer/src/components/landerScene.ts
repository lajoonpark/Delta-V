/**
 * Lander-stage 3D mount (three.js/WebGL): the chosen planet spins at left,
 * seeded landers fly up from it into their layout slots.
 *
 * Art stays owned by the 2D generators — this module only projects them:
 * the planet's equirect surface is the shared `getPlanetEquirect` texture
 * (same seed → same ramp/bands/blobs/streaks as the gallery and the orbit
 * view), landers are `renderLander` sprites. Termini/gloss come from scene
 * lighting, never baked in.
 */
import * as THREE from 'three'
import {
  colorRamp,
  getPlanetEquirect,
  hashSeed,
  hsl,
  mulberry32,
  planetSpec
} from '@renderer/art/planetGen'
import { renderLander } from '@renderer/art/landerGen'
import type { LanderStageLayout } from '@renderer/art/landerLayout'

export interface LanderSceneOptions {
  canvas: HTMLCanvasElement
  layout: LanderStageLayout
  planetSeed: string
  /** Milestone ring (earned at 50 launches, like everywhere else). */
  ring: boolean
  landerSeeds: string[]
  durationMs: number
  reducedMotion: boolean
}

export interface LanderSceneHandle {
  update(layout: LanderStageLayout): void
  setSelection(index: number): void
  setVisible(mask: boolean[]): void
  skip(): void
  dispose(): void
}

const CAM_Z = 10
const FOV = 45

function landerTexture(seed: string): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) renderLander(ctx, size, seed)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Damped settle (stands in for cubic-bezier(0.16, 1, 0.3, 1)). */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 4)
}

export function mountLanderScene(opts: LanderSceneOptions): LanderSceneHandle {
  const { canvas, planetSeed, ring, landerSeeds, reducedMotion } = opts
  let layout = opts.layout
  const durationMs = reducedMotion ? 0 : Math.max(0, opts.durationMs)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setClearColor(0x090b10, 1)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
  camera.position.z = CAM_Z

  scene.add(new THREE.AmbientLight(0x2a3442, 1.6))
  const key = new THREE.DirectionalLight(0xfff1e0, 2.4)
  key.position.set(-4, 3, 6)
  scene.add(key)

  // Starfield — deterministic, quiet chrome (all color stays on planets/landers).
  {
    const rnd = mulberry32(hashSeed('deltav:stars'))
    const count = 280
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rnd() - 0.5) * 26
      pos[i * 3 + 1] = (rnd() - 0.5) * 16
      pos[i * 3 + 2] = -4 - rnd() * 18
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({
      color: 0xede7da,
      size: 0.055,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    })
    scene.add(new THREE.Points(geo, mat))
  }

  // Planet
  const planetGroup = new THREE.Group()
  planetGroup.rotation.z = 0.1
  scene.add(planetGroup)

  const planetTex = new THREE.CanvasTexture(getPlanetEquirect(planetSeed))
  planetTex.colorSpace = THREE.SRGBColorSpace
  planetTex.wrapS = THREE.RepeatWrapping
  const planetMat = new THREE.MeshStandardMaterial({ map: planetTex, roughness: 0.92 })
  const planetMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), planetMat)
  planetGroup.add(planetMesh)

  let ringMesh: THREE.Mesh | null = null
  if (ring) {
    const tone = colorRamp(planetSeed).scale[2]
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(hsl(tone.h, tone.s, tone.l + 0.1)),
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    })
    ringMesh = new THREE.Mesh(new THREE.RingGeometry(1.38, 1.92, 96), ringMat)
    ringMesh.rotation.x = -Math.PI / 2 + 0.62
    ringMesh.rotation.z = planetSpec(planetSeed).ringAngle
    planetGroup.add(ringMesh)
  }

  // Landers — flat seeded sprites (art unchanged; lighting never touches them).
  const texCache = new Map<string, THREE.CanvasTexture>()
  const getTex = (seed: string): THREE.CanvasTexture => {
    let tex = texCache.get(seed)
    if (!tex) {
      tex = landerTexture(seed)
      texCache.set(seed, tex)
    }
    return tex
  }

  interface LanderSprite {
    sprite: THREE.Sprite
    mat: THREE.SpriteMaterial
    seed: string
    opacity: number
    scale: number
  }
  const sprites: LanderSprite[] = landerSeeds.map((seed) => {
    const mat = new THREE.SpriteMaterial({
      map: getTex(seed),
      transparent: true,
      depthWrite: false,
      opacity: 0
    })
    const sprite = new THREE.Sprite(mat)
    scene.add(sprite)
    return { sprite, mat, seed, opacity: 0, scale: 1 }
  })

  let selected = -1
  let visibleMask: boolean[] = sprites.map(() => true)
  let startedAt = performance.now()
  let progress = durationMs <= 0 ? 1 : 0
  let disposed = false

  const wpp = (): number => (2 * Math.tan((FOV * Math.PI) / 360) * CAM_Z) / Math.max(1, layout.height)
  const toWorld = (sx: number, sy: number): [number, number] => [
    (sx - layout.width / 2) * wpp(),
    (layout.height / 2 - sy) * wpp()
  ]

  const applySize = (): void => {
    renderer.setSize(layout.width, layout.height, false)
    camera.aspect = layout.width / Math.max(1, layout.height)
    camera.updateProjectionMatrix()
    const [px, py] = toWorld(layout.planet.x, layout.planet.y)
    planetGroup.position.set(px, py, 0)
    const r = layout.planet.radius * wpp()
    planetMesh.scale.setScalar(r)
    if (ringMesh) ringMesh.scale.setScalar(r)
  }

  let lastT = 0
  const frame = (now: number): void => {
    if (disposed) return
    requestAnimationFrame(frame)
    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016)
    lastT = now

    if (progress < 1) progress = Math.min(1, (now - startedAt) / Math.max(1, durationMs))
    if (!reducedMotion) planetMesh.rotation.y += dt * ((Math.PI * 2) / 40)

    const n = sprites.length
    const stag = n > 1 ? (1 - 0.62) / (n - 1) : 0
    for (let i = 0; i < n; i++) {
      const s = sprites[i]
      const slot = layout.slots[i]
      if (!slot) continue
      const local = durationMs <= 0 ? 1 : Math.max(0, Math.min(1, (progress - i * stag) / 0.62))
      const e = easeOut(local)

      // Fly up from the planet on a bowed arc into the slot.
      const [tx, ty] = toWorld(slot.x, slot.y)
      const [bx, by] = toWorld(layout.planet.x, layout.planet.y)
      const dx = tx - bx
      const dy = ty - by
      const startX = bx + dx * 0.35
      const startY = by + dy * 0.35
      const ctrlX = (startX + tx) / 2
      const ctrlY = (startY + ty) / 2 + Math.abs(dy) * 0.35 + 0.6
      const u = 1 - e
      const wx = u * u * startX + 2 * u * e * ctrlX + e * e * tx
      const wy = u * u * startY + 2 * u * e * ctrlY + e * e * ty
      s.sprite.position.set(wx, wy, 0)

      const want = visibleMask[i] ? (selected === i ? 1 : 0.86) : 0
      s.opacity += (want - s.opacity) * Math.min(1, dt * 10)
      s.scale += ((selected === i ? 1.12 : 1) - s.scale) * Math.min(1, dt * 10)
      const base = slot.size * wpp()
      s.sprite.scale.setScalar(base * (0.35 + 0.65 * e) * s.scale)
      s.mat.opacity = s.opacity * Math.min(1, local * 3)
    }
    renderer.render(scene, camera)
  }

  applySize()
  requestAnimationFrame((t) => {
    lastT = t
    frame(t)
  })

  return {
    update(next) {
      layout = next
      applySize()
    },
    setSelection(index) {
      selected = index
    },
    setVisible(mask) {
      visibleMask = mask
    },
    skip() {
      progress = 1
    },
    dispose() {
      disposed = true
      planetTex.dispose()
      planetMat.dispose()
      planetMesh.geometry.dispose()
      if (ringMesh) {
        ringMesh.geometry.dispose()
        ;(ringMesh.material as THREE.Material).dispose()
      }
      for (const s of sprites) {
        s.mat.dispose()
        s.sprite.geometry.dispose()
      }
      for (const tex of texCache.values()) tex.dispose()
      renderer.dispose()
    }
  }
}
