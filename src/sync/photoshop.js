/**
 * The Photoshop side of sync, minus Photoshop.
 *
 * Everything the UXP plugin does that can be decided from data lives here, so
 * it can be tested on a machine with no Photoshop on it. What is left in
 * `plugin/` is the part that genuinely needs the host: opening a socket,
 * reading `app.activeDocument`, and subscribing to notifications.
 *
 * That split is the point. A UXP plugin can only be exercised by a person with
 * Photoshop open, which means anything left inside it is untested until
 * someone runs it by hand -- so as little as possible is left inside it.
 *
 * Nothing here imports `photoshop` or `uxp`. It takes plain objects shaped the
 * way the host reports them and returns plain objects shaped the way
 * `protocol.js` validates them.
 */

import { CHANGE_KINDS, classifyChange } from './protocol.js';

/**
 * Photoshop layer kinds that are adjustment layers.
 *
 * `identity.js` needs to see `adjustment` for these, because an adjustment
 * layer has no app-side counterpart and has to be REPORTED rather than
 * matched. Photoshop does not have one `adjustment` kind -- it has one per
 * adjustment type -- so the collapse happens here.
 *
 * An adjustment kind missing from this list is not a correctness hazard: it
 * falls through as a raster layer, finds no app layer with its signature, and
 * is reported unmatched. The failure mode is disclosure, not a mis-mapped
 * edit, which is the direction this whole module leans.
 */
export const PHOTOSHOP_ADJUSTMENT_KINDS = new Set([
  'levels', 'curves', 'colorBalance', 'brightnessContrast', 'hueSaturation',
  'selectiveColor', 'channelMixer', 'gradientMap', 'inversion', 'threshold',
  'posterize', 'photoFilter', 'exposure', 'blackAndWhite', 'vibrance',
  'colorLookup',
].map((k) => k.toLowerCase()));

/** Kinds Photoshop uses for a layer group, in either of the spellings seen. */
const GROUP_KINDS = new Set(['group', 'groupend', 'layersection']);

/**
 * Reduce a host layer kind to what `identity.js` compares.
 *
 * Returns `adjustment` and `group` verbatim so those layers are excluded and
 * named; everything else is passed through unchanged for `kindOf` to reduce,
 * which keeps one reduction rather than two that can drift.
 */
export function normaliseKind(kind) {
  const k = String(kind ?? '').toLowerCase();
  if (!k) return '';
  if (GROUP_KINDS.has(k)) return 'group';
  if (PHOTOSHOP_ADJUSTMENT_KINDS.has(k)) return 'adjustment';
  return k;
}

/** Bounds from the host, whose numbers may be UnitValue wrappers rather than numbers. */
const edge = (v) => {
  if (typeof v === 'number') return v;
  // UXP hands back `{_value, _unit}` in some versions and a plain number in
  // others. Reading `_value` here beats every call site guessing.
  const n = typeof v?._value === 'number' ? v._value : Number(v);
  return Number.isFinite(n) ? n : null;
};

function boundsFrom(layer) {
  const b = layer?.bounds;
  if (!b) return null;
  const left = edge(b.left), top = edge(b.top), right = edge(b.right), bottom = edge(b.bottom);
  if ([left, top, right, bottom].some((v) => v === null)) return null;
  return { left, top, right, bottom };
}

/**
 * Walk the host's nested layer tree into the flat descriptor list
 * `matchLayers` takes.
 *
 * Groups are KEPT, not skipped. `matchLayers` reports every Photoshop entry it
 * cannot match with a reason, and `group` is one of those reasons -- dropping
 * them here would turn "this is a group, there is nothing to match" into
 * silence, and silence is what the identity model exists to avoid.
 *
 * Order is bottom-to-top, matching how `children[0]` is read everywhere else
 * in this repo. A host that reports top-down should be reversed by the caller,
 * not here, because only the caller knows which it got.
 *
 * @param {object[]} layers  nested `{id, name, kind, bounds, layers?}`
 * @returns {object[]} flat `{layerID, name, kind, bounds, groupPath}`
 */
export function flattenLayerTree(layers, groupPath = []) {
  const out = [];
  for (const layer of layers ?? []) {
    const bounds = boundsFrom(layer);
    // A layer with no readable bounds cannot be matched on a signature that is
    // half bounds. Skipping it silently would let it look absent; it is dropped
    // here and shows up as a Photoshop entry the app never heard of.
    if (bounds) {
      out.push({
        layerID: layer.id,
        name: String(layer.name ?? ''),
        kind: normaliseKind(layer.kind),
        bounds,
        groupPath: [...groupPath],
      });
    }
    if (Array.isArray(layer.layers) && layer.layers.length) {
      out.push(...flattenLayerTree(layer.layers, [...groupPath, String(layer.name ?? '')]));
    }
  }
  return out;
}

