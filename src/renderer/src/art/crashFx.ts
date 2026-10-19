/**
 * Crash-FX solver: one pure function turns a crash age into every number the
 * impact needs — flash, fireball, shock rings, debris, dust, camera shake,
 * radial blur/speed lines and the hero lander's jolt + damage.
 *
 * Pure math, no three.js: `landerScene` and `crashPass` only read the result,
 * and `tools/crash-fx-check.ts` exercises it under Node. Everything is
 * expressed in *planet radii* and radians so nothing here depends on the
 * viewport; the scene converts to world units and the pass to screen space.
 *
 * Age convention — `CrashFxInput.age` is 0 at the strike and 1 at the end of
 * the dive. Impact beats overlap deliberately (the fireball is still blooming
 * while the shock ring is already racing out), so all envelopes are piecewise
 * on age rather than one shared ramp.
 */

/** Damped overshoot (a hard hit that settles). */
export function easeOutBack(t: number, overshoot = 1.7): number {
  const u = Math.min(1, Math.max(0, t))
  const c = overshoot + 1
  return 1 + c * Math.pow(u - 1, 3) + overshoot * Math.pow(u - 1, 2)
}

/** Sharp attack, slow decay — the shape of a hit that flares then dies. */
export function spike(t: number, attack: number, decay: number): number {
  const u = Math.min(1, Math.max(0, t))
  if (u <= attack) return attack <= 0 ? 1 : u / attack
  const fall = Math.max(0, 1 - (u - attack) / Math.max(1e-3, decay))
  return fall * fall
}

function band(t: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (t - from) / Math.max(1e-3, to - from)))
}

export interface CrashFxInput {
  /** Crash age: 0 at the strike, 1 at the end of the dive. */
  age: number
  /**
   * Dive position blended toward the impact (0 → 1 as `age` goes 0 → ~0.12).
   * Used so the fireball launches *from* the lander rather than popping at a
   * fixed point.
   */
  travelBlend: number
  /** Hero lander's world half-extent, in planet radii. */
  landerRadius: number
  /** Camera distance from the crash site, in planet radii. */
  cameraDistance: number
  /** Deterministic per-launch RNG stream (see `crashFxSeed`). */
  rnd: () => number
}

/** A single chunk of hull thrown clear of the impact. */
export interface CrashDebris {
  /** Direction in the impact's local frame (+Z = surface normal). */
  dirX: number
  dirY: number
  dirZ: number
  /** Speed against the flight clock (radius/second, pre-drag). */
  speed: number
  /** Exponent on the drag term — bigger = shorter throw. */
  drag: number
  scale: number
  spinX: number
  spinY: number
  spinZ: number
  hot: number
  variant: number
}

/** A dust/steam puff expanding along the surface. */
export interface CrashPuff {
  dirX: number
  dirY: number
  dirZ: number
  speed: number
  scale: number
  growth: number
  delay: number
  variant: number
}

export interface CrashFx {
  /** White-hot core: 1 at the strike, gone within a few frames. */
  flash: number
  /** Blooming fireball: peaks early, swells, then thins out. */
  fireball: number
  /** Fireball radius in planet radii. */
  fireballRadius: number
  /** Lingering ember glow left in the crater. */
  ember: number
  /** Ground-hugging shockwave ring that races out past the fireball. */
  shockRing: number
  shockRadius: number
  /** Second, slower ring — gives the blast a double beat. */
  shockRing2: number
  shockRadius2: number
  /** Vertical blast column. */
  column: number
  columnHeight: number
  /** How far the debris field has been flying (seconds of ballistic flight). */
  debrisClock: number
  debrisOpacity: number
  /** Overall dust veil opacity. */
  dust: number
  /** Camera shake amplitude, in screen fractions of the half-height. */
  shakeAmp: number
  /** Camera shake phase (rad) — the scene turns this into offsets. */
  shakePhase: number
  /** 0 → 1 flash wash over the whole frame at the strike. */
  wash: number
  /** Radial motion blur strength (0..1) during the dive. */
  radialBlur: number
  /** Cartoon speed-line opacity (0..1) during the dive. */
  speedLines: number
  /** Hero lander's recoil: vertical squash-and-stretch (1 = undisturbed). */
  landerSquash: number
  /** Hero lander's recoil: extra pitch (rad). */
  landerRattle: number
  /** Hull damage 0 → 1, driving sooting/embers on the hero mesh. */
  damage: number
}

