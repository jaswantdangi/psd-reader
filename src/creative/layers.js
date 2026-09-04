/**
 * Structural layer creation.
 *
 * `createProject()` builds every layer the file had; this builds the ones the
 * user adds afterwards. The single hard requirement is that the result is
 * INDISTINGUISHABLE from a file layer to everything downstream — `renderProject`,
 * `renderSandwiched`, `panelRows`, `hitTest`, `toProjectJson` and the export
 * walk all read layers positionally and by field name, and a layer with an
 * extra field, a missing field or a wrongly-typed one fails somewhere far from
 * here. `blankLayer()` below is therefore a mirror of `toLayer()` in edit.js
 * and test/creative.mjs pins the two field sets together.
 *
 * ## Insertion IS on the undo stack
 *
 * `edit.js` grew `insert` and `remove` command types, so adding a sticker and
 * deleting a layer are ordinary history entries: `commit` pushes them, `invert`
 * turns each straight into the other, and undo/redo replays them like any set
 * or reorder. There is one command model and one undo stack.
 *
 * The command carries the LAYER OBJECT rather than a description of one, which
 * is what makes ids stable across an undo/redo cycle and what keeps the pixel
 * buffer of a deleted layer alive long enough to restore it.
 */
import { findLayer, commit } from '../edit.js';

/**
 * An id no layer in this project is using.
 *
 * Derived from the project rather than from a module counter: `edit.js` keeps
 * its own `nextId` private, and a second private counter here would collide
 * with it on the first insert. Ids only have to be unique WITHIN a project —
 * `findLayer` never looks anywhere else.
 */
export function nextLayerId(project) {
  let max = 0;
  for (const layer of project.layers) if (layer.id > max) max = layer.id;
  return max + 1;
}

/**
 * A layer with every field `toLayer()` produces and not one more.
 *
 * `sourceIndex` is `null` and stays that way. That is the whole identity
 * decision for created layers: the export walk matches decoded arrivals to
 * project layers on `sourceIndex` and nothing else, so any number here would
 * claim some other layer's pixels and shift every layer after it — a plausible
 * wrong image with a green suite. A layer that then carries its OWN
 * full-resolution pixels sets `selfSupplied` too, and export blends it from
 * what it holds instead of awaiting an arrival that will never come.
 *
 * @param {object} project
 * @param {object} fields  overrides applied on top of the defaults
 */
export function blankLayer(project, fields = {}) {
  return {
    id: nextLayerId(project),
    name: '(unnamed)',
    kind: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    x: 0, y: 0, w: 1, h: 1,
    pixels: null,
    sourceW: 1, sourceH: 1,
    proxyW: 1, proxyH: 1,
    sourceIndex: null,
    selfSupplied: false,
    mask: null,
    clipping: false,
    /**
     * Present, and undefined. A created layer has no Blend If ranges -- it came
     * from no file -- but toLayer assigns this key on every layer it builds, so
     * omitting it here would make a created layer DISTINGUISHABLE from a loaded
     * one by its key set alone. That is the invariant test/creative.mjs guards,
     * and it is not pedantry: payloadFor once stripped pixels off selfSupplied
     * layers on exactly this kind of divergence, and inserted images failed
     * export with NO_IDENTITY.
     */
    blendingRanges: undefined,
    groupPath: '',
    groupWarned: false,
    adjust: null,
    rerendered: false,
    rendered: null,
    text: null,
    ...fields,
  };
}

/**
 * Put a layer into the stack. `index` 0 is the bottom; the default is the top.
 *
 * Goes through `commit`, so it is an ordinary undo step: `revision` moves once
 * (the sandwich cache keys on it, and a stack that gained a layer must not be
 * served from a cache built before it existed), `mutation` moves once inside
 * `applyCommand`, and `future` is cleared because a new action always is a new
 * branch.
 */
export function insertLayer(project, layer, index = project.layers.length) {
  const at = Math.max(0, Math.min(project.layers.length, Math.round(index)));
  commit(project, { type: 'insert', layer, index: at });
  return layer;
}

/**
 * Take a layer back out. The exact inverse of `insertLayer`, and undoable:
 * `invert` turns the `remove` command straight back into the `insert` that
 * restores this same layer object — same id, same pixels — at `index`.
 *
 * @returns {{layer: object, index: number} | null} null when no layer has that id
 */
export function removeLayer(project, id) {
  const index = project.layers.findIndex((l) => l.id === id);
  if (index < 0) return null;
  const layer = project.layers[index];
  commit(project, { type: 'remove', layer, index });
  return { layer, index };
}

/** Look up a layer and insist it exists, so callers fail at the call rather than later. */
export function requireLayer(project, id) {
  const layer = findLayer(project, id);
  if (!layer) throw new Error(`No layer with id ${id} in this project.`);
  return layer;
}

/** Top-left placement that centres a `width` x `height` box in the document. */
export function centreIn(project, width, height) {
  return {
    x: Math.round((project.width - width) / 2),
    y: Math.round((project.height - height) / 2),
  };
}
