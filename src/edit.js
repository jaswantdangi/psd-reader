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
import { normaliseRect, sameRect } from './frame/rect.js';
import { normaliseLineBreaks } from './render.js';
import {
  FONT_STACKS, textTransformOf, effectiveFontSize, sourceFontName, fontStackFor,
} from './engine-data.js';

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

/**
 * The stacks the renderer can draw. Defined in engine-data.js next to the
 * substitution rule that picks between them, and re-exported here because this
 * is where every caller already imports it from.
 */
export { FONT_STACKS } from './engine-data.js';

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

/**
 * The parts of a text transform this renderer cannot express, said out loud.
 *
 * `hypot` recovers the scale from the matrix and discards the direction, so a
 * rotated layer would come out at exactly the right size, upright, and look
 * like a success. A non-uniform scale is legal in PSD and means genuinely
 * stretched glyphs, which `rasteriseTextAt` will not draw — it fits glyphs
 * inside their box undistorted, on purpose, because doing otherwise is what
 * squashed every text layer once already. Neither is fixed here; both are
 * disclosed, because a wrong picture with the right numbers in it is the one
 * outcome worse than a visible gap.
 */
function describeTextTransform(name, transform, warnings) {
  const label = `Text layer "${name}"`;
  if (transform.rotated)
    warnings.add(
      `${label} is rotated ${Math.round(transform.rotation * 10) / 10}° in the file. Rotation is not ` +
      `applied — the layer is drawn upright at the right size, so it will not match Photoshop.`,
    );
  if (!transform.uniform)
    warnings.add(
      `${label} is stretched in the file — ${Math.round((transform.scaleX / transform.scaleY) * 100)}% ` +
      `as wide as it is tall. Glyphs are drawn undistorted at the vertical size, so the text will be ` +
      `${transform.scaleX > transform.scaleY ? 'narrower' : 'wider'} than Photoshop draws it.`,
    );
}

/**
 * The width Photoshop wrapped a PARAGRAPH layer to, in the space the model
 * draws in — or null for point text and for a box we cannot read.
 *
 * `boxBounds` is `[left, top, right, bottom]` in the TEXT OBJECT's own space,
 * the same pre-transform space `style.fontSize` lives in. Photoshop composes
 * the paragraph there, so where the lines break depends only on the RATIO of
 * the box width to the font size. `toLayer` bakes the transform's vertical
 * scale into `fontSize` (see the note below and effectiveFontSize), so the box
 * width has to take the IDENTICAL scale or that ratio changes and every line
 * breaks in the wrong place.
 *
 * scaleY and not scaleX, for exactly that reason: it is the factor already
 * applied to the font size, so the pair stays in proportion. On a genuinely
 * stretched layer (scaleX !== scaleY) the box we draw is therefore the right
 * width for the LINE BREAKS and not for the rectangle Photoshop drew — that
 * renderer cannot draw a stretch at all, which is already disclosed by
 * `describeTextTransform`.
 *
 * Null rather than a guess wherever the numbers are not there. `render.js`
 * wraps only when the shape is 'box' AND the width is positive, because
 * wrapping to a made-up width gives plausible-looking wrong line breaks — the
 * worst available outcome, since nothing on screen says which it is.
 */
