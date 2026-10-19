/**
 * Crash-impact meshes: the visible half of the lander crash — white-hot core, a
 * lumpy multi-lobe fireball, two ground-hugging shock rings, a vertical blast
 * column, ballistic hull debris and an expanding dust skirt.
 *
 * Everything lives in one `THREE.Group` positioned at the crash site with +Z
 * along the surface normal, so the whole blast is authored in the impact's own
 * tangent frame and the scene only has to place and orient the group. Local
 * units are *lander radii* (what `art/crashFx.ts` emits) times the caller's
 * `landerRadius`, so one blast works for any planet size.
 *
 * Additive, depth-write-free materials so the blast reads as light rather than
 * geometry. Debris is the only solid-looking part, and it is emissive so it
 * still glows against the black. Every geometry/material/texture is tracked and
 * disposed.
 */
import * as THREE from 'three'
import {
  debrisPosition,
  sampleCrashField,
  type CrashFx,
  type CrashDebris,
  type CrashPuff
} from './crashFx'
import { hashSeed, mulberry32 } from './planetGen'

export interface CrashFieldOptions {
  /** FX seed — same seed + index -> the same blast. */
  seed: string
  /** Hero lander's world half-extent; the local unit for blast sizes. */
  landerRadius: number
}

export interface CrashFieldHandle {
  group: THREE.Group
  /** Fire once, at the strike: samples the deterministic debris/puff field. */
  arm(): void
  update(fx: CrashFx): void
  /** True while any part of the blast is still visible. */
  active(): boolean
  dispose(): void
}

const FIREBALL_LOBES = 7

