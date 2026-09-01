/**
 * Turning a model's answer into a layer mask, and putting it on the layer.
 *
 * This is the seam between "an ONNX tensor came back" and "the editor has a
 * cut-out". Everything above it is inference (in a worker, in the app);
 * everything below it is the mask plane render.js already understands.
 *
 * ## Why a generated mask is not a new kind of thing
 *
 * `maskOf()` in edit.js builds `{data, width, height, disabled}` on the pixel
 * buffer's own grid, and render.js multiplies alpha by it. A generated mask is
 * the same object with one extra field -- `generated: true` -- and that field
 * exists for exactly one reason: persistence. A PSD mask is rebuilt from the
 * file on every load, so toProjectJson stores only its toggle. A generated mask
 * has no file to be rebuilt from, so it has to be written out, and `generated`
 * is how the writer knows which is which. Nothing in the render path reads it.
 *
 * ## Why the mask is committed through setLayer
 *
 * `set` commands already assign arbitrary layer fields and capture the previous
 * value in `from`, which makes a mask swap invertible for free. Adding a
 * dedicated command type would have meant a second place that knows how to
 * restore a mask, and the frame work already showed what that costs.
 */

import { setLayer, findLayer } from '../edit.js';
import { combineMask, fullMask, strokeMask, isOpaque, cutFraction } from './mask-ops.js';
import { refineCutout } from './refine.js';

/**
 * Resample a model's single-channel output onto the layer's pixel grid.
 *
 * The model runs at its own training resolution (1024 square for BiRefNet_lite)
 * and the layer's proxy is whatever `proxyScaleFor` produced -- almost never the
 * same, and almost never the same aspect ratio either, because the image was
 * letterboxed into the square. Bilinear rather than nearest: a mask is a
 * continuous quantity and nearest-neighbour would stair-step every edge the
 * guided filter is about to be asked to clean up.
 *
 * `source` values may be 0..1 floats (a sigmoid output) or 0..255 bytes. Both
 * are accepted because the two runtimes disagree and forcing the caller to
 * normalise first is one more place to get it wrong.
 *
 * @param {Float32Array|Uint8Array|number[]} source
 */
export function resampleLogits(source, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH);
  // Probe rather than trust: a Float32Array of 0..255 is legal and a
  // Uint8Array is never 0..1, so the constructor alone does not settle it.
  let max = 0;
  for (let i = 0; i < source.length; i++) if (source[i] > max) max = source[i];
  const scale = max > 1.001 ? 1 : 255;

  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    // Sample at pixel CENTRES. Sampling at corners shifts the whole mask by
    // half a source pixel, which at a 4x proxy ratio is a visible two-pixel
    // offset along every edge.
    const sy = Math.min(srcH - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;

      const a = source[y0 * srcW + x0], b = source[y0 * srcW + x1];
      const c = source[y1 * srcW + x0], d = source[y1 * srcW + x1];
      const v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      const s = v * scale;
      out[y * dstW + x] = s <= 0 ? 0 : s >= 255 ? 255 : Math.round(s);
    }
  }
  return out;
}

/**
 * The full pipeline from raw model output to a mask ready to commit.
 *
 * Returns the cleaned pixels alongside, because decontamination rewrites edge
 * colours and those have to travel with the mask or the halo it removed comes
 * straight back at composite time.
 */
export function buildCutout(logits, srcW, srcH, pixels, options = {}) {
  const raw = resampleLogits(logits, srcW, srcH, pixels.width, pixels.height);
  const { mask, pixels: cleaned } = refineCutout(raw, pixels, options);
  return { mask, pixels: cleaned, coverage: cutFraction(mask), empty: isOpaque(mask) };
}

/**
 * Put a generated mask on a layer, as one undo step.
 *
 * `mode` composes with whatever mask the layer already has -- which is how a
 * click-refine adds to a cut, and how a cut lands on a layer that arrived from
 * the PSD already masked. Replacing unconditionally would silently discard the
 * file's own mask, and the user would have no way to know a mask had ever been
 * there.
 *
 * The decontaminated pixels are committed in the SAME command as the mask.
 * Two commands would mean an undo that restores the old alpha against the new
 * colours -- a state the document was never in.
 */
