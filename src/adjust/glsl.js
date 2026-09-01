/**
 * Assembles the adjustment stage of the fragment shader from ops.js.
 *
 * Generated rather than hand-written, for the reason src/gpu/glsl.js gives for
 * blend modes: the likeliest regression is adding an op and forgetting the
 * shader. Generation makes that impossible by construction, and the coverage
 * test makes it assertable inside `npm test`.
 *
 * WHAT THAT TEST PROVES, AND WHAT IT DOES NOT. It proves the shader has an
 * entry for every op. It cannot prove the entry is RIGHT, because nothing in
 * this repository compiles GLSL. 1B's accepted gap, restated for a larger
 * surface. Conformance Table D on a real device is the only thing that closes
 * it, and until 1B-2 exists there is no GPU to run it against.
 *
 * Class A contributes NOTHING here on purpose: it reaches the GPU as the 768
 * bytes buildLut produced, uploaded as a 256x1 RGBA texture and read with
 * texelFetch. Both tiers read the same table, so divergence there is not
 * reduced -- it is structurally impossible.
 *
 * Nothing here touches WebGL, so it imports and runs in Node.
 */
import { OPS } from './ops.js';

/** The ops that carry a shader body, and their bodies. */
export const ADJUST_GLSL = Object.fromEntries(
  Object.entries(OPS)
    .filter(([, op]) => typeof op.glsl === 'string' && op.glsl.length > 0)
    .map(([id, op]) => [id, op.glsl]),
);

/**
 * Uniforms the stage needs, spliced into the fragment header.
 *
 * uLut is the ONLY one class A uses, and it carries the whole class: texel i
 * holds (lut[i], lut[256 + i], lut[512 + i], 255), so .r indexed by red,
 * .g by green and .b by blue is the composed table, verbatim.
 */
export const ADJUST_UNIFORMS = `
uniform sampler2D uLut;          // 256x1 RGBA8: EXACTLY the 768 bytes buildLut produced
uniform int   uAdjustFlags;      // bit 0 = class-A LUT, bit 1 = HSL
uniform float uHslCentres[8];    // HSL_BANDS centres, in degrees
uniform float uHslBands[24];     // 8 bands x (h, s, l), each -100..100
uniform float uHslSaturation;
`;

/**
 * The class-A fetch.
 *
 * texelFetch, never texture(): an integer index with no filtering and no
 * interpolation. floor(c * 255 + 0.5) recovers n for all n in 0..255 on a
 * NEAREST unorm8 sample -- the round-trip error is ~1.2e-7, far inside the
 * half-LSB margin. This is 1B's argument for NEAREST at 1:1 being bit-exact,
 * applied one stage later.
 */
const LUT_FETCH = `
vec3 adjustLut(vec3 c) {
  return vec3(
    texelFetch(uLut, ivec2(int(floor(c.r * 255.0 + 0.5)), 0), 0).r,
    texelFetch(uLut, ivec2(int(floor(c.g * 255.0 + 0.5)), 0), 0).g,
    texelFetch(uLut, ivec2(int(floor(c.b * 255.0 + 0.5)), 0), 0).b);
}
`;

/**
 * The whole stage: the LUT fetch, every op body, and the entry point.
 *
 * `uAdjustFlags == 0` returns the source untouched. Not an optimisation: a
 * neutral adjustment must be BIT-IDENTICAL to no adjustment, and running the
 * stage anyway would quantise twice and be usually-but-not-always the same --
 * which is the whole class of bug conformance Table D's first row exists to
 * catch.
 *
 * `vec4(c, src.a)` is invariant A in the shader.
 */
export const ADJUST_STAGE =
  LUT_FETCH +
  Object.values(ADJUST_GLSL).join('\n') + `
vec4 applyAdjust(vec4 src) {
  if (uAdjustFlags == 0) return src;
  vec3 c = src.rgb;
  if ((uAdjustFlags & 1) != 0) c = adjustLut(c);
  if ((uAdjustFlags & 2) != 0) c = adjustHsl(c);
  return vec4(c, src.a);
}
`;
