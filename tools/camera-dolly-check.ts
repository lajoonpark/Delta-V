/**
 * Unit check for the camera dolly match-move (see art/cameraDolly.ts):
 *
 *  1. `projectWithCamera` agrees with `orbitLayout.projectPoint` on the home
 *     pose (the two projection conventions must be the same math).
 *  2. `solveFocusCamera` is the exact inverse of `projectWithCamera`: a solved
 *     pose frames the planet at the requested rect (center + radius) for any
 *     pitch/fov, including the off-center stage rect.
 *  3. Solving for the planet's home framing returns the home pose exactly —
 *     zero jump at t=0 of the dive.
 *
 * Run: npx esbuild tools/camera-dolly-check.ts --bundle --format=cjs --platform=node \
 *        --alias:@shared=./src/shared --alias:@renderer=./src/renderer/src \
 *        --outfile=/tmp/camera-dolly-check.cjs && node /tmp/camera-dolly-check.cjs
 */
import {
  frameOf,
  projectWithCamera,
  solveFocusCamera,
  solveLaunchStep,
  shouldPlayLaunchCinematic,
  LAUNCH_DURATION_FLOOR_MS,
  LAUNCH_IMPACT_T,
  type CameraPose,
  type Frame,
  type Vec3
} from '../src/renderer/src/art/cameraDolly'
import { CAM, cameraPosition, projectPoint } from '../src/renderer/src/art/orbitLayout'
import { layoutLanderStage } from '../src/renderer/src/art/landerLayout'
import {
  createLaunchSkipController,
  type LaunchSkipEvent
} from '../src/renderer/src/components/viewTransition'

const ELEV = (CAM.elevationDeg * Math.PI) / 180

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

/** Synthetic keydown/keyup event for the launch skip controller. */
function ev(partial: Partial<LaunchSkipEvent> & { key: string }): LaunchSkipEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    ...partial
  }
}

const homePose = (w: number, h: number): CameraPose => {
  const [cx, cy, cz] = cameraPosition(w, h)
  return { position: { x: cx, y: cy, z: cz }, theta: -ELEV, fovDeg: CAM.fovDeg }
}

// ── 1. projectWithCamera ≡ projectPoint on the home pose ──────────────────
console.log('projection agreement (home pose)')
{
  const w = 1280
  const h = 720
  const pose = homePose(w, h)
  const samples: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 19, y: 0, z: -11 },
    { x: -44, y: 2, z: 37 },
    { x: 6.25, y: -1.5, z: -40 }
  ]
  for (const p of samples) {
    const a = projectPoint(w, h, p.x, p.y, p.z)
    const b = projectWithCamera(pose, w, h, p)
    check(
      `project (${p.x}, ${p.y}, ${p.z})`,
      near(a.x, b.x, 1e-6) && near(a.y, b.y, 1e-6) && near(a.depth, b.depth, 1e-6) &&
        near(a.scale, b.scale, 1e-6),
      `projectPoint=(${a.x.toFixed(3)},${a.y.toFixed(3)}) vs (${b.x.toFixed(3)},${b.y.toFixed(3)})`
    )
  }
}

// ── 2. solveFocusCamera is the inverse of the projection ──────────────────
console.log('match-move solve')
{
  const cases: {
    w: number
    h: number
    planet: Vec3
    radius: number
    target: Frame
    theta: number
    fovDeg: number
  }[] = [
    // Stage rect at a typical window: off-center left, ~400px across.
    {
      w: 1280,
      h: 720,
      planet: { x: 31, y: 0, z: -22 },
      radius: 2.1,
      target: { x: 1280 * 0.235 - 200, y: 720 * 0.5 - 200, size: 400 },
      theta: 0,
      fovDeg: 45
    },
    // Mid-dive pitch + a squarer window, target pushed to the top-right.
    {
      w: 900,
      h: 880,
      planet: { x: -12, y: 0, z: 40 },
      radius: 1.2,
      target: { x: 620, y: 40, size: 120 },
      theta: -ELEV * 0.45,
      fovDeg: 41
    },
    // Home framing request (theta at the orbit elevation).
    {
      w: 1440,
      h: 640,
      planet: { x: 8, y: 0, z: 19 },
      radius: 1.9,
      target: { x: 400, y: 300, size: 36 },
      theta: -ELEV,
      fovDeg: CAM.fovDeg
    }
  ]
  for (const [i, c] of cases.entries()) {
    const pose = solveFocusCamera({
      width: c.w,
      height: c.h,
      planet: c.planet,
      planetRadius: c.radius,
      target: c.target,
      theta: c.theta,
      fovDeg: c.fovDeg
    })
    const back = frameOf(pose, c.w, c.h, c.planet, c.radius)
    const got = `got center (${(back.x + back.size / 2).toFixed(3)}, ${(back.y + back.size / 2).toFixed(3)}) r ${(back.size / 2).toFixed(3)}`
    const want = `want center (${(c.target.x + c.target.size / 2).toFixed(3)}, ${(c.target.y + c.target.size / 2).toFixed(3)}) r ${c.target.size / 2}`
    check(
      `case ${i} frames exactly [${want} | ${got}]`,
      near(back.x, c.target.x, 1e-3) &&
        near(back.y, c.target.y, 1e-3) &&
        near(back.size, c.target.size, 1e-3)
    )
  }
}

