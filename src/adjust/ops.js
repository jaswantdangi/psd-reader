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
  out.hsl = partial.hsl ? normaliseHsl(partial.hsl) : null;
  out.overlay = partial.overlay ? structuredClone(partial.overlay) : null;

  return deepFreeze(out);
}

/**
 * The HSL stage, as GLSL ES 3.00.
 *
 * A transcription of applyHsl in apply.js. NOTHING IN THIS REPOSITORY COMPILES
 * IT. Task 15's coverage test proves this string exists and is non-empty; it
 * cannot prove it is right, and conformance Table D on a real device is the
 * only thing that can. That is 1B's accepted gap, restated for a new surface.
 *
 * GLSL's `mod(x, 6.0)` returns a non-negative result where JS's `%` can return
 * a negative one -- but the JS side immediately adds 360 to a negative hue, so
 * the two agree. Checked by hand; it is exactly the kind of difference that
 * produces a hue rotated by 60 degrees on one tier only.
 */
const HSL_GLSL = `
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  float h = 0.0;
  float s = 0.0;
  if (d > 0.0) {
    s = (l > 0.5) ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else                h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, s, l);
}

vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y <= 0.0) return vec3(hsl.z);
  float c  = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float hp = mod(mod(hsl.x, 360.0) + 360.0, 360.0) / 60.0;
  float x  = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb = (hp < 1.0) ? vec3(c, x, 0.0)
           : (hp < 2.0) ? vec3(x, c, 0.0)
           : (hp < 3.0) ? vec3(0.0, c, x)
           : (hp < 4.0) ? vec3(0.0, x, c)
           : (hp < 5.0) ? vec3(x, 0.0, c)
                        : vec3(c, 0.0, x);
  return rgb + (hsl.z - c * 0.5);
}

vec3 adjustHsl(vec3 rgb) {
  vec3 hsl = rgb2hsl(rgb);
  float dh = 0.0;
  float ds = 0.0;
  float dl = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = uHslCentres[i];
    // (i + 1) % 8 keeps the index in range even in the wrap case, where the
    // upper bound is 360 rather than a centre. Reading one past the end of a
    // uniform array is undefined, not merely wrong.
    int   j = (i + 1) % 8;
    float b = (i == 7) ? 360.0 : uHslCentres[j];
    if (hsl.x >= a && hsl.x < b) {
      float t = (hsl.x - a) / (b - a);
      dh = (1.0 - t) * uHslBands[i * 3]     + t * uHslBands[j * 3];
      ds = (1.0 - t) * uHslBands[i * 3 + 1] + t * uHslBands[j * 3 + 1];
      dl = (1.0 - t) * uHslBands[i * 3 + 2] + t * uHslBands[j * 3 + 2];
    }
  }
  float h = hsl.x + dh * 0.3;
  float s = clamp(hsl.y * (1.0 + ds * 0.01) * (1.0 + uHslSaturation * 0.01), 0.0, 1.0);
  float t = dl * 0.01;
  float l = clamp(hsl.z + ((t >= 0.0) ? t * (1.0 - hsl.z) : t * hsl.z), 0.0, 1.0);
  return hsl2rgb(vec3(h, s, l));
}
`;

/**
 * The eight hue bands, at Photoshop's own centres.
 *
 * Not evenly spaced -- perceptual hue is not linear in degrees, and the gap
 * from blue to purple really is narrower than the one from yellow to green.
 * bandWeights interpolates between ADJACENT centres, so uneven spacing costs
 * nothing and the weights still sum to exactly 1.
 */
export const HSL_BANDS = Object.freeze([
  { id: 'red', centre: 0 }, { id: 'orange', centre: 30 }, { id: 'yellow', centre: 60 },
  { id: 'green', centre: 120 }, { id: 'aqua', centre: 180 }, { id: 'blue', centre: 240 },
  { id: 'purple', centre: 285 }, { id: 'magenta', centre: 315 },
].map(Object.freeze));

/**
 * +/-100 on a band's hue slider is +/-30 degrees. Conservative on purpose: a
 * wider range wraps a band's pixels past its neighbours and reads as noise
 * rather than as a hue shift.
 */
export const HSL_HUE_DEGREES = 30;

const clampBand = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? clamp(n, -100, 100) : 0;
};

/**
 * Always eight bands, always clamped. A short or ragged array from a
 * hand-edited save cannot reach the per-pixel loop.
 */
export function normaliseHsl(hsl) {
  return {
    bands: HSL_BANDS.map((_, i) => {
      const b = hsl?.bands?.[i] ?? {};
      return { h: clampBand(b.h), s: clampBand(b.s), l: clampBand(b.l) };
    }),
    saturation: clampBand(hsl?.saturation),
  };
}

export const NEUTRAL_HSL = deepFreeze(normaliseHsl(null));

export const isNeutralHsl = (hsl) =>
  !hsl || (hsl.saturation === 0
    && (hsl.bands ?? []).every((b) => b.h === 0 && b.s === 0 && b.l === 0));

/**
 * The eight band weights for one hue: a linear interpolation between the two
 * adjacent centres, written into `out`.
 *
 * At most two are non-zero and they sum to EXACTLY 1, which is what makes a
 * neutral setting a true no-op at every hue rather than only at the centres.
 *
 * @param {number} hue  degrees, 0 <= hue < 360
 * @param {Float64Array} out  length 8; overwritten
 */
export function bandWeights(hue, out) {
  out.fill(0);
  const n = HSL_BANDS.length;
  for (let i = 0; i < n; i++) {
    const a = HSL_BANDS[i].centre;
    // The last band wraps to the first, at 360 rather than back at 0.
    const b = i === n - 1 ? HSL_BANDS[0].centre + 360 : HSL_BANDS[i + 1].centre;
    if (hue >= a && hue < b) {
      const t = (hue - a) / (b - a);
      out[i] = 1 - t;
      out[(i + 1) % n] = t;
      return;
    }
  }
  out[0] = 1;   // hue is exactly 360 or NaN; rgbToHsl produces neither
}

/**
 * The one cross-channel op.
 *
 * Declared in the table so the table stays the complete inventory of what an
 * adjustment can do -- and so Task 15's coverage test can prove this one has a
 * shader body, which class A does not need and overlay does not yet have.
 */
OPS.hsl = {
  class: 'B', lut: false, glsl: HSL_GLSL, gpuDeferred: null,
  label: 'HSL', range: null, neutral: null,
  evaluate: null,          // cross-channel: it cannot be a per-channel function
};
