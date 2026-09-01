/**
 * Editable project model.
 *
 * `readDocument()` gives a faithful but immutable view of the file. This turns
 * that into something you can move, resize, reorder and retype.
 *
 * Two rules shape the design:
 *
 * 1. **Transforms are non-destructive.** A layer keeps its original pixels
 *    forever; `x/y/w/h` are applied at render time. Resizing to 20% and back
 *    to 100% loses nothing, which destructive resampling cannot promise.
 *
 * 2. **Every mutation is a command.** Nothing writes to a layer directly, so
 *    undo/redo is just replaying the inverse.
 */

import { projectMask, pixelRect } from './mask.js';
import { createAdjust } from './adjust/ops.js';
import { isNeutralAdjust } from './adjust/lut.js';

/**
 * Blend modes offered in the UI — every mode the compositor implements, in
 * Photoshop's own menu order.
 *
 * This list must stay in step with `SEPARABLE` and `NON_SEPARABLE` in
 * composite.js. It previously offered 18 of the 26, so eight working modes
 * were invisible: a file using one still rendered correctly but the user could
 * neither see nor preserve it. `dissolve` is deliberately absent — it is the
 * one mode the compositor does not implement.
 */
export const BLEND_MODES = [
  'normal',
  'darken', 'multiply', 'color burn', 'linear burn', 'darker color',
  'lighten', 'screen', 'color dodge', 'linear dodge', 'lighter color',
  'overlay', 'soft light', 'hard light', 'vivid light', 'linear light',
  'pin light', 'hard mix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
];

/** Photoshop's font names are unreliable (often the placeholder `AdobeInvisFont`). */
export const FONT_STACKS = [
  'Arial, Helvetica, sans-serif',
  'Helvetica, Arial, sans-serif',
  '"Segoe UI", system-ui, sans-serif',
  'Verdana, Geneva, sans-serif',
  'Tahoma, sans-serif',
  '"Times New Roman", Times, serif',
  'Georgia, serif',
  '"Courier New", Courier, monospace',
  'Impact, sans-serif',
];

const rgbToHex = (c) =>
  c ? '#' + [c.r, c.g, c.b].map((v) => Math.round(v ?? 0).toString(16).padStart(2, '0')).join('') : '#000000';

let nextId = 1;

/**
 * The layer's mask, on the pixel buffer's own grid.
 *
 * A streamed load has already done the expensive half inside loadProjectProxy --
 * projecting at full resolution, then shrinking to the proxy -- and left the
 * result on `proxyMask`, because reader.js releases `mask.imageData` the moment
 * onLayer returns. An eager load has no proxy step, so the projection happens
 * here against the full-resolution buffer that is still attached.
 *
 * Either way the result has NO independent geometry: it is `pixels.width` by
 * `pixels.height`, so render time resamples mask and pixels to the same target
 * from the same source and they cannot drift apart.
 */
function maskOf(source, pixelSource) {
  if (!pixelSource) return null;
  const data = source.proxyMask
    ?? (source.mask?.imageData ? projectMask(source, pixelRect(source, pixelSource)) : null);
  if (!data) return null;
  return {
    data,
    width: pixelSource.width,
    height: pixelSource.height,
    // Photoshop saves masks that are switched off. Reading the flag is not
    // optional -- honouring a disabled mask renders the file wrong in the
    // opposite direction from ignoring an enabled one.
    disabled: source.mask?.disabled === true,
  };
}

