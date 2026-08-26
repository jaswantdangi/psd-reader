/**
 * The adjustment op table.
 *
 * Pure data, pure functions and strings -- no DOM, no WebGL -- so `npm test`
 * imports it directly. Same construction as src/gpu/modes.js, and for the same
 * reason: a table that both the renderer and the shader generator read cannot
 * grow an entry on one side only.
 *
 * THREE CLASSES, and the class is what decides the cost:
 *
 *   'A'  per-channel pointwise. Composes into ONE 3x256 lookup table, so any
 *        number of stacked class-A ops costs three array indexes per pixel.
 *        Reaches the GPU as the LUT's 768 BYTES -- never as shader arithmetic --
 *        which is why these entries carry `glsl: null` and contribute exactly
 *        zero GPU/JS divergence risk.
 *   'B'  cross-channel pointwise. Cannot be a per-channel table; evaluated per
 *        pixel, in two implementations that have to agree. There is exactly one
 *        of these (`hsl`) and it stays one.
 *   'P'  positional -- pointwise in the pixel's NORMALISED position in the
 *        layer rect, so it is scale-invariant and tiles with no halo.
 *
 * Every evaluator works in the 0..255 non-linear space composite.js blends in.
 * Photometrically that is wrong -- "exposure" in gamma space is not exposure --
 * but it is CONSISTENT WITH THE ORACLE, which is what conformance measures
 * against. Adopting linear light would make the JS compositor a systematically
 * worse reference, and it cannot be done in the same phase as validating a new
 * feature. The UI never labels a control in photometric units.
 *
 * Evaluators return UNCLAMPED floats. buildLut clamps once, at the end of the
 * whole composition, so five stacked ops do not clip five times.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The class-A ops, in the order buildLut composes them.
 *
 * Pointwise operations DO NOT COMMUTE, so this order is a decision, not an
 * implementation detail: gains first, then the additive offset, then contrast
 * last so it pivots on the tone-mapped result rather than on the original.
 * An undeclared order is a bug the user finds by getting a different result
 * than the same sliders gave yesterday.
 */
export const CLASS_A_ORDER = ['exposure', 'temperature', 'tint', 'brightness', 'contrast'];

export const OPS = {
  exposure: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Exposure', range: [-100, 100], neutral: 0,
    // A pure gain: +100 doubles, -100 halves. Labelled Brightness+ in the UI,
    // never "Exposure (EV)" -- see the gamma-space note above.
    evaluate: (x, _c, v) => x * Math.pow(2, v / 100),
  },
  temperature: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Temperature', range: [-100, 100], neutral: 0,
    // Warm/cool as a per-channel GAIN -- it reads one channel and writes it,
    // with a different constant per channel, so it is still class A.
    evaluate: (x, c, v) => x * (c === 0 ? 1 + 0.30 * (v / 100) : c === 2 ? 1 - 0.30 * (v / 100) : 1),
  },
  tint: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Tint', range: [-100, 100], neutral: 0,
    // Green/magenta, same shape: positive pulls magenta, negative pulls green.
    evaluate: (x, c, v) => x * (c === 1 ? 1 - 0.30 * (v / 100) : 1 + 0.15 * (v / 100)),
  },
  brightness: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Brightness', range: [-100, 100], neutral: 0,
    // Additive, +/-128 at the extremes -- half the range, which is as far as a
    // single slider should be able to push before the clamp eats everything.
    evaluate: (x, _c, v) => x + 1.28 * v,
  },
  contrast: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Contrast', range: [-100, 100], neutral: 0,
    // Pivoted on mid-grey. The positive branch is a reciprocal so the gain
    // grows smoothly to 10x rather than jumping; the negative branch collapses
    // linearly to a flat grey at -100. Both give exactly 1 at v = 0, and
    // 127.5 + (x - 127.5) is exact for every integer x in 0..255, so the
    // neutral case is bit-exact rather than nearly so.
    evaluate: (x, _c, v) => {
      const k = v / 100;
      const gain = k >= 0 ? 1 / (1 - 0.9 * k) : 1 + k;
      return 127.5 + (x - 127.5) * gain;
    },
  },
};

/**
 * Freeze an object and everything reachable from it.
 *
 * Not decoration. `setLayer` does `from[key] = layer[key]`, so an object-valued
 * field's undo entry holds THE SAME OBJECT as the new value. A caller that
 * mutates in place has destroyed the undo entry before it was written, and
 * nothing complains until someone presses undo. Freezing makes that a TypeError
 * at the point of the mistake instead of a silent loss later.
 */
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};

/** The neutral value of the whole object. `null` on a layer means this. */
export const NEUTRAL_ADJUST = deepFreeze({
  preset: 'none',
  exposure: 0, temperature: 0, tint: 0, brightness: 0, contrast: 0,
  hsl: null, overlay: null,
});

/**
 * Build a complete, range-clamped, deeply frozen adjustment object.
 *
 * The ONLY sanctioned way to make one. Everything else -- presets, sliders,
 * a reopened project file -- goes through here, so an out-of-range number from
 * a hand-edited save cannot reach an evaluator, and no caller can hand a
 * mutable object to setLayer.
 *
 * @param {object} [partial]  Any subset. Unknown keys are dropped.
 * @returns {Readonly<object>}
 */
export function createAdjust(partial = {}) {
  const out = { preset: typeof partial.preset === 'string' ? partial.preset : 'none' };

  for (const id of CLASS_A_ORDER) {
    const op = OPS[id];
    const raw = Number(partial[id] ?? op.neutral);
    out[id] = Number.isFinite(raw) ? clamp(raw, op.range[0], op.range[1]) : op.neutral;
  }

  // Structural pass-through for now: Task 5 and Task 6 replace these two lines
  // with normaliseHsl() and normaliseOverlay(), which clamp and complete them.
  out.hsl = partial.hsl ? structuredClone(partial.hsl) : null;
  out.overlay = partial.overlay ? structuredClone(partial.overlay) : null;

  return deepFreeze(out);
}
