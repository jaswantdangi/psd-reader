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
import { drawLayerInto, drawClipRunInto, createClipScratch, releaseClipScratch } from '../render.js';
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

  /**
   * The clip run's group and alpha buffers, owned here for exactly the reasons
   * above: one growing pair rather than one per run, and dropped at `finish()`
   * so `w * h * 5` bytes are not alive through the encode peak.
   *
   * LAZY. `createClipScratch` allocates nothing; `acquireClipScratch` is
   * reached only from a run with a clipped layer in it. A document that uses no
   * clipping mask -- all 21 fixtures -- pays nothing at all.
   */
  const clipScratch = createClipScratch();

  /**
   * The run being assembled, or null. `layers[0]` is its base and the rest are
   * clipped to it; `pixels[i]` is what the renderer must read for `layers[i]`.
   *
   * A run has to be composited as a UNIT -- base into a scratch group, the
   * base's alpha taken from it, each clipped layer blended through that alpha,
   * and only then the whole group blended down with the BASE's opacity and
   * blend mode. Blending a clipped layer straight into `dest` as it arrives is
   * what made the export disagree with the preview.
   *
   * Assembled here rather than in the walk because `framedTarget` rewrites
   * every layer's geometry one `blend` call at a time; a run handed over whole
   * would arrive with the wrong coordinates.
   */
  let run = null;

  const onMissing = (missing, reason) => {
    if (reason === 'text')
      throw new ExportError(
        `Text layer "${missing.name}" could not be rasterised — there is no drawing surface in this context. ` +
        `Exporting would have dropped it from an image that otherwise looked fine.`,
        'TEXT_MISSING',
      );
    // A raster layer with no pixels draws nothing in the preview either.
    // Export reproduces the preview, so it draws nothing here too.
  };

  /**
   * The pixels the renderer must read for this layer.
   *
   * A self-supplied layer -- an inserted sticker, a replaced image -- has no
   * arrival, so `pixels` is null for it. Its own buffer IS the full-resolution
   * material, so use that.
   *
   * Narrowly gated on the flag, NOT on `pixels === null`. A blanket fallback to
   * layer.pixels would silently serve the PROXY buffer for any file layer that
   * failed to arrive, upscaling a 256-edge thumbnail into a correctly-sized
   * blurred layer -- which is the one failure this whole module exists to
   * prevent.
   */
  const sourceFor = (layer, pixels) =>
    (pixels === null && drawsOwnPixels(layer) ? (layer.pixels ?? null) : pixels);

  /**
   * Draw the assembled run and drop it.
   *
   * A run of one is the ordinary single-layer path, byte for byte and with no
   * group buffer -- which is every layer of every document that uses no
   * clipping mask.
   *
   * A longer run goes to `drawClipRunInto`, the preview's own function, so
   * there is no second clipping implementation to drift from it. It reads each
   * layer's pixels off `layer.pixels`, deliberately -- `options.pixels` names
   * ONE layer's buffer and a run is several -- so each layer is presented as an
   * `Object.create` VIEW carrying the streamed buffer.
   *
   * A view rather than a `{...layer}` copy, so `pixels` is the ONLY thing this
   * shadows. `framedTarget` installs accessors for the render caches
   * (`rendered`, `lut`, ...) that deliberately read and write THROUGH to the
   * real layer; a spread flattens them into dead values, and every cache the
   * run builds would then be thrown away with the copy instead of landing where
   * the editor will find it. A view inherits the accessors and keeps that
   * write-through intact.
   *
   * Nothing is written back onto the project's layers. Assigning the
   * full-resolution buffer onto `layer.pixels` itself would leave a proxy
   * project holding full-resolution pixels if anything threw between here and
   * the restore.
   */
  const flush = () => {
    if (!run) return;
    const { layers, pixels } = run;
    run = null;

    if (layers.length === 1) {
      drawLayerInto(dest, layers[0], 1, { pixels: pixels[0], scratch, onMissing });
      return;
    }

    const views = layers.map((layer, i) => {
      const view = Object.create(layer);
      view.pixels = pixels[i];
      return view;
    });
    drawClipRunInto(dest, views, 0, 1, { scratch, clipScratch, onMissing });
  };

  return {
    /**
     * @param {object} layer   Geometry in DOCUMENT coordinates, drawn at scale 1.
     * @param {object|null} pixels  Full-resolution pixels streamed from the
     *   file, or null for a layer that draws itself or has none at all.
     */
    blend(layer, pixels) {
      // A clipped layer joins the run under it. There is always one to join:
      // the walk hands over whole runs, base first, and a clipped layer with no
      // run open can only be the bottom layer of the stack -- which is its own
      // base, in Photoshop and in the compositor and in the preview.
      if (run && layer.clipping === true) {
        run.layers.push(layer);
        run.pixels.push(sourceFor(layer, pixels));
        return;
      }
      flush();
      run = { layers: [layer], pixels: [sourceFor(layer, pixels)] };
    },

    /**
     * Draw the open run now.
     *
     * ONLY LEGAL AT A RUN BOUNDARY. Called inside a run it would strand the next
     * clipped layer as a base of its own, drawing it unclipped -- the exact bug
     * this file was changed to fix. `exportFullRes` calls it when the next layer
     * in blend order is not a clipped one, which is the only place it may be
     * called from.
     *
     * OPTIONAL, and correctness never depends on it: the next unclipped `blend`
     * and `finish()` both flush anyway. It exists so the run's full-resolution
     * pixels are released before the reader decodes the next layer instead of
     * after, which is the difference between one full-resolution layer resident
     * and two.
     */
    flush,

    async finish() {
      flush();                                   // before the scratches go
      releaseScratch(scratch);
      releaseClipScratch(clipScratch);
      return dest;
    },

    dispose() {
      run = null;
      releaseScratch(scratch);
      releaseClipScratch(clipScratch);
    },

    /** Diagnostic seams. exportFullRes never reads them; the memory tests do. */
    scratch,
    clipScratch,
  };
}