/** Soft radial-gradient sprite used for dust and the ember pool. */
function puffTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.6)')
    g.addColorStop(0.72, 'rgba(255,255,255,0.15)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function buildCrashField(opts: CrashFieldOptions): CrashFieldHandle {
  const unit = Math.max(1e-4, opts.landerRadius)
  const rnd = mulberry32(hashSeed(`${opts.seed}:crash-field`))

  const group = new THREE.Group()
  group.visible = false

  const geos = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()

  const addGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.add(g)
    return g
  }
  const addMat = <T extends THREE.Material>(m: T): T => {
    materials.add(m)
    return m
  }
  const additive = (color: THREE.ColorRepresentation): THREE.MeshBasicMaterial =>
    addMat(
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    )

  // -- White-hot core ------------------------------------------------------
  const coreMat = additive(0xfffdf4)
  const core = new THREE.Mesh(addGeo(new THREE.SphereGeometry(1, 24, 16)), coreMat)
  group.add(core)

  // -- Fireball lobes: offset spheres read as one lumpy cartoon blast ------
  const lobes: {
    mesh: THREE.Mesh
    mat: THREE.MeshBasicMaterial
    off: THREE.Vector3
    scale: number
    tint: number
  }[] = []
  for (let i = 0; i < FIREBALL_LOBES; i++) {
    const t = i / (FIREBALL_LOBES - 1)
    // Warm ramp: pale yellow core through to deep orange on the outside.
    const mat = additive(new THREE.Color().setHSL(0.055 + t * 0.03, 0.96, 0.74 - t * 0.16))
    const mesh = new THREE.Mesh(addGeo(new THREE.SphereGeometry(1, 20, 14)), mat)
    const off = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, 0.2 + rnd() * 0.9).normalize()
    off.multiplyScalar(0.2 + rnd() * 0.5)
    lobes.push({ mesh, mat, off, scale: 0.5 + rnd() * 0.5, tint: 0.6 + t * 0.4 })
    group.add(mesh)
  }

  // -- Shock rings: thin annuli laid in the surface tangent plane ---------
  const shockMat1 = additive(0xffc27a)
  const shock1 = new THREE.Mesh(addGeo(new THREE.RingGeometry(0.88, 1, 96)), shockMat1)
  group.add(shock1)
  const shockMat2 = additive(0xffe6bb)
  const shock2 = new THREE.Mesh(addGeo(new THREE.RingGeometry(0.94, 1, 72)), shockMat2)
  group.add(shock2)

  // -- Ember pool left glowing in the crater ------------------------------
  const emberTex = puffTexture()
  textures.add(emberTex)
  const emberMat = addMat(
    new THREE.MeshBasicMaterial({
      map: emberTex,
      color: 0xff9a4a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  )
  const ember = new THREE.Mesh(addGeo(new THREE.PlaneGeometry(2, 2)), emberMat)
  group.add(ember)

  // -- Blast column: authored around its base so +Y stretches upward ------
  const columnMat = additive(0xffb066)
  const columnGeo = addGeo(new THREE.CylinderGeometry(0.5, 1, 1, 20, 1, true))
  columnGeo.translate(0, 0.5, 0)
  const column = new THREE.Mesh(columnGeo, columnMat)
  column.rotation.x = -Math.PI / 2
  group.add(column)

  // -- Dust skirt ---------------------------------------------------------
  const dustTex = puffTexture()
  textures.add(dustTex)
  const dustPuffs: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; def: CrashPuff }[] = []

  // -- Debris -------------------------------------------------------------
  const debrisGeos = [
    addGeo(new THREE.TetrahedronGeometry(1, 0)),
    addGeo(new THREE.BoxGeometry(1.2, 0.7, 0.8)),
    addGeo(new THREE.OctahedronGeometry(1, 0))
  ]
  const debris: { mesh: THREE.Mesh; def: CrashDebris }[] = []

  let armed = false

  const arm = (): void => {
    if (armed) return
    armed = true
    const { debris: defs, puffs } = sampleCrashField(rnd, { landerRadius: 1 })

    for (const def of defs) {
      // Emissive so a chunk still reads hot while it tumbles through the dark;
      // each chunk owns its material so opacity can be driven per fragment.
      const mat = addMat(
        new THREE.MeshStandardMaterial({
          color: def.variant < 0.5 ? 0x3a3126 : 0x2b2f38,
          emissive: 0xff7a2a,
          emissiveIntensity: 0.4 + def.hot,
          roughness: 0.85,
          metalness: 0.2,
          transparent: true,
          opacity: 0
        })
      )
      const mesh = new THREE.Mesh(debrisGeos[Math.floor(def.variant * 3) % 3], mat)
      mesh.visible = false
      group.add(mesh)
      debris.push({ mesh, def })
    }

    for (const def of puffs) {
      const mat = addMat(
        new THREE.MeshBasicMaterial({
          map: dustTex,
          color: 0xbfae9a,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide
        })
      )
      const mesh = new THREE.Mesh(addGeo(new THREE.PlaneGeometry(2, 2)), mat)
      mesh.visible = false
      group.add(mesh)
      dustPuffs.push({ mesh, mat, def })
    }
  }

  const update = (fx: CrashFx): void => {
    const anyVisible =
      fx.flash > 0.002 ||
      fx.fireball > 0.002 ||
      fx.ember > 0.002 ||
      fx.shockRing > 0.002 ||
      fx.shockRing2 > 0.002 ||
      fx.column > 0.002 ||
      fx.dust > 0.002 ||
      fx.debrisOpacity > 0.002
    group.visible = anyVisible
    if (!anyVisible) return

    const fr = fx.fireballRadius * unit

    // Core flash: a small hard ball that blows out the frame for a frame or two.
    coreMat.opacity = 0.9 * fx.flash
    core.visible = coreMat.opacity > 0.002
    core.scale.setScalar(Math.max(1e-3, unit * (0.35 + 0.9 * fx.flash) * fx.fireballRadius * 0.22))

    // Fireball lobes.
    for (const lobe of lobes) {
      lobe.mat.opacity = 0.34 * fx.fireball * lobe.tint
      lobe.mesh.visible = lobe.mat.opacity > 0.002
      if (!lobe.mesh.visible) continue
      lobe.mesh.position.copy(lobe.off).multiplyScalar(fr * 0.6)
      lobe.mesh.scale.setScalar(Math.max(1e-3, fr * lobe.scale * (0.66 + 0.34 * fx.fireball)))
    }

    // Shock rings: expand past the fireball, then dissolve.
    shock1.scale.setScalar(Math.max(1e-3, fx.shockRadius * unit))
    shockMat1.opacity = 0.85 * fx.shockRing
    shock1.visible = shockMat1.opacity > 0.002
    shock2.scale.setScalar(Math.max(1e-3, fx.shockRadius2 * unit))
    shockMat2.opacity = 0.55 * fx.shockRing2
    shock2.visible = shockMat2.opacity > 0.002

    // Ember pool: a crater glow tucked under the fireball, not a second blast.
    emberMat.opacity = 0.34 * fx.ember
    ember.visible = emberMat.opacity > 0.002
    ember.scale.setScalar(Math.max(1e-3, unit * (0.7 + 1.1 * fx.ember)))

    // Column: a narrow jet, kept under the planet's limb so it reads as a
    // plume rather than a wall of light.
    const width = unit * (0.35 + 0.7 * fx.column)
    column.scale.set(width, Math.max(1e-3, fx.columnHeight * unit), width)
    columnMat.opacity = 0.26 * fx.column
    column.visible = columnMat.opacity > 0.002

    // Dust skirt: flat discs running out along the surface.
    for (const p of dustPuffs) {
      const local = Math.max(0, fx.debrisClock - p.def.delay)
      const spread = 1 - Math.exp(-1.7 * local)
      const r = p.def.speed * spread * unit * 2.6
      p.mesh.position.set(p.def.dirX * r, p.def.dirY * r, p.def.dirZ * r * 0.5)
      const s = (p.def.scale + p.def.growth * local) * unit * 2
      p.mesh.scale.set(s, s, 1)
      // Swells in fast, then thins as it spreads.
      const fade = Math.min(1, local * 6) * Math.max(0, 1 - local / 1.7)
      p.mat.opacity = fx.dust * 0.45 * fade
      p.mesh.visible = p.mat.opacity > 0.002
    }

    // Debris: analytic ballistic throw, no per-frame integration.
    for (const d of debris) {
      const pos = debrisPosition(d.def, fx.debrisClock)
      d.mesh.position.set(pos.x * unit, pos.y * unit, pos.z * unit)
      d.mesh.rotation.set(
        d.def.spinX * fx.debrisClock,
        d.def.spinY * fx.debrisClock,
        d.def.spinZ * fx.debrisClock
      )
      d.mesh.scale.setScalar(Math.max(1e-3, d.def.scale * unit))
      d.mesh.visible = fx.debrisOpacity > 0.002
      ;(d.mesh.material as THREE.Material).opacity = fx.debrisOpacity
    }
  }

  return {
    group,
    arm,
    update,
    active: () => group.visible,
    dispose() {
      for (const g of geos) g.dispose()
      for (const m of materials) m.dispose()
      for (const t of textures) t.dispose()
    }
  }
}
