/**
 * Created and retyped text layers.
 *
 * The model already carries `layer.text` and `setLayer` already edits it. Two
 * things were missing, and both are geometry rather than pixels:
 *
 *   1. **Creating a text layer from nothing.** A layer needs bounds, and a
 *      string's bounds are whatever the platform's text engine says they are.
 *   2. **Bounds that follow the string.** Typing a character makes the text
 *      wider; if the box does not follow, the glyphs are drawn squashed into
 *      the old box, because `rasteriseTextAt` scales the transform to fill
 *      whatever rectangle it is handed.
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
import { measureText } from '../render.js';
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
 * Build the `layer.text` object, with the same fields and defaults `toLayer()`
 * gives a text layer read from a PSD.
 *
 * `originalContent` is `''` rather than the new string: it means "what
 * Photoshop had", and Photoshop never had this layer. Seeding it with the
 * user's own text would claim the file contained something it did not.
 */
const newText = (options) => ({
  content: String(options.content ?? ''),
  fontFamily: options.fontFamily ?? FONT_STACKS[0],
  fontSize: Math.max(1, Math.round(options.fontSize ?? 24)),
  color: options.color ?? '#000000',
  bold: options.bold === true,
  italic: options.italic === true,
  align: options.align ?? 'left',
  originalContent: '',
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
    const natural = naturalTextSize(text);
    if (!natural) throw new Error(NO_MEASURER);
    w = w ?? natural.width;
    h = h ?? natural.height;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));

  const centred = centreIn(project, w, h);
  const layer = blankLayer(project, {
    name: options.name ?? (text.content.split('\n')[0] || 'Text'),
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
 * Change a text layer's content or style and move its box to match.
 *
 * The box is not reset to the natural size — that would throw away a resize the
 * user made by hand. It is rescaled by the factor the CURRENT box already
 * applies to the CURRENT string, so a box dragged to three times natural size
 * stays at three times natural size as the string grows. Deriving that factor
 * from the old string each time keeps it stateless; nothing has to be stored on
 * the layer and nothing can go stale.
 *
 * The anchor is the alignment: left-aligned text grows rightwards, centred text
 * grows about its centre, right-aligned text keeps its right edge. Vertically
 * the top is fixed, because `rasteriseTextAt` draws from `textBaseline: 'top'`
 * downwards.
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

  const before = naturalTextSize(layer.text);
  const after = naturalTextSize({ ...layer.text, ...changes });
  if (!before || !after) throw new Error(NO_MEASURER);

  const scaleX = layer.w / before.width;
  const scaleY = layer.h / before.height;
  const w = Math.max(1, Math.round(after.width * scaleX));
  const h = Math.max(1, Math.round(after.height * scaleY));

  const align = changes.align ?? layer.text.align;
  const x = align === 'center' ? layer.x + Math.round((layer.w - w) / 2)
    : align === 'right' ? layer.x + layer.w - w
    : layer.x;

  // ONE command: setLayer merges `text` field-by-field and assigns the rest,
  // and `rerendered` is added by setLayer's own rule because `text` is present.
  setLayer(project, id, { text: changes, x, w, h }, coalesceKey);
  return layer;
}
