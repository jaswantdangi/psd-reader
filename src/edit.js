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

/** Blend modes offered in the UI — the separable set our compositor implements exactly. */
export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color dodge', 'color burn', 'hard light', 'soft light',
  'difference', 'exclusion', 'linear dodge', 'linear burn',
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
 */
function flatten(children, out, warnings) {
  for (const node of children || []) {
    if (node.children) {
      const opacity = node.opacity ?? 1;
      const mode = node.blendMode || 'pass through';
      if (opacity !== 1 || (mode !== 'pass through' && mode !== 'normal'))
        warnings.add(
          `Group "${node.name || 'unnamed'}" had ${mode} blending at ${Math.round(opacity * 100)}% ` +
          `opacity. Groups are flattened for editing, so this layer stack will render differently than in Photoshop.`,
        );
      if (node.hidden === true)
        warnings.add(`Group "${node.name || 'unnamed'}" was hidden; its layers are individually hidden instead.`);

      const before = out.length;
      flatten(node.children, out, warnings);
      // A hidden group hides its contents — but only its own, not everything
      // flattened so far.
      if (node.hidden === true) for (let i = before; i < out.length; i++) out[i].visible = false;
      continue;
    }
    if (!node.imageData && !node.proxyData && !node.text) continue; // nothing to draw or edit
    out.push(toLayer(node));
  }
  return out;
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
  const layers = flatten(doc.children, [], warnings);

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
        layer.rerendered = true;
      } else layer[key] = value;
    }
  } else if (command.type === 'reorder') {
    const [moved] = project.layers.splice(command.from, 1);
    project.layers.splice(command.to, 0, moved);
  }
}

function invert(command) {
  return command.type === 'set'
    ? { ...command, to: command.from, from: command.to }
    : { ...command, from: command.to, to: command.from };
}

/** Run a command and push it onto the undo stack. */
export function commit(project, command) {
  applyCommand(project, command);
  project.history.push(command);
  project.future.length = 0;
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
  return true;
}

export function redo(project) {
  const command = project.future.pop();
  if (!command) return false;
  applyCommand(project, command);
  project.history.push(command);
  return true;
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
    // Drop the cache KEY as well as the pixels. Clearing only `rendered` lets
    // the next lookup hit a still-matching key, get null back, and the layer
    // disappears — the same trap `setLayer` guards against above.
    layer.renderedKey = null;
    layer.rendered = null;
  });

  project.history.length = 0;
  project.future.length = 0;
  return project;
}
