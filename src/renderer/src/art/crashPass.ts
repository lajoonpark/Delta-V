/**
 * Full-frame crash look, as a three.js `ShaderPass`:
 *
 *  - **Radial motion blur** — samples the frame along rays fanning out from the
 *    focus point (the impact), so the dive reads as speed, not just a camera move.
 *  - **Cartoon speed lines** — procedural radial spokes, densest at the frame
 *    edge and masked away from the focus, the comic-book "zoom" punch.
 *  - **Impact wash** — a white radial flash over the whole frame at the strike,
 *    carrying the blast light beyond the fireball mesh.
 *
 * All three are driven by `CrashFx` numbers, so the pass is a pure readout of
 * the solver. Runs *before* bloom, feeding it a streaked, glowing frame.
 */
import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

export interface CrashPassUniforms {
  tDiffuse: { value: THREE.Texture | null }
  /** Screen-space focus (the impact point), in uv. */
  focus: { value: THREE.Vector2 }
  /** Aspect (w/h) so the blur rays are circular, not squashed. */
  aspect: { value: number }
  /** Radial motion blur strength (0..1). */
  radialBlur: { value: number }
  /** Cartoon speed-line opacity (0..1). */
  speedLines: { value: number }
  /** Impact flash wash (0..1). */
  wash: { value: number }
  /** Wall clock (s) so the speed lines shimmer rather than sitting still. */
  time: { value: number }
}

export interface CrashPassHandle {
  pass: ShaderPass
  uniforms: CrashPassUniforms
  setSize(width: number, height: number): void
  dispose(): void
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

const FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 focus;
uniform float aspect;
uniform float radialBlur;
uniform float speedLines;
uniform float wash;
uniform float time;
varying vec2 vUv;

// Cheap value hash for the speed-line field.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;

  // Work in an aspect-corrected frame centred on the focus so rays are round.
  vec2 d = uv - focus;
  d.x *= aspect;
  float r = length(d);
  float maxR = length(vec2(max(focus.x, 1.0 - focus.x), max(focus.y, 1.0 - focus.y)) * vec2(aspect, 1.0));
  float rn = clamp(r / max(1e-4, maxR), 0.0, 1.4);

  // -- Radial motion blur: 9 taps along the ray, weighted to the centre -----
  vec4 color = texture2D(tDiffuse, uv);
  if (radialBlur > 0.001) {
    float blurAmt = radialBlur * 0.13 * pow(rn, 1.35);
    vec4 acc = color * 0.34;
    float wsum = 0.34;
    vec2 dir = r > 1e-4 ? d / r * vec2(1.0 / aspect, 1.0) : vec2(0.0);
    for (int i = 1; i <= 8; i++) {
      float f = float(i) / 8.0;
      float w = (1.0 - f) * (1.0 - f);
      acc += texture2D(tDiffuse, uv - dir * blurAmt * f) * w;
      wsum += w;
    }
    color = acc / wsum;
  }

  // -- Cartoon speed lines: radial spokes, densest at the frame edge -------
  if (speedLines > 0.001) {
    float ang = atan(d.y, d.x);
    // Quantise the angle into spokes and jitter each one's phase.
    float spokes = 132.0;
    float idx = floor(ang / 6.2831853 * spokes);
    float jitter = hash21(vec2(idx, floor(time * 6.0)));
    float spoke = fract(ang / 6.2831853 * spokes + jitter);
    // Thin bright cores with soft shoulders.
    float line = smoothstep(0.5, 0.0, abs(spoke - 0.5) * 2.0);
    line = pow(line, 3.0);
    // Fade out near the focus and in the very centre of the frame.
    float mask = smoothstep(0.18, 1.0, rn);
    // Streaks only bite while the frame is streaking: gate on the blur.
    float amt = speedLines * mask * 0.5 * (0.35 + 0.65 * radialBlur);
    color.rgb += vec3(1.0, 0.97, 0.92) * line * amt;
  }

  // -- Impact wash: a white-hot flash that blooms out of the focus ---------
  //    Concentrated on the strike and gone within a couple of frames. A broad
  //    or long wash just desaturates the fireball into a white sheet, which is
  //    exactly the "you can't even tell it happened" problem this fixes.
  if (wash > 0.001) {
    float core = smoothstep(0.75, 0.0, rn);
    float glow = core * core;
    // Slightly warm rather than pure white: a crash flash should read as heat,
    // and a neutral white wash desaturates the fireball underneath it.
    vec3 flashTint = vec3(1.0, 0.94, 0.84);
    color.rgb = mix(color.rgb, flashTint, clamp(wash * (0.10 + 0.90 * glow), 0.0, 1.0));
  }

  // -- Impact fringe: a one-frame RGB split at the strike ------------------
  //    Lens-hit aberration — subtle, but it is what makes the flash feel like
  //    it went through a camera rather than being painted on the frame.
  if (wash > 0.001) {
    vec2 dir = r > 1e-4 ? d / r * vec2(1.0 / aspect, 1.0) : vec2(0.0);
    float splitAmt = wash * 0.012;
    float red = texture2D(tDiffuse, uv + dir * splitAmt).r;
    float blue = texture2D(tDiffuse, uv - dir * splitAmt).b;
    color.r = mix(color.r, red, 0.85);
    color.b = mix(color.b, blue, 0.85);
  }

  // -- Speed tunnel: darken the frame edges during the fall ----------------
  //    Vignette tied to the same blur envelope, so the frame closes in while
  //    the planet rushes up. Reads as acceleration without moving the camera.
  if (radialBlur > 0.001) {
    float edge = smoothstep(0.35, 1.15, rn);
    color.rgb *= 1.0 - edge * radialBlur * 0.42;
  }

  gl_FragColor = color;
}
`

export function createCrashPass(): CrashPassHandle {
  const uniforms: CrashPassUniforms = {
    tDiffuse: { value: null },
    focus: { value: new THREE.Vector2(0.5, 0.5) },
    aspect: { value: 1 },
    radialBlur: { value: 0 },
    speedLines: { value: 0 },
    wash: { value: 0 },
    time: { value: 0 }
  }

  const shader = {
    name: 'CrashPass',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT
  }

  const pass = new ShaderPass(shader)
  pass.needsSwap = true

  // `ShaderPass` deep-clones the uniforms it is given, so keep a reference to
  // the pass's own copies — writing to `shader.uniforms` would update an object
  // the shader never reads.
  const liveUniforms = pass.uniforms as unknown as CrashPassUniforms

  return {
    pass,
    uniforms: liveUniforms,
    setSize(width, height) {
      liveUniforms.aspect.value = width / Math.max(1, height)
    },
    dispose() {
      pass.dispose()
    }
  }
}
