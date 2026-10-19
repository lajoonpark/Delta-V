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
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
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
import { buildCrashField } from '@renderer/art/crash3d'
import { crashFxSeed, solveCrashFx } from '@renderer/art/crashFx'
import { createCrashPass } from '@renderer/art/crashPass'

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
  // Backdrop as a scene colour, not a clear colour: the post chain ends in
  // an sRGB `OutputPass`, and three writes a clear colour already encoded into
  // the render target, so a non-black clear would get encoded twice and the
  // whole backdrop would wash out. `scene.background` round-trips correctly.
  renderer.setClearColor(0x000000, 1)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x090b10)
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

  // Post-processing chain. The composer runs the whole time (so the resting
  // stage is bit-identical to before — all three passes are no-ops at rest),
  // and the crash pass + bloom only bite during the launch dive.
  //
  // MSAA lives on the composer's own render target: the default composer target
  // has no multisampling, and the resting stage's planet limb would jag.
  const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples: 4
  })
  const composer = new EffectComposer(renderer, renderTarget)
  const renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)
  const crashPass = createCrashPass()
  crashPass.pass.enabled = false
  composer.addPass(crashPass.pass)
  // Threshold sits just above the planet's lit surfaces, so at rest the bloom
  // contributes nothing and only the (additive) blast goes over the line.
  // Strength is modest: the blast is a lot of already-additive geometry, and
  // bloom on top of it saturates to flat white instead of glowing.
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.55, 0.95)
  bloom.enabled = false
  composer.addPass(bloom)
  const outputPass = new OutputPass()
  composer.addPass(outputPass)

  // Crash FX — the explosion's meshes, rebuilt per launch. Local frame: the
  // group sits at the crash site with +Z along the surface normal.
  let crashField: ReturnType<typeof buildCrashField> | null = null

  // Scratch vectors reused across frames (the frame loop must not allocate).
  const shakeOffset = new THREE.Vector3()
  const cameraRight = new THREE.Vector3()
  const cameraUp = new THREE.Vector3()
  const focusProj = new THREE.Vector3()
  const zAxis = new THREE.Vector3(0, 0, 1)

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
    /** Own FX RNG stream — the blast must not perturb the other landers. */
    rnd: () => number
    /** True once the blast has been armed at the strike. */
    armed: boolean
  } | null = null

  const clearLaunchHero = (): void => {
    if (crashField) {
      scene.remove(crashField.group)
      crashField.dispose()
      crashField = null
    }
    crashPass.pass.enabled = false
    bloom.enabled = false
    crashPass.uniforms.radialBlur.value = 0
    crashPass.uniforms.speedLines.value = 0
    crashPass.uniforms.wash.value = 0
    if (!launchState) return
    scene.remove(launchState.hero.group)
    launchState.hero.dispose()
    launchState = null
  }

  const applySize = (): void => {
    renderer.setSize(layout.width, layout.height, false)
    composer.setSize(layout.width, layout.height)
    crashPass.setSize(layout.width, layout.height)
    bloom.setSize(layout.width, layout.height)
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

      // ── Crash FX ────────────────────────────────────────────────────────
      // Age is 0 at the strike and 1 at the end of the dive; the solver turns
      // it into every envelope the blast, the shake and the frame look need.
      const fx = solveCrashFx({
        age: step.impact,
        travelBlend: step.dive,
        landerRadius: heroBase * 0.42,
        cameraDistance:
          camera.position.distanceTo(
            shakeOffset.set(step.landerPosition.x, step.landerPosition.y, step.landerPosition.z)
          ) / Math.max(1e-3, step.planetRadius),
        rnd: launch.rnd
      })

      // Arm the blast on the first frame it exists, so the debris field is
      // sampled exactly once and then only integrated.
      if (step.impact > 0 && !launch.armed && crashField) {
        launch.armed = true
        crashField.arm()
      }

      launch.hero.group.scale.setScalar(heroBase)
      // Recoil: squash-and-stretch plus a decaying rattle on the crash pose.
      launch.hero.group.scale.y *= fx.landerSquash
      launch.hero.group.rotation.set(
        step.landerPitchX + fx.landerRattle,
        launch.hero.restingYaw * step.landerYawMix,
        0
      )
      launch.hero.setAppearance(step.landerOpacity, 1, false)
      const pulse = 0.88 + 0.12 * Math.sin(now * 0.055)
      launch.hero.setThrust(step.landerThrust, pulse)
      launch.hero.setDamage(fx.damage, now / 1000)

      // Place and orient the blast: at the crash site, +Z along the surface
      // normal so the rings/column/dust lie in the tangent plane.
      if (crashField) {
        crashField.group.position.copy(launch.hero.group.position)
        const normal = crashField.group.position
        if (normal.lengthSq() > 1e-6) {
          crashField.group.quaternion.setFromUnitVectors(zAxis, normal.clone().normalize())
        }
        crashField.update(fx)
      }

      // Camera push-in toward the crash (t in [0.18, IMPACT]); it settles outside
      // the planet and holds through the impact — it never enters the mesh.
      camera.position.set(
        step.cameraPosition.x,
        step.cameraPosition.y,
        step.cameraPosition.z
      )
      camera.lookAt(step.cameraTarget.x, step.cameraTarget.y, step.cameraTarget.z)

      // Shake in the camera's own screen plane (right/up), so the whole frame
      // punches without the camera ever moving toward the planet. `shakeAmp`
      // is a fraction of the view's half-height, so it is converted to world
      // units through the same projection the rest of the scene uses —
      // scaling it by the pixel height instead throws the camera off the set.
      if (fx.shakeAmp > 1e-5) {
        cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
        cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion)
        const focusDist = camera.position.distanceTo(
          shakeOffset.set(step.landerPosition.x, step.landerPosition.y, step.landerPosition.z)
        )
        const amp = fx.shakeAmp * Math.tan((FOV * Math.PI) / 360) * focusDist
        // Two frequencies per axis so the ring-down never looks like a sine.
        const sx = Math.sin(fx.shakePhase) * 0.6 + Math.sin(fx.shakePhase * 2.37) * 0.4
        const sy = Math.cos(fx.shakePhase * 1.19) * 0.6 + Math.cos(fx.shakePhase * 3.1) * 0.4
        camera.position.addScaledVector(cameraRight, sx * amp)
        camera.position.addScaledVector(cameraUp, sy * amp)
      }

      // Frame look: radial blur + speed lines through the fall, flash wash and
      // bloom at the strike. The pass is centred on the impact in screen space.
      const wantLook = fx.radialBlur > 0.001 || fx.speedLines > 0.001 || fx.wash > 0.001
      crashPass.pass.enabled = wantLook
      if (wantLook) {
        // Project the blast to uv through the (post-shake) view-projection, so
        // the blur rays and spokes stay pinned to the crash site.
        camera.updateMatrixWorld()
        focusProj.copy(crashField ? crashField.group.position : launch.hero.group.position)
        focusProj.project(camera)
        crashPass.uniforms.focus.value.set(focusProj.x * 0.5 + 0.5, focusProj.y * 0.5 + 0.5)
        crashPass.uniforms.radialBlur.value = fx.radialBlur
        crashPass.uniforms.speedLines.value = fx.speedLines
        crashPass.uniforms.wash.value = fx.wash
        crashPass.uniforms.time.value = now / 1000
      }
      bloom.enabled = fx.fireball > 0.001 || fx.flash > 0.001 || fx.ember > 0.001

      composer.render()
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
    composer.render()
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

      // The blast sizes itself off the hero's own footprint, so it scales with
      // the slot size we will fly at.
      const slotSize =
        layout.slots[idx]?.size ??
        Math.max(56, Math.min(132, Math.min(layout.width, layout.height) * 0.12))
      crashField = buildCrashField({ seed, landerRadius: slotSize * wpp() * 0.42 })
      scene.add(crashField.group)

      launchState = {
        selectedIndex: idx,
        startedAt: performance.now(),
        durationMs,
        hero,
        rnd: mulberry32(crashFxSeed(seed, idx)),
        armed: false
      }
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
      crashPass.dispose()
      bloom.dispose()
      outputPass.dispose()
      renderTarget.dispose()
      composer.dispose()
      for (const actor of landers) actor.built.dispose()
      renderer.dispose()
    }
  }
}