// ── 3. Solving for the home framing returns the home pose ─────────────────
console.log('zero jump at t=0')
{
  const w = 1280
  const h = 720
  const planet = { x: 27.4, y: 0, z: -13.8 }
  const radius = 1.6
  const home = homePose(w, h)
  const homeFrame = frameOf(home, w, h, planet, radius)
  const solved = solveFocusCamera({
    width: w,
    height: h,
    planet,
    planetRadius: radius,
    target: homeFrame,
    theta: -ELEV,
    fovDeg: CAM.fovDeg
  })
  check(
    'solved home pose == home pose',
    near(solved.position.x, home.position.x, 1e-6) &&
      near(solved.position.y, home.position.y, 1e-6) &&
      near(solved.position.z, home.position.z, 1e-6),
    `home=(${home.position.x},${home.position.y},${home.position.z}) solved=(${solved.position.x},${solved.position.y},${solved.position.z})`
  )
}

// ── 4. The full dolly path: exact framing every frame, no jump at the ends ─
console.log('dolly path continuity')
{
  const w = 1280
  const h = 760
  const radius = 1.7
  const home = homePose(w, h)
  const target: Frame = { x: 1280 * 0.235 - 190, y: 760 * 0.5 - 190, size: 380 }
  let prev = { x: 0, y: 0, z: 0 }
  let maxStep = 0
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    const focus = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    // A drifting planet: the pose must re-solve against its live position.
    const planet = { x: 27 + t * 1.4, y: 0, z: -13.8 - t * 0.9 }
    const theta = -ELEV * (1 - focus)
    const fovDeg = CAM.fovDeg + (45 - CAM.fovDeg) * focus
    const homeFrame = frameOf(home, w, h, planet, radius)
    const desired = {
      x: homeFrame.x + (target.x - homeFrame.x) * focus,
      y: homeFrame.y + (target.y - homeFrame.y) * focus,
      size: homeFrame.size + (target.size - homeFrame.size) * focus
    }
    const pose = solveFocusCamera({
      width: w,
      height: h,
      planet,
      planetRadius: radius,
      target: desired,
      theta,
      fovDeg
    })
    const got = frameOf(pose, w, h, planet, radius)
    check(
      `t=${t.toFixed(2)} frames the planet exactly`,
      near(got.x, desired.x, 1e-3) &&
        near(got.y, desired.y, 1e-3) &&
        near(got.size, desired.size, 1e-3)
    )
    if (i > 0) {
      const step = Math.hypot(
        pose.position.x - prev.x,
        pose.position.y - prev.y,
        pose.position.z - prev.z
      )
      maxStep = Math.max(maxStep, step)
    }
    prev = { x: pose.position.x, y: pose.position.y, z: pose.position.z }
    if (i === 0) {
      // t=0 must be the home camera exactly — zero jump off the resting view.
      check(
        't=0 pose == home pose (drifting planet)',
        near(pose.position.x, home.position.x, 1e-3) &&
          near(pose.position.y, home.position.y, 1e-3) &&
          near(pose.position.z, home.position.z, 1e-3),
        `home=(${home.position.x},${home.position.y},${home.position.z}) got=(${pose.position.x},${pose.position.y},${pose.position.z})`
      )
    }
  }
  // Smoothness: no single frame may leap more than half the total travel.
  check(`max inter-frame camera step sane (${maxStep.toFixed(2)} world units)`, maxStep < 200)
}


