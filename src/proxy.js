/**
 * Proxy-resolution helpers.
 *
 * A PSD's layers are decoded at full resolution -- ag-psd offers no partial
 * decode -- so the only way to edit a large document on a phone is to shrink
 * each layer as it arrives and release the full raster immediately.
 */

/** Longest edge, in pixels, that a proxy layer is allowed to occupy. */
export const DEFAULT_PROXY_EDGE = 1024;

/**
 * Scale factor that fits a document inside `edge`. Never upscales: a document
 * already smaller than the proxy edge is used at its natural size.
 */
export function proxyScaleFor(width, height, edge = DEFAULT_PROXY_EDGE) {
  const longest = Math.max(width || 0, height || 0);
  if (!longest || !edge) return 1;
  return Math.min(1, edge / longest);
}

/**
 * Box-average downscale.
 *
 * Deliberately NOT `resample()` from render.js: that is bilinear, which reads
 * only four neighbours and therefore aliases badly below about half scale --
 * exactly the range a proxy lives in. Averaging the whole source box is the
 * correct filter for downscaling.
 *
 * Colour is weighted by alpha. Averaging RGB straight through would let fully
 * transparent pixels (whose RGB is arbitrary, often zero) drag the result
 * toward black, producing dark fringes around every soft edge.
 */
export function downscaleImage(img, scale) {
  if (!img || !img.width || !img.height) return null;
  if (scale >= 1) return img;

  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };

  const xRatio = img.width / w;
  const yRatio = img.height / h;

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(img.height, Math.max(sy0 + 1, Math.ceil((y + 1) * yRatio)));

    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(img.width, Math.max(sx0 + 1, Math.ceil((x + 1) * xRatio)));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const alpha = img.data[i + 3];
          r += img.data[i] * alpha;
          g += img.data[i + 1] * alpha;
          b += img.data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }

      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = r / a;
        out.data[o + 1] = g / a;
        out.data[o + 2] = b / a;
      }
      out.data[o + 3] = a / n;
    }
  }

  return out;
}
