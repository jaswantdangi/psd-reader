/**
 * Generates the compositor's GLSL from modes.js.
 *
 * Generated rather than hand-written for one reason: the likeliest regression
 * in this phase is adding a blend mode to composite.js and forgetting the
 * shader. Generation makes that impossible by construction, and the coverage
 * test in test/gpu.mjs makes it assertable inside `npm test` -- the one real
 * guarantee `npm test` can give about the GPU path.
 *
 * Nothing here touches WebGL, so it imports and runs in Node.
 */
import { SEPARABLE_GLSL, NON_SEPARABLE_GLSL, programNameFor, isNonSeparableMode } from './modes.js';
import { ADJUST_UNIFORMS, ADJUST_STAGE } from '../adjust/glsl.js';

/**
 * One full-canvas triangle from gl_VertexID. No attributes, no VBO, no VAO
 * contents -- the compositor binds an empty VAO and calls drawArrays(TRIANGLES, 0, 3).
 *
 * `vDstPx` is the destination pixel coordinate and lands on texel CENTRES after
 * interpolation (pixel 0 receives 0.5). That is what makes the 1:1 NEAREST blit
 * bit-exact rather than merely close -- `uv * texSize` comes out on whole texels.
 *
 * NOTE FOR THE PRESENT PASS: vDstPx.y is a ROW INDEX, matching the row-major
 * layout of every Uint8ClampedArray in this engine and of readPixels. Compositing
 * and readback are self-consistent with no flip. Presenting the final accumulator
 * to a VISIBLE canvas needs a Y flip in the present pass, or the preview is upside
 * down.
 */
export const VERTEX_SHADER = `#version 300 es
precision highp float;

uniform vec2 uCanvas;
out vec2 vDstPx;

void main() {
  vec2 c = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(c * 2.0 - 1.0, 0.0, 1.0);
  vDstPx = c * uCanvas;
}
`;

const FRAGMENT_HEADER = `#version 300 es
precision highp float;

uniform sampler2D uBackdrop;
uniform sampler2D uSource;
uniform sampler2D uMask;  // R8 on the SOURCE grid -- shares uv with uSource
uniform sampler2D uClip;  // R8 over the whole canvas -- the run base's alpha
uniform vec4  uRect;      // left, top, width, height -- destination pixels
uniform vec2  uCanvas;
uniform float uOpacity;
uniform bool  uUseMask;
uniform bool  uUseClip;

in  vec2 vDstPx;
out vec4 fragColor;
` + ADJUST_UNIFORMS;

/**
 * Ported from composite.js's lum / sat / clipColor / setLum / setSat.
 * Emitted only for the six non-separable programs.
 */
const NON_SEPARABLE_PRELUDE = `
const vec3  LUM_W = vec3(0.3, 0.59, 0.11);
const float EPS   = 1e-6;

float lum(vec3 c) { return dot(c, LUM_W); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  // l, n and x are computed ONCE, before both branches. composite.js mutates c
  // inside the first branch and then tests the STALE x. Recomputing here would
  // be tidier and would diverge from the oracle. Keep it stale.
  //
  // max(., EPS) covers a 0/0 believed unreachable: l - n is zero only when all
  // three channels are equal, and setLum is only ever called with an l taken
  // from a non-negative source, so the n < 0 branch cannot fire on a grey. In
  // JS the result would be NaN, which Uint8ClampedArray stores as 0; a NaN
  // written to a unorm8 target in GL is undefined and has been observed as
  // garbage. Two instructions to delete a class of driver-specific artifact.
  if (n < 0.0) c = l + (c - l) * (l / max(l - n, EPS));
  if (x > 1.0) c = l + (c - l) * ((1.0 - l) / max(x - l, EPS));
  return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

// Closed form of the W3C sort-based SetSat: branch-free, and with no dynamic
// vector indexing. GLSL ES 3.00 permits dynamic indexing, but it compiles to
// conditional moves or scratch memory and has a history of driver bugs. The
// sort in composite.js is an implementation artifact, not the maths -- the
// minimum channel maps to 0, the maximum to s, the middle to
// (mid - mn) * s / (mx - mn). That is exactly what this computes, componentwise.
vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  return (mx > mn) ? (c - mn) * (s / (mx - mn)) : vec3(0.0);
}
`;

