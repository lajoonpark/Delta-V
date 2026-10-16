/**
 * Lander-stage 3D mount (three.js/WebGL): the chosen planet spins at left,
 * seeded landers fly up from it into their layout slots.
 *
 * The planet's equirect surface is the shared `getPlanetEquirect` texture
 * (same seed → same ramp/bands/blobs/streaks as the gallery and the orbit
 * view); landers are `buildLander` 3D meshes seeded from the same `colorRamp`.
 * Both are lit by the same scene lights. Termini/gloss come from scene
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
import { buildLander, type LanderBuild } from '@renderer/art/lander3d'
import type { LanderStageLayout } from '@renderer/art/landerLayout'
import { LAUNCH_DIVE_MS, solveLaunchStep } from '@renderer/art/cameraDolly'

export interface LanderSceneOptions {
  canvas: HTMLCanvasElement
  layout: LanderStageLayout
  planetSeed: string
  /** Milestone ring (earned at 50 launches, like everywhere else). */
  ring: boolean
  landerSeeds: string[]
  durationMs: number
  reducedMotion: boolean
  /** Initial planet spin (rad) — matched to the orbit scene at the handoff. */
  initialSpin?: number
}

export interface LanderSceneHandle {
  update(layout: LanderStageLayout): void
  setSelection(index: number): void
  setVisible(mask: boolean[]): void
  /** Live planet spin phase (rad) — for the reverse (stage → orbit) handoff. */
  spinPhase(): number
  /** Start the launch dive: planet centers, selected lander rises & crashes onto the surface, camera pushes in behind it. */
  startLaunch(selectedIndex: number, durationMs?: number): void
  /** Abort an in-flight launch dive and restore the resting stage pose. */
  abortLaunch(): void
  skip(): void
  dispose(): void
}