function boxWidthOf(text, transform) {
  const bounds = text?.boxBounds;
  if (!Array.isArray(bounds) || bounds.length < 4) return null;
  const [left, , right] = bounds;
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  const width = (right - left) * transform.scaleY;
  return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Everything the model keeps from a PSD text layer, and the disclosures that
 * come with it.
 *
 * ## Two shapes, and only one of them wraps
 *
 * A PSD text layer is either POINT text — an insertion point and a string,
 * breaking only where the author typed a break — or BOX (paragraph) text: a
 * rectangle the author drew, with Photoshop wrapping the string to its width.
 * ag-psd reports which in `shapeType`, and the rectangle in `boxBounds`.
 *
 * Neither reached the model, so a paragraph layer lost every computed break as
 * soon as we started drawing it, and a three-line headline came out as one
 * line. `shapeType` and `boxWidth` are carried so `render.js` can lay the
 * paragraph out the way the file was laid out; point text is untouched by all
 * of it and keeps behaving exactly as before.
 *
 * ## The size is not `style.fontSize`
 *
 * `style.fontSize` is the PRE-transform size; Photoshop draws it under the
 * layer's own 2x3 matrix. fixtures/float-color.src.psd's "outer glow" says
 * 66.66666 and appears at 16.6, because that matrix scales by 0.249. Reading
 * `fontSize` alone drew it four times too large, and a file that scales UP —
 * which is what a real headline does — drew far too small. Both other text
 * fixtures carry an identity transform, which is precisely why nothing caught it.
 *
 * The scale is BAKED IN rather than carried alongside. Keeping it separate
 * would make `fontSize` a number that is never the size anything draws, and
 * every consumer — `fontSpec`, `measureText`, the render cache key, the size
 * slider, `retypeText` — would have to remember to multiply. That is the same
 * shape as the CR-versus-LF bug this file already normalises at the door: one
 * convention reaches the model, and nothing downstream has to know. The file's
 * own numbers are not lost — `sourceFontSize` and `sourceScale` keep them, so
 * the sheet can say where 17 came from rather than silently contradicting
 * Photoshop's own panel.
 *
 * ## The typeface is the file's, the stack is ours
 *
 * `fontFamily` used to be `FONT_STACKS[0]` for every layer ever read, so a
 * serif headline became Arial and nothing said so. The real name now reaches
 * `sourceFont` and picks the closest stack we can actually draw. It stays a
 * SUBSTITUTION — a PSD stores font names, never font files — so the name is
 * kept for the UI to disclose. `sourceFont` is null when the file names nothing,
 * which is the honest reading of Photoshop's `AdobeInvisFont` placeholder.
 *
 * @param {Set<string>} [warnings]  rotation and stretch this renderer cannot draw
 */
function toLayer(source, warnings) {
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
     * The file clips this layer to the one directly below it. APPLIED.
     *
     * The note that stood here said clipping was "NOT APPLIED: clipping is a
     * nested composite, not an alpha multiply, and it collides with the free
     * reorder this panel exists to offer". Half of that was right and half of
     * it was the reason nothing got fixed for two phases:
     *
     *   - it IS a nested composite. render.js builds one, ported step for step
     *     from the walk composite.js has always run: the base into a
     *     full-canvas group buffer, the base's alpha as a clip plane, each
     *     clipped layer blended into the group through it, the group into the
     *     canvas with the base's own opacity and blend mode.
     *   - it does NOT collide with reorder. A clipping mask is POSITIONAL, not
     *     a group: a clipped layer clips to whatever layer ends up below it.
     *     So a reorder simply recomputes the runs from the new order. Nothing
     *     is locked, nothing drags as a unit, and there is no new UI concept --
     *     `reorderLayer` needed no change at all, and undo restores the
     *     previous arrangement through the same inverse splice as ever.
     *
     * The flag is still carried for the panel's per-row chip and Clipped
     * filter, which say WHICH rows are clipped. That is still worth saying;
     * "and therefore wrong" no longer is.
     */
    clipping: source.clipping === true,
    /**
     * Photoshop's Blend If ranges, carried verbatim for composite.js to parse.
     *
     * NOT interpreted here. `parseBlendIf` in composite.js is the single
     * implementation of the rule, and render.js already calls it on every
     * layer of every frame -- it was simply always getting undefined, because
     * this field never made it out of the file. The inspector applied blend-if
     * and the editor did not, which is the same split that made clipping wrong
     * in preview and export while composite.js had been right all along.
     *
     * Undefined rather than null when absent: `parseBlendIf` returns null on
     * anything falsy and allocates nothing, so a document that does not use
     * blend-if -- 20 of the 21 fixtures -- pays nothing for this line.
     */
    blendingRanges: source.blendingRanges,
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
    // Photoshop stores line breaks as CR. Normalised HERE, at the one door a
    // file's string comes through, so nothing downstream has to know that --
    // see normaliseLineBreaks in render.js for why one convention beats three.
    const content = normaliseLineBreaks(source.text.text ?? '');
    const transform = textTransformOf(source.text.transform);
    const sourceFont = sourceFontName(style);
    const drawn = effectiveFontSize(style, source.text.transform);

    layer.text = {
      content,
      fontFamily: fontStackFor(sourceFont),
      fontSize: Math.max(1, Math.round(drawn || 24)),
      color: rgbToHex(style.fillColor),
      bold: false,
      italic: false,
      align: source.text.paragraphStyle?.justification === 'center' ? 'center'
        : source.text.paragraphStyle?.justification === 'right' ? 'right' : 'left',
      /**
       * The string as Photoshop had it — lets us tell whether content actually
       * changed. Normalised with `content` and never separately: leaving CR
       * here would report every untouched multi-line layer as edited.
       */
      originalContent: content,
      /** The typeface the FILE names, or null where it names none. Never drawn — disclosed. */
      sourceFont,
      /** `style.fontSize` before the transform, so the sheet can show where the drawn size came from. */
      sourceFontSize: typeof style.fontSize === 'number' ? style.fontSize : null,
      /** The vertical scale of the transform, already applied to `fontSize` above. */
      sourceScale: transform.scaleY,
      /**
       * 'point' or 'box', as the FILE says — not as we can act on it. A
       * paragraph layer whose boxBounds we cannot read is still a paragraph
       * layer, and reporting it as point text would hide the reason its lines
       * are not wrapping.
       */
      shapeType: source.text.shapeType === 'box' ? 'box' : 'point',
      /** The wrap width, at the same scale as `fontSize`. Null for point text. */
      boxWidth: boxWidthOf(source.text, transform),
    };

    if (warnings) describeTextTransform(layer.name, transform, warnings);
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
    const layer = toLayer(node, warnings);
    layer.groupPath = path.join(' / ');
    layer.groupWarned = inWarnedGroup;
    out.push(layer);
  }
  return out;
}

