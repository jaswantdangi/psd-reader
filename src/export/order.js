/**
 * Export ordering.
 *
 * Two orders exist and they are not the same one:
 *
 *   arrival order -- the file's leaf nodes, ascending `sourceIndex`
 *   blend order   -- `project.layers`, bottom to top, after any reorder
 *
 * When they agree, export blends each layer as it streams and nothing touches
 * disk. When they do not, some layers arrive before they are needed and have to
 * be parked. This module decides which, and how few.
 */
import { ExportError } from './errors.js';
import { clipRunEnd } from '../render.js';

/**
 * A retyped or restyled text layer draws itself at the final size, so it is
 * never awaited from the file and never spilled -- it is generated in place.
 *
 * An UNTOUCHED Photoshop text layer is deliberately NOT self-rendering:
 * render.js gates the sharp path on `rerendered`, which starts false, so it is
 * a raster and its full-resolution pixels must come from the file like any
 * other layer's.
 */
export function isSelfRendering(layer) {
  return layer.kind === 'text' && layer.rerendered === true;
}

/**
 * A layer the walk must NOT wait for, because no arrival will ever carry its
 * pixels. Two ways to be one, and they are the same fact seen twice:
 *
 *   - re-rendered text generates its own glyphs at the final size;
 *   - an inserted sticker or a replaced image already HOLDS its own
 *     full-resolution pixels — it never came from the file, so `sourceIndex`
 *     is null and nothing is coming for it.
 *
 * `selfSupplied` is a stamped flag, not something inferred from `pixels &&
 * sourceIndex === null`. Every layer of an EAGERLY read project matches that
 * shape too, and so does a proxy-loaded layer whose 256-edge buffer would be
 * upscaled into a correctly-sized, blurred image at scale 1 — the exact failure
 * stream.js exists to prevent. Only the code that PUT full-resolution pixels on
 * a layer knows they are full resolution, so only it sets the flag.
 *
 * The `pixels` check is not belt-and-braces: a flagged layer with nothing in it
 * would sail past assertIdentifiable and then draw nothing, which is a silent
 * missing layer rather than a refused export.
 */
export function drawsOwnPixels(layer) {
  return isSelfRendering(layer) || (layer.selfSupplied === true && !!layer.pixels);
}

/** A layer that draws nothing at all, wherever it sits. */
const drawsNothing = (layer) => !layer.visible || layer.opacity <= 0;

/**
 * The layers export will actually draw, bottom to top -- one CLIP RUN at a
 * time, because a run is what `renderProject` draws and export is the same
 * renderer or it is a bug.
 *
 * A plain `filter` is the trap, and it was what stood here. A clipping mask is
 * POSITIONAL: a clipped layer is visible only through the alpha of whatever
 * lies DIRECTLY under it. Drop a hidden BASE on its own and its clipped layers
 * close the gap and attach to whatever lands underneath -- a different picture,
 * and a plausible one, which is exactly why nothing downstream would catch it.
 *
 * So the two cases are not the same case:
 *
 *   - a base that draws nothing takes its WHOLE RUN with it. `drawClipRunInto`
 *     returns at `!base.visible || base.opacity <= 0` before it draws anything,
 *     and `renderList` in the compositor has always had the clipped block
 *     inside `if (layer.hidden !== true)`. The clipped layers have no alpha to
 *     be seen through.
 *   - a hidden MEMBER is skipped alone; the run's other members still clip to
 *     the same base.
 *
 * Run bounds come from `clipRunEnd`, the same function the renderer walks with,
 * so there is no second definition of where a run ends. The walk starts at 0
 * and steps run by run, which also makes a clipped layer at the very bottom of
 * the stack its own base -- what Photoshop does, and what the preview does.
 *
 * The result keeps every run CONTIGUOUS, which is what lets the blend target
 * reconstruct runs from `clipping` alone as the layers stream past it.
 */
export function buildExportOrder(project) {
  const layers = project.layers;
  const order = [];
  for (let i = 0; i < layers.length; ) {
    const end = clipRunEnd(layers, i);
    if (!drawsNothing(layers[i])) {
      order.push(layers[i]);
      for (let j = i + 1; j < end; j++)
        if (!drawsNothing(layers[j])) order.push(layers[j]);
    }
    i = end;
  }
  return order;
}

/** The sourceIndex values the stream has to decode. Hidden layers are absent. */
export function wantedIndices(order) {
  const wanted = new Set();
  for (const layer of order)
    if (!drawsOwnPixels(layer) && typeof layer.sourceIndex === 'number')
      wanted.add(layer.sourceIndex);
  return wanted;
}

/**
 * Refuse an export that could not possibly finish, before reading the file.
 * A layer with no identity can never be matched to an arrival, so the drain
 * would stall forever waiting for something that will not come.
 */
export function assertIdentifiable(order) {
  for (const layer of order) {
    if (drawsOwnPixels(layer)) continue;
    if (typeof layer.sourceIndex !== 'number')
      throw new ExportError(
        `Layer "${layer.name}" has no sourceIndex, so export cannot match it back to the file. ` +
        `This project was not opened with a streamed read.`,
        'NO_IDENTITY',
      );
  }
}

/** True when arrival order is already blend order, so nothing needs parking. */
export function isFastPath(order) {
  let last = -1;
  for (const layer of order) {
    if (drawsOwnPixels(layer)) continue;
    if (layer.sourceIndex <= last) return false;
    last = layer.sourceIndex;
  }
  return true;
}

/**
 * Simulate the walk and report which layers have to go to disk.
 *
 * Deliberately NOT "spill everything when the order changed". Moving the bottom
 * layer to the top parks one layer; moving the top layer to the bottom parks
 * all but one. Both are strictly better than parking the whole stack, and the
 * common reorder is the cheap one.
 *
 * The loop below is the same state machine stream.js runs against real I/O.
 * Task 9 asserts the two produce identical spill sets, which is what keeps them
 * from drifting.
 */
export function planSpill(order) {
  const arrivals = [...wantedIndices(order)].sort((a, b) => a - b);
  const parked = new Set();
  const spill = [];
  let need = 0;

  const drain = () => {
    while (need < order.length) {
      const layer = order[need];
      if (drawsOwnPixels(layer)) { need++; continue; }
      if (!parked.has(layer.sourceIndex)) break;
      parked.delete(layer.sourceIndex);
      need++;
    }
  };

  drain();
  for (const index of arrivals) {
    const next = order[need];
    if (next && !drawsOwnPixels(next) && next.sourceIndex === index) { need++; drain(); }
    else { parked.add(index); spill.push(index); }
  }

  return { spill, fastPath: spill.length === 0 };
}
