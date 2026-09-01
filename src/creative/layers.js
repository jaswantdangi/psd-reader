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
 * ## Insertion is NOT on the undo stack
 *
 * `edit.js`'s `applyCommand` understands exactly two command types, `set` and
 * `reorder`, and this module deliberately does not edit that file. A `commit()`
 * of an unknown command type would push a history entry that undoes to nothing
 * — a dead press of the undo button that silently swallows a step — which is
 * strictly worse than not being on the stack at all.
 *
 * So `insertLayer` and `removeLayer` are structural, like `createProject`
 * itself: they mutate the stack, bump both counters, and clear the redo stack
 * the way any new action does. `removeLayer` is the exact inverse and returns
 * the index it removed from, so a caller with its own stack can reverse it.
 * Everything that changes a layer already in the stack — `replaceImage`,
 * `retypeText` — goes through `setLayer` and IS undoable.
 */
import { findLayer } from '../edit.js';

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
 * wrong image with a green suite. `null` instead makes `assertIdentifiable()`
 * refuse the export by name, which is the failure the user can act on.
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
    mask: null,
    clipping: false,
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
 * Bumps `revision` as well as `mutation`: the sandwich cache keys on
 * `revision`, and a stack that gained a layer must not be served from a cache
 * built before it existed.
 */
export function insertLayer(project, layer, index = project.layers.length) {
  const at = Math.max(0, Math.min(project.layers.length, Math.round(index)));
  project.layers.splice(at, 0, layer);
  project.future.length = 0;
  project.revision = (project.revision ?? 0) + 1;
  project.mutation = (project.mutation ?? 0) + 1;
  return layer;
}

/**
 * Take a layer back out. The exact inverse of `insertLayer`.
 *
 * History entries naming the removed layer become no-ops rather than errors —
 * `applyCommand` looks the id up and returns when it is gone — so undoing past
 * a removal is safe but cannot resurrect it.
 *
 * @returns {{layer: object, index: number} | null} null when no layer has that id
 */
export function removeLayer(project, id) {
  const index = project.layers.findIndex((l) => l.id === id);
  if (index < 0) return null;
  const [layer] = project.layers.splice(index, 1);
  project.future.length = 0;
  project.revision = (project.revision ?? 0) + 1;
  project.mutation = (project.mutation ?? 0) + 1;
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
