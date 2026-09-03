/**
 * Full-resolution streaming export.
 *
 * Editing happens against a proxy, so the pixels the editor is holding are
 * roughly 1/23rd of the document's real pixel count. Compositing them at
 * scale 1 would upscale a 1024-edge bitmap and produce a blurred image at
 * exactly the right dimensions -- the worst failure shape available, because it
 * looks like it worked. So export goes back to the file.
 *
 * Every side effect is injected: `readSource` for bytes, `spill` for disk,
 * `createTarget` for the compositor. Nothing here imports Capacitor or WebGL,
 * which is what lets the whole walk run in Node against fs and a Map.
 *
 * Peak memory is `file bytes + one full-res layer + output buffer` on both the
 * fast and the spill path -- exactly one full-resolution layer is resident at a
 * time, and the file bytes are dropped before the readback.
 *
 * A CLIP RUN IS THE ONE EXCEPTION, and it is a real one. A run is composited as
 * a unit, so every member's pixels have to be in hand at once; the layer term
 * becomes `max(largest layer, largest run)` and a `w * h * 5` group-and-alpha
 * pair joins it while a run is being drawn. `estimatePeakBytes` in
 * src/budget.js carries both terms. A document with no clipping mask -- which
 * is every one of the 21 fixtures -- pays neither: its runs are all of length
 * one, which is the ordinary single-layer path and allocates nothing.
 */
import { readDocument } from '../reader.js';
import { ExportError } from './errors.js';
import { buildExportOrder, wantedIndices, assertIdentifiable, drawsOwnPixels } from './order.js';
import { spillHeader, decodeSpill } from './spill.js';
import { phaseFraction } from './progress.js';
import { createJsExportTarget } from './target-js.js';

const EMPTY = { width: 0, height: 0, data: new Uint8ClampedArray(0) };

/**
 * @param {object} options
 * @param {object} options.project        A proxy-loaded project. Geometry is in document space.
 * @param {() => Promise<Uint8Array>} options.readSource
 *   Re-reads the original file. Must NOT retain the result -- export drops its
 *   own reference before the readback, and a second reference would keep
 *   300-odd MB alive through the encode peak.
 * @param {{write(name: string, chunks: Uint8Array[]): Promise<void>,
 *          read(name: string): Promise<Uint8Array>,
 *          remove(name: string): Promise<void>,
 *          dispose(): Promise<void>}} options.spill
 * @param {(width: number, height: number) => object} [options.createTarget]
 *   Defaults to the JS compositor. 1C-2 passes the tiled GPU target here.
 *   An OPTIONAL `flush()` is called at every clip-run boundary; a target
 *   without one draws the same picture and just holds one layer longer.
 * @param {(p: {phase: string, done: number, total: number, fraction: number}) => void} [options.onProgress]
 * @param {{cancelled: boolean}} [options.signal]
 *   Checked at every layer boundary. Cancel latency is therefore up to one full
 *   layer decode -- an estimated 1-3 s on mobile for a 66 MB layer. Say
 *   "Cancelling…" in the UI and mean it.
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>}
 */