export function applyCutout(project, id, cut, options = {}) {
  const layer = findLayer(project, id);
  if (!layer) return project;

  const { mode = 'replace', coalesceKey } = options;
  const base = layer.mask?.data ?? fullMask(layer.pixels.width, layer.pixels.height);
  const data = mode === 'replace' ? cut.mask : combineMask(base, cut.mask, mode);

  const changes = {
    mask: {
      data,
      width: layer.pixels.width,
      height: layer.pixels.height,
      // A generated mask is never born switched off. Carrying the old flag
      // forward would hide a fresh cut behind a PSD's disabled-mask toggle.
      disabled: false,
      /** @see the persistence note at the top of this file. */
      generated: true,
    },
  };
  // Only when decontamination actually ran. Writing `pixels` unconditionally
  // would replace the layer's original buffer with a copy of itself and cost a
  // full-size allocation per cut for nothing.
  if (cut.pixels && cut.pixels !== layer.pixels) changes.pixels = cut.pixels;

  return setLayer(project, id, changes, coalesceKey);
}

/**
 * Paint on the mask by hand.
 *
 * Works with no model, which is the point: the automatic cut is gated behind a
 * memory budget that a large share of Android devices fail, and this is the
 * path those devices still have. It is also the escape hatch when the model is
 * simply wrong, which no amount of model quality removes the need for.
 *
 * `points` are in the LAYER's pixel space, not document or canvas space. The
 * caller converts, because only it knows the view transform -- and naming the
 * space here is the whole defence against the class of bug the frame work hit
 * when hitTest quietly changed coordinate systems.
 */
export function paintMask(project, id, points, options = {}) {
  const layer = findLayer(project, id);
  if (!layer?.pixels) return project;

  const { width, height } = layer.pixels;
  // Start from a fully-covering plane rather than an empty one: painting on an
  // unmasked layer should reveal nothing at first and then hide where the user
  // erases. Starting empty would blank the layer the moment the brush is armed.
  const base = layer.mask?.data ?? fullMask(width, height);
  const data = strokeMask(base, width, height, points, {
    radius: options.radius ?? 24,
    hardness: options.hardness ?? 0.5,
    flow: options.flow ?? 1,
    erase: options.erase ?? false,
  });

  return setLayer(project, id, {
    mask: { data, width, height, disabled: false, generated: true },
  }, options.coalesceKey);
}

/**
 * Remove a generated mask, restoring the layer to uncut.
 *
 * Deliberately does NOT try to put a PSD-derived mask back: that raster is
 * rebuilt from the file on load and this project may have been reopened since,
 * so reconstructing it here would be guessing. Clearing to null and letting the
 * next load rebuild it is the only honest answer, and it is what undo does
 * anyway if the user reaches for that instead.
 */
export function clearCutout(project, id) {
  const layer = findLayer(project, id);
  if (!layer?.mask?.generated) return project;
  return setLayer(project, id, { mask: null });
}

/**
 * How much sharpness the export will lose, and whether to say so.
 *
 * The mask is generated on the proxy (1024 max edge) and export streams layers
 * at FULL resolution, so the mask is upscaled by the proxy ratio on the way
 * out. At 2x that is invisible; at 4x, hair-scale detail the model found is
 * simply not in the buffer any more and the exported edge is soft.
 *
 * This is the disclosure, not a fix. It returns a sentence rather than logging
 * one because a caveat that lives only in a console message is a caveat the
 * user never reads -- and the exported file is the artefact they keep.
 *
 * @returns {string | null} null when the upscale is small enough not to matter.
 */
export function exportSoftnessNote(project, proxyScale) {
  if (!proxyScale || proxyScale >= 0.5) return null;
  const factor = Math.round((1 / proxyScale) * 10) / 10;
  const cut = project.layers.filter((l) => l.mask?.generated).length;
  if (cut === 0) return null;
  return (
    `${cut} cut-out layer${cut === 1 ? '' : 's'} will be exported at ${factor}x the ` +
    `size the cut was made at, so fine edges such as hair will be softer in the ` +
    `exported file than they look here.`
  );
}
