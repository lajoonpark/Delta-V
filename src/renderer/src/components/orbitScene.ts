/**
 * Orbit-view 3D mount (three.js/WebGL): the solar system seen at a lazy
 * elevation — a glowing sun, faint orbit ellipses (real Keplerian ellipses,
 * not circles), and one seeded planet per repo spinning and drifting along
 * its orbit. The camera mirrors `CAM` from orbitLayout exactly, so the DOM
 * callouts can project screen positions without the renderer.
 *
 * The camera is animatable: `cameraMove()` dollies the real camera into (or
 * out of) a planet until it fills an exact screen rect — the match-move that
 * carries the orbit → stage transition (see art/cameraDolly.ts). During a
 * move the focused planet's orbit freezes (its spin keeps going), the sun,
 * orbit lines and the other planets fade away, and the lights drift toward
 * the lander stage's recipe so the handoff lands without a lighting pop.
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
import {
  easeInOut,
  frameOf,
  lerp,
  lerpFrame,
  solveFocusCamera,
  type Frame
} from '@renderer/art/cameraDolly'
import { hashSeed, mulberry32 } from '@renderer/art/planetGen'

export interface OrbitSceneOptions {
  canvas: HTMLCanvasElement
  width: number
  height: number
  bodies: OrbitBody[]
  reducedMotion: boolean
}

export interface CameraMoveSpec {
  /** Planet to lock onto (its live world position tracks every frame). */
  tileId: string
  /** Desired framing in canvas pixels — re-read live, so resizes re-solve. */
  getTarget: () => Frame
  /** 'dive': home pose → target. 'rise': target → home pose. */
  mode: 'dive' | 'rise'
  durationMs: number
  /** Fires exactly once when the move completes, is skipped, or aborts. */
  onDone?: () => void
}

export interface OrbitSceneHandle {
  /** Resize + re-sync body params. Drift angles survive across body objects. */
  update(width: number, height: number, bodies: OrbitBody[]): void
  setVisible(mask: Record<string, boolean>): void
  /** Finish the reveal instantly (skippable entrance). */
  skip(): void
  /** Run the camera dolly; replaces any move still in flight. */
  cameraMove(spec: CameraMoveSpec): void
  /** Jump to the end pose of the current move (fires its onDone once). */
  skipMove(): void
  /** Live spin phase of a body (rad) — for the stage handoff. */
  spinPhase(tileId: string): number | null
  /** Seed a body's spin phase (rad) — so the rise starts on the stage's phase. */
  setSpinPhase(tileId: string, rotationY: number): void
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
const ELEV = (CAM.elevationDeg * Math.PI) / 180
/** The lander stage's camera + lights (see landerScene.ts) — matched at handoff. */
const STAGE_FOV = 45
const STAGE_KEY_DIR = new THREE.Vector3(-4, 3, 6)
const ORBIT_SUN_INTENSITY = 2.4
const ORBIT_AMBIENT_INTENSITY = 1.35
const STAGE_AMBIENT_INTENSITY = 1.6
/** Fraction of the move over which the chrome (sun/lines/planets) dissolves. */
const CHROME_FADE = 0.35
/** Fraction of the move over which the lights settle into the stage recipe. */
const LIGHT_MIX = 0.35

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

  // Sun-lighted system: a warm key at the origin (no falloff — outer planets
  // stay lit, art over physics) over the stage's bluish ambient floor. A
  // directional key matching the lander stage is mixed in as a dive lands, so
  // the terminator the stage shows is the one the camera arrives on.
  const sunLight = new THREE.PointLight(0xfff1e0, ORBIT_SUN_INTENSITY, 0, 0)
  scene.add(sunLight)
  const ambient = new THREE.AmbientLight(0x2a3442, ORBIT_AMBIENT_INTENSITY)
  scene.add(ambient)
  const keyLight = new THREE.DirectionalLight(0xfff1e0, 0)
  keyLight.position.copy(STAGE_KEY_DIR)
  scene.add(keyLight)

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

  // ── Camera dolly (match-move into/out of a planet) ─────────────────────
  let move: (CameraMoveSpec & { startedAt: number; finished: boolean }) | null = null

  const finishMove = (): void => {
    if (!move || move.finished) return
    move.finished = true
    const onDone = move.onDone
    move = null
    onDone?.()
  }

