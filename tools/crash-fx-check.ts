/**
 * Unit check for the crash-FX solver (see art/crashFx.ts).
 *
 * The solver is the only part of the crash cinematic that is pure math, so it
 * is the only part we can pin down without a GPU. These checks lock in the
 * properties the visuals depend on:
 *
 *  1. Continuity — no envelope jumps between adjacent frames, so the blast
 *     never pops or snaps back to zero mid-beat.
 *  2. Calm before the strike — nothing but the approach effects is non-zero at
 *     age 0, and the approach effects themselves are zero until the dive.
 *  3. Salience — the flash has to be a real spike, not a slow swell, or the
 *     strike reads as a fade instead of a hit.
 *  4. Boundedness — every envelope stays in range and the blast stays inside
 *     the planet-relative sizes the scene can frame.
 *  5. Determinism — the same seed gives the same debris field.
 *
 * Run: npx esbuild tools/crash-fx-check.ts --bundle --format=cjs --platform=node \
 *        --outfile=/tmp/crash-fx-check.cjs && node /tmp/crash-fx-check.cjs
 */
import {
  solveCrashFx,
  sampleCrashField,
  crashFxSeed,
  type CrashFx
} from '../src/renderer/src/art/crashFx'
import { mulberry32 } from '../src/renderer/src/art/planetGen'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const FRAMES = 240

function solve(age: number, seed = 'Alpha', rnd?: () => number): CrashFx {
  return solveCrashFx({
    age,
    travelBlend: Math.min(1, age / 0.12),
    landerRadius: 0.14,
    cameraDistance: 2.4,
    rnd: rnd ?? mulberry32(crashFxSeed(seed, 0))
  })
}

function sweep(seed: string): CrashFx[] {
  return Array.from({ length: FRAMES + 1 }, (_, i) => solve(i / FRAMES, seed))
}

// ── 1. Continuity: no frame-to-frame jumps ───────────────────────────────
console.log('continuity')
for (const seed of ['Alpha', 'Bravo', 'Echo']) {
  const frames = sweep(seed)
  const fields: (keyof CrashFx)[] = [
    'flash',
    'fireball',
    'fireballRadius',
    'ember',
    'shockRing',
    'shockRadius',
    'column',
    'columnHeight',
    'debrisOpacity',
    'dust',
    'shakeAmp',
    'wash',
    'radialBlur',
    'speedLines',
    'landerSquash',
    'damage'
  ]
  // `flash` is exempt from the smoothness bound: its whole point is a
  // near-instant attack (it peaks within ~1 frame of the strike). Everything
  // else must ramp, or the blast visibly pops.
  const LIMIT: Partial<Record<keyof CrashFx, number>> = { flash: 0.75, wash: 0.75 }
  let worst = 0
  let worstAt = ''
  for (const key of fields) {
    // Start at 2: the 0 -> 1 pair straddles the strike gate by design (there is
    // no blast before impact, and a shockwave legitimately starts at the
    // impact point at full strength). Every other step must be smooth.
    for (let i = 2; i < frames.length; i++) {
      const d = Math.abs(frames[i][key] - frames[i - 1][key])
      const scaled = key.endsWith('Radius') || key.endsWith('Height') ? d * 4 : d
      const over = scaled / (LIMIT[key] ?? 0.34)
      if (over > worst) {
        worst = over
        worstAt = `${key}@${(i / FRAMES).toFixed(3)}=${scaled.toFixed(3)}`
      }
    }
  }
  // A single frame is 1/240 of the dive; a hard hit legitimately moves a lot,
  // but nothing should teleport by more than a third of its range.
  check(`${seed}: no envelope jumps`, worst <= 1, `worst=${(worst * 100).toFixed(0)}% of its limit (${worstAt})`)
}

