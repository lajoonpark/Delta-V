/**
 * Shared 3D planet construction: one seeded sphere (the equirect surface from
 * planetGen — same seed → same planet in the orbit view, the lander stage and
 * view-transition flights) plus the milestone ring. Termini/gloss come from
 * scene lighting, never baked into the surface.
 */
import * as THREE from 'three'
import { colorRamp, getPlanetEquirect, hsl, planetSpec } from './planetGen'

export interface PlanetBuild {
  group: THREE.Group
  /** Spin this mesh's rotation.y — the ring stays put. */
  spinMesh: THREE.Mesh
  dispose(): void
}

export function buildPlanet(seed: string, ring: boolean): PlanetBuild {
  const group = new THREE.Group()

  const tex = new THREE.CanvasTexture(getPlanetEquirect(seed))
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), mat)
  group.add(mesh)

  let ringMesh: THREE.Mesh | null = null
  if (ring) {
    const tone = colorRamp(seed).scale[2]
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(hsl(tone.h, tone.s, tone.l + 0.1)),
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    })
    ringMesh = new THREE.Mesh(new THREE.RingGeometry(1.38, 1.92, 96), ringMat)
    ringMesh.rotation.x = -Math.PI / 2 + 0.62
    ringMesh.rotation.z = planetSpec(seed).ringAngle
    group.add(ringMesh)
  }

  return {
    group,
    spinMesh: mesh,
    dispose() {
      tex.dispose()
      mat.dispose()
      mesh.geometry.dispose()
      if (ringMesh) {
        ringMesh.geometry.dispose()
        ;(ringMesh.material as THREE.Material).dispose()
      }
    }
  }
}

/**
 * Render one lit planet to a 2D canvas (transparent background) — used for the
 * flying planet in cross-view transitions, so the sprite is a real 3D render
 * handing off to the 3D views at either end, never a flat cutout. Lights match
 * the lander stage (bluish ambient + warm key from upper-left).
 *
 * The canvas is 2× `planetPx` with the planet's diameter exactly `planetPx`
 * centered — room for the milestone ring to overflow the planet like it does
 * on the stage, without clipping at the canvas edge.
 */
export function snapshotPlanet(seed: string, ring: boolean, planetPx: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const canvasPx = Math.max(1, Math.round(planetPx * 2))
  out.width = Math.max(1, Math.round(canvasPx * dpr))
  out.height = out.width

  const scratch = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({
    canvas: scratch,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(dpr)
  renderer.setSize(canvasPx, canvasPx, false)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50)
  // Planet diameter (2 world units) spans half the frame → exactly planetPx.
  camera.position.set(0, 0, 5)

  scene.add(new THREE.AmbientLight(0x2a3442, 1.6))
  const key = new THREE.DirectionalLight(0xfff1e0, 2.4)
  key.position.set(-4, 3, 6)
  scene.add(key)

  const planet = buildPlanet(seed, ring)
  planet.group.rotation.y = 0.6
  planet.group.rotation.z = 0.1
  scene.add(planet.group)

  renderer.render(scene, camera)
  const ctx = out.getContext('2d')
  if (ctx) ctx.drawImage(scratch, 0, 0, out.width, out.height)

  planet.dispose()
  renderer.dispose()
  return out
}
