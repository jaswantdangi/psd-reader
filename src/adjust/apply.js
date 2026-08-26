/**
 * The per-pixel adjustment pass.
 *
 * Reads `pixels`, writes `out`, and NEVER aliases the two. Applied in a fixed,
 * declared order -- LUT, then HSL, then overlay -- because pointwise operations
 * do not commute and an undeclared order is a bug the user discovers by getting
 * a different result than the same sliders gave yesterday.
 *
 * Alpha is copied through untouched by every stage. See invariant A in the
 * spec: four consumers depend on it and three of them fail silently.
 */
import { buildLut } from './lut.js';
import { HSL_BANDS, HSL_HUE_DEGREES, bandWeights, isNeutralHsl } from './ops.js';

/**
 * Do two typed-array views share bytes?
 *
 * Reference equality is not enough. acquireScratch hands out `subarray` views
 * of one buffer, so two DIFFERENT arrays can address the same memory -- and an
 * adjustment written through one while reading the other would corrupt the
 * image from the middle outwards, which reads as a decode bug rather than as
 * what it is.
 */
const sharesBytes = (a, b) =>
  a === b || (a.buffer === b.buffer
    && a.byteOffset < b.byteOffset + b.byteLength
    && b.byteOffset < a.byteOffset + a.byteLength);

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} pixels  the source
 * @param {object|null} adjust
 * @param {{width:number,height:number,data:Uint8ClampedArray}} out  MUST NOT alias `pixels`
 * @param {Uint8Array|null} [lut]  the caller's cached table; built here when absent
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} `out`
 */
export function applyAdjustments(pixels, adjust, out, lut = null) {
  if (out.width !== pixels.width || out.height !== pixels.height)
    throw new Error(
      `applyAdjustments: destination is ${out.width}x${out.height}, ` +
      `source is ${pixels.width}x${pixels.height}`);

  if (sharesBytes(out.data, pixels.data))
    throw new Error(
      'applyAdjustments would write into its own input. resample() and textPixelsAt() BOTH ' +
      'return their input object when the dimensions already match -- which is the default ' +
      'preview path -- so an in-place adjustment overwrites the layer\'s original pixels ' +
      'permanently and compounds on every frame of a drag. Acquire a scratch destination.');

  const table = lut || buildLut(adjust);
  const src = pixels.data;
  const dst = out.data;
  const count = pixels.width * pixels.height;

  // Three array indexes and three stores, for ANY number of stacked class-A
  // operations. That is the whole cost design.
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    dst[o] = table[src[o]];
    dst[o + 1] = table[256 + src[o + 1]];
    dst[o + 2] = table[512 + src[o + 2]];
    dst[o + 3] = src[o + 3];        // invariant A: alpha is never touched
  }

  // Stage 2. Skipped entirely when neutral, decided ONCE per layer per frame
  // from the parameters, never per pixel.
  if (adjust?.hsl && !isNeutralHsl(adjust.hsl)) applyHsl(dst, count, adjust.hsl);

  return out;
}

function rgbToHsl(r, g, b, out) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn);
  const mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0, s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === rn) h = ((gn - bn) / d) % 6;
    else if (mx === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  out[0] = h; out[1] = s; out[2] = l;
}

function hslToRgb(h, s, l, out) {
  if (s <= 0) { const v = l * 255; out[0] = v; out[1] = v; out[2] = v; return; }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  out[0] = (r + m) * 255; out[1] = (g + m) * 255; out[2] = (b + m) * 255;
}

/**
 * The HSL stage, in place on an already-class-A-adjusted buffer.
 *
 * Exported so a test can force it to run on a NEUTRAL block and measure the
 * round-trip error, which applyAdjustments would otherwise skip -- and the skip
 * is precisely what makes the neutral case bit-exact, so the two facts have to
 * be measurable separately.
 *
 * @param {Uint8ClampedArray} dst
 * @param {number} count  pixels, not bytes
 * @param {{bands: {h:number,s:number,l:number}[], saturation: number}} hsl  already normalised
 */
export function applyHsl(dst, count, hsl) {
  const w = new Float64Array(HSL_BANDS.length);
  const c = new Float64Array(3);
  const bands = hsl.bands;
  const global = 1 + hsl.saturation / 100;

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    // A pixel with no alpha is never read by blendInto (`as <= 0` -> continue)
    // and is normalised away by flattenOnto before any comparison. Two colour
    // conversions for a pixel nothing can observe is the expensive pass's
    // easiest saving, and it is invisible to every consumer.
    if (dst[o + 3] === 0) continue;

    rgbToHsl(dst[o], dst[o + 1], dst[o + 2], c);
    bandWeights(c[0], w);

    let dh = 0, ds = 0, dl = 0;
    for (let k = 0; k < w.length; k++) {
      if (w[k] === 0) continue;
      dh += w[k] * bands[k].h;
      ds += w[k] * bands[k].s;
      dl += w[k] * bands[k].l;
    }

    const h = c[0] + dh * (HSL_HUE_DEGREES / 100);
    const s = Math.min(1, Math.max(0, c[1] * (1 + ds / 100) * global));
    // Lightness moves TOWARDS white or black rather than by a fixed amount, so
    // it cannot leave 0..1 no matter how the band is set.
    const t = dl / 100;
    const l = Math.min(1, Math.max(0, c[2] + (t >= 0 ? t * (1 - c[2]) : t * c[2])));

    hslToRgb(h, s, l, c);
    dst[o] = c[0]; dst[o + 1] = c[1]; dst[o + 2] = c[2];
    // dst[o + 3] deliberately untouched -- invariant A
  }
}
