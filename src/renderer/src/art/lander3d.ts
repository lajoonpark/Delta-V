/**
 * Shared 3D lander construction: one seeded vehicle built from `landerSpec`
 * (so the 2D generator and this mesh never drift) plus a secondary RNG for
 * 3D-only archetype variations and idle-motion phases. Lit by the lander
 * stage's scene lights — no baked shading, no lights added here. Mirrors
 * planet3d's construction/disposal discipline: every geometry and material is
 * tracked and disposed, and the same seed → the same vehicle everywhere.
 */
import * as THREE from 'three'
import { landerSpec } from './landerGen'
import { hashSeed, hsl, mulberry32 } from './planetGen'

export interface LanderBuild {
  group: THREE.Group
  /** Deterministic resting yaw (rad) so landers sit at a readable 3/4 angle. */
  restingYaw: number
  /** Deterministic phase offset (rad) for idle vertical bob. */
  bobPhase: number
  /** Deterministic phase offset (rad) for idle yaw wobble. */
  wobblePhase: number
  /** Set overall reveal/visibility opacity (0..1) and unselected/selected brightness. */
  setAppearance(opacity: number, selectMix: number, showRing?: boolean): void
  /** Set thruster plume intensity (0..1) during the fly-up entrance (0 hides flame). */
  setThrust(thrust: number, pulse?: number): void
  dispose(): void
}

/** A standard material plus the base values `setAppearance` restores each frame. */
interface MatEntry {
  mat: THREE.MeshStandardMaterial
  baseColor: THREE.Color
  baseEmissive: THREE.Color
  baseEmissiveIntensity: number
  selectEmissiveBoost: number
}

