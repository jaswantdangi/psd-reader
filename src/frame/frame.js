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
 * ## The seam this module has, stated plainly
 *
 * `edit.js`'s `applyCommand` understands `set` and `reorder` and nothing else,
 * so a frame command cannot ride its `undo`/`redo`/`discardTo`. The three
 * wrappers below share the SAME `project.history` array and intercept only
 * their own command type, delegating everything else — so interleaving is
 * correct and ordering is exact. The cost is that a caller must route through
 * these three rather than edit.js's. Six lines in `applyCommand` would remove
 * the seam; `edit.js` is not this task's to edit.
 */
import { undo as editUndo, redo as editRedo, discardTo as editDiscardTo } from '../edit.js';
import { intersectRect } from '../export/tiles.js';
import { normaliseRect, sameRect, largestCentredRect, ratioOf, MIN_FRAME_SIZE } from './rect.js';

export { MIN_FRAME_SIZE };

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

/** The whole source document, which is what an unframed project means. */
export const fullFrame = (project) => ({ x: 0, y: 0, width: project.width, height: project.height });

/** The current frame — never null, so callers never branch on absence. */
export const frameOf = (project) => project.frame || fullFrame(project);

export function isCropped(project) {
  const frame = project.frame;
  return !!frame &&
    (frame.x !== 0 || frame.y !== 0 || frame.width !== project.width || frame.height !== project.height);
}

// ---------------------------------------------------------------- commands

/**
 * Frozen for the same reason `createAdjust` freezes: the undo entry captures
 * `from` BY REFERENCE, so a caller who mutates `project.frame` in place has
 * destroyed that entry before it was written, and nothing would notice until
 * someone pressed undo.
 */
const freezeFrame = (rect) => Object.freeze(normaliseRect(rect));

function applyFrameCommand(project, command) {
  project.frame = command.to;
  // Bumped on EVERY applied frame, coalesced drag frames included -- the same
  // contract edit.js's applyCommand has. `revision` is the one that stays still
  // during a gesture, so the sandwich cache survives it.
  project.mutation = (project.mutation ?? 0) + 1;
}

const invertFrame = (command) => ({ ...command, from: command.to, to: command.from });

function commitFrame(project, command) {
  applyFrameCommand(project, command);
  project.history.push(command);
  project.future.length = 0;
  project.revision = (project.revision ?? 0) + 1;
  return project;
}

/**
 * Set the document frame. `null` clears it, restoring the whole document.
 *
 * @param {object} project
 * @param {{x,y,width,height}|null} rect  document coordinates; may extend
 *   OUTSIDE the document, which is how the canvas is enlarged.
 * @param {string} [coalesceKey]  from `nextGestureKey('crop')`. Merges with the
 *   previous entry for the same gesture, so a crop drag is one undo step and
 *   `revision` does not move — exactly as a layer drag behaves.
 */
export function setFrame(project, rect, coalesceKey) {
  const to = rect ? freezeFrame(rect) : null;
  const from = project.frame || null;
  if (sameRect(from, to) || (!from && !to)) return project;

  const previous = project.history[project.history.length - 1];
  if (coalesceKey && previous && previous.type === 'frame' && previous.coalesceKey === coalesceKey) {
    // Extend the existing step. `previous.from` stays the rect the gesture
    // started from, so one undo unwinds the whole drag.
    previous.to = to;
    applyFrameCommand(project, { type: 'frame', from, to });
    project.future.length = 0;
    return project;
  }

  return commitFrame(project, { type: 'frame', from, to, coalesceKey });
}

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
 *   Taking the id too is not a convenience: `usableRatio` rejects a string, so
 *   a chip that passed one would silently clear the crop instead of setting it.
 */
export function setRatio(project, ratio, coalesceKey) {
  const value = typeof ratio === 'string' ? ratioOf(ratio) : ratio;
  if (!value) return setFrame(project, null, coalesceKey);
  return setFrame(project, largestCentredRect(project.width, project.height, value), coalesceKey);
}

const topIsFrame = (stack) => {
  const top = stack[stack.length - 1];
  return !!top && top.type === 'frame';
};

/** Undo, whichever kind of command is on top. Delegates everything but a frame. */
export function undo(project) {
  if (!topIsFrame(project.history)) return editUndo(project);
  const command = project.history.pop();
  applyFrameCommand(project, invertFrame(command));
  project.future.push(command);
  project.revision = (project.revision ?? 0) + 1;
  return true;
}

/** Redo, whichever kind of command is on top. Delegates everything but a frame. */
export function redo(project) {
  if (!topIsFrame(project.future)) return editRedo(project);
  const command = project.future.pop();
  applyFrameCommand(project, command);
  project.history.push(command);
  project.revision = (project.revision ?? 0) + 1;
  return true;
}

/**
 * Roll the history back to a recorded length — what a tool sheet's X does.
 *
 * Pops WITHOUT pushing to `future`, exactly as edit.js's does: a discarded
 * experiment left on the redo stack is something the user finds again by
 * accident three actions later and cannot explain.
 *
 * Non-frame commands are handed to edit.js in RUNS rather than one at a time,
 * so a rollback of eight layer edits still costs the one `revision` bump it
 * was designed to cost.
 */
export function discardTo(project, historyLength) {
  const target = Math.max(0, Number(historyLength) || 0);
  let popped = 0;

  while (project.history.length > target) {
    if (topIsFrame(project.history)) {
      applyFrameCommand(project, invertFrame(project.history.pop()));
      popped++;
      continue;
    }
    let floor = project.history.length;
    while (floor > target && project.history[floor - 1].type !== 'frame') floor--;
    const run = editDiscardTo(project, floor);
    if (!run) break;
    popped += run;
  }

  if (popped) {
    project.future.length = 0;
    project.revision = (project.revision ?? 0) + 1;
  }
  return popped;
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