// ── 5. Launch cinematic choreography (solveLaunchStep) ────────────────────
console.log('launch cinematic: solveLaunchStep choreography')
{
  const w = 1280
  const h = 720
  const camZ = 10
  const fovDeg = 45
  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360)
  const wpp = (2 * tanHalfFov * camZ) / h
  const layout = layoutLanderStage(1, w, h)
  const planetScreen = { x: layout.planet.x, y: layout.planet.y, radius: layout.planet.radius }
  const restX = (planetScreen.x - w / 2) * wpp
  const restY = (h / 2 - planetScreen.y) * wpp
  const planetRadius = Math.max(0.2, planetScreen.radius * wpp)
  const step = (t: number, width = w, height = h) =>
    solveLaunchStep({ width, height, planetScreen, t, camZ, fovDeg })

  // t = 0 — resting stage pose
  {
    const s = step(0)
    check(
      't=0 camera at (0, 0, 10)',
      near(s.cameraPosition.x, 0) && near(s.cameraPosition.y, 0) && near(s.cameraPosition.z, 10),
      `got (${s.cameraPosition.x},${s.cameraPosition.y},${s.cameraPosition.z})`
    )
    check(
      't=0 camera target at origin',
      near(s.cameraTarget.x, 0) && near(s.cameraTarget.y, 0) && near(s.cameraTarget.z, 0)
    )
    check(
      't=0 planet at left-side stage layout position',
      near(s.planetPosition.x, restX) && near(s.planetPosition.y, restY) && near(s.planetPosition.z, 0),
      `got (${s.planetPosition.x.toFixed(3)},${s.planetPosition.y.toFixed(3)},${s.planetPosition.z}) want (${restX.toFixed(3)},${restY.toFixed(3)},0)`
    )
    check('t=0 slot landers fully opaque', near(s.slotLandersOpacity, 1))
    check('t=0 hero lander hidden', near(s.landerOpacity, 0))
  }

  // slot fade + planet recenter
  check('slot landers faded out by t=0.20', near(step(0.20).slotLandersOpacity, 0))
  {
    const s = step(0.45)
    check(
      'planet recentered at origin by t=0.45',
      near(s.planetPosition.x, 0) && near(s.planetPosition.y, 0) && near(s.planetPosition.z, 0),
      `got (${s.planetPosition.x},${s.planetPosition.y},${s.planetPosition.z})`
    )
  }

  // lander rises from below the viewport
  {
    const s = step(0.08)
    const pose: CameraPose = { position: s.cameraPosition, theta: 0, fovDeg }
    const proj = projectWithCamera(pose, w, h, s.landerPosition)
    check(
      't=0.08 hero lander starts below the viewport',
      proj.y > h,
      `proj.y=${proj.y.toFixed(1)} (h=${h})`
    )
  }

  // Approach + crash: the lander's center never enters the planet; the camera
  // pushes in but stays outside the mesh the whole way.
  {
    const s = step(0.68)
    check(
      't=0.68 hero lander still outside the planet',
      Math.hypot(s.landerPosition.x, s.landerPosition.y, s.landerPosition.z) > s.planetRadius,
      `|lander|=${Math.hypot(s.landerPosition.x, s.landerPosition.y, s.landerPosition.z).toFixed(3)} r=${s.planetRadius.toFixed(3)}`
    )
    check(
      't=0.68 camera still outside planet',
      Math.hypot(s.cameraPosition.x, s.cameraPosition.y, s.cameraPosition.z) > s.planetRadius,
      `|cam|=${Math.hypot(s.cameraPosition.x, s.cameraPosition.y, s.cameraPosition.z).toFixed(3)} r=${s.planetRadius.toFixed(3)}`
    )
  }

  // t = 1 — the lander has crashed ONTO the near surface (not through it).
  {
    const s = step(1)
    const dist = Math.hypot(s.landerPosition.x, s.landerPosition.y, s.landerPosition.z)
    const landerRadius = planetRadius * 0.2 // solver default when not supplied
    check(
      't=1 hero lander rests on the surface (center at/just outside R)',
      dist >= s.planetRadius && dist <= s.planetRadius + 2 * landerRadius,
      `|lander|=${dist.toFixed(3)} r=${s.planetRadius.toFixed(3)}`
    )
    check('t=1 hero lander on the near face', s.landerPosition.z > 0)
    check(
      't=1 camera outside the planet',
      Math.hypot(s.cameraPosition.x, s.cameraPosition.y, s.cameraPosition.z) > s.planetRadius
    )
  }

  // Impact burst timing: quiet until the strike, then ramps to 1.
  {
    check('t < impact → no burst', step(LAUNCH_IMPACT_T - 0.01).impact === 0)
    check('t = impact → burst starts', near(step(LAUNCH_IMPACT_T).impact, 0))
    check('t between impact and end → burst active', step((LAUNCH_IMPACT_T + 1) / 2).impact > 0)
    check('t=1 → burst complete', near(step(1).impact, 1))
  }

  // The hero lander's center never dips inside the sphere for any t.
  {
    let ok = true
    let worst = ''
    let minDist = Infinity
    for (let i = 0; i <= 100; i++) {
      const s = step(i / 100)
      const d = Math.hypot(s.landerPosition.x, s.landerPosition.y, s.landerPosition.z)
      minDist = Math.min(minDist, d)
      if (d < s.planetRadius * 0.99) {
        ok = false
        worst = `t=${(i / 100).toFixed(2)} |lander|=${d.toFixed(3)} r=${s.planetRadius.toFixed(3)}`
      }
    }
    check(
      `hero lander stays outside the mesh for all t (min |lander|=${minDist.toFixed(3)})`,
      ok,
      worst
    )
  }

  // The camera never enters the mesh either.
  {
    let ok = true
    let worst = ''
    for (let i = 0; i <= 100; i++) {
      const s = step(i / 100)
      const d = Math.hypot(s.cameraPosition.x, s.cameraPosition.y, s.cameraPosition.z)
      if (d < s.planetRadius) {
        ok = false
        worst = `t=${(i / 100).toFixed(2)} |cam|=${d.toFixed(3)} r=${s.planetRadius.toFixed(3)}`
      }
    }
    check('camera stays outside the mesh for all t', ok, worst)
  }

  // camera never flips: target stays in front of the camera for all t
  {
    let ok = true
    let worst = ''
    for (let i = 0; i <= 100; i++) {
      const t = i / 100
      const s = step(t)
      if (!(s.cameraTarget.z < s.cameraPosition.z)) {
        ok = false
        worst = `t=${t.toFixed(2)} target.z=${s.cameraTarget.z.toFixed(3)} cam.z=${s.cameraPosition.z.toFixed(3)}`
      }
    }
    check('cameraTarget.z < cameraPosition.z for all t in [0, 1]', ok, worst)
  }

  // resize mid-transition keeps the recenter + crash-surface invariants
  {
    const dims: [number, number][] = [
      [1280, 720],
      [900, 880],
      [1440, 640],
      [1024, 768]
    ]
    let ok = true
    let detail = ''
    for (const [dw, dh] of dims) {
      const dl = layoutLanderStage(1, dw, dh)
      const ps = { x: dl.planet.x, y: dl.planet.y, radius: dl.planet.radius }
      const st = (t: number) => solveLaunchStep({ width: dw, height: dh, planetScreen: ps, t, camZ, fovDeg })
      for (const t of [0.44, 0.5, 0.68, 1]) {
        const s = st(t)
        const landerDist = Math.hypot(s.landerPosition.x, s.landerPosition.y, s.landerPosition.z)
        const camDist = Math.hypot(s.cameraPosition.x, s.cameraPosition.y, s.cameraPosition.z)
        if (t >= 0.44 && !(near(s.planetPosition.x, 0) && near(s.planetPosition.y, 0))) {
          ok = false
          detail = `${dw}x${dh} t=${t} planet=(${s.planetPosition.x},${s.planetPosition.y})`
        }
        // Throughout: the lander's body may touch, but never passes through.
        if (!(landerDist >= s.planetRadius && camDist > s.planetRadius)) {
          ok = false
          detail = `${dw}x${dh} t=${t} lander=${landerDist.toFixed(2)} cam=${camDist.toFixed(2)} r=${s.planetRadius.toFixed(2)}`
        }
        if (t === 1 && !(s.landerPosition.z > 0 && near(s.impact, 1))) {
          ok = false
          detail = `${dw}x${dh} t=1 crash site/burst`
        }
      }
    }
    check('resize keeps centered planet + crash-surface invariants', ok, detail)
  }

  // sanity: planetRadius is the world radius the cinematic crashes onto
  check(
    `planetRadius sane (${planetRadius.toFixed(3)} world units)`,
    planetRadius > 0.2 && planetRadius < camZ
  )
}