function toLayer(source) {
  const x = source.left ?? 0;
  const y = source.top ?? 0;
  const w = (source.right ?? 0) - x;
  const h = (source.bottom ?? 0) - y;
  const pixelSource = source.proxyData || source.imageData;

  const layer = {
    id: nextId++,
    name: source.name || '(unnamed)',
    kind: source.text ? 'text' : 'raster',
    visible: source.hidden !== true,
    opacity: source.opacity ?? 1,
    blendMode: source.blendMode === 'pass through' ? 'normal' : (source.blendMode || 'normal'),
    x, y, w, h,
    // Original decoded pixels — never mutated. A streamed load supplies a
    // downscaled proxy here instead; geometry below stays in document space
    // either way, so the renderer's `scale` handles the difference.
    pixels: pixelSource || null,
    // Full-resolution dimensions, always in document space. Under a proxy load
    // the buffer is smaller than this — export re-reads the file at full
    // resolution and needs the true size, so it must not be taken from `pixels`.
    sourceW: w,
    sourceH: h,
    /** Actual dimensions of whatever is in `pixels` — equal to sourceW/H on a full load. */
    proxyW: pixelSource?.width ?? w,
    proxyH: pixelSource?.height ?? h,
    /**
     * This layer's position among the file's leaf nodes, stamped by reader.js
     * during a streamed read. Full-resolution export matches arriving layers to
     * project layers on this and nothing else -- array position is wrong,
     * because flatten() below drops pixel-less leaves. `null` after an eager
     * read, which never streams and therefore has nothing to match.
     */
    sourceIndex: source.sourceIndex ?? null,
    /**
     * `pixels` is this layer's own FULL-RESOLUTION material and did not come
     * from the file — an inserted sticker, or an image the user replaced. False
     * for anything read out of a PSD, including an eager read, which is the
     * whole reason this is a stamped flag rather than `pixels && sourceIndex
     * === null`: that shape also describes every eagerly-read layer and every
     * proxy-loaded one, whose 256-edge buffer must NOT be blended at scale 1.
     *
     * Export reads it through `drawsOwnPixels()` and blends such a layer from
     * what it already holds instead of awaiting an arrival that never comes.
     * Only code that puts full-resolution pixels on a layer may set it.
     */
    selfSupplied: false,
    /**
     * Layer mask as a 0..255 coverage plane on exactly the `pixels` grid, or
     * null. blendInto has always accepted one; nothing ever supplied it, which
     * is why masked documents rendered correctly in the inspector and wrong in
     * the editor -- in preview AND in export.
     */
    mask: maskOf(source, pixelSource),
    /**
     * The file clips this layer to the one below it. NOT APPLIED: clipping is a
     * nested composite, not an alpha multiply, and it collides with the free
     * reorder this panel exists to offer. The field exists so the UI can say so
     * -- a per-row chip, a filter, and a document warning -- rather than
     * rendering the layer in full and saying nothing.
     */
    clipping: source.clipping === true,
    /** ' / '-joined names of the groups this layer was flattened out of. Assigned by flatten(). */
    groupPath: '',
    /** One of the groups this layer came from raised a flattening warning. Assigned by flatten(). */
    groupWarned: false,
    /**
     * Non-destructive raster adjustments: one FROZEN object, or null when
     * neutral. Evaluated at render time inside drawLayerInto, after resampling
     * and before blending -- never baked into `pixels`, never written to a
     * saved project as pixels, and never seen by a neighbouring layer.
     *
     * REPLACED WHOLESALE, NEVER MUTATED. setLayer captures object-valued `from`
     * by reference, so mutating this in place destroys the undo entry before it
     * is written. createAdjust deep-freezes every object it builds, which turns
     * that mistake into a TypeError where it happens instead of a silent loss
     * later. Go through setAdjust().
     */
    adjust: null,
    /** Set when we have re-drawn the layer ourselves instead of using Photoshop's pixels. */
    rerendered: false,
    /** Cache of our own render, invalidated whenever `text` changes. */
    rendered: null,
    text: null,
  };

  if (source.text) {
    const style = source.text.style || {};
    layer.text = {
      content: source.text.text ?? '',
      fontFamily: FONT_STACKS[0],
      fontSize: Math.round(style.fontSize ?? 24),
      color: rgbToHex(style.fillColor),
      bold: false,
      italic: false,
      align: source.text.paragraphStyle?.justification === 'center' ? 'center'
        : source.text.paragraphStyle?.justification === 'right' ? 'right' : 'left',
      /** The string as Photoshop had it — lets us tell whether content actually changed. */
      originalContent: source.text.text ?? '',
    };
  }

  return layer;
}

/**
 * Flatten the layer tree into an ordered list, bottom to top.
 *
 * Groups become pure containers: their children are spliced inline. That keeps
 * every layer individually editable, which is the point of the editor. It is
 * only lossless when a group had default opacity and blending — otherwise the
 * render changes, so we say so.
 *
 * @param {string[]} path      group names above this level, outermost first
 * @param {{skipped:number}} stats  mutated: leaves dropped for having nothing to draw
 * @param {boolean} inWarnedGroup   a group above this level raised a warning
 */