/** Deterministic per-launch FX seed (same seed + index → same blast). */
export function crashFxSeed(seed: string, index: number): number {
  let h = 2166136261 >>> 0
  const s = `${seed}:crash-fx:${index}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export const CRASH_DEBRIS_COUNT = 14
export const CRASH_PUFF_COUNT = 9
/** Age at which the camera shake has fully rung down. */
export const CRASH_SHAKE_END = 0.85

export function solveCrashFx(input: CrashFxInput): CrashFx {
  const age = Math.min(1, Math.max(0, input.age))
  const lr = Math.max(1e-3, input.landerRadius)
  const camD = Math.max(1e-3, input.cameraDistance)

  // ── Dive look: radial blur + speed lines ramp in with the fall. These are
  //    the only outputs that are non-zero *before* the strike, so they are
  //    solved up front and reused by the pre-impact early-out below. ──
  const travel = Math.min(1, Math.max(0, input.travelBlend))
  const dive = Math.pow(band(travel, 0, 1), 1.4)
  const approachBlur = clamp01(0.8 * dive)
  const approachLines = clamp01(0.16 * band(travel, 0, 0.3) + 0.84 * dive)

  // Before the strike there is no blast at all. Returning here keeps every
  // impact envelope honest — most of them are 1 at age 0 (a fireball is
  // "starting", a ring is "fully rolled out"), which would otherwise paint a
  // full explosion across the whole approach.
  if (age <= 0) {
    return {
      flash: 0,
      fireball: 0,
      fireballRadius: lr * 0.35,
      ember: 0,
      shockRing: 0,
      shockRadius: lr,
      shockRing2: 0,
      shockRadius2: lr,
      column: 0,
      columnHeight: 0,
      debrisClock: 0,
      debrisOpacity: 0,
      dust: 0,
      shakeAmp: 0,
      shakePhase: 0,
      wash: 0,
      radialBlur: approachBlur,
      speedLines: approachLines,
      landerSquash: 1,
      landerRattle: 0,
      damage: 0
    }
  }

  // ── Flash: one hard frame of white-hot light, centred on the strike. ──
  // At 1650ms total the whole post-impact window is only ~10 frames, so the
  // attack has to be near-instant and the decay short — otherwise the flash
  // lingers and washes the explosion (and the lander) out of the frame.
  const flash = spike(age, 0.012, 0.06)

  // ── Fireball: blooms hard, swells, thins out. Sized off the lander, which
  //    is what the eye reads as "how big was that" — the sphere stack stays
  //    inside the planet's limb so the blast reads against the surface. ──
  const bloom = band(age, 0, 0.26)
  const fireball = Math.max(0, Math.pow(1 - bloom, 1.6))
  const fireballRadius = lr * (0.35 + 3.4 * easeOutBack(bloom, 2.1))

  // ── Ember: the crater keeps glowing after the fireball has gone. Ramps in
  //    over ~2 frames so the crater lights up with the blast instead of
  //    popping on at full strength the instant age leaves 0. ──
  const ember = Math.pow(Math.max(0, 1 - band(age, 0.18, 0.78)), 2) * Math.min(1, age / 0.03)

  // ── Shock rings: a fast one and a slower echo, both ground-hugging. ──
  const ring1 = band(age, 0.04, 0.42)
  const shockRing = Math.pow(1 - ring1, 1.5)
  const shockRadius = lr * (1 + 9.5 * easeOutBack(ring1, 1.2))
  const ring2 = band(age, 0.12, 0.62)
  const shockRing2 = Math.pow(1 - ring2, 1.8)
  const shockRadius2 = lr * (1 + 6.2 * easeOutBack(ring2, 1.35))

  // ── Blast column: kicks straight up off the normal. ──
  const col = band(age, 0.05, 0.55)
  const column = Math.pow(1 - col, 1.7)
  const columnHeight = lr * (1 + 5.5 * easeOutBack(col, 1.9))

  // ── Debris: ballistically thrown chunks, sampled once at launch. ──
  const debrisClock = Math.max(0, age - 0.03) * 2.4
  const debrisOpacity = Math.pow(Math.max(0, 1 - band(age, 0.15, 0.72)), 1.25)

  // ── Dust veil: swells behind the blast, then settles. ──
  const dustRise = band(age, 0.02, 0.34)
  const dustFall = band(age, 0.34, 0.95)
  const dust = 0.6 * Math.pow(dustRise, 0.6) * Math.pow(1 - dustFall, 1.6)

  // ── Camera shake: a hard hit that rings down by CRASH_SHAKE_END. ──
  // Gated on `age > 0`: age is 0 for the whole pre-impact flight, so an
  // ungated envelope would shake at full amplitude before the lander lands.
  const shakeEnv =
    age > 0
      ? Math.pow(Math.max(0, 1 - age / CRASH_SHAKE_END), 1.9) * Math.min(1, age / 0.02)
      : 0
  // Measured against the distance so a closer crash shakes harder on screen.
  const shakeAmp = 0.15 * shakeEnv * (1.6 / Math.max(1.2, camD))
  const shakePhase = age * 46

  // ── Full-frame flash wash — the light from the strike, not the object.
  //    Deliberately brief: at 1650ms the whole aftermath is ~10 frames, so a
  //    long wash would white out the fireball it is supposed to reveal. ──
  const wash = 0.72 * spike(age, 0.015, 0.055)

  // ── Dive look: radial blur and speed lines are *approach* effects. Both die
  //    at the strike, where the blast takes over — leaving the blur running
  //    through the explosion smears the fireball into the background. ──
  const lookFade = Math.pow(Math.max(0, 1 - age / 0.1), 1.5)
  // A short recoil streak right on contact, so the hit itself reads as motion.
  const impactStreak = 0.34 * spike(age, 0.01, 0.09)
  const radialBlur = clamp01(approachBlur * lookFade + impactStreak)
  const lineFade = Math.pow(Math.max(0, 1 - age / 0.16), 1.4)
  const speedLines = clamp01(approachLines * lineFade)

  // ── Hero recoil: squash on contact, then a decaying rattle. ──
  const hit = band(age, 0, 0.14)
  const landerSquash = age > 0 ? 1 - 0.22 * Math.pow(1 - hit, 1.4) : 1
  const landerRattle =
    age > 0 ? 0.22 * Math.pow(Math.max(0, 1 - age / 0.5), 1.6) * Math.cos(age * 62) : 0
  // Capped below 1: the lander survives the crash, so it should read as
  // scorched and battle-worn rather than burnt out.
  const damage = 0.75 * clamp01(band(age, 0.02, 0.35))

  return {
    flash,
    fireball,
    fireballRadius,
    ember,
    shockRing,
    shockRadius,
    shockRing2,
    shockRadius2,
    column,
    columnHeight,
    debrisClock,
    debrisOpacity,
    dust,
    shakeAmp,
    shakePhase,
    wash,
    radialBlur,
    speedLines,
    landerSquash,
    landerRattle,
    damage
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/**
 * Sample the deterministic debris/puff field once, at the strike. The scene
 * builds its meshes from this and then only integrates ballistics, so a
 * re-render of the same launch produces exactly the same blast.
 */
export function sampleCrashField(
  rnd: () => number,
  opts: { count?: number; puffs?: number; landerRadius: number }
): { debris: CrashDebris[]; puffs: CrashPuff[] } {
  const lr = Math.max(1e-3, opts.landerRadius)
  const debris: CrashDebris[] = []
  const n = opts.count ?? CRASH_DEBRIS_COUNT
  for (let i = 0; i < n; i++) {
    // Biased up-and-out off the surface normal, fanned around the impact.
    const theta = rnd() * Math.PI * 2
    const lift = 0.18 + rnd() * 0.85
    const out = Math.sqrt(Math.max(0, 1 - lift * lift)) * (0.6 + rnd() * 0.4)
    debris.push({
      dirX: Math.cos(theta) * out,
      dirY: Math.sin(theta) * out,
      dirZ: lift,
      speed: 4.5 + rnd() * 9.5,
      drag: 1.5 + rnd() * 1.8,
      scale: lr * (0.06 + rnd() * 0.14),
      spinX: (rnd() - 0.5) * 16,
      spinY: (rnd() - 0.5) * 16,
      spinZ: (rnd() - 0.5) * 16,
      hot: 0.25 + rnd() * 0.75,
      variant: rnd()
    })
  }

  const puffs: CrashPuff[] = []
  const pn = opts.puffs ?? CRASH_PUFF_COUNT
  for (let i = 0; i < pn; i++) {
    const theta = (i / pn) * Math.PI * 2 + rnd() * 0.5
    const lift = rnd() * 0.34
    const out = Math.sqrt(Math.max(0, 1 - lift * lift))
    puffs.push({
      dirX: Math.cos(theta) * out,
      dirY: Math.sin(theta) * out,
      dirZ: lift,
      speed: 1.6 + rnd() * 3.4,
      scale: lr * (0.5 + rnd() * 0.7),
      growth: lr * (0.5 + rnd() * 0.9),
      delay: rnd() * 0.16,
      variant: rnd()
    })
  }

  return { debris, puffs }
}

/**
 * Integrate one debris chunk's ballistic throw. Drag is applied analytically
 * so the position is a pure function of the flight clock (no per-frame state).
 */
export function debrisPosition(
  d: CrashDebris,
  clock: number
): { x: number; y: number; z: number } {
  const k = d.drag
  const reach = (1 - Math.exp(-k * clock)) / k
  const rise = reach * d.speed * d.dirZ - 2.6 * clock * clock
  return {
    x: d.dirX * d.speed * reach,
    y: d.dirY * d.speed * reach,
    z: d.dirZ * d.speed * reach + rise * 0.35
  }
}
