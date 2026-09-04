/**
 * Edge refinement and colour decontamination -- the two passes that separate a
 * clean cut-out from a fringed one.
 *
 * Neither of these is a neural network. That is the point: the model already
 * cost 115 MB, and both of the remaining quality problems are classical image
 * processing that costs kilobytes. Stacking a second model to fix the first
 * model's edges would have doubled the download to buy something a guided
 * filter does in one pass over the buffer.
 *
 * ## What each pass is for
 *
 * A segmentation model answers "is this pixel foreground", and it answers it at
 * whatever resolution it was trained on, with a soft boundary that follows the
 * SHAPE it inferred rather than the edge actually present in the pixels. Two
 * artefacts follow, and they need different fixes:
 *
 *   1. The alpha boundary sits a pixel or two off the real edge, and is too
 *      soft where the edge is sharp and too sharp where it is soft (hair).
 *      `guidedRefine` pulls the alpha back onto the edge the PIXELS show.
 *
 *   2. Partly-transparent edge pixels still contain the old background's
 *      colour, mixed in by the camera. Composite that over white and you get a
 *      dark halo; over a new background you get the old one's colour bleeding
 *      through. `decontaminate` solves for the foreground colour and rewrites
 *      those pixels.
 *
 * Fix 2 is the one people notice and cannot name. It is why a cut-out looks
 * "cheap" even when the mask is correct.
 */

import { boxBlur } from './mask-ops.js';

/**
 * Pull a soft mask onto the edges present in the guide image.
 *
 * He, Sun & Tang's guided filter, with the layer's own luminance as the guide.
 * The classic formulation: fit `q = a*I + b` over a local window, where `a` and
 * `b` are chosen to minimise the difference from the input mask, then average
 * the per-window fits. Where the guide has no variance the fit collapses to the
 * local mean (a smooth blur); where it has an edge, `a` goes large and the
 * output snaps to that edge. One pass, O(pixels), no iteration.
 *
 * `eps` is the regularisation: it sets what counts as "an edge worth following"
 * in squared luminance units on a 0..1 scale. Small values track fine texture
 * and will happily follow JPEG noise into the mask; large values ignore all but
 * strong edges. 1e-4 is the usual starting point for 8-bit photographic input.
 *
 * @param {Uint8Array} mask    coverage plane, width*height
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} pixels RGBA guide
 * @returns {Uint8Array} refined plane, same dimensions
 */
export function guidedRefine(mask, pixels, options = {}) {
  const { width, height } = pixels;
  const { radius = 4, eps = 1e-4 } = options;
  if (mask.length !== width * height)
    throw new Error(`mask/guide mismatch: ${mask.length} vs ${width * height}`);
  if (radius < 1) return Uint8Array.from(mask);

  const n = width * height;
  const guide = new Float32Array(n);
  const p = new Float32Array(n);
  const src = pixels.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Rec. 601 luma. The choice barely matters here -- what matters is that the
    // guide is a single channel, because a three-channel guided filter needs a
    // 3x3 covariance inverse per pixel and buys almost nothing on an alpha
    // boundary that is already achromatic.
    guide[i] = (src[o] * 0.299 + src[o + 1] * 0.587 + src[o + 2] * 0.114) / 255;
    p[i] = mask[i] / 255;
  }

  const meanI = boxBlur(guide, width, height, radius);
  const meanP = boxBlur(p, width, height, radius);

  const II = new Float32Array(n);
  const IP = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = guide[i] * guide[i];
    IP[i] = guide[i] * p[i];
  }
  const meanII = boxBlur(II, width, height, radius);
  const meanIP = boxBlur(IP, width, height, radius);

  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = meanII[i] - meanI[i] * meanI[i];
    const covIP = meanIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }

  const meanA = boxBlur(a, width, height, radius);
  const meanB = boxBlur(b, width, height, radius);

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const q = meanA[i] * guide[i] + meanB[i];
    out[i] = q <= 0 ? 0 : q >= 1 ? 255 : Math.round(q * 255);
  }
  return out;
}

