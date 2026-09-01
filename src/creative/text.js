/**
 * Created and retyped text layers.
 *
 * The model already carries `layer.text` and `setLayer` already edits it. Two
 * things were missing, and both are geometry rather than pixels:
 *
 *   1. **Creating a text layer from nothing.** A layer needs bounds, and a
 *      string's bounds are whatever the platform's text engine says they are.
 *   2. **Bounds that follow the string.** Typing a character makes the text
 *      wider; if the box does not follow, the glyphs are drawn shrunk into the
 *      old box, because `rasteriseTextAt` scales the transform to fit whatever
 *      rectangle it is handed.
 *
 * ## Photoshop's bounds are the same quantity as ours — but not the same font
 *
 * A text layer read from a PSD arrives with the FILE's box, and that box is the
 * INK extent of the glyphs — 60 x 21 for "TEST" at 30px in
 * fixtures/text.src.psd. `measureText` used to answer with a LINE BOX instead:
 * the widest advance by lines * round(fontSize * 1.25), 38 tall for the same
 * string. Two different quantities, so dividing one by the other gave a units
 * error rather than a scale — ~1.4x worse vertically than horizontally, which
 * is what "editing a PSD text layer squashes it" looked like on screen, and
 * then a visible jump in SIZE once the first edit re-fitted the box to that 38
 * instead. It now reports the ink extent as well, so the heights agree (21
 * against 21) and the first edit no longer moves the box vertically.
 *
 * The WIDTH can still differ, because `toLayer` substitutes the nearest stack it
 * can draw for whatever typeface the file named — a PSD stores font names, never
 * font files — so our box is right for the glyphs we draw and cannot be right
 * for glyphs we never had. `text.sourceFont` keeps the file's own name so the
 * substitution is stated rather than silent.
 *
 * So the rule is unchanged: the file's box positions the layer and never
 * scales it. The first edit re-fits the box to our own measurement; every edit
 * after that measures against a box already in our font.
 *
 * ## Measurement is a platform capability, not a fallback
 *
 * `measureText` returns null wherever there is no 2D surface — Node, and any
 * worker without `OffscreenCanvas`. Nothing here invents glyph metrics to fill
 * that gap: a made-up width produces a box that is confidently the wrong size,
 * and the error only becomes visible once a browser draws into it. So the
 * functions below either measure or say they cannot, and a caller with its own
 * numbers can always pass explicit `w`/`h`.
 *
 * The consequence for testing is worth stating plainly: bounds, anchoring and
 * the whole model path run in Node against a stubbed measurer, and the actual
 * glyph raster does not run there at all.
 */
import { setLayer, FONT_STACKS } from '../edit.js';
import { measureText, splitTextLines, normaliseLineBreaks, wrapsInBox } from '../render.js';
import { blankLayer, insertLayer, requireLayer, centreIn } from './layers.js';

const NO_MEASURER =
  'Cannot measure text here — there is no drawing surface in this context. ' +
  'Pass explicit w and h, or run this where a canvas exists.';

/**
 * The size this string wants to be, or null where nothing can measure it.
 *
 * @param {{content:string,fontFamily:string,fontSize:number,bold?:boolean,italic?:boolean}} text
 * @returns {{width:number,height:number} | null}
 */
export function naturalTextSize(text) {
  const measured = measureText(text);
  if (!measured || !measured.width || !measured.height) return null;
  return { width: measured.width, height: measured.height };
}

/**
 * The box a text layer of THIS shape wants — and it is not the same question
 * for the two shapes.
 *
 * POINT text has no rectangle of its own. Both axes are the glyphs' own ink,
 * which is what `naturalTextSize` returns and what every caller here used
 * before paragraph text existed in the model.
 *
 * BOX text does have one, and it is the AUTHOR'S: a rectangle they drew in
 * Photoshop, carried as `text.boxWidth`, and the thing every computed line
 * break in the paragraph was derived from. Re-measuring that width from our own
 * substituted glyphs would re-wrap the paragraph on the first keystroke — the
 * same class of bug as losing the breaks entirely, and the reason the re-fit
 * has to hold the width and let only the HEIGHT follow the text.
 *
 * `Math.max` rather than the author's width alone, for the one case where the
 * text is genuinely wider than the box: a word too long to fit overhangs its
 * line rather than being hyphenated or dropped (see `wrapParagraph`), and the
 * LAYER box has to contain that overhang. Without this,
 * `rasteriseTextAt`'s `min(w / natural.width, h / natural.height)` would scale
 * the whole paragraph down to squeeze one long word inside the author's width,
 * shrinking every other line because of a word on one of them. The author's
 * box is untouched by this; only the layer's bounds grow.
 */
