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

import { SUPPORTED_BLEND_MODES } from '../composite.js';
import { DEFAULT_PROXY_EDGE } from '../proxy.js';

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
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;

  /*
   * PIXELS ARE THE EXCEPTION, and freezing a typed array is not the same thing
   * as freezing an object. Two separate reasons this has to stop here:
   *
   *   - `Object.freeze` on an ArrayBuffer view that HAS elements throws
   *     outright ("Cannot freeze array buffer views with elements"), so an
   *     image overlay would make createAdjust throw rather than return.
   *   - `Object.keys` on one enumerates every INDEX. A 1024x1024 texture is
   *     four million own keys, each of which the loop above would then recurse
   *     into. That is not a freeze, it is a hang.
   *
   * So an overlay's pixels are immutable BY CONVENTION rather than by the
   * runtime. The convention is enforceable because it is narrow: the container
   * `{width, height, data}` IS frozen, so the reference cannot be swapped or
   * re-pointed, and the whole adjust stack only ever READS through it --
   * applyOverlay writes into its own row buffer, never into the source. The
   * undo hazard deepFreeze exists for is a mutated PARAMETER, and the pixels
   * are not a parameter: they are handed in once and never edited in place.
   */
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

  for (const key of Object.keys(value)) deepFreeze(value[key]);
  Object.freeze(value);
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

  out.hsl = partial.hsl ? normaliseHsl(partial.hsl) : null;
  out.overlay = partial.overlay ? normaliseOverlay(partial.overlay) : null;

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

/**
 * `linear` and `radial` are PROCEDURAL -- two colours and a direction. `image`
 * is the user's own PNG or JPEG: a light leak, a texture, bokeh, grain.
 *
 * The third one is a new kind on the same operation, not a parallel one. It
 * carries the same `mode` and `opacity`, goes through the same blendInto, is
 * clipped to the same layer alpha, and is sampled at the same NORMALISED
 * positions -- so everything the gradient already proved about proxy/export
 * agreement holds for it unchanged.
 */
export const OVERLAY_KINDS = ['linear', 'radial', 'image'];

/**
 * How a texture of arbitrary size covers a rect of arbitrary size.
 *
 *   'stretch'  the whole texture, distorted to the rect's aspect.
 *   'cover'    aspect preserved, the overflowing axis cropped, centred.
 *
 * `cover` is the default because it cannot distort, and a distorted light leak
 * reads as a rendering bug rather than as a choice.
 *
 * Both rules are computed from ASPECT RATIOS ALONE (overlaySourceWindow), never
 * from pixel counts. That is the whole resolution-independence argument for the
 * image kind, and it is one function: the destination rect doubles between
 * proxy and export, its aspect does not, so the crop window is bit-identical at
 * both and the export cannot come out framed differently from the screen.
 *
 * NOT HERE: `tile`. A grain tile locked to source pixels is the one rule that
 * is NOT scale-invariant -- it would double its frequency at export -- and a
 * tile expressed as "repeat N times across the rect" is scale-invariant but
 * needs a repeat count, a UI for it, and a source stored well above the cap
 * below to be worth having at all. Recorded in docs/BACKLOG.md rather than
 * shipped as a near-miss.
 */
export const OVERLAY_FITS = ['stretch', 'cover'];

/**
 * Longest edge an overlay texture is stored at.
 *
 * DELIBERATELY THE PROXY EDGE, as one number rather than two. src/budget.js
 * accounts for `file bytes + one full-res layer + sum of proxy layers`; an
 * overlay is a resident bitmap that sum never counted, so it is priced at
 * exactly one more proxy layer -- 4 MB at the very worst, 1024x1024x4 -- and a
 * device that could afford the document can afford the texture on top of it.
 *
 * The reduction happens ONCE, on import, in the app layer: the picked file is
 * decoded and drawn STRAIGHT INTO A CANVAS OF THE CAPPED SIZE, so a
 * 24-megapixel JPEG never becomes 96 MB of JS heap on its way in. The size
 * itself comes from `proxyScaleFor(w, h, OVERLAY_IMAGE_EDGE)` -- the engine's
 * own rule, not a second copy of it -- and `downscaleImage` is the in-engine
 * equivalent the cap test reduces through to prove the bound holds.
 *
 * That import is where the whole anti-alias budget for this feature is spent.
 * The sampler in apply.js is then plain bilinear, matching `resample`, so the
 * overlay is filtered exactly the way the layer pixels underneath it are.
 */
export const OVERLAY_IMAGE_EDGE = DEFAULT_PROXY_EDGE;