/**
 * Leaves whose vector mask would actually change what we draw.
 *
 * ag-psd exposes `layer.vectorMask` and `mask.fromVectorData`; neither is ever
 * consulted by composite.js or render.js, so a path this codebase has to apply
 * itself is a path that goes unapplied.
 *
 * THE COMMON CASE IS NOT THAT ONE, and this used to claim it was. The test was
 * "is there a rasterised mask alongside the path?", and for a Photoshop shape
 * layer the answer is no -- there is no separate mask because the path is
 * already baked into the layer's OWN pixels, which arrive cropped to the
 * shape's bounds. Measured on the corpus: shapes.src.psd and vectors.src.psd
 * hold 8 vector-masked layers between them, every one with no raster mask and
 * every one composited bit-exact against Photoshop (0.00% real diff, maxDelta
 * 0). The warning fired on all 8 and was false on all 8 -- it told the user to
 * distrust a picture that is pixel-for-pixel correct, which is worse than
 * saying nothing, because it spends the credibility the true warnings need.
 *
 * So the question is what we would DRAW, not what fields are present. A leaf
 * with pixels of its own has the path already applied to them, whether the
 * clipping came from a raster mask or from Photoshop's own rasteriser. Only a
 * leaf with a path and NO pixels -- a live shape whose fill we would have to
 * synthesise from `vectorFill` -- is one we cannot render faithfully.
 *
 * `proxyData` as well as `imageData`: a streamed load carries the layer's
 * pixels on the former, and asking only about the latter would put the false
 * warning straight back for every streamed document.
 */
