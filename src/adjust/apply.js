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
import { blendInto } from '../composite.js';
import {
  HSL_BANDS, HSL_HUE_DEGREES, bandWeights, isNeutralHsl, isNeutralOverlay,
  overlaySourceWindow,
} from './ops.js';

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

  // Stage 3. Pointwise in the pixel's NORMALISED position, so it is
  // scale-invariant and tiles with no halo.
  if (adjust?.overlay && !isNeutralOverlay(adjust.overlay)) applyOverlay(out, adjust.overlay);

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

/** The gradient colour at `t`, written into `out` as r, g, b, a(0..1). */
function sampleStops(stops, t, out) {
  const first = stops[0];
  if (t <= first.t) { out[0] = first.r; out[1] = first.g; out[2] = first.b; out[3] = first.a; return; }
  const last = stops[stops.length - 1];
  if (t >= last.t) { out[0] = last.r; out[1] = last.g; out[2] = last.b; out[3] = last.a; return; }

  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (t > b.t) continue;
    const a = stops[i - 1];
    const span = b.t - a.t;
    const f = span > 0 ? (t - a.t) / span : 0;
    out[0] = a.r + (b.r - a.r) * f;
    out[1] = a.g + (b.g - a.g) * f;
    out[2] = a.b + (b.b - a.b) * f;
    out[3] = a.a + (b.a - a.a) * f;
    return;
  }
}

/**
 * Bilinear sample of a texture at a NORMALISED position inside `win`,
 * written into `out` as r, g, b, a(0..1).
 *
 * ## Why bilinear, and not downscaleImage's box average
 *
 * The two filters in this repository answer different questions.
 * `downscaleImage` is the correct filter for MINIFICATION -- averaging the
 * whole source box, which four bilinear neighbours cannot do below about half
 * scale. `resample` is bilinear, and is what every layer's own pixels go
 * through in drawLayerInto one line above this pass.
 *
 * The anti-alias budget for an overlay is spent ONCE, at import, where the
 * user's PNG is box-reduced to OVERLAY_IMAGE_EDGE by the app layer. What
 * reaches here is therefore an already-band-limited texture, and the remaining
 * job is a resample to the destination rect -- upscaling at export, mild
 * minification at proxy. Bilinear is right for the first and adequate for the
 * second, and choosing it means the overlay is filtered by exactly the same
 * arithmetic as the layer it sits on, rather than by a second filter that could
 * make the two disagree about where an edge is.
 *
 * A per-destination-pixel box average WOULD be better under heavy minification.
 * It is not free: the honest version is scale-dependent, and a filter that
 * changes with `scale` is precisely the thing this whole feature must not have
 * -- it would make the proxy and the export differ by construction. Documented
 * here rather than left as a silent choice; the visible cost is that a
 * high-frequency grain texture shrunk hard will sparkle, which is one of the
 * reasons `tile` is backlogged rather than shipped.
 *
 * Clamped to the source's own range at BOTH ends rather than only at the top,
 * so an edge texel is the edge colour rather than a linear extrapolation past
 * it -- `resample` tolerates the negative fraction because its source and
 * destination always cover the same rect; a cropped `cover` window does not.
 */
function sampleImage(image, win, u, v, out) {
  const w = image.width;
  const h = image.height;

  let sx = (win.u0 + u * (win.u1 - win.u0)) * w - 0.5;
  let sy = (win.v0 + v * (win.v1 - win.v0)) * h - 0.5;
  sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
  sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;

  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = x0 + 1 > w - 1 ? w - 1 : x0 + 1;
  const y1 = y0 + 1 > h - 1 ? h - 1 : y0 + 1;
  const fx = sx - x0;
  const fy = sy - y0;

  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const data = image.data;

  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
    const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
    out[c] = top + (bottom - top) * fy;
  }
  // One convention for both sources: sampleStops reports alpha as 0..1.
  out[3] /= 255;
}

/**
 * Paint the overlay over the adjusted buffer, in place.
 *
 * Row by row, through blendInto. Two reasons, both about not building a second
 * compositor: the 26 blend modes stay in ONE implementation -- the
 * pixel-validated oracle -- and the overlay needs only a `width * 4` row
 * buffer rather than a second full-size scratch, which the export peak cannot
 * afford. That is also why an image overlay is sampled per pixel INTO THAT ROW
 * rather than pre-resampled to the destination rect: a pre-resample would
 * allocate a second rect-sized buffer, which at export is another 66 MB for the
 * measured poster.
 *
 * The sample position is normalised: (x + 0.5) / width, never a pixel offset.
 * That is the whole scale-invariance argument, and it is one line -- and it is
 * the same line for a gradient and for an image, which is why the image kind
 * needed no new argument about proxy and export agreeing.
 */
export function applyOverlay(out, overlay) {
  const { width, height } = out;
  const row = new Uint8ClampedArray(width * 4);
  const alphas = new Uint8ClampedArray(width);
  const sample = new Float64Array(4);
  const radians = (overlay.angle * Math.PI) / 180;
  const ca = Math.cos(radians);
  const sa = Math.sin(radians);
  const image = overlay.kind === 'image' ? overlay.image : null;
  const radial = overlay.kind === 'radial';
  const rect = { left: 0, top: 0, width, height: 1 };

  // Decided ONCE for the whole pass, from aspect ratios alone -- so the crop is
  // the same number at proxy scale and at document scale. See
  // overlaySourceWindow.
  const srcWindow = image
    ? overlaySourceWindow(overlay.fit, width, height, image.width, image.height)
    : null;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const base = y * width * 4;

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;

      if (image) {
        sampleImage(image, srcWindow, u, v, sample);
      } else {
        const t = radial
          ? Math.min(1, Math.hypot(u - overlay.cx, v - overlay.cy) / overlay.radius)
          : Math.min(1, Math.max(0, 0.5 + (u - 0.5) * ca + (v - 0.5) * sa));
        sampleStops(overlay.stops, t, sample);
      }

      const dstAlpha = out.data[base + x * 4 + 3];
      alphas[x] = dstAlpha;
      row[x * 4] = sample[0];
      row[x * 4 + 1] = sample[1];
      row[x * 4 + 2] = sample[2];
      // Clipped to the layer's OWN alpha, times the texture's own where there
      // is one -- which is what lets a light leak fade out. Without the layer
      // term an overlay paints into the transparent region and turns a cut-out
      // into a rectangle.
      row[x * 4 + 3] = sample[3] * 255 * (dstAlpha / 255);
    }

    rect.top = y;
    blendInto(out, row, rect, overlay.opacity, overlay.mode);

    // blendInto is a GENERAL compositor: ao = as + ab(1 - as) raises alpha on
    // every partially transparent pixel. An overlay tints; it does not add
    // coverage. Restoring the column is what keeps invariant A true rather than
    // nearly true.
    for (let x = 0; x < width; x++) out.data[base + x * 4 + 3] = alphas[x];
  }
}