/** A gradient needs two stops. This is what a missing or ragged one becomes. */
const DEFAULT_STOPS = () => ([
  { t: 0, r: 0, g: 0, b: 0, a: 0 },
  { t: 1, r: 0, g: 0, b: 0, a: 0 },
]);

/**
 * The source window a fit rule reads, in NORMALISED texture coordinates.
 *
 * Aspect ratios only. `destWidth / destHeight` is the same number at proxy
 * scale and at document scale, so this returns the identical window for both --
 * which is the property that stops an export coming back cropped differently
 * from the preview. A rule written against pixel counts would not have it, and
 * the difference is invisible until someone opens the PNG.
 *
 * @param {'stretch'|'cover'} fit
 * @returns {{u0:number,v0:number,u1:number,v1:number}}
 */
export function overlaySourceWindow(fit, destWidth, destHeight, imageWidth, imageHeight) {
  const full = { u0: 0, v0: 0, u1: 1, v1: 1 };
  if (fit !== 'cover') return full;
  if (!(destWidth > 0 && destHeight > 0 && imageWidth > 0 && imageHeight > 0)) return full;

  const destAspect = destWidth / destHeight;
  const imageAspect = imageWidth / imageHeight;

  // Wider than the rect: keep a centred slice of the width, all of the height.
  if (imageAspect > destAspect) {
    const keep = destAspect / imageAspect;
    return { u0: (1 - keep) / 2, v0: 0, u1: (1 + keep) / 2, v1: 1 };
  }
  // Taller: the same, the other way round.
  if (imageAspect < destAspect) {
    const keep = imageAspect / destAspect;
    return { u0: 0, v0: (1 - keep) / 2, u1: 1, v1: (1 + keep) / 2 };
  }
  return full;
}

/**
 * Accept a decoded texture, or refuse it.
 *
 * A project file is text on a device and can carry anything -- the same
 * argument `decodeMaskJson` makes -- and the sampler indexes by
 * `(y * width + x) * 4` with no bounds check, so a buffer whose length
 * disagrees with its dimensions would read arithmetic noise rather than fail.
 *
 * The array is KEPT, never copied: a copy here doubles the resident cost of
 * every texture, and it is what lets one texture applied to N layers stay one
 * buffer -- including across the structured clone into the export worker, which
 * preserves shared references.
 *
 * @returns {{width:number,height:number,data:Uint8ClampedArray}|null}
 */
function normaliseOverlayImage(image) {
  if (!image || typeof image !== 'object') return null;
  const width = image.width | 0;
  const height = image.height | 0;
  const data = image.data;
  if (width <= 0 || height <= 0) return null;
  // A plain Array of numbers would index fine and read wrong; require bytes.
  if (!ArrayBuffer.isView(data) || data.BYTES_PER_ELEMENT !== 1) return null;
  if (data.length !== width * height * 4) return null;
  return { width, height, data };
}

/**
 * How an overlay serialises -- and the answer to "what does a saved project do
 * with an image overlay".
 *
 * IT REFERENCES IT BY NAME AND DROPS THE PIXELS. `toProjectJson` already makes
 * this exact distinction for masks: a PSD mask is left out because the file it
 * came from will still be there, while a GENERATED mask is written because
 * nothing could rebuild it. A user's texture is the first case -- the file is
 * on their device -- so the name goes in the save and the megabytes do not. A
 * 1024-edge texture would be ~5.5 MB of base64 PER LAYER; the generated mask's
 * ~1.4 MB is already flagged as heavy in that file's own comment.
 *
 * Reopening therefore yields an overlay with `kind: 'image'` and no pixels.
 * That state is DELIBERATE and visible rather than silent: `isNeutralOverlay`
 * makes it paint nothing (never a wrong picture, never a substituted gradient)
 * and `overlayNeedsImage` makes the sheet say which file to supply again.
 *
 * WHY A `toJSON` AND NOT A LINE IN toProjectJson. Two properties nothing else
 * gives at once:
 *
 *   - `JSON.stringify` honours `toJSON` wherever it is called, so no future
 *     save path can forget and write four million numbers.
 *   - it is installed NON-ENUMERABLE, and structured clone serialises only
 *     enumerable own properties -- so the export worker still receives the real
 *     pixels. An enumerable function property would instead throw
 *     DataCloneError and break export outright, which is why the test for the
 *     worker crossing also stands as the test for this.
 */
function overlayToJson() {
  return { ...this, image: null };
}