function countUnrasterisedVectorMasks(children) {
  let n = 0;
  for (const node of children || []) {
    if (node.children) { n += countUnrasterisedVectorMasks(node.children); continue; }
    if (!node.vectorMask) continue;
    if (node.mask?.imageData || node.proxyMask) continue;  // rasterised mask: applied
    if (node.imageData || node.proxyData) continue;        // pixels: path already baked in
    n++;
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

  // NO CLIPPING WARNING. There used to be one here -- "N layers are clipped to
  // the layer below. Clipping is not applied [...] Reordering will not restore
  // the relationship." -- and every clause of it is now false: render.js draws
  // the clip runs, a reorder recomputes them, and undo puts them back.
  //
  // Deleted rather than reworded. A warning discloses a DIVERGENCE from
  // Photoshop, and there is no longer one to disclose; leaving it would tell
  // the user to distrust a picture that is now correct, which is a worse
  // failure than the silence it originally replaced. The two disclosure
  // surfaces that say something still true -- the panel's per-row chip and the
  // Clipped filter, both driven off `layer.clipping` -- are untouched.

  const vectorMasked = countUnrasterisedVectorMasks(doc.children);
  if (vectorMasked)
    warnings.add(
      `${vectorMasked} layer${vectorMasked === 1 ? ' has' : 's have'} a vector shape and no pixels of ` +
      `${vectorMasked === 1 ? 'its' : 'their'} own. Vector paths are not rasterised — ` +
      `${vectorMasked === 1 ? 'that layer is' : 'those layers are'} drawn unmasked.`,
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
    /**
     * The window onto the document that is currently the canvas, or null for
     * the whole of it. `width`/`height` above are the SOURCE document and never
     * change — that is what makes a crop reversible — so anything asking "how
     * big is the canvas" must go through `canvasSize()`, not read them.
     * src/frame owns the geometry; the command lives here with every other one.
     */
    frame: null,
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

// ---------------------------------------------------------------- the frame

/** The whole source document, which is what an unframed project means. */
export const fullFrame = (project) => ({ x: 0, y: 0, width: project.width, height: project.height });

/** The current frame — never null, so callers never branch on absence. */
export const frameOf = (project) => project.frame || fullFrame(project);

export function isCropped(project) {
  const frame = project.frame;
  return !!frame &&
    (frame.x !== 0 || frame.y !== 0 || frame.width !== project.width || frame.height !== project.height);
}

/**
 * How big the CANVAS is — the one accessor everything that means "the size of
 * the thing on screen" must use.
 *
 * `project.width`/`height` are the source document and stay put through a crop,
 * so reading them for a canvas size is silently wrong the moment a frame is
 * set: the view would be scaled to the uncropped document and every tap would
 * land on the wrong layer. Two fields both plausibly mean "how big is it", and
 * a comment is not enough to stop the next reader picking the wrong one — so
 * the right one has a name.
 */
export function canvasSize(project) {
  const frame = frameOf(project);
  return { width: frame.width, height: frame.height };
}

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
  } else if (command.type === 'frame') {
    // A crop is a document-level change to a single field, so it is a command
    // like any other. It lives here rather than in a wrapper over `history`
    // because two undo functions over one stack is a bug waiting to be filed as
    // "undo doesn't work sometimes" -- whichever one a caller imported.
    project.frame = command.to;
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

/**
 * Set the document frame. `null` clears it, restoring the whole document.
 *
 * The geometry that produces the rect lives in `src/frame` — the ratio presets,
 * the handle drags, the canvas anchors. Only the COMMAND lives here, next to
 * every other command, so there is one `applyCommand`, one `invert` and one
 * undo stack for the whole editor.
 *
 * The rect is frozen for the same reason `createAdjust` freezes its result: the
 * undo entry captures `from` BY REFERENCE, so a caller who mutated
 * `project.frame` in place would have destroyed that entry before it was
 * written, and nothing would notice until someone pressed undo.
 *
 * @param {object} project
 * @param {{x,y,width,height}|null} rect  document coordinates; may extend
 *   OUTSIDE the document, which is how the canvas is enlarged.
 * @param {string} [coalesceKey]  from `nextGestureKey('crop')`. Merges with the
 *   previous entry for the same gesture, so a crop drag is one undo step and
 *   `revision` does not move — exactly as a layer drag behaves.
 */
export function setFrame(project, rect, coalesceKey) {
  const to = rect ? Object.freeze(normaliseRect(rect)) : null;
  const from = project.frame || null;
  if (sameRect(from, to)) return project;

  const previous = project.history[project.history.length - 1];
  if (coalesceKey && previous && previous.type === 'frame' && previous.coalesceKey === coalesceKey) {
    // Extend the existing step. `previous.from` stays the rect the gesture
    // started from, so one undo unwinds the whole drag.
    previous.to = to;
    applyCommand(project, { type: 'frame', from, to });
    project.future.length = 0;
    return project;
  }

  return commit(project, { type: 'frame', from, to, coalesceKey });
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
 * What a layer DRAWS at a document point, 0..255 -- its pixel alpha times its
 * mask. Or `null` when it has no buffer to read at all.
 *
 * The product is the one `blendInto` computes: `prepareLayer` resamples
 * `layer.mask` into the destination rect and `blendInto` multiplies `as` by
 * it, so anything that reads alpha alone is reading a layer's old shape rather
 * than its drawn one.
 *
 * `disabled` is honoured for exactly the reason `prepareLayer` honours it:
 * Photoshop saves switched-off masks, and applying one hides a layer that is
 * fully on screen -- as wrong as ignoring an enabled one, in the other
 * direction.
 *
 * NEAREST on both planes. render.js resamples the mask BILINEARLY into the
 * rect, but this reads one point instead of building a plane, and hitTest has
 * always read its pixels nearest; the two can disagree only on the sub-pixel
 * edge of a soft mask, which is finer than a fingertip.
 *
 * The mask is sampled on ITS OWN grid rather than the pixel grid. `toLayer`
 * builds the two on identical dimensions on purpose, so today the ratio is 1 --
 * but `layer.rendered` is a re-render at whatever size the text needed, and
 * mapping by ratio costs nothing and cannot drift.
 *
 * @param {object} layer  the point must already be inside its bounds
 * @returns {number|null}
 */
function coverageAt(layer, x, y) {
  const pixels = layer.rendered || layer.pixels;
  if (!pixels) return null;

  // Map the document point back into the layer's own (unscaled) pixel grid.
  const sx = Math.floor(((x - layer.x) / layer.w) * pixels.width);
  const sy = Math.floor(((y - layer.y) / layer.h) * pixels.height);
  if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) return 0;

  const alpha = pixels.data[(sy * pixels.width + sx) * 4 + 3];
  const mask = layer.mask;
  if (!alpha || !mask || mask.disabled || !mask.data || mask.width <= 0 || mask.height <= 0)
    return alpha;

  const mx = Math.min(mask.width - 1, Math.floor(((x - layer.x) / layer.w) * mask.width));
  const my = Math.min(mask.height - 1, Math.floor(((y - layer.y) / layer.h) * mask.height));
  return (alpha * mask.data[my * mask.width + mx]) / 255;
}

/**
 * Topmost visible layer that actually DRAWS something at (x, y).
 * Falls back to bounds for layers we re-render (text being retyped).
 *
 * "Draws something" is pixel alpha times the layer's mask, thresholded at 8 --
 * the same product `blendInto` multiplies into `as`, so a tap agrees with the
 * picture. It used to be pixel alpha alone, and a layer masked down to a small
 * shape stayed pickable across its whole bounding box: the user tapped what
 * was visibly the layer underneath and selected the masked one instead.
 *
 * `x`/`y` are CANVAS coordinates — the space `viewToDoc` produces, and the
 * space the rendered buffer is in. On a cropped document that is the frame's
 * space, not the source document's, so the frame's origin is added back before
 * anything is compared to a layer's `x`/`y`. Reading the tap as a source-
 * document point instead puts every selection off by the crop offset, which
 * looks like the wrong layer being picked rather than like a coordinate bug.
 */
export function hitTest(project, canvasX, canvasY) {
  const frame = frameOf(project);
  const x = canvasX + frame.x;
  const y = canvasY + frame.y;

  for (let i = project.layers.length - 1; i >= 0; i--) {
    const layer = project.layers[i];
    if (!layer.visible || layer.opacity === 0) continue;
    if (x < layer.x || y < layer.y || x >= layer.x + layer.w || y >= layer.y + layer.h) continue;

    const covered = coverageAt(layer, x, y);
    // No buffer at all: bounds are all there is to go on, so the layer takes
    // the tap. `0` would mean "transparent here" and is a different answer.
    if (covered === null) return layer;
    if (covered > 8) return layer;
  }
  return null;
}

// ---------------------------------------------------------------- persistence

/**
 * Base64 for a coverage plane, in both runtimes.
 *
 * `btoa` exists in browsers and in Node, so no Buffer branch is needed -- but
 * it takes a STRING, and `String.fromCharCode(...bytes)` on a megapixel plane
 * spreads a million arguments and overflows the call stack. Chunked instead,
 * at a width small enough to be safe on every engine.
 */
const B64_CHUNK = 0x8000;

function encodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  return btoa(binary);
}

function decodeBytes(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Serialise a mask, but only when it is the user's work rather than the file's. */
function maskJson(mask) {
  if (!mask?.generated || !mask.data) return null;
  return {
    width: mask.width,
    height: mask.height,
    disabled: mask.disabled === true,
    generated: true,
    data: encodeBytes(mask.data),
  };
}

/**
 * Rebuild a saved mask, refusing anything that does not describe itself.
 *
 * A project file is text on a device and can carry anything, so the byte count
 * is checked against the dimensions rather than trusted: a plane whose length
 * disagrees with `width * height` would be indexed out of bounds by render.js.
 */
function decodeMaskJson(saved) {
  if (!saved || typeof saved.data !== 'string') return null;
  const width = saved.width | 0;
  const height = saved.height | 0;
  if (width <= 0 || height <= 0) return null;
  let data;
  try {
    data = decodeBytes(saved.data);
  } catch {
    return null;
  }
  if (data.length !== width * height) return null;
  return { data, width, height, disabled: saved.disabled === true, generated: true };
}

/** Everything needed to rebuild this edit session on top of the same source PSD. */
export function toProjectJson(project) {
  return {
    format: 'psd-reader-project',
    version: 1,
    source: project.fileName,
    width: project.width,
    height: project.height,
    /**
     * The crop, or null. Written even when null so a reopen can CLEAR a frame
     * as well as set one — a save made before the crop must un-crop the project
     * it is applied to, not leave the old one standing.
     *
     * Two numbers and an origin, not pixels: nothing was cut, so there is
     * nothing to store but the window.
     */
    frame: project.frame ? { ...project.frame } : null,
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
       * The exception to the line above: a GENERATED mask.
       *
       * A PSD mask can be left out because the file it came from will still be
       * there next time. A mask produced by a cut-out or painted by hand has no
       * such source -- drop it and the user's work is gone on reopen, silently,
       * which is the same failure the inserted-image layers already have.
       *
       * Written as base64 of the raw coverage bytes. That is one byte per pixel
       * before encoding and about 1.37 after, so a 1024x1024 proxy layer costs
       * ~1.4 MB of JSON. Real, and worth it against losing the cut; PNG-packing
       * the plane would cut it by roughly an order of magnitude and is the
       * obvious follow-up.
       */
      mask: maskJson(l.mask),
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
    if (saved.text && layer.text) {
      Object.assign(layer.text, saved.text);
      // A project file written before line breaks were normalised can still
      // carry CR, and it is a file on a device, so it can carry anything.
      layer.text.content = normaliseLineBreaks(layer.text.content);
      layer.text.originalContent = normaliseLineBreaks(layer.text.originalContent);
    }
    if (typeof saved.clipping === 'boolean') layer.clipping = saved.clipping;
    if (typeof saved.groupPath === 'string') layer.groupPath = saved.groupPath;
    // The raster is whatever this load produced; only the toggle is restored.
    if (layer.mask && typeof saved.maskDisabled === 'boolean') layer.mask.disabled = saved.maskDisabled;
    /*
     * A saved GENERATED mask replaces whatever this load produced, because it
     * IS the user's work rather than a re-derivation of the file's. Restored
     * only when its dimensions match the layer's pixel buffer: a project saved
     * at one proxy edge and reopened at another would otherwise write a plane
     * of the wrong size onto the layer, and render.js indexes it by
     * `y * width + x` with no bounds check -- it would read past the end and
     * mask the layer with arithmetic noise rather than fail.
     */
    const savedMask = decodeMaskJson(saved.mask);
    if (savedMask && layer.pixels
        && savedMask.width === layer.pixels.width
        && savedMask.height === layer.pixels.height) {
      layer.mask = savedMask;
    }
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

  // Re-frozen and re-normalised, not Object.assign'd: the save file is text on
  // a device, so a hand-edited or half-built rect has to be completed before it
  // becomes the canvas, and frozen for the same reason setFrame freezes.
  // A file written before frames existed has no key, which reads as uncropped.
  project.frame = json.frame ? Object.freeze(normaliseRect(json.frame)) : null;

  project.history.length = 0;
  project.future.length = 0;
  project.revision = (project.revision ?? 0) + 1;
  project.mutation = (project.mutation ?? 0) + 1;
  return project;
}
