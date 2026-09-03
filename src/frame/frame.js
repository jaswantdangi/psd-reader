/**
 * The document frame: crop, aspect ratio and canvas resize, non-destructively.
 *
 * A crop is NOT a pixel operation here. Every layer's geometry is already in
 * document coordinates, so cropping is an ORIGIN SHIFT plus a new width and
 * height — and both of those are properties of the document, not of any layer.
 * So the frame lives on the project as one rect, `project.frame`, and no layer
 * is touched at all:
 *
 *     project.width/height        the SOURCE document, forever
 *     project.frame               the window onto it that is currently the canvas
 *     layer.x/y/w/h               untouched, still in source-document coordinates
 *     layer.pixels                untouched, still every pixel the file had
 *
 * That is what makes a crop undoable and re-widenable: nothing was thrown away,
 * so there is nothing to restore. It is also what makes it cheap — a crop is a
 * single frozen rect, not N layer mutations, so it is one undo step by
 * construction rather than by coalescing.
 *
 * The frame is applied at exactly two places, and both go through
 * `framedLayer`, which is the whole of it:
 *
 *     preview    renderProject(framedProject(project), {scale})
 *     export     exportFullRes({project, createTarget: framedTarget(frame, ...)})
 *
 * Export applies it ONE LAYER AT A TIME, inside the target, because the export
 * walk cannot see a neighbour and must never be handed a project whose
 * dimensions disagree with the file it is re-reading.
 *
 * ## Where the command lives
 *
 * NOT here. `project.frame` is a field on the project, so `setFrame` is a
 * command in `edit.js` beside `setLayer` and `reorderLayer`, and `applyCommand`
 * / `invert` / `undo` / `redo` / `discardTo` handle it like any other. This
 * module owns the GEOMETRY — which rect a ratio chip, a handle drag or a canvas
 * anchor produces — and how the frame is applied to a render and an export.
 *
 * It used to wrap `undo`/`redo`/`discardTo` over the shared history array
 * instead, which meant two undo functions and a caller who had to know which to
 * import. That is the shape of bug that gets filed as "undo doesn't work
 * sometimes" and takes a day to find. One undo, one history, one command model.
 */
import { frameOf, isCropped, setFrame } from '../edit.js';
import { intersectRect } from '../export/tiles.js';
import { largestCentredRect, ratioOf, MIN_FRAME_SIZE } from './rect.js';

export { MIN_FRAME_SIZE };
// Re-exported so `src/frame` stays one import for the whole framing surface.
// These are the REAL ones, not wrappers: `undo === editUndo` is asserted.
export { frameOf, fullFrame, isCropped, canvasSize, setFrame, undo, redo, discardTo } from '../edit.js';

/**
 * Cache fields that `render.js` writes onto the layer it is handed.
 *
 * `framedLayer` builds a fresh copy per render, so these have to be windows
 * onto the real layer rather than copied values. Otherwise every frame of a
 * crop drag would re-rasterise every text layer and rebuild every LUT into an
 * object that is thrown away microseconds later — a cache that looks like it is
 * working and never hits.
 */
const CACHE_KEYS = ['rendered', 'renderedKey', 'lut', 'lutKey'];

/**
 * Crop to the largest centred rect of a ratio. `free` (or `null`) restores the
 * whole document.
 *
 * Derived from the SOURCE DOCUMENT, not from the current frame. A ratio chip is
 * a reset, not a refinement: deriving from the current frame would make three
 * taps on three chips shrink the crop to nothing, and tapping the same chip
 * twice would not be a no-op — which is exactly the behaviour a row of chips
 * promises.
 *
 * @param {number|string|null} ratio  a number, or a preset id like `'4:5'`.
 *   Taking the id too is not a convenience: a raw string would be falsy-checked
 *   as a number and silently clear the crop instead of setting it.
 */
export function setRatio(project, ratio, coalesceKey) {
  const value = typeof ratio === 'string' ? ratioOf(ratio) : ratio;
  if (!value) return setFrame(project, null, coalesceKey);
  return setFrame(project, largestCentredRect(project.width, project.height, value), coalesceKey);
}

// ---------------------------------------------------------------- application

/**
 * The same layer, seen from the frame's origin.
 *
 * The ONE place the frame meets geometry. Position moves; `w`/`h` and `pixels`
 * do not, because a crop never resizes or resamples anything — a layer that
 * hangs over the edge is clipped by `blendInto`, which already clamps to the
 * destination and has done since the compositor was written.
 *
 * Identity-returns when there is nothing to shift, the same bargain
 * `resample()` makes: an uncropped document pays nothing for this module
 * existing.
 */
export function framedLayer(layer, frame) {
  if (!frame || (frame.x === 0 && frame.y === 0)) return layer;

  const out = { ...layer, x: layer.x - frame.x, y: layer.y - frame.y };
  for (const key of CACHE_KEYS)
    Object.defineProperty(out, key, {
      get: () => layer[key],
      set: (value) => { layer[key] = value; },
      enumerable: true,
      configurable: true,
    });
  return out;
}

