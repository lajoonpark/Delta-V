/**
 * Orbit-view 3D mount (three.js/WebGL): the solar system seen at a lazy
 * elevation — a glowing sun, faint orbit ellipses (real Keplerian ellipses,
 * not circles), and one seeded planet per repo spinning and drifting along
 * its orbit. The camera mirrors `CAM` from orbitLayout exactly, so the DOM
 * callouts can project screen positions without the renderer.
 *
 * Art stays owned by the 2D generators — planets are `buildPlanet` groups over
 * the shared equirect surface; lighting does the day/night terminator.
 */
import * as THREE from 'three'
import { buildPlanet } from '@renderer/art/planet3d'
import {
  cameraPosition,
  CAM,
  SUN_RADIUS,
  SUN_GLOW,
  RING_AT_LAUNCHES,
  orbitPoint,
  type OrbitBody
} from '@renderer/art/orbitLayout'
import { hashSeed, mulberry32 } from '@renderer/art/planetGen'

export interface OrbitSceneOptions {
  canvas: HTMLCanvasElement
  width: number
  height: number
  bodies: OrbitBody[]
  reducedMotion: boolean
}

export interface OrbitSceneHandle {
  /** Resize + re-sync body params. Drift angles survive across body objects. */
  update(width: number, height: number, bodies: OrbitBody[]): void
  setVisible(mask: Record<string, boolean>): void
  /** Finish the reveal instantly (skippable entrance). */
  skip(): void
  dispose(): void
}

interface BodyActor {
  tileId: string
  /** Live mean anomaly — the body's position along its orbit. */
  meanAnomaly: number
  meanMotion: number
  a: number
  ecc: number
  peri: number
  spinPeriod: number
  radius: number
  group: THREE.Group
  spinMesh: THREE.Mesh
  dispose(): void
}

const REVEAL_STAGGER = 0.09
const REVEAL_MS = 700
/** World-space sun glow sprite radius (kept inside the innermost orbit). */
const GLOW_RADIUS = SUN_RADIUS * SUN_GLOW

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 4)
}