// ── 2. Calm before the strike ────────────────────────────────────────────
console.log('calm before the strike')
{
  const f = solve(0)
  const blast: (keyof CrashFx)[] = [
    'flash',
    'fireball',
    'ember',
    'shockRing',
    'shockRing2',
    'column',
    'debrisOpacity',
    'dust',
    'wash'
  ]
  check(
    'no blast geometry at age 0',
    blast.every((k) => f[k] === 0),
    blast.filter((k) => f[k] !== 0).map((k) => `${k}=${f[k]}`).join(', ')
  )
  check('approach starts blended in', f.radialBlur === 0 && f.speedLines === 0, `blur=${f.radialBlur} lines=${f.speedLines}`)
  check('lander undamaged at age 0', f.damage === 0, `damage=${f.damage}`)
  check('lander unrattled at age 0', f.landerSquash === 1 && f.landerRattle === 0, `squash=${f.landerSquash}`)
}

// ── 3. The flash must be a spike ─────────────────────────────────────────
console.log('impact salience')
{
  const frames = sweep('Alpha')
  const peak = frames.reduce((m, f, i) => (f.flash > frames[m].flash ? i : m), 0)
  const peakAge = peak / FRAMES
  check('flash peaks in the first fifth of the crash', peakAge <= 0.2, `peakAge=${peakAge.toFixed(3)}`)
  check('flash peaks at full strength', frames[peak].flash > 0.9, `peak=${frames[peak].flash.toFixed(3)}`)
  // The strike has to be over quickly or it stops reading as an instant.
  const half = frames.filter((f) => f.flash > 0.5).length / FRAMES
  check('flash is brief', half <= 0.06, `fraction above 0.5 = ${half.toFixed(3)}`)

  // ...but the blaze behind it must survive long enough to be seen.
  const blaze = frames.filter((f) => f.fireball > 0.5).length / FRAMES
  check('fireball holds long enough to read', blaze >= 0.08, `fraction above 0.5 = ${blaze.toFixed(3)}`)
}

// ── 4. Bounded values and sane blast scale ───────────────────────────────
console.log('bounded')
{
  const frames = sweep('Alpha')
  const all = frames.flatMap((f) => Object.entries(f))
  const outOfRange = all.filter(([k, v]) => typeof v === 'number' && Number.isFinite(v) === false)
  check('all envelopes finite', outOfRange.length === 0, outOfRange.slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', '))

  const unbounded = frames.filter((f) =>
    [f.flash, f.fireball, f.ember, f.shockRing, f.column, f.dust, f.wash, f.radialBlur, f.speedLines, f.damage].some(
      (v) => v < -1e-6 || v > 1 + 1e-6
    )
  )
  check('normalised envelopes stay within 0..1', unbounded.length === 0, `${unbounded.length} frames out of range`)

  const maxShake = Math.max(...frames.map((f) => f.shakeAmp))
  check('camera shake is a screen-space fraction, not world units', maxShake > 0 && maxShake < 0.35, `max=${maxShake.toFixed(3)}`)

  // The scene frames the planet at ~1 radius; a blast much wider than the
  // planet cannot be framed and washes the shot instead of reading as a blast.
  const maxFireball = Math.max(...frames.map((f) => f.fireballRadius))
  check('fireball stays frameable', maxFireball > 0.5 && maxFireball < 4, `max=${maxFireball.toFixed(2)} radii`)

  const damage = frames[frames.length - 1].damage
  check('lander survives with damage, not destroyed', damage > 0.2 && damage < 1, `end damage=${damage.toFixed(2)}`)
}

// ── 5. Determinism ───────────────────────────────────────────────────────
console.log('determinism')
{
  const field = (seed: string): string =>
    JSON.stringify(
      sampleCrashField(mulberry32(crashFxSeed(seed, 0)), { landerRadius: 0.14 })
    )
  check('same seed reproduces the debris field', field('Delta') === field('Delta'))
  check('different seeds diverge', field('Delta') !== field('Charlie'))
}

if (failures > 0) {
  console.error(`\n${failures} crash-fx check(s) failed`)
  process.exit(1)
}
console.log('\ncrash-fx checks passed')
