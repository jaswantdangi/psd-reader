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

/** The layers export will actually draw, bottom to top. */
export function buildExportOrder(project) {
  return project.layers.filter((layer) => layer.visible && layer.opacity > 0);
}

/** The sourceIndex values the stream has to decode. Hidden layers are absent. */
export function wantedIndices(order) {
  const wanted = new Set();
  for (const layer of order)
    if (!isSelfRendering(layer) && typeof layer.sourceIndex === 'number')
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
    if (isSelfRendering(layer)) continue;
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
    if (isSelfRendering(layer)) continue;
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
      if (isSelfRendering(layer)) { need++; continue; }
      if (!parked.has(layer.sourceIndex)) break;
      parked.delete(layer.sourceIndex);
      need++;
    }
  };

  drain();
  for (const index of arrivals) {
    const next = order[need];
    if (next && !isSelfRendering(next) && next.sourceIndex === index) { need++; drain(); }
    else { parked.add(index); spill.push(index); }
  }

  return { spill, fastPath: spill.length === 0 };
}