function fittedSize(text) {
  const natural = naturalTextSize(text);
  if (!natural) return null;
  if (!wrapsInBox(text)) return natural;
  return {
    width: Math.max(Math.max(1, Math.round(text.boxWidth)), natural.width),
    height: natural.height,
  };
}

/**
 * Build the `layer.text` object, with the same fields and defaults `toLayer()`
 * gives a text layer read from a PSD.
 *
 * `originalContent` is `''` rather than the new string: it means "what
 * Photoshop had", and Photoshop never had this layer. Seeding it with the
 * user's own text would claim the file contained something it did not.
 */
const newText = (options) => ({
  content: normaliseLineBreaks(options.content),
  fontFamily: options.fontFamily ?? FONT_STACKS[0],
  fontSize: Math.max(1, Math.round(options.fontSize ?? 24)),
  color: options.color ?? '#000000',
  bold: options.bold === true,
  italic: options.italic === true,
  align: options.align ?? 'left',
  originalContent: '',
  /**
   * Null and 1, for the same reason `originalContent` is `''`: these three
   * fields mean "what the FILE said", and no file said anything about this
   * layer. Naming the chosen stack as a `sourceFont` would make the sheet
   * report a substitution that never happened.
   */
  sourceFont: null,
  sourceFontSize: null,
  sourceScale: 1,
  /**
   * Point, and no box.
   *
   * That is the shape Photoshop gives a layer created by CLICKING rather than
   * by dragging out a rectangle, and it is the only honest answer for a string
   * typed into a sheet: nobody drew a box, so every line break in it is the
   * author's own. It also keeps a created layer's handle drag scaling, which is
   * the only sensible drag for a layer with no author width. Converting one to
   * a paragraph box is in docs/BACKLOG.md.
   */
  shapeType: 'point',
  boxWidth: null,
});

/**
 * Create a text layer.
 *
 * `rerendered` is true and cannot be anything else: a created layer has no
 * Photoshop bitmap, and `drawLayerInto` only takes the live-text branch when
 * this flag is set. False would send it down the raster branch with null
 * pixels, where it draws nothing and reports nothing. It is also what makes the
 * layer self-rendering to the export walk, so export generates it in place
 * rather than waiting for an arrival from a file that never contained it.
 *
 * Sized from the measurer and centred in the document unless `w`/`h`/`x`/`y`
 * say otherwise. With no measurer and no explicit box this THROWS rather than
 * guessing — see the note at the top of the file.
 *
 * @param {object} project
 * @param {object} options  content, fontFamily, fontSize, color, bold, italic, align,
 *   plus x, y, w, h, name, index, opacity, blendMode, visible
 * @returns {object} the new layer
 */
export function insertTextLayer(project, options = {}) {
  const { index, opacity = 1, blendMode = 'normal', visible = true } = options;
  const text = newText(options);

  let w = options.w, h = options.h;
  if (w === undefined || h === undefined) {
    const natural = fittedSize(text);
    if (!natural) throw new Error(NO_MEASURER);
    w = w ?? natural.width;
    h = h ?? natural.height;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));

  const centred = centreIn(project, w, h);
  const layer = blankLayer(project, {
    name: options.name ?? (splitTextLines(text.content)[0] || 'Text'),
    kind: 'text',
    visible, opacity, blendMode,
    x: Math.round(options.x ?? centred.x),
    y: Math.round(options.y ?? centred.y),
    w, h,
    // No Photoshop bitmap exists for this layer, at any resolution.
    pixels: null,
    sourceW: w, sourceH: h,
    proxyW: w, proxyH: h,
    rerendered: true,
    text,
  });

  return insertLayer(project, layer, index);
}

/**
 * The scale a text layer's box currently applies to its own string, as ONE
 * number — the same one `rasteriseTextAt` derives from the same two rects.
 *
 * 1 for a layer still on Photoshop's pixels, whatever its box says: those are
 * the file's bounds for the file's own typeface (see the note at the top of
 * this file), and reading a resize out of them is where the stretch was minted.
 *
 * One number rather than two, on purpose. A corner drag does not lock aspect,
 * so a box CAN end up non-uniform — but the glyphs are fitted inside it
 * undistorted and the leftover is empty space, not a stretch. Carrying two
 * factors forward is what turned that empty space into a permanent distortion
 * which every later keystroke re-applied.
 *
 * BOX text is excluded outright, and not because the arithmetic would come out
 * wrong — `fittedSize` keeps its box equal to its own fitted size, so this
 * would return 1 anyway. It is excluded because box text does not EXPRESS a
 * hand scale in its bounds at all: its width is the author's rectangle and its
 * height is derived from the wrap, so the only way to make box text bigger is
 * to move `fontSize`, which `retypeText` carries the box along with. Reading a
 * factor out of bounds that mean something else is how the stretch was minted
 * the first time; saying so here stops a stray `setLayer({w})` from a caller
 * that has not been taught the two operations turning into a silent type-size
 * change on the next keystroke.
 *
 * @param {object} layer
 * @param {{width:number,height:number}} natural  the CURRENT string's own size
 */
