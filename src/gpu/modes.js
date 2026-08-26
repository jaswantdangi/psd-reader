/**
 * The blend-mode table, shared by the GLSL generator and the coverage test.
 *
 * Pure data and strings — no WebGL, no DOM — so `npm test` can import it. That
 * is deliberate: Node has no GPU, and this file plus `glsl.js` are the only
 * part of the GPU path a Node suite can say anything about.
 *
 * Every body is a transcription of the matching entry in composite.js, divided
 * into 0..1. Do NOT "simplify" one. GLSL ES 3.00 has no `precise` qualifier, the
 * JS compositor is the oracle conformance measures against, and an algebraic
 * rewrite changes the rounding.
 */

/**
 * Body of `float chan(float b, float s)` for each separable mode, in the same
 * order as composite.js's SEPARABLE.
 */
export const SEPARABLE_GLSL = {
  'normal': 'return s;',
  'darken': 'return min(b, s);',
  'multiply': 'return b * s;',
  'color burn': 'return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s);',
  'linear burn': 'return (b + s < 1.0) ? 0.0 : b + s - 1.0;',
  'lighten': 'return max(b, s);',
  'screen': 'return b + s - b * s;',
  'color dodge': 'return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));',
  'linear dodge': 'return (b + s > 1.0) ? 1.0 : b + s;',
  'overlay': 'return (b <= 0.5) ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);',
  'hard light': 'return (s <= 0.5) ? 2.0 * s * b : 1.0 - 2.0 * (1.0 - s) * (1.0 - b);',
  'soft light':
    'float d = (b <= 0.25) ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);\n' +
    '  return (s <= 0.5) ? b - (1.0 - 2.0 * s) * b * (1.0 - b)\n' +
    '                    : b + (2.0 * s - 1.0) * (d - b);',
  'vivid light':
    'return (s <= 0.5)\n' +
    '    ? (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / (2.0 * s)))\n' +
    '    : (s >= 1.0 ? 1.0 : min(1.0, b / (2.0 * (1.0 - s))));',
  'linear light': 'return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);',
  'pin light': 'return (s <= 0.5) ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);',
  // The ONE mode that must compare in integer space. It is discontinuous at its
  // boundary, and float(n/255) + float(m/255) where n + m == 255 can round to
  // 0.99999994 -- flipping the output from 255 to 0, a full-channel-range error
  // out of half a ULP of rounding. Every other threshold in this table is either
  // continuous across it (linear burn, linear dodge) or tests an
  // exactly-representable 0.0 / 1.0 (color burn, color dodge, divide).
  'hard mix': 'return (floor(b * 255.0 + 0.5) + floor(s * 255.0 + 0.5) >= 255.0) ? 1.0 : 0.0;',
  'difference': 'return abs(b - s);',
  'exclusion': 'return b + s - 2.0 * b * s;',
  'subtract': 'return max(0.0, b - s);',
  'divide': 'return (s <= 0.0) ? 1.0 : min(1.0, b / s);',
};

/**
 * Body of `vec3 blendFn(vec3 b, vec3 s)` for each non-separable mode, in the
 * same order as composite.js's NON_SEPARABLE. These need lum/sat/setLum/setSat,
 * which glsl.js emits as a prelude.
 */
export const NON_SEPARABLE_GLSL = {
  'hue': 'return setLum(setSat(s, sat(b)), lum(b));',
  'saturation': 'return setLum(setSat(b, sat(s)), lum(b));',
  'color': 'return setLum(s, lum(b));',
  'luminosity': 'return setLum(b, lum(s));',
  'darker color': 'return (lum(s) < lum(b)) ? s : b;',
  'lighter color': 'return (lum(s) > lum(b)) ? s : b;',
};

/** All 26, in composite.js's SUPPORTED_BLEND_MODES order. */
export const GPU_BLEND_MODES = [
  ...Object.keys(SEPARABLE_GLSL),
  ...Object.keys(NON_SEPARABLE_GLSL),
];

export const isNonSeparableMode = (name) => Object.hasOwn(NON_SEPARABLE_GLSL, name);

/**
 * The program a layer's blend mode compiles to.
 *
 * Mirrors blendInto's `const blend = fn || SEPARABLE.normal` exactly:
 * `dissolve`, `pass through` and anything unrecognised render as `normal`.
 *
 * One specialised program per mode -- never a switch on a uniform int, which is
 * the shape old Mali/Adreno compilers miscompile or serialise. A typical
 * document uses one to three modes, so lazily compiling per mode costs almost
 * nothing.
 *
 * `Object.hasOwn` rather than `in`, so `programNameFor('constructor')` cannot
 * resolve to a prototype member and emit `undefined` into a shader.
 */
export function programNameFor(mode) {
  if (typeof mode !== 'string') return 'normal';
  if (Object.hasOwn(SEPARABLE_GLSL, mode) || Object.hasOwn(NON_SEPARABLE_GLSL, mode)) return mode;
  return 'normal';
}
