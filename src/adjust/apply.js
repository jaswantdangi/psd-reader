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

  return out;
}