const CAM_Z = 10
const FOV = 45

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

  // Planet — same construction as `buildPlanet` (orbit view), so the two
  // scenes agree at the camera-dive handoff. In particular no roll: the orbit
  // planets are untilted, and a tilt here would pop the surface at the fade.
  const planetGroup = new THREE.Group()
  scene.add(planetGroup)

  const planetTex = new THREE.CanvasTexture(getPlanetEquirect(planetSeed))
  planetTex.colorSpace = THREE.SRGBColorSpace
  planetTex.wrapS = THREE.RepeatWrapping
  const planetMat = new THREE.MeshStandardMaterial({
    map: planetTex,
    roughness: 0.92,
    side: THREE.DoubleSide
  })
  const planetMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), planetMat)
  planetMesh.rotation.y = opts.initialSpin ?? 0
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

  // Landers — seeded 3D meshes sharing the planet's ramp, lit by the stage lights.
  interface LanderActor {
    built: LanderBuild
    seed: string
    opacity: number
    scale: number
    selectMix: number
    yaw: number
  }
  const landers: LanderActor[] = landerSeeds.map((seed) => {
    const built = buildLander(seed)
    built.setAppearance(0, 0)
    built.setThrust(0)
    built.group.rotation.y = built.restingYaw
    built.group.rotation.x = 0.08
    scene.add(built.group)
    return {
      built,
      seed,
      opacity: reducedMotion ? 1 : 0,
      scale: 1,
      selectMix: 0,
      yaw: built.restingYaw
    }
  })

  // Impact burst — a white-hot flash plus an expanding surface shock ring, fired
  // the instant the hero lander strikes the planet (`step.impact`). Additive and
  // depth-write-free, so it reads as light, not geometry.
  const burst = new THREE.Group()
  burst.visible = false
  scene.add(burst)
  const burstFlashMat = new THREE.MeshBasicMaterial({
    color: 0xfff2d8,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  const burstFlash = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), burstFlashMat)
  burst.add(burstFlash)
  const burstRingMat = new THREE.MeshBasicMaterial({
    color: 0xffab5e,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  })
  const burstRing = new THREE.Mesh(new THREE.RingGeometry(0.62, 1, 48), burstRingMat)
  burst.add(burstRing)

  let selected = -1
  let visibleMask: boolean[] = landers.map(() => true)
  let startedAt = performance.now()
  let progress = durationMs <= 0 ? 1 : 0
  let disposed = false

  const wpp = (): number => (2 * Math.tan((FOV * Math.PI) / 360) * CAM_Z) / Math.max(1, layout.height)
  const toWorld = (sx: number, sy: number): [number, number] => [
    (sx - layout.width / 2) * wpp(),
    (layout.height / 2 - sy) * wpp()
  ]

  let launchState: {
    selectedIndex: number
    startedAt: number
    durationMs: number
    hero: LanderBuild
  } | null = null

  const clearLaunchHero = (): void => {
    burst.visible = false
    if (!launchState) return
    scene.remove(launchState.hero.group)
    launchState.hero.dispose()
    launchState = null
  }

  const applySize = (): void => {
    renderer.setSize(layout.width, layout.height, false)
    camera.aspect = layout.width / Math.max(1, layout.height)
    camera.updateProjectionMatrix()
    if (!launchState) {
      const [px, py] = toWorld(layout.planet.x, layout.planet.y)
      planetGroup.position.set(px, py, 0)
      const r = layout.planet.radius * wpp()
      planetMesh.scale.setScalar(r)
      if (ringMesh) ringMesh.scale.setScalar(r)
      camera.position.set(0, 0, CAM_Z)
      camera.rotation.set(0, 0, 0)
    }
  }

  let lastT = 0
  const frame = (now: number): void => {
    if (disposed) return
    requestAnimationFrame(frame)

    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016)
    lastT = now
    if (!reducedMotion) planetMesh.rotation.y += dt * ((Math.PI * 2) / 40)

    if (launchState) {
      const launch = launchState
      const launchT = Math.min(
        1,
        Math.max(0, (now - launch.startedAt) / Math.max(1, launch.durationMs))
      )
      const slotSize =
        layout.slots[launch.selectedIndex]?.size ??
        Math.max(56, Math.min(132, Math.min(layout.width, layout.height) * 0.12))
      const heroBase = slotSize * wpp()
      const step = solveLaunchStep({
        width: layout.width,
        height: layout.height,
        planetScreen: layout.planet,
        t: launchT,
        camZ: CAM_Z,
        fovDeg: FOV,
        // The lander's mesh spans ~1 unit; ~0.42 is its half-extent. Passing it
        // in lets the solver rest the vehicle ON the surface, not through it.
        landerRadius: heroBase * 0.42
      })
      planetGroup.position.set(
        step.planetPosition.x,
        step.planetPosition.y,
        step.planetPosition.z
      )
      planetMesh.scale.setScalar(step.planetRadius)
      if (ringMesh) ringMesh.scale.setScalar(step.planetRadius)

      for (let i = 0; i < landers.length; i++) {
        const actor = landers[i]
        const slot = layout.slots[i]
        if (!slot) continue
        const [tx, ty] = toWorld(slot.x, slot.y)
        const base = slot.size * wpp()
        actor.built.group.position.set(tx, ty, 0)
        actor.built.group.scale.setScalar(base * actor.scale)
        actor.built.setAppearance(actor.opacity * step.slotLandersOpacity, actor.selectMix)
        actor.built.setThrust(0)
      }

      launch.hero.group.position.set(
        step.landerPosition.x,
        step.landerPosition.y,
        step.landerPosition.z
      )
      launch.hero.group.scale.setScalar(heroBase)
      launch.hero.group.rotation.set(
        step.landerPitchX,
        launch.hero.restingYaw * step.landerYawMix,
        0
      )
      launch.hero.setAppearance(step.landerOpacity, 1, false)
      const pulse = 0.88 + 0.12 * Math.sin(now * 0.055)
      launch.hero.setThrust(step.landerThrust, pulse)

      camera.position.set(
        step.cameraPosition.x,
        step.cameraPosition.y,
        step.cameraPosition.z
      )
      camera.lookAt(step.cameraTarget.x, step.cameraTarget.y, step.cameraTarget.z)

      // Impact burst: sit at the crash site, ring laid in the surface tangent
      // plane (normal = radial), flash billboarded as a sphere. Both envelope
      // off `step.impact` (0 before the strike → 1 at the end of the dive).
      const b = step.impact
      if (b > 0) {
        burst.visible = true
        burst.position.set(
          step.landerPosition.x,
          step.landerPosition.y,
          step.landerPosition.z
        )
        const normal = burst.position.clone()
        if (normal.lengthSq() > 1e-6) {
          normal.normalize()
          burstRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
        }
        burstFlash.scale.setScalar(step.planetRadius * (0.3 + 0.5 * b))
        burstFlashMat.opacity = 0.95 * Math.pow(1 - b, 2)
        burstRing.scale.setScalar(step.planetRadius * (0.25 + 1.2 * b))
        burstRingMat.opacity = 0.8 * (1 - b)
      } else {
        burst.visible = false
      }

      renderer.render(scene, camera)
      return
    }

    if (progress < 1) progress = Math.min(1, (now - startedAt) / Math.max(1, durationMs))

    const n = landers.length
    const stag = n > 1 ? (1 - 0.62) / (n - 1) : 0
    const elapsed = (now - startedAt) / 1000
    for (let i = 0; i < n; i++) {
      const actor = landers[i]
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

      // Visibility & selection easing.
      const wantVisible = visibleMask[i] ? 1 : 0
      const isSelected = selected === i
      const wantSelect = isSelected ? 1 : 0
      if (reducedMotion) {
        // Reduced motion is immediately at its settled end state, no easing.
        actor.opacity = wantVisible
        actor.selectMix = wantSelect
        actor.scale = isSelected ? 1.12 : 1
      } else {
        actor.opacity += (wantVisible - actor.opacity) * Math.min(1, dt * 10)
        actor.selectMix += (wantSelect - actor.selectMix) * Math.min(1, dt * 10)
        actor.scale += ((isSelected ? 1.12 : 1) - actor.scale) * Math.min(1, dt * 10)
      }
      const base = slot.size * wpp()
      const revealOpacity = actor.opacity * Math.min(1, local * 3)
      actor.built.setAppearance(revealOpacity, actor.selectMix)

      if (reducedMotion) {
        actor.yaw = actor.built.restingYaw * (1 - actor.selectMix)
        actor.built.group.position.set(wx, wy, 0)
        actor.built.group.rotation.set(0.08, actor.yaw, 0)
        actor.built.setThrust(0)
      } else {
        // Idle bob + yaw wobble (wobble damps as the lander turns to face us).
        const bobY = Math.sin(elapsed * 1.85 + actor.built.bobPhase) * (base * 0.032) * e
        const wobble =
          Math.sin(elapsed * 1.25 + actor.built.wobblePhase) *
          0.14 *
          (1 - actor.selectMix * 0.75) *
          e
        const targetYaw = actor.built.restingYaw * (1 - actor.selectMix) + wobble
        actor.yaw += (targetYaw - actor.yaw) * Math.min(1, dt * 8)
        const bankZ = (1 - e) * -0.22
        actor.built.group.position.set(wx, wy + bobY, 0)
        actor.built.group.rotation.set(0.08 * e, actor.yaw, bankZ)

        // Thruster flame while flying up.
        const flightThrust =
          local > 0 && local < 0.995
            ? Math.min(1, local * 5) * Math.pow(1 - local, 1.15) * actor.opacity
            : 0
        const pulse = 0.88 + 0.12 * Math.sin(now * 0.045 + i * 1.9)
        actor.built.setThrust(flightThrust, pulse)
      }

      actor.built.group.scale.setScalar(base * (0.35 + 0.65 * e) * actor.scale)
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
    spinPhase() {
      return planetMesh.rotation.y
    },
    startLaunch(selectedIndex, durationMs = LAUNCH_DIVE_MS) {
      clearLaunchHero()
      progress = 1
      const idx =
        selectedIndex >= 0 && selectedIndex < landerSeeds.length
          ? selectedIndex
          : Math.max(0, selected)
      const seed = landerSeeds[idx] ?? landerSeeds[0] ?? planetSeed
      const hero = buildLander(seed)
      hero.setAppearance(0, 1, false)
      hero.setThrust(0)
      scene.add(hero.group)
      launchState = { selectedIndex: idx, startedAt: performance.now(), durationMs, hero }
    },
    abortLaunch() {
      clearLaunchHero()
      for (let i = 0; i < landers.length; i++) {
        landers[i].opacity = visibleMask[i] ? 1 : 0
      }
      applySize()
    },
    skip() {
      progress = 1
    },
    dispose() {
      disposed = true
      clearLaunchHero()
      planetTex.dispose()
      planetMat.dispose()
      planetMesh.geometry.dispose()
      if (ringMesh) {
        ringMesh.geometry.dispose()
        ;(ringMesh.material as THREE.Material).dispose()
      }
      burstFlash.geometry.dispose()
      burstFlashMat.dispose()
      burstRing.geometry.dispose()
      burstRingMat.dispose()
      for (const actor of landers) actor.built.dispose()
      renderer.dispose()
    }
  }
}