function glyphScaleOf(layer, natural) {
  if (!layer.rerendered) return 1;
  if (wrapsInBox(layer.text)) return 1;
  return Math.min(layer.w / natural.width, layer.h / natural.height);
}

/**
 * Place a `w` x `h` box against the one the layer already has.
 *
 * Horizontally the anchor is the alignment: left-aligned text grows rightwards,
 * centred text about its centre, right-aligned text keeps its right edge.
 *
 * Vertically the top is fixed, because `rasteriseTextAt` puts the first
 * baseline a fixed ascent below the top of the box, so a second line has to
 * grow DOWN rather than shove the first one upwards. `recentre` is the single exception: on the
 * switch off Photoshop's pixels the two boxes are measured from different
 * typefaces, so their ink heights need not match. They usually now do — both
 * are ink extents — which is what makes the first edit continuous; where the
 * substituted face is taller or shorter, centring the new box on the old one
 * keeps the ink where the user is looking at it instead of dropping it by the
 * whole difference.
 */
const anchorBox = (layer, w, h, align, recentre) => ({
  x: align === 'center' ? layer.x + Math.round((layer.w - w) / 2)
    : align === 'right' ? layer.x + layer.w - w
    : layer.x,
  y: recentre ? layer.y + Math.round((layer.h - h) / 2) : layer.y,
  w,
  h,
});

/**
 * The box a PSD text layer takes the moment it stops being Photoshop's pixels
 * and starts being ours: our own natural size, anchored on the file's box so
 * the glyphs do not jump.
 *
 * For a gesture that is ABOUT to re-render the layer — dragging a corner
 * handle — this is the rect the drag has to start from. Starting from the
 * file's box scales a rectangle that never meant what our renderer reads it as,
 * and the layer jumps on the first frame of the drag instead.
 *
 * @returns {{x:number,y:number,w:number,h:number}|null} null when the layer is
 *   not text, is already ours, or when nothing here can measure.
 */
export function liveTextRect(layer) {
  if (!layer || layer.kind !== 'text' || !layer.text || layer.rerendered) return null;
  const natural = fittedSize(layer.text);
  if (!natural) return null;
  return anchorBox(
    layer,
    Math.max(1, Math.round(natural.width)),
    Math.max(1, Math.round(natural.height)),
    layer.text.align,
    true,
  );
}

/**
 * SCALE, expressed as a size change: the type moves and the box goes with it.
 *
 * The two operations a text box needs are not the same edit, and today's single
 * handle drag only ever expressed one of them:
 *
 *   1. RESIZE THE BOX — the author's width changes, the paragraph re-wraps to
 *      it, the type size does not move. `resizeTextBox` below.
 *   2. SCALE — the type gets bigger or smaller and the box scales with it, so
 *      the wrap is preserved proportionally. This function, applied to any
 *      change that carries a `fontSize`.
 *
 * Where the line breaks fall depends on ONE quantity: the ratio of the box
 * width to the font size. Both are in the text object's own pre-transform space
 * (see `boxWidthOf` in src/edit.js), so scaling the two by the same factor
 * moves neither the ratio nor a single break — the same words stay on the same
 * lines, larger. Moving `fontSize` alone would instead re-wrap the paragraph,
 * which is operation 1 with the wrong control.
 *
 * An explicit `boxWidth` in the same change WINS, and that is the third thing
 * a user can want: a different type size inside the same column. It is the two
 * operations issued as one command rather than a third operation.
 *
 * Point text is untouched — it has no author width to carry, its box has always
 * been the glyphs' own ink, and a size change simply re-measures it.
 */
function withScaledBox(text, changes) {
  if (!wrapsInBox(text)) return changes;
  if (changes.fontSize === undefined || 'boxWidth' in changes) return changes;

  const factor = changes.fontSize / text.fontSize;
  if (!Number.isFinite(factor) || factor <= 0) return changes;
  return { ...changes, boxWidth: text.boxWidth * factor };
}

