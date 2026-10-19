/**
 * Camera dolly match-move: solve the orbit camera pose that frames a planet at
 * an exact screen rect (the lander stage's planet rect), so the orbit → stage
 * transition can be one continuous camera push-in instead of a flying sprite.
 *
 * Pure math — no three.js. The camera keeps the same "up" convention as
 * `orbitLayout.projectPoint` (a pure rotation about the X axis), so the home
 * pose is recovered exactly at t=0 and the stage's head-on framing at t=1.
 * Orientation is the single angle `theta` (rad about +X):
 *
 *   theta = -elevation  →  the orbit home pose (looking down at the plane)
 *   theta = 0           →  the lander stage's pose (head-on, looking along -Z)
 *
 * which makes slerp a plain lerp of the angle.
 */

/** Screen framing: top-left + diameter, in the canvas's own pixels. */
export interface Frame {
  x: number
  y: number
  size: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Camera pose: position + pitch about X (yaw/roll stay 0, matching both scenes). */
export interface CameraPose {
  position: Vec3
  /** Rotation about the +X axis (rad). */
  theta: number
  fovDeg: number
}

function tanHalf(fovDeg: number): number {
  return Math.tan((fovDeg * Math.PI) / 360)
}

/** Camera basis for a pitch of `theta` about +X (matches projectPoint at its
 *  home elevation: right = +X, up = (0, cosθ, sinθ), back = (0, -sinθ, cosθ)). */
function basis(theta: number): { x: Vec3; y: Vec3; z: Vec3 } {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return {
    x: { x: 1, y: 0, z: 0 },
    y: { x: 0, y: c, z: s },
    z: { x: 0, y: -s, z: c }
  }
}

/**
 * Solve the camera pose that projects `planet` to `target` — center
 * (x + size/2, y + size/2) and radius size/2 — with the given pitch and fov.
 *
 * The solve is the exact inverse of {@link projectWithCamera}: framing is
 * exact for any pitch, so the caller is free to animate theta/fov while this
 * re-solves every frame and the planet stays pinned to the rect.
 */
export function solveFocusCamera(opts: {
  width: number
  height: number
  planet: Vec3
  /** World radius of the planet (sphere, not ring). */
  planetRadius: number
  target: Frame
  theta: number
  fovDeg: number
}): CameraPose {
  const w = Math.max(2, opts.width)
  const h = Math.max(2, opts.height)
  const { x: rx, y: ry, z: rz } = basis(opts.theta)
  const t = tanHalf(opts.fovDeg)
  const aspect = w / h

  const cx = opts.target.x + opts.target.size / 2
  const cy = opts.target.y + opts.target.size / 2
  const rPx = Math.max(1e-3, opts.target.size / 2)

  // Depth that makes the sphere's linear projection exactly `rPx` wide — the
  // same `radius * scale` convention orbitLayout/landerStage use for radii.
  const depth = Math.max(1e-3, (opts.planetRadius * (h / 2)) / (t * rPx))
  // Planet's view-space offset from the camera (the rect, back-projected).
  const vx = ((cx - w / 2) * 2) / w * t * aspect * depth
  const vy = (-(cy - h / 2) * 2) / h * t * depth

  // C = P - vx·X - vy·Y + depth·Z  (Z points behind the camera).
  return {
    position: {
      x: opts.planet.x - vx * rx.x - vy * ry.x + depth * rz.x,
      y: opts.planet.y - vx * rx.y - vy * ry.y + depth * rz.y,
      z: opts.planet.z - vx * rx.z - vy * ry.z + depth * rz.z
    },
    theta: opts.theta,
    fovDeg: opts.fovDeg
  }
}

export interface Projection {
  x: number
  y: number
  depth: number
  /** World unit → screen px at this depth (for radii). */
  scale: number
}

/** Project a world point with an arbitrary pose — same conventions as
 *  `orbitLayout.projectPoint` (y-down pixels). */
export function projectWithCamera(
  pose: CameraPose,
  width: number,
  height: number,
  p: Vec3
): Projection {
  const w = Math.max(2, width)
  const h = Math.max(2, height)
  const { x: rx, y: ry, z: rz } = basis(pose.theta)
  const dx = p.x - pose.position.x
  const dy = p.y - pose.position.y
  const dz = p.z - pose.position.z
  const vx = dx * rx.x + dy * rx.y + dz * rx.z
  const vy = dx * ry.x + dy * ry.y + dz * ry.z
  const depth = -(dx * rz.x + dy * rz.y + dz * rz.z)
  const t = tanHalf(pose.fovDeg)
  const aspect = w / h
  const d = Math.max(1e-3, depth)
  return {
    x: w / 2 + ((vx / d / t / aspect) * w) / 2,
    y: h / 2 - ((vy / d / t) * h) / 2,
    depth,
    scale: h / 2 / t / d
  }
}

/** The pose's world-space framing rect — the inverse of {@link solveFocusCamera}. */
export function frameOf(
  pose: CameraPose,
  width: number,
  height: number,
  planet: Vec3,
  planetRadius: number
): Frame {
  const p = projectWithCamera(pose, width, height, planet)
  const r = planetRadius * p.scale
  return { x: p.x - r, y: p.y - r, size: r * 2 }
}

/** Damped settle used by the dolly (calm at both ends — an authored push-in). */
export function easeInOut(t: number): number {
  const u = Math.min(1, Math.max(0, t))
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpFrame(a: Frame, b: Frame, t: number): Frame {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    size: lerp(a.size, b.size, t)
  }
}


export const LAUNCH_CINEMATIC_MS = 2000
export const LAUNCH_DIVE_MS = 1650
export const LAUNCH_STAGE_UNMOUNT_MS = 1600
export const LAUNCH_DURATION_FLOOR_MS = 250

/**
 * Normalized dive progress at which the hero lander strikes the planet's near
 * surface. The lander holds this pose (and the crash FX fire) for the rest of
 * the dive, while the black curtain closes over the aftermath. Set well before
 * the curtain ramp (see styles/index.css) so the explosion, shake and debris
 * all get room to play before the frame goes black.
 */
export const LAUNCH_IMPACT_T = 0.6

/** Dive progress at which the fall starts (the lander leaves its rise). */
export const LAUNCH_FLIGHT_START = 0.08

/**
 * The stage → terminal launch cinematic runs at a fixed 2000ms duration when
 * transitionDurationMs is above the floor (250ms), and hard-cuts when <= 250ms,
 * === 0, or when OS reduced-motion is active.
 */
export function shouldPlayLaunchCinematic(
  transitionDurationMs: number,
  reducedMotion: boolean
): boolean {
  return !reducedMotion && transitionDurationMs > LAUNCH_DURATION_FLOOR_MS
}

export interface LaunchStepInput {
  width: number
  height: number
  /** Resting planet screen position & radius from layoutLanderStage. */
  planetScreen: { x: number; y: number; radius: number }
  /** Normalized progress t in [0, 1] over the 3D dive (LAUNCH_DIVE_MS). */
  t: number
  /** Resting camera Z (default 10) and vertical FOV in degrees (default 45). */
  camZ?: number
  fovDeg?: number
  /**
   * World half-extent of the hero lander. The lander's center stops this far
   * outside the surface so the vehicle rests ON the planet instead of passing
   * through it. Defaults to a small fraction of the planet radius.
   */
  landerRadius?: number
}

export interface LaunchStepPose {
  /** World-space planet center (slides from left to (0, 0, 0)). */
  planetPosition: Vec3
  /** World-space planet radius. */
  planetRadius: number
  /** World-space hero lander position along its rise-and-punch arc. */
  landerPosition: Vec3
  /** Hero lander pitch about +X (rad) — nose aligned with trajectory tangent. */
  landerPitchX: number
  /** Mix (1 → 0) of resting yaw remaining on the hero lander. */
  landerYawMix: number
  /** Hero lander visibility/opacity (0 before rise starts, 1 during flight). */
  landerOpacity: number
  /** Hero lander thruster intensity (0..1). */
  landerThrust: number
  /** Slot landers opacity multiplier (1 at t=0, fades to 0 early). */
  slotLandersOpacity: number
  /**
   * Impact burst age in [0, 1]: 0 until the lander strikes the surface, then
   * ramps to 1 by the end of the dive. Drives the crash flash + shock ring.
   */
  impact: number
  /**
   * How far into the fall the lander is, 0 (still rising) → 1 (at the strike).
   * The dive-look FX (radial blur, speed lines) ramp on this, so they peak
   * exactly as the lander arrives and stop the instant it touches down.
   */
  dive: number
  /** Camera world position (starts at (0, 0, camZ), pushes in — stays outside). */
  cameraPosition: Vec3
  /** Camera lookAt target in world space (settles onto the crash site). */
  cameraTarget: Vec3
}

/**
 * Solve the stage → terminal launch cinematic pose at normalized progress `t`:
 * the planet recenters, the selected hero lander rises, arcs over and crashes
 * onto the planet's near surface on a cubic Bézier, and the camera pushes in
 * toward the impact but stays outside the planet — it never enters the mesh.
 * The lander holds its crash pose while the burst fires and the black closes.
 */
export function solveLaunchStep(input: LaunchStepInput): LaunchStepPose {
  const w = Math.max(2, input.width)
  const h = Math.max(2, input.height)
  const camZ = input.camZ ?? 10
  const fovDeg = input.fovDeg ?? 45
  const t = Math.min(1, Math.max(0, input.t))
  const tanHalfFov = tanHalf(fovDeg)
  const wpp = (2 * tanHalfFov * camZ) / h
  const restX = (input.planetScreen.x - w / 2) * wpp
  const restY = (h / 2 - input.planetScreen.y) * wpp
  const planetRadius = Math.max(0.2, input.planetScreen.radius * wpp)

  // Slot landers fade out early.
  const slotT = Math.min(1, Math.max(0, t / 0.18))
  const slotLandersOpacity = Math.pow(1 - slotT, 3)

  // Planet recenter (t in [0, 0.44]).
  const recenterT = easeInOut(Math.min(1, Math.max(0, t / 0.44)))
  const planetPosition: Vec3 = {
    x: lerp(restX, 0, recenterT),
    y: lerp(restY, 0, recenterT),
    z: 0
  }

  // Hero lander crash-dive cubic Bézier (rise t in [0.08, IMPACT], hold after).
  const flightStart = LAUNCH_FLIGHT_START
  const flightSpan = Math.max(1e-3, LAUNCH_IMPACT_T - flightStart)
  const flightRaw = Math.min(1, Math.max(0, (t - flightStart) / flightSpan))
  const s = easeInOut(flightRaw)
  const startZ = Math.min(camZ - 2.2, planetRadius + 2.6)
  const halfHAtStart = (camZ - startZ) * tanHalfFov
  const landerRadius = Math.max(0.12, input.landerRadius ?? planetRadius * 0.2)
  // Crash site: a point on the planet's near surface, a little below the equator
  // (toward the camera). The lander's center rests `0.7·landerRadius` outside so
  // the body touches the mesh without the vehicle passing through it.
  const impactNormal = { x: 0, y: -0.32, z: 0.947 }
  const restDist = planetRadius + landerRadius * 0.7
  const contact: Vec3 = {
    x: impactNormal.x * restDist,
    y: impactNormal.y * restDist,
    z: impactNormal.z * restDist
  }
  const p0: Vec3 = { x: restX * 0.1, y: -halfHAtStart - 0.65, z: startZ }
  const p1: Vec3 = { x: restX * 0.03, y: planetRadius * 0.28, z: planetRadius + 2.2 }
  const p2: Vec3 = { x: 0, y: planetRadius * 0.03, z: planetRadius + 1.15 }
  const p3: Vec3 = contact
  const u = 1 - s
  const bw0 = u * u * u
  const bw1 = 3 * u * u * s
  const bw2 = 3 * u * s * s
  const bw3 = s * s * s
  const landerPosition: Vec3 = {
    x: bw0 * p0.x + bw1 * p1.x + bw2 * p2.x + bw3 * p3.x,
    y: bw0 * p0.y + bw1 * p1.y + bw2 * p2.y + bw3 * p3.y,
    z: bw0 * p0.z + bw1 * p1.z + bw2 * p2.z + bw3 * p3.z
  }
  const dB: Vec3 = {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * s * (p2.x - p1.x) + 3 * s * s * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * s * (p2.y - p1.y) + 3 * s * s * (p3.y - p2.y),
    z: 3 * u * u * (p1.z - p0.z) + 6 * u * s * (p2.z - p1.z) + 3 * s * s * (p3.z - p2.z)
  }
  const landerPitchX = Math.atan2(dB.z, dB.y)
  const yawFade = easeInOut(Math.min(1, Math.max(0, (flightRaw - 0.2) / 0.6)))
  const landerYawMix = 1 - yawFade
  const landerOpacity = t <= flightStart ? 0 : Math.min(1, (t - flightStart) / 0.06)
  // Engines burn through the dive, then die at the moment of impact.
  const landerThrust =
    t <= flightStart
      ? 0
      : t <= LAUNCH_IMPACT_T
        ? Math.min(1, (t - flightStart) / 0.08)
        : Math.max(0, 1 - (t - LAUNCH_IMPACT_T) / 0.05)

  // Impact burst age: 0 until the lander strikes the surface, → 1 at the end.
  const impact = Math.min(
    1,
    Math.max(0, (t - LAUNCH_IMPACT_T) / Math.max(1e-3, 1 - LAUNCH_IMPACT_T))
  )

  // Dive progress for the speed FX: 0 through the rise, 1 exactly at the
  // strike. Deliberately NOT eased — the blur should track raw closing speed.
  const dive = flightRaw

  // Camera push-in toward the crash (t in [0.18, IMPACT]); it settles outside
  // the planet and holds through the impact — it never enters the mesh.
  const camRaw = Math.min(1, Math.max(0, (t - 0.18) / Math.max(1e-3, LAUNCH_IMPACT_T - 0.18)))
  const camS = easeInOut(camRaw)
  const c0: Vec3 = { x: 0, y: 0, z: camZ }
  const c1: Vec3 = { x: 0, y: planetRadius * 0.08, z: camZ - (camZ - planetRadius) * 0.25 }
  const c2: Vec3 = { x: 0, y: planetRadius * 0.05, z: planetRadius + 3.4 }
  const c3: Vec3 = { x: 0, y: -planetRadius * 0.3, z: planetRadius + 3.0 }
  const cu = 1 - camS
  const cw0 = cu * cu * cu
  const cw1 = 3 * cu * cu * camS
  const cw2 = 3 * cu * camS * camS
  const cw3 = camS * camS * camS
  const cameraPosition: Vec3 = {
    x: cw0 * c0.x + cw1 * c1.x + cw2 * c2.x + cw3 * c3.x,
    y: cw0 * c0.y + cw1 * c1.y + cw2 * c2.y + cw3 * c3.y,
    z: cw0 * c0.z + cw1 * c1.z + cw2 * c2.z + cw3 * c3.z
  }
  const cameraTarget: Vec3 = {
    x: lerp(0, landerPosition.x, camS),
    y: lerp(0, landerPosition.y, camS),
    z: lerp(0, landerPosition.z, camS)
  }

  return {
    planetPosition,
    planetRadius,
    landerPosition,
    landerPitchX,
    landerYawMix,
    landerOpacity,
    landerThrust,
    slotLandersOpacity,
    impact,
    dive,
    cameraPosition,
    cameraTarget
  }
}