  const moveFocus = (now: number): { focus: number; t: number } => {
    if (!move) return { focus: 0, t: 0 }
    const t =
      move.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (now - move.startedAt) / move.durationMs))
    // focus = 1 at the framed pose, 0 at the home pose.
    const focus = move.mode === 'dive' ? easeInOut(t) : easeInOut(1 - t)
    return { focus, t }
  }

  const homePose = (): { cx: number; cy: number; cz: number } => {
    const [cx, cy, cz] = cameraPosition(Math.max(2, width), Math.max(2, height))
    return { cx, cy, cz }
  }

  const applyCameraPose = (mv: typeof move, focus: number): void => {
    const w = Math.max(2, width)
    const h = Math.max(2, height)
    // Pitch from the orbit elevation (home) toward the stage's head-on view.
    const theta = -ELEV * (1 - focus)
    const fov = lerp(CAM.fovDeg, STAGE_FOV, focus)
    const focused = mv ? actors.get(mv.tileId) : null
    const home = homePose()
    if (!focused || !mv) {
      camera.position.set(home.cx, home.cy, home.cz)
      camera.rotation.set(-ELEV, 0, 0)
      camera.fov = CAM.fovDeg
      camera.updateProjectionMatrix()
      return
    }
    const [wx, wz] = orbitPoint(focused.a, focused.ecc, focused.peri, focused.meanAnomaly)
    const planet = { x: wx, y: 0, z: wz }
    // The planet rides a straight line in screen space from wherever the home
    // camera frames it to the target rect — exact at both ends, smooth between.
    const homeFrame = frameOf(
      { position: { x: home.cx, y: home.cy, z: home.cz }, theta: -ELEV, fovDeg: CAM.fovDeg },
      w,
      h,
      planet,
      focused.radius
    )
    const target = lerpFrame(homeFrame, mv.getTarget(), focus)
    const pose = solveFocusCamera({
      width: w,
      height: h,
      planet,
      planetRadius: focused.radius,
      target,
      theta,
      fovDeg: fov
    })
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    camera.rotation.set(pose.theta, 0, 0)
    camera.fov = pose.fovDeg
    camera.updateProjectionMatrix()
  }

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

    const { focus, t } = moveFocus(now)
    if (move && !actors.has(move.tileId)) {
      // The focused repo left the scan mid-dolly — land on the end state.
      finishMove()
    }
    applyCameraPose(move, move ? focus : 0)

    // Chrome dissolves early in a dive / reveals late in a rise.
    const chrome = move
      ? move.mode === 'dive'
        ? 1 - Math.min(1, t / CHROME_FADE)
        : Math.max(0, (t - CHROME_FADE) / (1 - CHROME_FADE))
      : 1
    const mix = move ? Math.min(1, Math.max(0, (focus - (1 - LIGHT_MIX)) / LIGHT_MIX)) : 0
    sunLight.intensity = ORBIT_SUN_INTENSITY * (1 - mix)
    keyLight.intensity = ORBIT_SUN_INTENSITY * mix
    ambient.intensity = lerp(ORBIT_AMBIENT_INTENSITY, STAGE_AMBIENT_INTENSITY, mix)
    ;(sunSprite.material as THREE.SpriteMaterial).opacity = chrome
    for (const line of orbitLines.values()) {
      ;(line.material as THREE.LineBasicMaterial).opacity = 0.38 * chrome
    }

    let i = 0
    for (const b of bodies) {
      const actor = actors.get(b.tile.id)
      if (!actor) continue
      const isFocus = move?.tileId === b.tile.id
      // A locked-on planet keeps spinning but stops sliding along its orbit.
      const drift = isFocus ? 1 - focus : 1
      if (!reducedMotion) {
        // Keplerian drift: mean anomaly advances at the orbit's own rate, so
        // planets sweep faster near perihelion and inner ones lapping outer.
        actor.meanAnomaly += actor.meanMotion * dt * drift
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
      const s = actor.radius * (0.2 + 0.8 * e) * (isFocus ? 1 : chrome)
      actor.group.scale.setScalar(s)
      const want = visibleMask[b.tile.id] === false ? 0 : 1
      actor.group.visible = want > 0 && s > 0.001
    }

    renderer.render(scene, camera)
    // The move is done once playback reaches the end — land it and report once.
    if (move && t >= 1) finishMove()
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
      syncBodies(nextBodies)
    },
    setVisible(mask) {
      visibleMask = mask
    },
    skip() {
      revealDone = true
    },
    cameraMove(spec) {
      if (move && !move.finished) {
        move.finished = true
        move.onDone?.()
      }
      move = { ...spec, startedAt: performance.now(), finished: false }
      if (spec.durationMs <= 0) finishMove()
    },
    skipMove() {
      // Land on the end state and report done exactly once.
      finishMove()
    },
    spinPhase(tileId) {
      return actors.get(tileId)?.spinMesh.rotation.y ?? null
    },
    setSpinPhase(tileId, rotationY) {
      const actor = actors.get(tileId)
      if (actor) actor.spinMesh.rotation.y = rotationY
    },
    dispose() {
      disposed = true
      if (move && !move.finished) {
        move.finished = true
        move.onDone?.()
      }
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