function flatten(children, out, warnings, path = [], stats = { skipped: 0 }, inWarnedGroup = false) {
  for (const node of children || []) {
    if (node.children) {
      const opacity = node.opacity ?? 1;
      const mode = node.blendMode || 'pass through';
      let raised = false;
      if (opacity !== 1 || (mode !== 'pass through' && mode !== 'normal')) {
        warnings.add(
          `Group "${node.name || 'unnamed'}" had ${mode} blending at ${Math.round(opacity * 100)}% ` +
          `opacity. Groups are flattened for editing, so this layer stack will render differently than in Photoshop.`,
        );
        raised = true;
      }
      if (node.hidden === true) {
        warnings.add(`Group "${node.name || 'unnamed'}" was hidden; its layers are individually hidden instead.`);
        raised = true;
      }

      const before = out.length;
      flatten(node.children, out, warnings, [...path, node.name || 'unnamed'], stats, inWarnedGroup || raised);
      // A hidden group hides its contents — but only its own, not everything
      // flattened so far.
      if (node.hidden === true) for (let i = before; i < out.length; i++) out[i].visible = false;
      continue;
    }
    if (!node.imageData && !node.proxyData && !node.text) {
      // Counted, not silently dropped: a document where EVERY leaf lands here
      // produces an empty panel, and "this PSD has no editable layers, N layers
      // had no pixels or text" is the only copy that explains it.
      stats.skipped++;
      continue;
    }
    const layer = toLayer(node);
    layer.groupPath = path.join(' / ');
    layer.groupWarned = inWarnedGroup;
    out.push(layer);
  }
  return out;
}

/**
 * Leaves carrying a vector mask that nothing in this codebase rasterises.
 *
 * ag-psd exposes `layer.vectorMask` and `mask.fromVectorData`; neither is ever
 * consulted by composite.js or render.js. A layer whose ONLY mask is vector
 * data therefore renders completely unmasked, in the inspector and the editor
 * alike. Photoshop sometimes also writes a rasterised copy into `mask.imageData`
 * -- when it has, the layer renders correctly and must not be warned about.
 */
function countUnrasterisedVectorMasks(children) {
  let n = 0;
  for (const node of children || []) {
    if (node.children) { n += countUnrasterisedVectorMasks(node.children); continue; }
    if (node.vectorMask && !node.mask?.imageData && !node.proxyMask) n++;
  }
  return n;
}

/**
 * @param {object} doc  Result of `readDocument()` — either `pixels: 'eager'`,
 *   or `pixels: 'stream'` with proxies stashed on each node as `proxyData`.
 * @param {string} fileName
 * @param {{proxyScale?: number, source?: {uri: string, name: string, size: number} | null}} [options]
 */
export function createProject(doc, fileName = 'untitled.psd', options = {}) {
  const { proxyScale = 1, source = null } = options;
  const warnings = new Set();
  const stats = { skipped: 0 };
  const layers = flatten(doc.children, [], warnings, [], stats);

  // The reader's own findings -- the Patt pattern warning and ag-psd's whole
  // Unhandled feature list -- were being dropped on the floor here. The shape
  // is the real bug: createProject takes a doc and ignores a field on it.
  for (const warning of doc.warnings || []) warnings.add(warning);

  // Clipping is CARRIED but NOT APPLIED. This is one of three disclosure
  // surfaces the spec requires; the per-row chip and the Clipped filter are the
  // other two. None of them is dismissible, because the file's clip runs are a
  // permanent property of the document and reordering silently destroys them.
  const clipped = layers.filter((l) => l.clipping).length;
  if (clipped)
    warnings.add(
      `${clipped} layer${clipped === 1 ? ' is' : 's are'} clipped to the layer below. ` +
      `Clipping is not applied — ${clipped === 1 ? 'it is' : 'they are'} drawn in full and will ` +
      `differ from Photoshop. Reordering will not restore the relationship.`,
    );

  const vectorMasked = countUnrasterisedVectorMasks(doc.children);
  if (vectorMasked)
    warnings.add(
      `${vectorMasked} layer${vectorMasked === 1 ? ' has' : 's have'} a vector mask. Vector masks are ` +
      `not rasterised — ${vectorMasked === 1 ? 'that layer is' : 'those layers are'} drawn unmasked.`,
    );

  return {
    fileName,
    width: doc.width,
    height: doc.height,
    /** Scale of every layer's `pixels` relative to document space. 1 = full resolution. */
    proxyScale,
    /** Where the file came from, so a full-resolution export can re-read it. */
    source,
    layers,                       // index 0 = bottom, matching the file
    warnings: [...warnings],
    /** Leaves flatten() dropped for carrying neither pixels nor text. Drives the empty-document copy. */
    skippedLeaves: stats.skipped,
    /**
     * Bumped by every mutation, so caches keyed on it drop on any commit, undo
     * or redo — but NOT on the coalesced frames of a drag, which take
     * applyCommand directly and leave it alone. That asymmetry is the whole
     * reason the sandwich cache survives a gesture.
     */
    revision: 0,
    /** Bumped by every APPLIED command, coalesced drag frames and undo included. */
    mutation: 0,
    history: [],
    future: [],
  };
}

