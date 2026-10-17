/**
 * Pure-module checks for the Delta-V Remote mobile client. No DOM: bundles and
 * runs in plain node.
 *
 * Run: npx esbuild tools/remote-client-pure-check.ts --bundle --format=cjs --platform=node --alias:@shared=./src/shared --outfile=/tmp/remote-client-pure-check.cjs && node /tmp/remote-client-pure-check.cjs
 */
import { browserEnv, backoffDelayMs } from '../src/renderer/src/remote/env'
import { extractToken, TOKEN_STORAGE_KEY } from '../src/renderer/src/remote/pairing'
import { ViewerSync } from '../src/renderer/src/remote/viewerSync'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  PASS ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const UUID = '123e4567-e89b-12d3-a456-426614174000'

// ── extractToken ────────────────────────────────────────────────────────────
console.log('extractToken')
{
  const cases: Array<[string, string, string | null]> = [
    ['raw uuid', UUID, UUID],
    ['hash-prefixed uuid', `#${UUID}`, UUID],
    ['full pairing URL', `http://192.168.1.5:4137/#${UUID}`, UUID],
    ['whitespace around uuid', `  ${UUID}  `, UUID],
    ['too short', 'abc123', null],
    ['invalid chars', `${UUID}!`, null],
    ['empty', '', null],
    ['URL without hash', 'http://192.168.1.5:4137/', null]
  ]
  for (const [name, input, expected] of cases) {
    check(name, extractToken(input) === expected, `got ${JSON.stringify(extractToken(input))}`)
  }
  check('TOKEN_STORAGE_KEY', TOKEN_STORAGE_KEY === 'deltav.remote.token', TOKEN_STORAGE_KEY)
}

// ── backoffDelayMs ──────────────────────────────────────────────────────────
console.log('backoffDelayMs')
{
  const cases: Array<[number, number]> = [
    [1, 500],
    [2, 1000],
    [3, 2000],
    [4, 5000],
    [9, 5000],
    [0, 500],
    [-3, 500]
  ]
  for (const [failures, expected] of cases) {
    const got = backoffDelayMs(failures)
    check(`${failures} → ${expected}`, got === expected, `got ${got}`)
  }
}

// ── ViewerSync ──────────────────────────────────────────────────────────────
console.log('ViewerSync')
{
  const vs = new ViewerSync()
  check('not synced before snapshot', !vs.synced)
  check('wait before snapshot', vs.live(0, 'x').kind === 'wait')

  vs.applySnapshot(10)
  check('synced after snapshot', vs.synced)
  check('skip duplicate', vs.live(0, 'abcde').kind === 'skip')

  vs.reset()
  check('not synced after reset', !vs.synced)
  check('wait again after reset', vs.live(0, 'x').kind === 'wait')

  const exact = new ViewerSync()
  exact.applySnapshot(5)
  const e = exact.live(5, 'hello')
  check('exact continuation writes full data', e.kind === 'write' && e.data === 'hello')

  const partial = new ViewerSync()
  partial.applySnapshot(3)
  const p = partial.live(0, 'abcde')
  check('partial overlap sliced', p.kind === 'write' && p.data === 'de', JSON.stringify(p))

  const gap = new ViewerSync()
  gap.applySnapshot(5)
  check('gap resyncs', gap.live(10, 'x').kind === 'resync')
  check('gap leaves end unadvanced (duplicate then skipped)', gap.live(0, 'abcde').kind === 'skip')

  // Many contiguous chunks must concatenate exactly.
  const seq = new ViewerSync()
  seq.applySnapshot(0)
  const chunks = ['one', 'two', 'three', 'four', 'five']
  let out = ''
  let off = 0
  let contiguous = true
  for (const c of chunks) {
    const a = seq.live(off, c)
    if (a.kind !== 'write' || a.data !== c) contiguous = false
    out += a.kind === 'write' ? a.data : ''
    off += c.length
  }
  check('contiguous chunk sequence writes all', contiguous && out === chunks.join(''), out)
  check('still synced after sequence', seq.synced)
}

// ── env smoke ───────────────────────────────────────────────────────────────
console.log('env')
{
  // Importing env.ts in node must not throw (reaching here proves it) and it
  // must export browserEnv as a function — but we never call it here.
  check('browserEnv is a function', typeof browserEnv === 'function')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall remote-client-pure checks passed')
process.exit(0)
