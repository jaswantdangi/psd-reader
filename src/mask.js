/**
 * Layer masks, as a single-channel coverage plane.
 *
 * A mask is a per-layer alpha multiplier and nothing else -- `blendInto` has
 * always taken one (`if (rect.mask) as *= rect.mask[...] / 255`). What was
 * missing is everything that gets a mask from the file to that line, which is
 * this file.
 *
 * Stored one byte per pixel, never RGBA. Sixty proxy layers at 1024x1024 would
 * waste ~189 MB on three channels holding the same value, which is also why
 * `resample()` from render.js cannot be reused for the resize below.
 *
 * `projectMask` was `maskFor` in composite.js and was MOVED here, not rewritten:
 * composite.js is the 21-fixture pixel oracle and is the only place a mask was
 * ever applied correctly. It still imports this function, so the oracle keeps
 * exercising the one implementation on every test run.
 */

/** A layer node's rect in document space, taken from its own bounds. */
export const layerRect = (node) => ({
  left: node.left ?? 0,
  top: node.top ?? 0,
  width: (node.right ?? 0) - (node.left ?? 0),
  height: (node.bottom ?? 0) - (node.top ?? 0),
});

/**
 * A layer node's rect at the dimensions of a specific pixel buffer.
 *
 * The editor projects masks onto THIS rather than `layerRect` so the mask lands
 * on exactly the grid the pixels occupy, even in the rare file where a layer's
 * decoded buffer does not match its declared bounds. Alignment then holds by
 * construction rather than by two expressions happening to agree.
 */
export const pixelRect = (node, pixels) => ({
  left: node.left ?? 0,
  top: node.top ?? 0,
  width: pixels.width,
  height: pixels.height,
});

/**
 * Reproject a layer's mask into `rect`'s own grid as 0..255 coverage.
 *
 * `mask.left/top/right/bottom` can differ from the layer's bounds, and
 * `defaultColor` fills everything outside them -- so this resolves both, once,
 * and the result has NO independent geometry left to keep in sync.
 *
 * @returns {Uint8Array | null} `rect.width * rect.height` bytes, or null when
 *   the layer has no usable mask raster.
 */
export function projectMask(node, rect) {
  const mask = node.mask;
  if (!mask || !mask.imageData) return null;

  const mw = (mask.right ?? 0) - (mask.left ?? 0);
  const mh = (mask.bottom ?? 0) - (mask.top ?? 0);
  if (mw <= 0 || mh <= 0) return null;

  const fallback = mask.defaultColor ?? 0;
  const out = new Uint8Array(rect.width * rect.height).fill(fallback);
  const src = mask.imageData.data;

  for (let y = 0; y < rect.height; y++) {
    const my = rect.top + y - mask.top;
    if (my < 0 || my >= mh) continue;
    for (let x = 0; x < rect.width; x++) {
      const mx = rect.left + x - mask.left;
      if (mx < 0 || mx >= mw) continue;
      out[y * rect.width + x] = src[(my * mw + mx) * 4]; // masks are greyscale — red channel
    }
  }
  return out;
}

/**
 * Box-average a projected mask down to the dimensions of a proxy pixel buffer.
 *
 * `target` is the BUFFER, not a scale. Passing `node.proxyData` here means the
 * mask reads the very dimensions its pixels ended up with, rather than
 * evaluating `Math.round(w * scale)` a second time. The two expressions agree
 * today; making one READ the other means they cannot disagree tomorrow, at any
 * rounding, at any scale, under any future change to downscaleImage.
 *
 * Box-average for the same reason downscaleImage uses one: bilinear reads four
 * neighbours and aliases badly below about half scale, which is exactly where a
 * proxy lives. No alpha weighting -- there is only one channel, and it IS the
 * coverage.
 *
 * @param {Uint8Array} data
 * @param {{width:number,height:number}} source  dimensions of `data`
 * @param {{width:number,height:number}} target  the proxy pixel buffer
 * @returns {{width:number,height:number,data:Uint8Array}|null}
 *   `data` is returned by reference when no resizing is needed.
 */
export function downscaleMask(data, source, target) {
  if (!data || !source || !target || !target.width || !target.height) return null;

  const w = target.width;
  const h = target.height;
  if (w === source.width && h === source.height) return { width: w, height: h, data };

  const out = new Uint8Array(w * h);
  const xRatio = source.width / w;
  const yRatio = source.height / h;

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(source.height, Math.max(sy0 + 1, Math.ceil((y + 1) * yRatio)));

    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(source.width, Math.max(sx0 + 1, Math.ceil((x + 1) * xRatio)));

      let sum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) { sum += data[sy * source.width + sx]; n++; }

      out[y * w + x] = n ? Math.round(sum / n) : 0;
    }
  }

  return { width: w, height: h, data: out };
}