/**
 * The project as the frame presents it: a document of the frame's size, with
 * every layer shifted into it. For `renderProject` and for `fitView`.
 *
 * A READ-ONLY VIEW. `history`, `future` and the layers' identities are shared
 * with the real project, so committing against this would write into shallow
 * copies and lose the change. Commit against the real project; render this.
 */
export function framedProject(project) {
  if (!isCropped(project)) return project;
  const frame = frameOf(project);
  return {
    ...project,
    width: frame.width,
    height: frame.height,
    layers: project.layers.map((layer) => framedLayer(layer, frame)),
  };
}

/**
 * Wrap an ExportTarget factory so the full-resolution export writes the frame
 * instead of the whole document.
 *
 * `exportFullRes` calls this with the DOCUMENT's dimensions and they are
 * deliberately ignored: they are what the source file must match, and the walk
 * checks that. The output is the frame's size, and each layer is shifted as it
 * arrives — one at a time, which is all the walk can offer.
 *
 * @param {{x,y,width,height}} frame
 * @param {(w:number,h:number)=>object} createTarget  createJsExportTarget, or 1C-2's GPU one
 */
export function framedTarget(frame, createTarget) {
  return () => {
    const inner = createTarget(frame.width, frame.height);
    return {
      blend: (layer, pixels) => inner.blend(framedLayer(layer, frame), pixels),
      /** Forwarded so a cropped export releases a clip run's pixels as early as an uncropped one. */
      flush: () => { if (inner.flush) inner.flush(); },
      finish: () => inner.finish(),
      dispose: () => inner.dispose(),
      /** Diagnostic seam, forwarded so the memory test can still reach it. */
      get scratch() { return inner.scratch; },
    };
  };
}

// ---------------------------------------------------------------- canvas resize

/**
 * Photoshop's nine-way canvas anchor, as the fraction of the size CHANGE that
 * is taken off the top-left. `nw` grows right and down; `center` grows evenly.
 */
const ANCHOR_FACTORS = Object.freeze({
  nw: [0, 0], n: [0.5, 0], ne: [1, 0],
  w: [0, 0.5], center: [0.5, 0.5], e: [1, 0.5],
  sw: [0, 1], s: [0.5, 1], se: [1, 1],
});

export const CANVAS_ANCHORS = Object.freeze(['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se']);

/**
 * The frame for a canvas of `width` x `height`, anchored within the CURRENT
 * frame — not the source document, because the canvas the user is looking at is
 * the current frame.
 *
 * A larger canvas produces a frame that extends outside the document. That is
 * legal and is the whole mechanism: the new area has no layer over it, so it
 * composites as transparent, and no layer moved to make room for it.
 */
export function canvasRect(project, width, height, anchor = 'center') {
  const frame = frameOf(project);
  const w = Math.max(MIN_FRAME_SIZE, Math.round(Number(width) || 0));
  const h = Math.max(MIN_FRAME_SIZE, Math.round(Number(height) || 0));
  const [fx, fy] = ANCHOR_FACTORS[anchor] || ANCHOR_FACTORS.center;
  return {
    x: frame.x + Math.round((frame.width - w) * fx),
    y: frame.y + Math.round((frame.height - h) * fy),
    width: w,
    height: h,
  };
}

/** Commit a canvas resize. One undo step; no layer is touched. */
export const resizeCanvas = (project, width, height, anchor = 'center', coalesceKey) =>
  setFrame(project, canvasRect(project, width, height, anchor), coalesceKey);

// ---------------------------------------------------------------- disclosure

const rectOfLayer = (layer) => ({ x: layer.x, y: layer.y, width: layer.w, height: layer.h });

/**
 * What the frame does to one layer: `inside`, `clipped` or `outside`.
 *
 * NONE of these deletes it. "Outside" means "draws nothing at this frame" —
 * widening the frame or pressing undo brings it back whole, because its pixels
 * and coordinates were never touched.
 */
export function layerFate(layer, frame) {
  const hit = intersectRect(rectOfLayer(layer), frame);
  if (!hit) return 'outside';
  return hit.width === layer.w && hit.height === layer.h ? 'inside' : 'clipped';
}

/**
 * Which layers the frame hides or cuts, and the one sentence the UI owes the
 * user about it.
 *
 * The document already discloses flattened groups, unapplied clipping and
 * unrasterised vector masks. A layer that silently vanished when the canvas
 * shrank would be the same class of failure, so it is named the same way — and
 * named as recoverable, which it is.
 */
export function framingReport(project, frame = frameOf(project)) {
  const outside = [];
  const clipped = [];
  for (const layer of project.layers) {
    const fate = layerFate(layer, frame);
    if (fate === 'outside') outside.push(layer);
    else if (fate === 'clipped') clipped.push(layer);
  }

  const warnings = [];
  if (outside.length)
    warnings.push(
      `${outside.length} layer${outside.length === 1 ? '' : 's'} fall${outside.length === 1 ? 's' : ''} ` +
      `outside the current frame and ${outside.length === 1 ? 'is' : 'are'} not drawn. ` +
      `${outside.length === 1 ? 'It is' : 'They are'} not deleted — widening the frame or undoing the crop ` +
      `brings ${outside.length === 1 ? 'it' : 'them'} back whole.`,
    );

  return { outside, clipped, warnings };
}