/**
 * Complete, clamp and sort an overlay.
 *
 * Everything here is in NORMALISED layer coordinates -- cx, cy and radius are
 * fractions of the layer rect, never pixels -- which is what makes the overlay
 * scale-invariant and is why no proxyScale term appears anywhere in this file.
 * The image kind adds no exception: its fit is aspect-only, see
 * overlaySourceWindow.
 */
export function normaliseOverlay(overlay) {
  const stops = (Array.isArray(overlay?.stops) ? overlay.stops : [])
    .map((s) => ({
      t: clamp(Number(s?.t) || 0, 0, 1),
      r: clamp(Math.round(Number(s?.r) || 0), 0, 255),
      g: clamp(Math.round(Number(s?.g) || 0), 0, 255),
      b: clamp(Math.round(Number(s?.b) || 0), 0, 255),
      a: clamp(Number(s?.a ?? 1), 0, 1),
    }))
    .sort((p, q) => p.t - q.t);

  const angle = Number(overlay?.angle);
  const radius = Number(overlay?.radius ?? 0.7071);

  const out = {
    kind: OVERLAY_KINDS.includes(overlay?.kind) ? overlay.kind : 'linear',
    // Kept whatever the kind is, so toggling image -> linear -> image does not
    // throw the user's picked texture away and make them find the file again.
    fit: OVERLAY_FITS.includes(overlay?.fit) ? overlay.fit : 'cover',
    image: normaliseOverlayImage(overlay?.image),
    // The FILE NAME, for the reopen disclosure. Capped: a save file is text on
    // a device and this one string must not be able to carry a megabyte.
    source: typeof overlay?.source === 'string' ? overlay.source.slice(0, 120) : '',
    angle: Number.isFinite(angle) ? angle : 0,
    cx: clamp(Number(overlay?.cx ?? 0.5) || 0, -1, 2),
    cy: clamp(Number(overlay?.cy ?? 0.5) || 0, -1, 2),
    // A zero radius divides by zero and paints the far stop everywhere.
    radius: Number.isFinite(radius) && radius > 0 ? radius : 0.7071,
    stops: stops.length >= 2 ? stops : DEFAULT_STOPS(),
    // Chosen from OUR list, not the file's -- so Phase 2's "current value not in
    // the picker" case cannot arise for an overlay, and does not need
    // duplicating here for no reason.
    mode: SUPPORTED_BLEND_MODES.includes(overlay?.mode) ? overlay.mode : 'normal',
    opacity: clamp(Number(overlay?.opacity ?? 1), 0, 1),
  };

  Object.defineProperty(out, 'toJSON', { value: overlayToJson, enumerable: false });
  return out;
}

/**
 * Nothing to paint: no opacity, no pixels, or every stop fully transparent.
 *
 * An image overlay whose pixels are absent -- a reopened project, before the
 * user re-supplies the file -- is neutral rather than an error. Painting a
 * gradient in its place would be inventing a picture; refusing to open the
 * project would lose the rest of the session. Neutral plus `overlayNeedsImage`
 * is the third answer: nothing on screen, and a sentence saying why.
 */
export const isNeutralOverlay = (overlay) => {
  if (!overlay || overlay.opacity <= 0) return true;
  if (overlay.kind === 'image') return !overlay.image;
  return (overlay.stops ?? []).every((s) => s.a <= 0);
};

/**
 * An image overlay that has lost its pixels and is waiting for them.
 *
 * The one state a saved project can reopen into. Exported so the sheet can name
 * the file rather than showing an overlay that silently does nothing.
 */
export const overlayNeedsImage = (overlay) => !!overlay && overlay.kind === 'image' && !overlay.image;

/**
 * The one positional op.
 *
 * `gpuDeferred` is not a to-do, it is a DESIGN CONSTRAINT that has to be
 * resolved before an overlay can run on a GPU tier: the fragment program
 * already specialises on the LAYER's blend mode (programNameFor -- one program
 * per mode, deliberately never a switch on a uniform), and an overlay carries
 * its OWN mode from the same 26. Supporting both makes the program key a 26x26
 * matrix, which nothing in 1B anticipated. Until 1B-2 resolves it, a layer
 * carrying an overlay must stay on the JS tier -- which costs nothing today,
 * because selectTier returns TIER_JS for everything with the verdict
 * 'shader probe not run'.
 */
OPS.overlay = {
  class: 'P', lut: false, glsl: null,
  gpuDeferred: 'a per-layer overlay blend mode multiplied by the layer\'s own is a 26x26 ' +
               'program matrix that programNameFor cannot express; the image kind adds a ' +
               'second per-layer sampler and its own texture upload on top; resolve in 1B-2',
  label: 'Overlay', range: null, neutral: null,
  evaluate: null,
};