/** A literal transcription of blendInto's inner loop, one fragment at a time. */
const FRAGMENT_MAIN = `
void main() {
  vec4 dst = texture(uBackdrop, vDstPx / uCanvas);

  vec2 uv = (vDstPx - uRect.xy) / uRect.zw;
  // Reproduces blendInto's x0..x1 / y0..y1 clamp exactly.
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) {
    fragColor = dst; return;
  }

  vec4 src = applyAdjust(texture(uSource, uv));

  float as = src.a * uOpacity;
  // blendInto's order, exactly: opacity, then the layer mask, then the clip
  // plane, and only THEN the early-out. The mask rides the source grid so it
  // shares uv; the clip plane is full-canvas because clipAlphaMap writes it
  // that way. Float multiplication does not associate, so the order is
  // load-bearing rather than stylistic.
  if (uUseMask) as *= texture(uMask, uv).r;
  if (uUseClip) as *= texture(uClip, vDstPx / uCanvas).r;
  // Not an optimisation. Without it a transparent source fragment would run the
  // straight-alpha divide and re-quantise the backdrop. Returning dst unchanged
  // is an exact unorm8 -> float -> unorm8 round trip, matching JS's \`continue\`.
  if (as <= 0.0) { fragColor = dst; return; }

  float ab = dst.a;
  float ao = as + ab * (1.0 - as);
  // Replaces blendInto's second \`continue\`: straight alpha divides by ao.
  if (ao <= 0.0) { fragColor = vec4(0.0); return; }

  vec3 B = blendFn(dst.rgb, src.rgb);
  // JS association order on purpose. Do NOT rewrite as mix(src.rgb, B, ab) --
  // algebraically equal, differently rounded.
  vec3 C = src.rgb + ab * (B - src.rgb);

  fragColor = vec4((as * C + ab * dst.rgb * (1.0 - as)) / ao, ao);
}
`;

/**
 * Complete fragment shader source for one blend mode.
 *
 * @param {string} mode  A layer's blendMode. Unknown values, `dissolve` and
 *   `pass through` all yield the `normal` program, matching blendInto.
 * @returns {string}
 */
export function fragmentShaderFor(mode) {
  const name = programNameFor(mode);

  if (isNonSeparableMode(name)) {
    return FRAGMENT_HEADER + NON_SEPARABLE_PRELUDE + ADJUST_STAGE +
      `\nvec3 blendFn(vec3 b, vec3 s) {\n  ${NON_SEPARABLE_GLSL[name]}\n}\n` +
      FRAGMENT_MAIN;
  }

  return FRAGMENT_HEADER + ADJUST_STAGE +
    `\nfloat chan(float b, float s) {\n  ${SEPARABLE_GLSL[name]}\n}\n` +
    '\nvec3 blendFn(vec3 b, vec3 s) {\n' +
    '  return vec3(chan(b.r, s.r), chan(b.g, s.g), chan(b.b, s.b));\n}\n' +
    FRAGMENT_MAIN;
}

/**
 * The `clip-alpha` reduction pass: the run base's alpha, over the whole canvas,
 * into the R8 plane every clipped member then multiplies its own alpha by.
 *
 * A LINE-FOR-LINE PORT of `clipAlphaMap` in render.js, and the integer
 * arithmetic is the reason it is a separate shader rather than a flag on the
 * blend program:
 *
 *   - `clipAlphaMap` writes into a `Uint8Array`, which TRUNCATES. A unorm8
 *     render target ROUNDS. Left alone, every partially masked pixel of every
 *     clipped run would sit 1 LSB away from the oracle -- exactly the class of
 *     divergence render.js's own docstring says is load-bearing. `floor()` here
 *     puts the truncation back.
 *   - the mask divides by 255 because it is a separate 0..255 plane, and the
 *     alpha does NOT, because `pixels[si + 3] * opacity` is already 0..255.
 *     Both halves are reproduced in 0..255 space and only the final store
 *     returns to unorm.
 *
 * Outside the rect it writes 0, which is what the zeroed scratch plane holds
 * where `clipAlphaMap` never reaches. The `255` constants here are legitimate:
 * this shader is not produced by `fragmentShaderFor`, and the rule that keeps
 * blend-mode bodies in 0..1 space is about the mode table, not about a
 * deliberate integer reduction.
 */
export const CLIP_ALPHA_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform sampler2D uMask;
uniform vec4  uRect;
uniform vec2  uCanvas;
uniform float uOpacity;
uniform bool  uUseMask;

in  vec2 vDstPx;
out vec4 fragColor;

void main() {
  vec2 uv = (vDstPx - uRect.xy) / uRect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) {
    fragColor = vec4(0.0); return;
  }

  float a = floor(texture(uSource, uv).a * 255.0 + 0.5) * uOpacity;
  if (uUseMask) a *= floor(texture(uMask, uv).r * 255.0 + 0.5) / 255.0;
  fragColor = vec4(floor(a) / 255.0, 0.0, 0.0, 1.0);
}
`;

/**
 * The present pass: the finished accumulator onto the VISIBLE drawing buffer.
 *
 * The Y flip the vertex shader's docstring warns about lives here and ONLY
 * here. Every internal target is row-major with row 0 at the top, matching each
 * Uint8ClampedArray in this engine and matching readPixels, so compositing and
 * readback need no flip and conformance compares like for like. The default
 * framebuffer is the one surface with y running the other way.
 *
 * Sampled with NEAREST at 1:1, so presenting is a copy and not a resample.
 */
export const PRESENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform vec2 uCanvas;

in  vec2 vDstPx;
out vec4 fragColor;

void main() {
  fragColor = texture(uSource, vec2(vDstPx.x, uCanvas.y - vDstPx.y) / uCanvas);
}
`;
