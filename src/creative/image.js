/**
 * Image and sticker layers.
 *
 * A "sticker" is not a kind of layer — it is an image layer the user added
 * instead of Photoshop. So there is one code path for both, and it takes
 * DECODED RGBA PIXELS as input. Decoding a PNG, unpacking a sticker pack,
 * fetching a URL and asking for permission are all the app's problem; nothing
 * here touches the network, the filesystem or a codec.
 *
 * `replaceImage` is the same operation aimed at a layer that already exists,
 * which is the "image replacement" gap the handoff has carried since the first
 * editor build.
 */
import { setLayer } from '../edit.js';
import { blankLayer, insertLayer, requireLayer, centreIn } from './layers.js';

/** How a replacement image is fitted into the box the old one occupied. */
export const IMAGE_FITS = ['contain', 'stretch'];

/**
 * Reject anything that is not a decoded RGBA buffer, before it is stored.
 *
 * The two mistakes this catches are both silent otherwise: an `HTMLImageElement`
 * or `Blob` passed straight through (no `data`, so the layer draws nothing and
 * looks like a bug in the renderer), and a buffer whose length disagrees with
 * its dimensions (the renderer reads past the end and produces black or
 * transparent bands). `ImageData` satisfies this as-is.
 */
function assertPixels(pixels) {
  if (!pixels || !pixels.data || !(pixels.width > 0) || !(pixels.height > 0))
    throw new Error(
      'Expected decoded RGBA pixels of the shape { width, height, data } — ' +
      'decode the image first; this engine has no codec.',
    );
  const expected = pixels.width * pixels.height * 4;
  if (pixels.data.length !== expected)
    throw new Error(
      `Pixel buffer does not match its dimensions: ${pixels.width}x${pixels.height} needs ` +
      `${expected} bytes, got ${pixels.data.length}.`,
    );
}

/** The largest `width` x `height` box that fits inside `boxW` x `boxH`, centred on it. */
function contain(box, width, height) {
  const scale = Math.min(box.w / width, box.h / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: box.x + Math.round((box.w - w) / 2), y: box.y + Math.round((box.h - h) / 2), w, h };
}

/**
 * Add an image layer to the document.
 *
 * Defaults to the image's natural pixel size, centred — an inserted sticker at
 * (0, 0) is off in a corner nine times out of ten, and the natural size is the
 * only size that is not a guess. A source larger than the document will
 * overflow it; that is deliberate rather than an auto-shrink the user did not
 * ask for, and the caller has `w`/`h` if it wants otherwise.
 *
 * `sourceW/sourceH` are the pixels' own dimensions rather than the placement
 * box, matching what they mean for a file layer: the full-resolution size of
 * the material, not where it currently sits.
 *
 * @param {object} project
 * @param {object} options
 * @param {{width:number,height:number,data:Uint8ClampedArray}} options.pixels  decoded RGBA
 * @param {number} [options.x] @param {number} [options.y]  top-left; defaults to centred
 * @param {number} [options.w] @param {number} [options.h]  placement size; defaults to natural
 * @param {string} [options.name] @param {number} [options.index]  0 = bottom, default top
 * @param {number} [options.opacity] @param {string} [options.blendMode] @param {boolean} [options.visible]
 * @returns {object} the new layer
 */
export function insertImageLayer(project, options = {}) {
  const { pixels, name = 'Image', index, opacity = 1, blendMode = 'normal', visible = true } = options;
  assertPixels(pixels);

  const w = Math.max(1, Math.round(options.w ?? pixels.width));
  const h = Math.max(1, Math.round(options.h ?? pixels.height));
  const centred = centreIn(project, w, h);

  const layer = blankLayer(project, {
    name, kind: 'raster', visible, opacity, blendMode,
    x: Math.round(options.x ?? centred.x),
    y: Math.round(options.y ?? centred.y),
    w, h,
    pixels,
    sourceW: pixels.width, sourceH: pixels.height,
    proxyW: pixels.width, proxyH: pixels.height,
    // These pixels ARE the full-resolution material -- there is no file copy to
    // re-read, and no arrival is ever coming for this layer. Export blends what
    // is here, in this stack position, and steps its `need` pointer past it.
    selfSupplied: true,
  });

  return insertLayer(project, layer, index);
}

/**
 * Swap the pixels of an existing image layer, keeping its place in the stack.
 *
 * **It clears `sourceIndex`, and that is the point.** Export re-reads the
 * original PSD and matches arrivals to layers on `sourceIndex`; a replaced
 * layer that kept its index would export the picture the user just got rid of,
 * at full resolution, looking entirely correct. It sets `selfSupplied` in the
 * same breath, so export blends the NEW buffer — which is the full-resolution
 * material now — instead of awaiting an arrival for a layer the file no longer
 * describes.
 *
 * Goes through `setLayer`, so it is one undo step. The outgoing buffer is
 * captured by reference in the command's `from` and is never written into —
 * `resample()` identity-returns its input, so anything that mutated pixels in
 * place would destroy the layer's original permanently.
 *
 * @param {object} project @param {number} id
 * @param {{pixels: object, fit?: 'contain'|'stretch'}} options
 *   `contain` (default) fits the new image inside the current box without
 *   distorting it; `stretch` keeps the box exactly and squashes to fit.
 * @returns {object} the layer
 */
export function replaceImage(project, id, options = {}) {
  const layer = requireLayer(project, id);
  const { pixels, fit = 'contain' } = options;
  assertPixels(pixels);

  if (layer.kind !== 'raster')
    throw new Error(`Layer "${layer.name}" is a ${layer.kind} layer — replace its image is not meaningful.`);
  if (!IMAGE_FITS.includes(fit))
    throw new Error(`Unknown fit "${fit}". Expected one of: ${IMAGE_FITS.join(', ')}.`);

  const box = fit === 'stretch'
    ? { x: layer.x, y: layer.y, w: layer.w, h: layer.h }
    : contain(layer, pixels.width, pixels.height);

  setLayer(project, id, {
    ...box,
    pixels,
    sourceW: pixels.width, sourceH: pixels.height,
    proxyW: pixels.width, proxyH: pixels.height,
    // No longer the file's layer. See the note above. The two fields move
    // together and are captured together in the command's `from`, so undo puts
    // BOTH back -- a restored sourceIndex with a stale `selfSupplied: true`
    // would blend the proxy buffer at full resolution.
    sourceIndex: null,
    selfSupplied: true,
    // Drop the cache KEY as well as the pixels: hitTest reads `rendered` in
    // preference to `pixels`, so a stale one hit-tests against the old image.
    rendered: null,
    renderedKey: null,
  });

  return layer;
}