/**
 * RESIZE THE BOX: the author's width becomes `rect.w`, the paragraph re-wraps
 * to it, and the type size does not move at all.
 *
 * This is what dragging a text box's handle does in Photoshop, Figma and
 * InDesign, and it is the operation the canvas's corner handles now perform on
 * a paragraph layer. Dragging used to SCALE, which for box text is the wrong
 * verb — it is why resizing a paragraph read as distortion rather than reflow.
 * Scaling is still reachable, one-fingered, from the Size slider in the text
 * sheet; see `withScaledBox`.
 *
 * ## What follows what
 *
 * `w` is the input. `h` is not an input at all and is never read off the rect:
 * a paragraph's height is however tall the new wrap turns out to be, so a
 * corner drag's vertical component is ignored rather than fought with. That is
 * the same behaviour an auto-height text frame has everywhere else, and it is
 * what makes the operation honest — there is no height the user could drag to
 * that the text would then obey.
 *
 * `x`/`y` come from the CALLER, unlike every other write in this file. A typed
 * string grows the way the paragraph is set, so `retypeText` anchors on the
 * ALIGNMENT; a drag has a corner standing still under the other hand, and
 * `resizeFrom` has already worked out where that puts the rect. Re-deriving it
 * from the alignment here would slide the layer out from under the finger.
 *
 * Point text is REFUSED rather than quietly scaled: it has no author width, so
 * there is nothing here to reflow, and a caller that has not noticed the
 * distinction should find out rather than get a silent type-size change.
 *
 * @param {object} project @param {number} id
 * @param {{x?:number,y?:number,w:number}} rect  document coordinates
 * @param {string} [coalesceKey]  one key for a whole drag -> one undo step
 * @returns {object} the layer
 */
export function resizeTextBox(project, id, rect, coalesceKey) {
  const layer = requireLayer(project, id);
  if (layer.kind !== 'text' || !layer.text)
    throw new Error(`Layer "${layer.name}" is not a text layer.`);
  if (!wrapsInBox(layer.text))
    throw new Error(
      `Layer "${layer.name}" is point text: it has no box to resize, because its ` +
      'bounds are the glyphs\' own. Scale it instead.',
    );

  const boxWidth = Math.max(1, rect.w);
  const size = fittedSize({ ...layer.text, boxWidth });
  if (!size) throw new Error(NO_MEASURER);

  // ONE command, exactly as retypeText is: the author's width and the bounds it
  // implies can never be undone apart.
  setLayer(project, id, {
    text: { boxWidth },
    x: Math.round(rect.x ?? layer.x),
    y: Math.round(rect.y ?? layer.y),
    w: Math.max(1, Math.round(size.width)),
    h: Math.max(1, Math.round(size.height)),
  }, coalesceKey);
  return layer;
}

/**
 * Change a text layer's content or style and move its box to match.
 *
 * The box is not reset to the natural size — that would throw away a resize the
 * user made by hand. It is rescaled by the factor the CURRENT box already
 * applies to the CURRENT string, so a box dragged to three times natural size
 * stays at three times natural size as the string grows. Deriving that factor
 * from the old string each time keeps it stateless; nothing has to be stored on
 * the layer and nothing can go stale.
 *
 * That factor is ONE number, so the box it produces always has the natural
 * aspect ratio: typing can grow or shrink the box, and can never re-shape the
 * glyphs. On the first edit of a PSD layer the factor is 1 rather than
 * "Photoshop's box over our measurement" — see `glyphScaleOf`, and the note at
 * the top of this file for why that ratio is not a number at all.
 *
 * Everything goes through `setLayer` in ONE command, so the string and the box
 * are a single undo step and can never be undone apart. Pass a
 * `nextGestureKey('type')` for a typing burst and the frames coalesce.
 *
 * @param {object} project @param {number} id
 * @param {object} changes  any subset of the text fields
 * @param {string} [coalesceKey]
 * @returns {object} the layer
 */
export function retypeText(project, id, changes = {}, coalesceKey) {
  const layer = requireLayer(project, id);
  if (layer.kind !== 'text' || !layer.text)
    throw new Error(`Layer "${layer.name}" is not a text layer.`);

  // A textarea normalises its own value to LF, but a programmatic caller or a
  // paste need not have. One convention reaches the model, always.
  if (changes.content !== undefined) changes = { ...changes, content: normaliseLineBreaks(changes.content) };

  // A size change on box text is a SCALE, so the box comes too. Before the
  // measurements below, because `after` has to be measured against the box the
  // layer is about to have or the height would be one wrap out of date.
  changes = withScaledBox(layer.text, changes);

  const before = fittedSize(layer.text);
  const after = fittedSize({ ...layer.text, ...changes });
  if (!before || !after) throw new Error(NO_MEASURER);

  const scale = glyphScaleOf(layer, before);
  const box = anchorBox(
    layer,
    Math.max(1, Math.round(after.width * scale)),
    Math.max(1, Math.round(after.height * scale)),
    changes.align ?? layer.text.align,
    // The box changes UNITS exactly once: on the first edit of a PSD layer.
    !layer.rerendered,
  );

  // ONE command: setLayer merges `text` field-by-field and assigns the rest,
  // and `rerendered` is added by setLayer's own rule because `text` is present.
  setLayer(project, id, { text: changes, x: box.x, y: box.y, w: box.w, h: box.h }, coalesceKey);
  return layer;
}
