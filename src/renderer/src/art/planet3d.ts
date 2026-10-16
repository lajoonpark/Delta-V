/**
 * Shared 3D planet construction: one seeded sphere (the equirect surface from
 * planetGen — same seed → same planet in the orbit view and the lander stage)
 * plus the milestone ring. Termini/gloss come from scene lighting, never baked
 * into the surface. The lander stage mirrors this construction exactly so the
 * camera-dive handoff shows one planet, not two slightly different ones.
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