export function buildLander(seed: string): LanderBuild {
  const spec = landerSpec(seed)
  // 3D-only RNG: keeps `landerSpec(seed)` untouched and 100% in sync with the
  // 2D generator while still letting the mesh pick its own archetype/pose.
  const rnd = mulberry32(hashSeed(seed + ':lander3d'))
  const dark = spec.scale[0]
  const mid = spec.scale[1]
  const light = spec.scale[2]

  // Authored centered on (0, 0, 0) in a ~1.0 unit box (facing +Z), so scaling
  // the group by slot.size * wpp() maps 1.0 unit to slot.size pixels.
  const group = new THREE.Group()

  const geos = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const matEntries: MatEntry[] = []

  const mkStdMat = (params: {
    color: THREE.ColorRepresentation
    emissive: THREE.ColorRepresentation
    emissiveIntensity: number
    selectEmissiveBoost: number
    roughness: number
    metalness: number
  }): THREE.MeshStandardMaterial => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(params.color),
      emissive: new THREE.Color(params.emissive),
      emissiveIntensity: params.emissiveIntensity,
      roughness: params.roughness,
      metalness: params.metalness
    })
    materials.add(mat)
    matEntries.push({
      mat,
      baseColor: new THREE.Color(params.color),
      baseEmissive: new THREE.Color(params.emissive),
      baseEmissiveIntensity: params.emissiveIntensity,
      selectEmissiveBoost: params.selectEmissiveBoost
    })
    return mat
  }
  const mkMesh = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh => {
    geos.add(geometry)
    return new THREE.Mesh(geometry, material)
  }

  // ── Materials (base color / emissive tracked for setAppearance) ──
  const hullMat = mkStdMat({
    color: hsl(mid.h, mid.s, mid.l),
    emissive: hsl(mid.h, mid.s, mid.l * 0.65),
    emissiveIntensity: 0.16,
    selectEmissiveBoost: 0.22,
    roughness: 0.62,
    metalness: 0.12
  })
  const domeMat = mkStdMat({
    color: hsl(light.h, light.s, light.l),
    emissive: hsl(light.h, light.s, light.l * 0.7),
    emissiveIntensity: 0.18,
    selectEmissiveBoost: 0.26,
    roughness: 0.52,
    metalness: 0.08
  })
  const darkMat = mkStdMat({
    color: hsl(dark.h, dark.s, dark.l + 0.03),
    emissive: hsl(dark.h, dark.s, dark.l * 0.5),
    emissiveIntensity: 0.14,
    selectEmissiveBoost: 0.18,
    roughness: 0.68,
    metalness: 0.18
  })
  const panelMat = mkStdMat({
    color: hsl(dark.h, dark.s, Math.min(1, dark.l + 0.08)),
    emissive: hsl(dark.h, dark.s, dark.l * 0.6),
    emissiveIntensity: 0.16,
    selectEmissiveBoost: 0.22,
    roughness: 0.58,
    metalness: 0.15
  })
  const nozzleMat = mkStdMat({
    color: hsl(dark.h, dark.s, Math.max(0.12, dark.l - 0.04)),
    emissive: hsl(spec.baseHue, spec.sat, 0.35),
    emissiveIntensity: 0.12,
    selectEmissiveBoost: 0.25,
    roughness: 0.48,
    metalness: 0.28
  })
  const accentMat = mkStdMat({
    color: 0xf4f1ea,
    emissive: hsl(spec.baseHue, spec.sat * 0.25, 0.9),
    emissiveIntensity: 0.35,
    selectEmissiveBoost: 0.35,
    roughness: 0.4,
    metalness: 0.05
  })
  // The dish is open-ended, so the accent paint must render on both faces.
  accentMat.side = THREE.DoubleSide
  const windowMat = mkStdMat({
    color: hsl(spec.baseHue, spec.sat * 0.35, 0.93),
    emissive: hsl(spec.baseHue, spec.sat * 0.55, 0.82),
    emissiveIntensity: 0.72,
    selectEmissiveBoost: 0.55,
    roughness: 0.22,
    metalness: 0.05
  })

  // A cylinder whose axis runs along `to - from`, centered on their midpoint.
  const strut = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    rTop: number,
    rBot: number,
    seg: number,
    material: THREE.Material
  ): THREE.Mesh => {
    const dir = new THREE.Vector3().subVectors(to, from)
    const len = dir.length()
    const mesh = mkMesh(new THREE.CylinderGeometry(rTop, rBot, len, seg), material)
    mesh.position.copy(from).add(to).multiplyScalar(0.5)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    return mesh
  }

  // ── Archetypes (deterministic from the 3D-only RNG) ──
  const hullArch = Math.floor(rnd() * 3)
  const addonArch = Math.floor(rnd() * 4)
  // Front hull face across archetypes, so front-mounted details sit flush.
  const frontZ = hullArch === 2 ? 0.18 : 0.21

  // 1. Body / hull — centered around y ≈ +0.015, ≈0.23 tall and ≈0.46 wide.
  if (hullArch === 0) {
    // Octagonal/chamfered lander bus.
    const bus = mkMesh(new THREE.CylinderGeometry(0.23, 0.245, 0.22, 8), hullMat)
    bus.rotation.y = Math.PI / 8
    bus.position.y = 0.015
    group.add(bus)
    const adapter = mkMesh(new THREE.CylinderGeometry(0.21, 0.19, 0.04, 8), darkMat)
    adapter.position.y = -0.105
    group.add(adapter)
    const collar = mkMesh(new THREE.CylinderGeometry(0.175, 0.2, 0.03, 16), darkMat)
    collar.position.y = 0.125
    group.add(collar)
  } else if (hullArch === 1) {
    // Cylindrical capsule descent stage with a heatshield rim.
    const shell = mkMesh(new THREE.CylinderGeometry(0.215, 0.23, 0.22, 20), hullMat)
    shell.position.y = 0.015
    group.add(shell)
    const skirt = mkMesh(new THREE.CylinderGeometry(0.25, 0.22, 0.05, 20), panelMat)
    skirt.position.y = -0.095
    group.add(skirt)
    const collar = mkMesh(new THREE.CylinderGeometry(0.175, 0.2, 0.03, 16), darkMat)
    collar.position.y = 0.125
    group.add(collar)
  } else {
    // Core bus flanked by twin side propellant tanks.
    const core = mkMesh(new THREE.BoxGeometry(0.34, 0.22, 0.36), hullMat)
    core.position.y = 0.015
    group.add(core)
    for (const sx of [-1, 1]) {
      const tank = mkMesh(new THREE.CapsuleGeometry(0.068, 0.1, 8, 14), domeMat)
      tank.position.set(sx * 0.195, 0.01, -0.01)
      group.add(tank)
      const band = mkMesh(new THREE.CylinderGeometry(0.072, 0.072, 0.03, 14), darkMat)
      band.position.set(sx * 0.195, 0.01, -0.01)
      group.add(band)
    }
  }

  // 2. Upper pressurized crew dome (y ≈ +0.13..+0.33).
  const domeBase = mkMesh(new THREE.CylinderGeometry(0.145, 0.155, 0.09, 24), domeMat)
  domeBase.position.y = 0.165
  group.add(domeBase)
  const domeCap = mkMesh(
    new THREE.SphereGeometry(0.145, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
    domeMat
  )
  domeCap.position.y = 0.205
  group.add(domeCap)

  // 3. Cockpit window on the front (+Z) of the dome, tilted slightly.
  const windowGroup = new THREE.Group()
  windowGroup.position.set(0, 0.22, 0.135)
  windowGroup.rotation.x = -0.18
  group.add(windowGroup)
  if (spec.windowRound) {
    const bezel = mkMesh(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 20), darkMat)
    bezel.rotation.x = Math.PI / 2
    windowGroup.add(bezel)
    const viewport = mkMesh(new THREE.CylinderGeometry(0.048, 0.048, 0.024, 20), windowMat)
    viewport.rotation.x = Math.PI / 2
    viewport.position.z = 0.003
    windowGroup.add(viewport)
  } else {
    const frame = mkMesh(new THREE.CapsuleGeometry(0.035, 0.105, 6, 12), darkMat)
    frame.rotation.z = Math.PI / 2
    frame.scale.set(1, 1, 0.35)
    frame.position.z = -0.003
    windowGroup.add(frame)
    const visor = mkMesh(new THREE.CapsuleGeometry(0.027, 0.095, 6, 12), windowMat)
    visor.rotation.z = Math.PI / 2
    visor.scale.set(1, 1, 0.45)
    visor.position.z = 0.003
    windowGroup.add(visor)
  }

  // 4. White pill accent — the same stroke of paint as the planet cloud streaks.
  const pill = mkMesh(new THREE.CapsuleGeometry(0.016, 0.095, 6, 12), accentMat)
  pill.rotation.z = Math.PI / 2
  pill.position.set(-0.095, 0.055, frontZ + 0.008)
  group.add(pill)

  // 5. Equipment bay on the front-right shoulder.
  if (spec.sidePanel) {
    const bay = mkMesh(new THREE.BoxGeometry(0.11, 0.125, 0.055), panelMat)
    bay.position.set(0.125, -0.005, frontZ - 0.012)
    group.add(bay)
    const strip = mkMesh(new THREE.BoxGeometry(0.075, 0.022, 0.06), domeMat)
    strip.position.set(0.125, -0.005, frontZ - 0.012)
    group.add(strip)
  }

  // 6. Archetype add-on.
  if (addonArch === 0) {
    // External fuel tank on the left flank + a short strut to the hull.
    const tank = mkMesh(new THREE.CapsuleGeometry(0.048, 0.09, 6, 12), panelMat)
    tank.position.set(-0.245, 0.01, 0.02)
    group.add(tank)
    group.add(
      strut(
        new THREE.Vector3(-0.17, 0.02, 0.0),
        new THREE.Vector3(-0.245, 0.01, 0.02),
        0.012,
        0.012,
        8,
        darkMat
      )
    )
  } else if (addonArch === 1) {
    // Tilted parabolic comms dish on the left shoulder.
    group.add(
      strut(
        new THREE.Vector3(-0.185, 0.09, 0.02),
        new THREE.Vector3(-0.23, 0.13, 0.04),
        0.008,
        0.008,
        8,
        darkMat
      )
    )
    const dish = mkMesh(new THREE.CylinderGeometry(0.065, 0.016, 0.032, 16, 1, true), accentMat)
    dish.position.set(-0.23, 0.13, 0.04)
    dish.rotation.z = 0.65
    dish.rotation.x = -0.22
    group.add(dish)
    const feed = mkMesh(new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6), darkMat)
    feed.position.set(-0.24, 0.14, 0.045)
    feed.rotation.z = 0.65
    feed.rotation.x = -0.22
    group.add(feed)
  } else if (addonArch === 2) {
    // Swept stabilizer fins on the lower flanks.
    for (const sx of [-1, 1]) {
      const fin = mkMesh(new THREE.BoxGeometry(0.08, 0.14, 0.022), panelMat)
      fin.position.set(sx * 0.245, -0.01, 0)
      fin.rotation.z = -sx * 0.22
      group.add(fin)
    }
  } else {
    // Secondary sensor cupola / cargo pod on the upper deck shoulder.
    const cupola = mkMesh(new THREE.CapsuleGeometry(0.045, 0.04, 6, 12), domeMat)
    cupola.position.set(-0.175, 0.145, 0.03)
    group.add(cupola)
    const dot = mkMesh(new THREE.SphereGeometry(0.016, 8, 8), windowMat)
    dot.position.set(-0.175, 0.145, 0.068)
    group.add(dot)
  }

  // 7. Antenna mast + beacon.
  if (spec.antenna) {
    const mast = mkMesh(new THREE.CylinderGeometry(0.009, 0.011, 0.095, 8), darkMat)
    mast.position.set(0, 0.375, 0)
    group.add(mast)
    const beacon = mkMesh(new THREE.SphereGeometry(0.024, 12, 12), windowMat)
    beacon.position.set(0, 0.428, 0)
    group.add(beacon)
  }

  // 8. Engine bell + throat ring.
  const bell = mkMesh(new THREE.CylinderGeometry(0.068, 0.128, 0.125, 20), nozzleMat)
  bell.position.set(0, -0.145, 0)
  group.add(bell)
  const throat = mkMesh(new THREE.TorusGeometry(0.072, 0.012, 8, 20), darkMat)
  throat.rotation.x = Math.PI / 2
  throat.position.set(0, -0.095, 0)
  group.add(throat)

  // 9. Four landing legs — true 3D depth while matching the 2D spread.
  for (const sideX of [-1, 1]) {
    for (const sideZ of [-1, 1]) {
      const top = new THREE.Vector3(sideX * 0.165, -0.085, sideZ * 0.095)
      const foot = new THREE.Vector3(
        sideX * (0.195 + spec.legSpread),
        -0.315,
        sideZ * 0.135
      )
      group.add(
        strut(top, foot, 0.016, 0.019, 10, darkMat)
      )
      const kneeFrom = new THREE.Vector3(sideX * 0.12, -0.11, sideZ * 0.07)
      const kneeTo = new THREE.Vector3().addVectors(top, foot).multiplyScalar(0.5)
      group.add(strut(kneeFrom, kneeTo, 0.01, 0.01, 8, darkMat))
      const pad = mkMesh(new THREE.CylinderGeometry(0.058, 0.068, 0.028, 14), panelMat)
      pad.position.set(foot.x, -0.325, foot.z)
      group.add(pad)
    }
  }

  // 10. Selection halo ring (opacity driven by setAppearance).
  const selectRingMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(hsl(spec.baseHue, Math.min(1, spec.sat * 1.1), 0.72)),
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false
  })
  materials.add(selectRingMat)
  const selectRing = mkMesh(new THREE.RingGeometry(0.28, 0.315, 36), selectRingMat)
  selectRing.rotation.x = -Math.PI / 2
  selectRing.position.y = -0.338
  selectRing.visible = false
  group.add(selectRing)

  // 11. Thruster plume (driven by setThrust during the fly-up entrance).
  const plumeMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(hsl(spec.baseHue, Math.min(1, spec.sat * 0.9), 0.72)),
    transparent: true,
    opacity: 0,
    depthWrite: false
  })
  materials.add(plumeMat)
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xfff6e5,
    transparent: true,
    opacity: 0,
    depthWrite: false
  })
  materials.add(coreMat)

  const flameGroup = new THREE.Group()
  flameGroup.position.y = -0.205
  flameGroup.visible = false
  group.add(flameGroup)

  const plume = mkMesh(new THREE.ConeGeometry(0.088, 0.18, 16), plumeMat)
  plume.rotation.x = Math.PI
  plume.position.y = -0.085
  flameGroup.add(plume)
  const core = mkMesh(new THREE.ConeGeometry(0.048, 0.11, 12), coreMat)
  core.rotation.x = Math.PI
  core.position.y = -0.05
  flameGroup.add(core)
  if (spec.exhaust > 0) {
    for (let i = 0; i < spec.exhaust; i++) {
      const ring = mkMesh(new THREE.TorusGeometry(0.065 - i * 0.018, 0.012, 8, 20), coreMat)
      ring.rotation.x = Math.PI / 2
      ring.position.y = -0.055 - i * 0.055
      flameGroup.add(ring)
    }
  }

  const setAppearance = (opacity: number, selectMix: number, showRing = true): void => {
    const op = Math.max(0, Math.min(1, opacity))
    const sel = Math.max(0, Math.min(1, selectMix))
    group.visible = op > 0.004
    // Dim unselected landers slightly; settled landers stay fully opaque solids
    // (transparent only during entrance/filter fades) to avoid sorting artifacts.
    const dim = 0.82 + 0.18 * sel
    for (const entry of matEntries) {
      const mat = entry.mat
      mat.color.copy(entry.baseColor).multiplyScalar(dim)
      mat.emissiveIntensity = entry.baseEmissiveIntensity * dim + entry.selectEmissiveBoost * sel
      const isTrans = op < 0.995
      if (mat.transparent !== isTrans) {
        mat.transparent = isTrans
        mat.needsUpdate = true
      }
      mat.opacity = op
    }
    selectRingMat.opacity = showRing ? op * sel * 0.65 : 0
    selectRing.visible = showRing && op * sel > 0.01
  }

  const setThrust = (thrust: number, pulse = 1): void => {
    const t = Math.max(0, Math.min(1, thrust))
    flameGroup.visible = t > 0.005
    flameGroup.scale.set(0.85 + 0.25 * t, (0.4 + 0.85 * t) * pulse, 0.85 + 0.25 * t)
    plumeMat.opacity = 0.78 * t
    coreMat.opacity = 0.92 * t
  }

  // Deterministic idle motion (bob + yaw wobble phases, readable 3/4 pose).
  const yawSign = rnd() < 0.5 ? -1 : 1
  const restingYaw = yawSign * (0.32 + rnd() * 0.22)
  const bobPhase = rnd() * Math.PI * 2
  const wobblePhase = rnd() * Math.PI * 2

  return {
    group,
    restingYaw,
    bobPhase,
    wobblePhase,
    setAppearance,
    setThrust,
    dispose() {
      for (const g of geos) g.dispose()
      for (const m of materials) m.dispose()
    }
  }
}