export const findLayer = (project, id) => project.layers.find((l) => l.id === id) || null;

// ---------------------------------------------------------------- commands

function applyCommand(project, command) {
  if (command.type === 'set') {
    const layer = findLayer(project, command.id);
    if (!layer) return;
    for (const [key, value] of Object.entries(command.to)) {
      if (key === 'text') {
        Object.assign(layer.text, value);
        // Drop the cache KEY, not just the pixels — clearing only `rendered`
        // would let the next lookup hit a matching key and return null.
        layer.renderedKey = null;
        layer.rendered = null;
      } else layer[key] = value;
    }
  } else if (command.type === 'reorder') {
    const [moved] = project.layers.splice(command.from, 1);
    project.layers.splice(command.to, 0, moved);
  } else if (command.type === 'insert') {
    // The command holds the LAYER OBJECT, not a description of one. Rebuilding
    // it would mint a fresh id on every redo, and both the panel's selection
    // and the sandwich cache's slice boundaries name layers by id -- they would
    // silently start pointing at nothing. Holding the object also keeps the
    // pixel buffer alive, which is the only way undoing a delete can put the
    // picture back.
    const at = Math.max(0, Math.min(project.layers.length, command.index));
    project.layers.splice(at, 0, command.layer);
  } else if (command.type === 'remove') {
    // By id, not by `command.index`: an insert or a reorder between the remove
    // and its undo shifts the array, and the recorded index would then delete
    // the wrong layer. The index is only used to put it BACK.
    const at = project.layers.findIndex((l) => l.id === command.layer.id);
    if (at >= 0) project.layers.splice(at, 1);
  }

  /**
   * Every path reaches here: commit, setLayer's coalescing early-return, undo
   * and redo. `revision` deliberately does NOT move on the coalesced frames of
   * a drag -- that asymmetry is what lets the sandwich cache survive a gesture
   * (src/sandwich.js:103-107). Anything that must react to EVERY applied
   * change -- an Angular signal, a thumbnail, the panel's badge row -- reads
   * this counter instead. Two counters, two different questions.
   */
  project.mutation = (project.mutation ?? 0) + 1;
}

function invert(command) {
  if (command.type === 'insert') return { ...command, type: 'remove' };
  if (command.type === 'remove') return { ...command, type: 'insert' };
  return command.type === 'set'
    ? { ...command, to: command.from, from: command.to }
    : { ...command, from: command.to, to: command.from };
}

/**
 * A coalesce key scoped to ONE gesture.
 *
 * setLayer merges a command into the previous one when the keys match, which is
 * what turns four hundred pointer moves into a single undo step. A literal key
 * would also merge two SEPARATE drags of the same layer, minutes apart, and the
 * earlier one would become unreachable. The nonce is what stops that, and it
 * lives here rather than in the UI so no caller can forget it.
 *
 * Mint one at pointer-down and reuse it for the whole gesture.
 */
let gestureSerial = 0;
export const nextGestureKey = (prefix) => `${prefix}#${++gestureSerial}`;

/** Run a command and push it onto the undo stack. */
export function commit(project, command) {
  applyCommand(project, command);
  project.history.push(command);
  project.future.length = 0;
  project.revision = (project.revision ?? 0) + 1;
  return project;
}

/**
 * Change layer properties. Captures the previous values so undo works.
 *
 * @param {string[]} [coalesceKey]  Merge with the previous entry when it targeted
 *   the same layer and fields — so a drag is one undo step, not four hundred.
 */