function glowTexture(): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,236,196,1)')
    g.addColorStop(0.3, 'rgba(255,196,120,1)')
    g.addColorStop(0.42, 'rgba(255,160,80,0.5)')
    g.addColorStop(0.62, 'rgba(255,138,61,0.16)')
    g.addColorStop(1, 'rgba(255,138,61,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function mountOrbitScene(opts: OrbitSceneOptions): OrbitSceneHandle {
  const { canvas, reducedMotion } = opts
  let width = opts.width
  let height = opts.height

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setClearColor(0x090b10, 1)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAM.fovDeg, 1, 0.1, 400)
  const applyCamera = (): void => {
    const [cx, cy, cz] = cameraPosition(Math.max(2, width), Math.max(2, height))
    camera.position.set(cx, cy, cz)
    camera.lookAt(CAM.targetX, CAM.targetY, CAM.targetZ)
  }
  applyCamera()

  // Sun-lighted system: a warm key at the origin (no falloff — outer planets
  // stay lit, art over physics) over the stage's bluish ambient floor.
  const sunLight = new THREE.PointLight(0xfff1e0, 2.4, 0, 0)
  scene.add(sunLight)
  scene.add(new THREE.AmbientLight(0x2a3442, 1.35))

  // Sun — a soft glowing orb sprite at the origin (drives the point light).
  const glowTex = glowTexture()
  const sunSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false
    })
  )
  sunSprite.scale.setScalar(GLOW_RADIUS * 2)
  scene.add(sunSprite)

  // Starfield — deterministic, quiet chrome (all color stays on the planets).
  {
    const rnd = mulberry32(hashSeed('deltav:stars'))
    const count = 320
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (rnd() - 0.5) * 220
      pos[i * 3 + 1] = (rnd() - 0.5) * 90
      pos[i * 3 + 2] = (rnd() - 0.5) * 220
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mat = new THREE.PointsMaterial({
      color: 0xede7da,
      size: 0.45,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    })
    scene.add(new THREE.Points(geo, mat))
  }

  // Orbit ring lines — one thin hairline ellipse per distinct ring (solid,
  // like the reference composition; the JPL dashes live on the callouts where
  // they read clearly). Co-orbital bodies share elements, so one line per ring
  // matches every planet on it.
  const orbitLines = new Map<string, THREE.Line>()
  let orbitKey = ''
  const buildOrbitLine = (a: number, ecc: number, peri: number): THREE.Line => {
    const segs = 200
    const pts: number[] = []
    for (let i = 0; i <= segs; i++) {
      const [x, z] = orbitPoint(a, ecc, peri, (i / segs) * Math.PI * 2)
      pts.push(x, 0, z)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0x44526a,
      transparent: true,
      opacity: 0.38
    })
    const line = new THREE.Line(geo, mat)
    scene.add(line)
    return line
  }
  const clearOrbitLines = (): void => {
    for (const line of orbitLines.values()) {
      scene.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    orbitLines.clear()
  }

  // Bodies — keyed by tile id so drift angles survive layout object swaps.
  const actors = new Map<string, BodyActor>()
  let bodies: OrbitBody[] = []

  const syncBodies = (next: OrbitBody[]): void => {
    const seen = new Set<string>()
    for (const b of next) {
      seen.add(b.tile.id)
      let actor = actors.get(b.tile.id)
      if (!actor) {
        const built = buildPlanet(b.tile.name, b.tile.openCount >= RING_AT_LAUNCHES)
        actor = {
          tileId: b.tile.id,
          meanAnomaly: b.meanAnomaly,
          meanMotion: b.meanMotion,
          a: b.a,
          ecc: b.ecc,
          peri: b.peri,
          spinPeriod: b.spinPeriod,
          radius: b.radius,
          group: built.group,
          spinMesh: built.spinMesh,
          dispose: built.dispose
        }
        scene.add(actor.group)
        actors.set(b.tile.id, actor)
      } else {
        actor.meanMotion = b.meanMotion
        actor.a = b.a
        actor.ecc = b.ecc
        actor.peri = b.peri
        actor.spinPeriod = b.spinPeriod
        actor.radius = b.radius
      }
      // Keep the layout object live for the DOM projection loop.
      b.meanAnomaly = actor.meanAnomaly
    }
    for (const [id, actor] of [...actors]) {
      if (!seen.has(id)) {
        scene.remove(actor.group)
        actor.dispose()
        actors.delete(id)
      }
    }
    bodies = next

    // Orbit lines track the current ring set.
    const keys = new Set(
      bodies.map((b) => `${b.a.toFixed(3)}:${b.ecc.toFixed(3)}:${b.peri.toFixed(3)}`)
    )
    const key = [...keys].sort().join('|')
    if (key !== orbitKey) {
      orbitKey = key
      clearOrbitLines()
      for (const b of bodies) {
        const k = `${b.a.toFixed(3)}:${b.ecc.toFixed(3)}:${b.peri.toFixed(3)}`
        if (!orbitLines.has(k)) orbitLines.set(k, buildOrbitLine(b.a, b.ecc, b.peri))
      }
    }
  }
  syncBodies(opts.bodies)

  let visibleMask: Record<string, boolean> = {}
  let revealStart = performance.now()
  let revealDone = reducedMotion
  let disposed = false
  let lastT = 0

  const applySize = (): void => {
    renderer.setSize(width, height, false)
    camera.aspect = Math.max(2, width) / Math.max(2, height)
    camera.updateProjectionMatrix()
    sunSprite.scale.setScalar(GLOW_RADIUS * 2)
  }
  applySize()

  const frame = (now: number): void => {
    if (disposed) return
    requestAnimationFrame(frame)
    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016)
    lastT = now
    const elapsed = (now - revealStart) / 1000

    let i = 0
    for (const b of bodies) {
      const actor = actors.get(b.tile.id)
      if (!actor) continue
      if (!reducedMotion) {
        // Keplerian drift: mean anomaly advances at the orbit's own rate, so
        // planets sweep faster near perihelion and inner ones lapping outer.
        actor.meanAnomaly += actor.meanMotion * dt
        actor.spinMesh.rotation.y += dt * ((Math.PI * 2) / actor.spinPeriod)
      }
      b.meanAnomaly = actor.meanAnomaly
      const [wx, wz] = orbitPoint(actor.a, actor.ecc, actor.peri, actor.meanAnomaly)
      actor.group.position.set(wx, 0, wz)

      // Staggered reveal: planets pop up from nothing on their own beat.
      const local = revealDone
        ? 1
        : Math.max(0, Math.min(1, (elapsed - i * REVEAL_STAGGER) / (REVEAL_MS / 1000)))
      i++
      const e = easeOut(local)
      const s = actor.radius * (0.2 + 0.8 * e)
      actor.group.scale.setScalar(s)
      const want = visibleMask[b.tile.id] === false ? 0 : 1
      actor.group.visible = want > 0 && s > 0.001
    }

    renderer.render(scene, camera)
  }
  requestAnimationFrame((t) => {
    lastT = t
    frame(t)
  })

  return {
    update(nextWidth, nextHeight, nextBodies) {
      width = nextWidth
      height = nextHeight
      applySize()
      applyCamera()
      syncBodies(nextBodies)
    },
    setVisible(mask) {
      visibleMask = mask
    },
    skip() {
      revealDone = true
    },
    dispose() {
      disposed = true
      for (const actor of actors.values()) {
        scene.remove(actor.group)
        actor.dispose()
      }
      actors.clear()
      clearOrbitLines()
      glowTex.dispose()
      ;(sunSprite.material as THREE.Material).dispose()
      renderer.dispose()
    }
  }
}
