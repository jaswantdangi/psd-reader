/**
 * The JS fallback compositor, wearing the ExportTarget interface.
 *
 * No tiling: there is no texture limit to respect, so the blend target is one
 * document-sized buffer. Transformed layers go through resample(), which is
 * where the measured 3.1 s -> 4.3 s desktop difference comes from.
 *
 * 1C-2's GPU target implements the same three methods over tiled FBOs, and
 * exportFullRes cannot tell them apart.
 */
import { createBuffer } from '../composite.js';
import { drawLayerInto } from '../render.js';
import { ExportError } from './errors.js';
import { drawsOwnPixels } from './order.js';
import { createScratch, releaseScratch } from '../adjust/scratch.js';

export function createJsExportTarget(width, height) {
  const dest = createBuffer(width, height);

  /**
   * Export owns its OWN adjustment scratch rather than sharing the editor's
   * module-level one, for a memory reason. At scale 1 the buffer grows to the
   * largest DESTINATION RECT in the document -- +66.4 MB for the measured
   * 4961x3508 poster, derived from 1C's peak arithmetic -- and it has to be
   * droppable before the PNG encode peak, which is the same place 1C already
   * drops the file bytes. Sharing the editor's would leave a full-resolution
   * buffer alive for the rest of the session.
   *
   * ONE term, not N: every layer reuses it, and it is only ever allocated when
   * some layer actually carries a non-neutral adjustment.
   */
  const scratch = createScratch();

  return {
    /**
     * @param {object} layer   Geometry in DOCUMENT coordinates, drawn at scale 1.
     * @param {object|null} pixels  Full-resolution pixels streamed from the
     *   file, or null for a layer that draws itself or has none at all.
     */
    blend(layer, pixels) {
      // A self-supplied layer -- an inserted sticker, a replaced image -- has
      // no arrival, so `pixels` is null for it. Its own buffer IS the
      // full-resolution material, so blend that.
      //
      // Narrowly gated on the flag, NOT on `pixels === null`. A blanket
      // fallback to layer.pixels would silently serve the PROXY buffer for any
      // file layer that failed to arrive, upscaling a 256-edge thumbnail into a
      // correctly-sized blurred layer -- which is the one failure this whole
      // module exists to prevent.
      const source = pixels === null && drawsOwnPixels(layer) ? (layer.pixels ?? null) : pixels;
      drawLayerInto(dest, layer, 1, {
        pixels: source,
        scratch,
        onMissing: (missing, reason) => {
          if (reason === 'text')
            throw new ExportError(
              `Text layer "${missing.name}" could not be rasterised — there is no drawing surface in this context. ` +
              `Exporting would have dropped it from an image that otherwise looked fine.`,
              'TEXT_MISSING',
            );
          // A raster layer with no pixels draws nothing in the preview either.
          // Export reproduces the preview, so it draws nothing here too.
        },
      });
    },

    async finish() { releaseScratch(scratch); return dest; },

    dispose() { releaseScratch(scratch); },

    /** Diagnostic seam. exportFullRes never reads it; the memory test does. */
    scratch,
  };
}