/**
 * Rewrite edge pixels to the foreground colour, removing background spill.
 *
 * The compositing equation the camera already applied is
 *
 *     C = a*F + (1 - a)*B
 *
 * where C is what we have, `a` is the mask, and F and B are unknown. Two
 * unknowns, one equation -- so B is estimated from the neighbourhood and F
 * solved for. B is taken as the local average of pixels weighted by their
 * BACKGROUND-ness (1 - a), which is the cheap standard estimate: near an edge,
 * the background a few pixels away is a good guess for the background mixed
 * into the edge.
 *
 * Only pixels with a partial alpha are touched. A fully opaque pixel has no
 * background in it to remove, and rewriting it would tint solid interior
 * regions for no reason -- a failure mode worth naming because it looks like a
 * colour-management bug rather than a matting one.
 *
 * Returns NEW pixel data; the layer's original buffer is never mutated, because
 * `layer.pixels` is the thing the whole editor treats as immutable source.
 *
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function decontaminate(pixels, mask, options = {}) {
  const { width, height } = pixels;
  const { radius = 6, threshold = 8 } = options;
  const n = width * height;
  // guidedRefine has always thrown on a mismatch; this did not, and the
  // consequence was worse than a throw. Past the end of a short mask
  // `mask[i]` is undefined, `1 - undefined / 255` is NaN, and a
  // Uint8ClampedArray stores NaN as 0 -- so the tail of the image went BLACK,
  // with alpha left at 255 so it did not even read as transparent. Silent,
  // and indistinguishable from a legitimately dark image.
  if (mask.length !== n)
    throw new Error(`mask/pixels mismatch: ${mask.length} vs ${n}`);
  const src = pixels.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);
  if (radius < 1) return { data: out, width, height };

  // Background-weighted colour sums. Weighting by (1 - a) rather than taking a
  // plain neighbourhood average is what keeps the foreground's own colour from
  // contaminating the very estimate meant to remove contamination.
  const wB = new Float32Array(n);
  const rB = new Float32Array(n);
  const gB = new Float32Array(n);
  const bB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const w = 1 - mask[i] / 255;
    wB[i] = w;
    rB[i] = src[o] * w;
    gB[i] = src[o + 1] * w;
    bB[i] = src[o + 2] * w;
  }
  const sumW = boxBlur(wB, width, height, radius);
  const sumR = boxBlur(rB, width, height, radius);
  const sumG = boxBlur(gB, width, height, radius);
  const sumB = boxBlur(bB, width, height, radius);

  for (let i = 0; i < n; i++) {
    const a = mask[i] / 255;
    // Skip the interior and the fully-cut. `threshold` also skips alphas so
    // near zero that dividing by them amplifies the estimate's own error into
    // saturated confetti -- the classic un-premultiply blow-up.
    if (mask[i] <= threshold || mask[i] >= 255 - threshold) continue;
    // No background anywhere nearby: nothing to estimate B from, so leave the
    // pixel exactly as the camera recorded it rather than invent a colour.
    if (sumW[i] < 1e-3) continue;

    const o = i * 4;
    const bR = sumR[i] / sumW[i];
    const bG = sumG[i] / sumW[i];
    const bBl = sumB[i] / sumW[i];

    out[o] = (src[o] - (1 - a) * bR) / a;
    out[o + 1] = (src[o + 1] - (1 - a) * bG) / a;
    out[o + 2] = (src[o + 2] - (1 - a) * bBl) / a;
    // Uint8ClampedArray does the clamping, which is the one place in this
    // codebase where relying on the clamp is correct rather than lazy: values
    // outside 0..255 here mean the linear model did not hold for that pixel,
    // and the nearest valid colour is exactly the right fallback.
  }
  return { data: out, width, height };
}

/**
 * Both passes, in the order they have to run.
 *
 * Refinement first: decontamination divides by the alpha, so it must see the
 * FINAL alpha or it removes spill in proportion to a number that is about to
 * change. Running them the other way round produces edges that look corrected
 * at a glance and are wrong by a few percent everywhere -- the kind of error
 * that survives review.
 */
export function refineCutout(mask, pixels, options = {}) {
  const refined = options.refine === false
    ? Uint8Array.from(mask)
    : guidedRefine(mask, pixels, options);
  // A copy, not `pixels`. This returned the caller's own object when
  // decontamination was off, contradicting this function's own promise of new
  // pixel data and leaving the two aliased -- so writing to the result wrote
  // through to the source. The same shape as the resample() identity-return
  // this codebase was already bitten by, where writing into the output
  // permanently destroyed layer.pixels.
  const cleaned = options.decontaminate === false
    ? { data: Uint8ClampedArray.from(pixels.data), width: pixels.width, height: pixels.height }
    : decontaminate(pixels, refined, options);
  return { mask: refined, pixels: cleaned };
}