export async function exportFullRes(options) {
  const {
    project,
    readSource,
    spill,
    createTarget = createJsExportTarget,
    onProgress = null,
    signal = null,
  } = options;

  const order = buildExportOrder(project);
  assertIdentifiable(order);
  const wanted = wantedIndices(order);

  const report = (phase, done = 0, total = 0) => {
    if (onProgress) onProgress({ phase, done, total, fraction: phaseFraction(phase, done, total) });
  };
  const stopIfCancelled = () => {
    if (signal && signal.cancelled) throw new ExportError('Export cancelled.', 'CANCELLED');
  };

  const target = createTarget(project.width, project.height);
  const parked = new Set();
  const seen = new Set();
  const nameFor = (index) => `${index}.rgba`;
  let need = 0;
  let drained = 0;

  /**
   * Hand one layer to the target and close the run if this layer ended it.
   *
   * The target assembles clip runs itself -- `framedTarget` rewrites geometry one
   * `blend` call at a time, so a run cannot be handed over whole -- and it
   * cannot see a run END, only a run start. So the walk tells it, here, at the
   * only place that knows: `order` keeps every run contiguous, so the run is
   * over exactly when the next layer is not a clipped one.
   *
   * FLUSHING INSIDE A RUN WOULD BE A BUG, not a slowdown: the next clipped
   * layer would open a run of its own and draw unclipped.
   *
   * `flush` is optional -- a target without one still flushes on the next
   * unclipped blend and at `finish()` -- so this is a memory optimisation, not
   * a correctness one. Without it the target holds the last blended layer's
   * full-resolution pixels while the reader decodes the next, which is a second
   * full-resolution layer resident on every export, clipped or not.
   */
  const blend = (layer, pixels) => {
    target.blend(layer, pixels);
    need++;
    const next = order[need];
    if ((!next || next.clipping !== true) && target.flush) target.flush();
  };

  /**
   * Satisfy every layer that can be satisfied right now, in blend order:
   * a layer that draws its own pixels -- re-rendered text, or an inserted or
   * replaced image that already holds its full-resolution buffer -- needs
   * nothing from the file, and anything already on disk comes back.
   * Stops at the first layer that still has to arrive from the stream.
   *
   * `blend(layer, null)` is what advances `need` past a self-supplying layer.
   * It has NO arrival, so waiting for one would park every layer behind it and,
   * once the stream ended, fail the INCOMPLETE check with nothing to blame.
   */
  const drain = async (phase) => {
    while (need < order.length) {
      const layer = order[need];
      if (drawsOwnPixels(layer)) { blend(layer, null); continue; }
      if (!parked.has(layer.sourceIndex)) break;

      const name = nameFor(layer.sourceIndex);
      blend(layer, decodeSpill(await spill.read(name)));
      await spill.remove(name);
      parked.delete(layer.sourceIndex);
      drained++;
      if (phase === 'drain') report('drain', drained, drained + parked.size);
      stopIfCancelled();
    }
  };

  try {
    stopIfCancelled();

    report('read', 0, 1);
    let bytes = await readSource();
    report('read', 1, 1);

    const expectedSize = project.source && project.source.size;
    if (expectedSize && bytes.byteLength !== expectedSize)
      throw new ExportError(
        `"${project.source.name}" is ${bytes.byteLength} bytes but was ${expectedSize} when it was opened — ` +
        `the file changed on disk.`,
        'SOURCE_CHANGED',
      );

    await readDocument(bytes, {
      pixels: 'stream',
      metadata: false,
      // Three naive O(n) scans of the whole file, for a warning already shown
      // at load. Not on this path.
      patterns: false,
      wantLayer: (_layer, index) => wanted.has(index),

      onStart: async ({ width, height }) => {
        if (width !== project.width || height !== project.height)
          throw new ExportError(
            `The source file is ${width}x${height} but this project is ${project.width}x${project.height} — ` +
            `it is not the same document.`,
            'SOURCE_MISMATCH',
          );
        report('parse', 0, 0);
        // A self-supplying layer at the bottom of the stack -- re-rendered text
        // or an inserted sticker -- has to be drawn before the first arrival,
        // or `need` never points at anything the stream can satisfy and every
        // arrival would be parked.
        await drain('layers');
      },

      onLayer: async (node, image) => {
        stopIfCancelled();
        seen.add(node.sourceIndex);

        const next = order[need];
        if (next && !drawsOwnPixels(next) && next.sourceIndex === node.sourceIndex) {
          // Arrival order is blend order for this layer. Blend it now, release
          // it, and take anything the drain can now finish.
          blend(next, image || null);
          await drain('layers');
        } else {
          // Needed later. Park it and let the reader release the memory copy.
          // A wanted layer that decoded to nothing is parked as an empty spill
          // so the drain treats it uniformly -- it will draw nothing, which is
          // exactly what the preview does with it.
          const source = image && image.width && image.height ? image : EMPTY;
          const chunks = source === EMPTY
            ? [spillHeader(0, 0)]
            : [spillHeader(source.width, source.height), source.data];
          await spill.write(nameFor(node.sourceIndex), chunks);
          parked.add(node.sourceIndex);
        }

        report('layers', seen.size, wanted.size);
      },
    });

    // The file bytes are 68-78% of peak. Nothing below needs them, and the
    // readback and encode peaks are still to come, so drop the reference here
    // rather than letting it live to the end of the function.
    bytes = null;

    for (const index of wanted)
      if (!seen.has(index))
        throw new ExportError(
          `The source file has no layer at position ${index}, but this project expects one — ` +
          `it is not the file this project was opened from.`,
          'SOURCE_MISMATCH',
        );

    await drain('drain');

    if (need < order.length)
      throw new ExportError(
        `Export finished with ${order.length - need} layer(s) never satisfied. ` +
        `This is a bug in the export walk, not a problem with the file.`,
        'INCOMPLETE',
      );

    report('readback', 0, 1);
    const out = await target.finish();
    report('readback', 1, 1);
    return out;
  } finally {
    // Runs on success, on failure and on cancel. It does NOT run when the OS
    // kills the process -- that is what sweep.js is for.
    target.dispose();
    await spill.dispose();
  }
}
