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

export function createJsExportTarget(width, height) {
  const dest = createBuffer(width, height);

  return {
    /**
     * @param {object} layer   Geometry in DOCUMENT coordinates, drawn at scale 1.
     * @param {object|null} pixels  Full-resolution pixels, or null for a layer
     *   that draws itself (re-rendered text) or has none at all.
     */
    blend(layer, pixels) {
      drawLayerInto(dest, layer, 1, {
        pixels,
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

    async finish() { return dest; },

    dispose() {},
  };
}