export function setLayer(project, id, changes, coalesceKey) {
  const layer = findLayer(project, id);
  if (!layer) return project;

  // ONE owner for `rerendered`, and it has to be here rather than in
  // applyCommand: render.js:154 branches on this flag to decide whether a text
  // layer re-rasterises at its target size (sharp) or goes through resample()
  // (pixelated), and applyCommand also replays INVERTED commands. A flag set
  // there is never captured in `from`, so undoing a text resize would leave the
  // layer stuck on the live renderer. Deciding it here makes it invertible.
  //
  // Photoshop's text pixels are a bitmap; upscaling them can only blur. Raster
  // layers really are bitmaps, so resampling is all there is and the flag stays
  // false for them.
  if (layer.kind === 'text' && !('rerendered' in changes)
      && ('w' in changes || 'h' in changes || 'text' in changes))
    changes = { ...changes, rerendered: true };

  const from = {};
  for (const key of Object.keys(changes))
    from[key] = key === 'text'
      ? Object.fromEntries(Object.keys(changes.text).map((k) => [k, layer.text[k]]))
      : layer[key];

  const previous = project.history[project.history.length - 1];
  if (coalesceKey && previous && previous.coalesceKey === coalesceKey && previous.id === id) {
    // Extend the existing step rather than adding a new one.
    Object.assign(previous.to, changes);
    applyCommand(project, { type: 'set', id, to: changes, from });
    project.future.length = 0;
    return project;
  }

  return commit(project, { type: 'set', id, from, to: changes, coalesceKey });
}

/**
 * Merge a change into a layer's adjustment.
 *
 * The ONLY sanctioned way to change one. It rebuilds a complete, clamped,
 * deeply frozen object from the current parameters plus `changes` and hands
 * that to setLayer, so:
 *
 *   - `from` and `to` are always DIFFERENT objects, and undo works;
 *   - an out-of-range number can never reach an evaluator;
 *   - a neutral result is stored as `null` rather than as an empty-looking
 *     object, so isNeutralAdjust short-cuts the whole pass and a reset layer
 *     costs what an untouched one costs.
 *
 * Pass a gesture key from nextGestureKey('adjust') for a slider drag: setLayer
 * then coalesces the frames into ONE history entry and leaves `revision`
 * alone, which is what lets the sandwich cache survive the gesture.
 *
 * @param {object} project
 * @param {number} id
 * @param {object} changes  any subset of the adjust schema
 * @param {string} [coalesceKey]
 */
export function setAdjust(project, id, changes, coalesceKey) {
  const layer = findLayer(project, id);
  if (!layer) return project;

  // Touching a parameter without naming a preset means the numbers are no
  // longer the preset's. Keeping the highlight would claim a look they are not.
  const touchesParameters = Object.keys(changes).some((k) => k !== 'preset');
  const preset = 'preset' in changes ? changes.preset
    : touchesParameters && layer.adjust && layer.adjust.preset !== 'none' ? 'custom'
    : layer.adjust?.preset;

  const next = createAdjust({ ...(layer.adjust ?? {}), ...changes, preset });
  return setLayer(project, id, { adjust: isNeutralAdjust(next) ? null : next }, coalesceKey);
}

export function reorderLayer(project, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return project;
  if (fromIndex >= project.layers.length || toIndex >= project.layers.length) return project;
  return commit(project, { type: 'reorder', from: fromIndex, to: toIndex });
}

export function undo(project) {
  const command = project.history.pop();
  if (!command) return false;
  applyCommand(project, invert(command));
  project.future.push(command);
  // undo() and redo() call applyCommand directly, NOT commit — so each has to
  // bump this itself or a cache keyed on it serves stale pixels afterwards.
  project.revision = (project.revision ?? 0) + 1;
  return true;
}

export function redo(project) {
  const command = project.future.pop();
  if (!command) return false;
  applyCommand(project, command);
  project.history.push(command);
  project.revision = (project.revision ?? 0) + 1;
  return true;
}

/**
 * Roll the history back to a recorded length, discarding what was popped.
 *
 * What `X` on a tool sheet does. PixelPerfect's X/tick mean cancel/apply
 * because it BAKES; nothing bakes here, so the tick is just "close" and needs
 * no code, and the X has to mean "discard this whole session, however many
 * sliders were touched, in one action".
 *
 * Pops WITHOUT pushing to `future`, deliberately: a discarded experiment left
 * on the redo stack is something the user finds again by accident three actions
 * later and cannot explain.
 *
 * `revision` bumps ONCE for the whole rollback rather than once per pop. The
 * caches keyed on it only need to know that something structural changed, and
 * describing one user action with eight keys is eight keys nobody reads.
 *
 * @param {object} project
 * @param {number} historyLength  project.history.length as it was when the sheet opened
 * @returns {number} commands popped
 */
export function discardTo(project, historyLength) {
  const target = Math.max(0, Number(historyLength) || 0);
  let popped = 0;

  while (project.history.length > target) {
    const command = project.history.pop();
    if (!command) break;
    applyCommand(project, invert(command));
    popped++;
  }

  if (popped) {
    project.future.length = 0;
    project.revision = (project.revision ?? 0) + 1;
  }
  return popped;
}

// ---------------------------------------------------------------- hit testing