/**
 * The `tree` frame for a host document.
 *
 * @param {{name:string,width:number,height:number}} document
 * @param {object[]} layers nested host layers
 */
export function treeFrameFor(document, layers) {
  return {
    type: 'tree',
    document: {
      name: String(document?.name ?? ''),
      width: edge(document?.width) ?? 0,
      height: edge(document?.height) ?? 0,
    },
    layers: flattenLayerTree(layers),
  };
}

/**
 * Photoshop's notification names, and the change kind each one is.
 *
 * Photoshop reports what the USER DID -- `move`, `set`, `delete` -- in its own
 * vocabulary, which is not ours. This table is the whole translation, and it
 * is deliberately a table: an event that is not in it is unknown, and unknown
 * is surfaced rather than guessed at.
 *
 * `set` is the ambiguous one. Photoshop uses it for opacity, blend mode,
 * visibility and rename alike, and which one it was is only in the descriptor
 * -- see `changeForNotification`.
 */
export const PHOTOSHOP_EVENTS = {
  move: 'move',
  transform: 'transform',
  free: 'transform',
  reorder: 'reorder',
  duplicate: 'add',
  make: 'add',
  delete: 'delete',
  // Photoshop fires these rather than a `set` when a layer's eye is toggled.
  // Without them a hide or a show is simply an event nobody claimed.
  hide: 'visibility',
  show: 'visibility',
  crop: 'crop',
  canvasSize: 'canvasSize',
  paint: 'brush',
  brushTool: 'brush',
  eraserTool: 'brush',
  gaussianBlur: 'filter',
  filter: 'filter',
  applyImage: 'filter',
  hueSaturation: 'adjustment',
  levels: 'adjustment',
  curves: 'adjustment',
  brightnessContrast: 'adjustment',
  setLayerEffects: 'layerEffect',
  disableLayerStyle: 'layerEffect',
};

/** Which `set` is it? Read off the descriptor's `to` payload, in this order. */
const SET_FIELDS = [
  ['opacity', 'opacity'],
  ['fillOpacity', 'opacity'],
  ['mode', 'blendMode'],
  ['blendMode', 'blendMode'],
  ['visible', 'visibility'],
  ['name', 'rename'],
  ['textKey', 'retype'],
];

/**
 * What one Photoshop notification is, in this protocol's vocabulary.
 *
 * @param {string} event      the notification name Photoshop fired
 * @param {object} descriptor the descriptor it came with
 * @returns {{change:string|null, known:boolean, mappable:boolean, requiresPixels:boolean}}
 */
export function changeForNotification(event, descriptor = {}) {
  let change = PHOTOSHOP_EVENTS[event] ?? null;

  if (!change && event === 'set') {
    const to = descriptor?.to ?? descriptor ?? {};
    for (const [field, kind] of SET_FIELDS) {
      if (to[field] !== undefined) { change = kind; break; }
    }
    // A `set` carrying nothing this protocol represents is not a `set` we can
    // forward. Saying "unknown" is honest; picking one at random is not.
  }

  if (!change || !CHANGE_KINDS.includes(change)) {
    return { change: null, known: false, mappable: false, requiresPixels: false };
  }
  const { mappable, requiresPixels } = classifyChange(change);
  return { change, known: true, mappable, requiresPixels };
}

/**
 * Collapse a burst of notifications down to what is worth sending.
 *
 * Photoshop's notification stream fires CONTINUOUSLY during one gesture -- a
 * single drag is dozens of `move` notifications, a single stroke dozens of
 * `paint`. Forwarding each one spends the session byte budget on frames that
 * are all superseded by the last of their run.
 *
 * Only the LAST of each (change, layerID) survives, and order is the order
 * each key was FIRST seen. Keeping first-seen order matters: `reorder` then
 * `move` on one layer must not become `move` then `reorder`, because the app
 * applies them in the order they arrive.
 *
 * This is a coalescer, not a debouncer -- it has no timer and no clock. When
 * to call it is the caller's decision, which is what makes it testable.
 */
export function coalesceEvents(events) {
  const order = [];
  const latest = new Map();
  for (const e of events ?? []) {
    const key = `${e.change}::${e.layerID ?? ''}`;
    if (!latest.has(key)) order.push(key);
    latest.set(key, e);
  }
  return order.map((k) => latest.get(k));
}