// ── 6. Launch cinematic duration floor & reduced motion ───────────────────
console.log('launch cinematic: duration floor & reduced motion')
{
  check('plays at default 800ms', shouldPlayLaunchCinematic(800, false) === true)
  check('plays at 251ms (just above floor)', shouldPlayLaunchCinematic(251, false) === true)
  check('plays at 2000ms', shouldPlayLaunchCinematic(2000, false) === true)
  check('hard-cuts at 0ms', shouldPlayLaunchCinematic(0, false) === false)
  check('hard-cuts at 100ms', shouldPlayLaunchCinematic(100, false) === false)
  check(
    `hard-cuts at the ${LAUNCH_DURATION_FLOOR_MS}ms floor`,
    shouldPlayLaunchCinematic(LAUNCH_DURATION_FLOOR_MS, false) === false
  )
  check('reduced motion hard-cuts 800ms', shouldPlayLaunchCinematic(800, true) === false)
  check('reduced motion hard-cuts 2000ms', shouldPlayLaunchCinematic(2000, true) === false)
}

// ── 7. Launch cinematic skip controller ───────────────────────────────────
console.log('launch cinematic: skip controller')
{
  const skipShortcut = 'mod+shift+s'
  const mk = (triggeredByKey: boolean) =>
    createLaunchSkipController({ triggeredByKey, skipShortcut, isMac: true })

  // Keyboard-triggered launch: Enter must be released before a fresh press skips.
  {
    const c = mk(true)
    check('keyboard: not armed at t=0', c.isEnterArmed() === false)
    check(
      'keyboard: held Enter repeat is consumed',
      c.onKeyDown(ev({ key: 'Enter', repeat: true })) === 'consume'
    )
    const repeats: string[] = []
    for (let i = 0; i < 5; i++) repeats.push(c.onKeyDown(ev({ key: 'Enter', repeat: true })))
    check('keyboard: repeat keydowns before keyup never skip', repeats.every((a) => a === 'consume'))
    check('keyboard: Escape consumed during cinematic', c.onKeyDown(ev({ key: 'Escape' })) === 'consume')
    check(
      'keyboard: IME composition ignored',
      c.onKeyDown(ev({ key: 'Enter', isComposing: true })) === 'ignore'
    )
    check(
      'keyboard: IME keyCode 229 ignored',
      c.onKeyDown(ev({ key: 'Enter', keyCode: 229 })) === 'ignore'
    )
    check('keyboard: IME does not arm skip', c.isEnterArmed() === false)
    c.onKeyUp({ key: 'Enter' })
    check('keyboard: Enter keyup arms skip', c.isEnterArmed() === true)
    check(
      'keyboard: fresh Enter press skips',
      c.onKeyDown(ev({ key: 'Enter', repeat: false })) === 'skip'
    )
  }

  // Rapid double-tap: down → up → down skips on the second down.
  {
    const c = mk(true)
    const first = c.onKeyDown(ev({ key: 'Enter', repeat: false }))
    c.onKeyUp({ key: 'Enter' })
    const second = c.onKeyDown(ev({ key: 'Enter', repeat: false }))
    check('rapid double-tap: first down does not skip', first === 'consume')
    check('rapid double-tap: second down skips', second === 'skip')
  }

  // Modifier-Enter (window mode): keyup arms, next Enter skips with or without modifier.
  {
    const c = mk(true)
    c.onKeyUp({ key: 'Enter' })
    check('modifier-Enter: Enter keyup arms skip', c.isEnterArmed() === true)
    check(
      'modifier-Enter: meta-Enter skips',
      c.onKeyDown(ev({ key: 'Enter', metaKey: true, repeat: false })) === 'skip'
    )
  }
  {
    const c = mk(true)
    c.onKeyUp({ key: 'Enter' })
    check(
      'modifier-Enter: ctrl-Enter skips',
      c.onKeyDown(ev({ key: 'Enter', ctrlKey: true, repeat: false })) === 'skip'
    )
  }

  // skipTransitionShortcut fires immediately, before any Enter keyup.
  {
    const c = mk(true)
    check(
      'skip shortcut: skips immediately from t=0',
      c.onKeyDown(ev({ key: 's', metaKey: true, shiftKey: true })) === 'skip'
    )
  }

  // Mouse-triggered launch: armed from the start, so a single fresh Enter skips.
  {
    const c = mk(false)
    check('mouse: armed from t=0', c.isEnterArmed() === true)
    check(
      'mouse: fresh Enter skips immediately',
      c.onKeyDown(ev({ key: 'Enter', repeat: false })) === 'skip'
    )
  }
  {
    const c = mk(false)
    check(
      'mouse: held Enter repeat still consumed',
      c.onKeyDown(ev({ key: 'Enter', repeat: true })) === 'consume'
    )
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall camera-dolly checks passed')