/**
 * Topmost visible layer whose pixel at (x, y) is not transparent.
 * Falls back to bounds for layers we re-render (text being retyped).
 */
export function hitTest(project, x, y) {
  for (let i = project.layers.length - 1; i >= 0; i--) {
    const layer = project.layers[i];
    if (!layer.visible || layer.opacity === 0) continue;
    if (x < layer.x || y < layer.y || x >= layer.x + layer.w || y >= layer.y + layer.h) continue;

    const pixels = layer.rendered || layer.pixels;
    if (!pixels) return layer;

    // Map canvas point back into the layer's own (unscaled) pixel grid.
    const sx = Math.floor(((x - layer.x) / layer.w) * pixels.width);
    const sy = Math.floor(((y - layer.y) / layer.h) * pixels.height);
    if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) continue;
    if (pixels.data[(sy * pixels.width + sx) * 4 + 3] > 8) return layer;
  }
  return null;
}

// ---------------------------------------------------------------- persistence

/** Everything needed to rebuild this edit session on top of the same source PSD. */
export function toProjectJson(project) {
  return {
    format: 'psd-reader-project',
    version: 1,
    source: project.fileName,
    width: project.width,
    height: project.height,
    layers: project.layers.map((l) => ({
      id: l.id, name: l.name, kind: l.kind,
      visible: l.visible, opacity: l.opacity, blendMode: l.blendMode,
      x: l.x, y: l.y, w: l.w, h: l.h,
      rerendered: l.rerendered,
      // Carried so a reopened session does not silently lose the clipping
      // disclosure -- the chip, the filter and the document warning all read
      // these, and a saved project that drops them is a saved project that
      // stops telling the truth.
      clipping: l.clipping,
      groupPath: l.groupPath,
      /**
       * ONLY the toggle. The mask raster is rebuilt from the PSD on every load;
       * writing it here would store a second copy of the document.
       */
      maskDisabled: l.mask ? l.mask.disabled : null,
      /**
       * The adjustment PARAMETERS. Not the table they build: lutFor rebuilds
       * that from these, keyed on exactly the values it reads, so writing it
       * here would be storing a cache that can only ever disagree with its
       * input. The object is already frozen and JSON-shaped.
       */
      adjust: l.adjust ?? null,
      text: l.text ? { ...l.text } : null,
    })),
  };
}

/**
 * Re-apply a saved project onto a freshly read PSD. Matches by index, since
 * ids are assigned per session — so it only holds for the same source file.
 */
export function applyProjectJson(project, json) {
  if (json?.format !== 'psd-reader-project')
    throw new Error('Not a psd-reader project file');
  if (json.layers.length !== project.layers.length)
    throw new Error(`Layer count differs (project has ${json.layers.length}, file has ${project.layers.length}) — is this the same PSD?`);

  json.layers.forEach((saved, i) => {
    const layer = project.layers[i];
    Object.assign(layer, {
      visible: saved.visible, opacity: saved.opacity, blendMode: saved.blendMode,
      x: saved.x, y: saved.y, w: saved.w, h: saved.h, rerendered: saved.rerendered,
    });
    if (saved.text && layer.text) Object.assign(layer.text, saved.text);
    if (typeof saved.clipping === 'boolean') layer.clipping = saved.clipping;
    if (typeof saved.groupPath === 'string') layer.groupPath = saved.groupPath;
    // The raster is whatever this load produced; only the toggle is restored.
    if (layer.mask && typeof saved.maskDisabled === 'boolean') layer.mask.disabled = saved.maskDisabled;
    // Through createAdjust rather than Object.assign: the save file is text on
    // a device, so an out-of-range or half-built object has to be clamped and
    // completed before it can reach an evaluator -- and the result has to be
    // frozen for the same reason every other one is.
    layer.adjust = saved.adjust ? createAdjust(saved.adjust) : null;
    // The derived table is keyed on the parameters, so it re-derives itself on
    // the next lutFor. Dropping the key anyway keeps the pair honest.
    layer.lutKey = null;
    layer.lut = null;
    // Drop the cache KEY as well as the pixels. Clearing only `rendered` lets
    // the next lookup hit a still-matching key, get null back, and the layer
    // disappears — the same trap `setLayer` guards against above.
    layer.renderedKey = null;
    layer.rendered = null;
  });

  project.history.length = 0;
  project.future.length = 0;
  project.revision = (project.revision ?? 0) + 1;
  project.mutation = (project.mutation ?? 0) + 1;
  return project;
}
