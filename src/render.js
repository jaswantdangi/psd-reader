/**
 * Renders an editable project.
 *
 * Differs from `composite.js` in two ways: layers carry an arbitrary
 * position/size rather than their original bounds, and text layers may need
 * re-drawing because their content changed.
 *
 * Rendering at a reduced `scale` keeps dragging interactive on large documents
 * — the whole stack is recomposited on every change, so a 4000x4000 canvas at
 * full resolution would not keep up.
 */
import { createBuffer, blendInto } from './composite.js';
import { create2dSurface } from './surface.js';
import { resampleMask } from './mask.js';
import { isNeutralAdjust, lutFor, adjustCostOf } from './adjust/lut.js';
import { applyAdjustments } from './adjust/apply.js';
import { acquireScratch, DEFAULT_SCRATCH } from './adjust/scratch.js';

/**
 * Bilinear resample. Written by hand rather than going through Canvas
 * `drawImage` so the pixel path stays free of premultiplied-alpha rounding.
 */
export function resample(src, width, height) {
  if (src.width === width && src.height === height) return src;

  const out = createBuffer(width, height);
  const xRatio = src.width / width;
  const yRatio = src.height / height;

  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;

      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const o = (y * width + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = src.data[i00 + c] + (src.data[i10 + c] - src.data[i00 + c]) * fx;
        const bottom = src.data[i01 + c] + (src.data[i11 + c] - src.data[i01 + c]) * fx;
        out.data[o + c] = top + (bottom - top) * fy;
      }
    }
  }
  return out;
}

/** CSS font shorthand from a layer's text settings. */
const fontSpec = (text, scale = 1) =>
  `${text.italic ? 'italic ' : ''}${text.bold ? 'bold ' : ''}${Math.max(1, text.fontSize * scale)}px ${text.fontFamily}`;

/**
 * Every line separator a text layer can arrive with.
 *
 * Photoshop stores a line break as CR, and nothing else: a multi-line PSD text
 * layer reaches us as "AB\rCD". A browser textarea always hands its value back
 * with LF. A pasted string can carry CRLF. Splitting on \n alone — which is
 * what this did — turned every multi-line PSD layer into one line the instant
 * it switched to live rendering, which is precisely "editing destroys my line
 * breaks": the file's own raster showed the breaks, ours did not.
 *
 * CRLF is ONE break. The alternation order matters — \r\n has to be tried
 * before either half, or a Windows-authored string doubles its line count.
 */
const LINE_BREAK = /\r\n|\r|\n/;

/** Split a string into lines on any of CR, LF or CRLF. */
export const splitTextLines = (content) => String(content ?? '').split(LINE_BREAK);

/**
 * One convention for the model: LF.
 *
 * Applied at every door a string can come in through — a PSD layer, a created
 * layer, an edit, a reopened project file — so `layer.text.content` holds LF
 * and only LF. The alternative, tolerating all three separators everywhere,
 * means every consumer that ever counts lines (the render path, the sheet's
 * "N line(s)" readout, the layer name) has to know about CR forever, and each
 * one that forgets is the same bug again. `splitTextLines` above stays
 * tolerant regardless, because a project file saved before this normalisation
 * existed can still carry CR.
 */
export const normaliseLineBreaks = (content) =>
  String(content ?? '').split(LINE_BREAK).join('\n');

/**
 * Measure re-drawn text so the layer box can follow the string as it's typed.
 * Returns null outside a browser — Node has no text rasteriser.
 */
export function measureText(text) {
  const surface = create2dSurface(1, 1);
  if (!surface) return null;
  const ctx = surface.getContext('2d');
  ctx.font = fontSpec(text);
  const lines = splitTextLines(text.content);
  const lineHeight = Math.round(text.fontSize * 1.25);
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  return { width: Math.ceil(width) || 1, height: lines.length * lineHeight || 1, lineHeight, lines };
}

/**
 * Rasterise a text layer directly at its final pixel size.
 *
 * Text is vector, so drawing it once at its natural size and then resampling
 * the bitmap up is exactly how you get pixelated text. Scaling the canvas
 * transform instead re-shapes the glyphs at the target size, which stays sharp
 * at any scale.
 *
 * ONE scale, on both axes. sx and sy used to be independent, and that is not a
 * feature anyone asked for: it is what squashed every text layer read from a
 * PSD. Photoshop's bounds are the INK extent of the glyphs; `natural` below is
 * a LINE BOX — the widest advance by lines * round(fontSize * 1.25). Two
 * different quantities, so w/natural.width and h/natural.height differ by
 * ~1.4x on a layer nobody has touched, and treating their ratio as a scale is
 * a units error rather than a resize. The smaller ratio wins, so the glyphs
 * always FIT the rect: the larger one would overflow and the canvas edge would
 * clip it. Whatever rectangle this is handed, glyph shape survives.
 */
export function rasteriseTextAt(layer, width, height) {
  const natural = measureText(layer.text);
  if (!natural || !natural.width || !natural.height) return null;

  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const canvas = create2dSurface(w, h);
  if (!canvas) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const scale = Math.min(w / natural.width, h / natural.height);
  // Slack on the roomier axis goes where the alignment says, so a box wider
  // than the string cannot silently left-shift centred or right-aligned text.
  // Vertically it stays at the top, which is where textBaseline 'top' draws
  // from and where the box grows from as lines are added.
  const drawn = natural.width * scale;
  const offsetX = layer.text.align === 'center' ? (w - drawn) / 2
    : layer.text.align === 'right' ? w - drawn : 0;
  ctx.setTransform(scale, 0, 0, scale, offsetX, 0);
  ctx.font = fontSpec(layer.text, 1);
  ctx.fillStyle = layer.text.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = layer.text.align;

  const originX = layer.text.align === 'center' ? natural.width / 2
    : layer.text.align === 'right' ? natural.width : 0;
  natural.lines.forEach((line, i) => ctx.fillText(line, originX, i * natural.lineHeight));

  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** Cached by target size — a resize drag re-rasterises, a static frame does not. */
function textPixelsAt(layer, width, height) {
  const key = `${width}x${height}|${layer.text.fontSize}|${layer.text.fontFamily}|${layer.text.color}` +
    `|${layer.text.align}|${layer.text.bold}|${layer.text.italic}|${layer.text.content}`;
  if (layer.renderedKey !== key) {
    layer.rendered = rasteriseTextAt(layer, width, height);
    layer.renderedKey = key;
  }
  return layer.rendered;
}

/**
 * Per-frame cost counters.
 *
 * Phase 1B and Phase 2 both established that an approximation or a cost the
 * user cannot see is a bug. These are the Phase 3 instance: the debug readout
 * shows `lut: N / hsl: M`, the two terms separately, because they differ by an
 * estimated order of magnitude per layer and a single total would hide which
 * one a slow frame is made of.
 */
export const createRenderStats = () => ({ layers: 0, lut: 0, hsl: 0, overlay: 0 });

/**
 * Draw one layer into `dest`, exactly as renderProject does.
 *
 * Extracted from renderProject's loop so sandwich.js can re-blend a single live
 * layer per drag frame. The alternative -- copying the text-versus-resample
 * branch into a second file -- is precisely how text ends up going through
 * resample(), which is the one thing this renderer must never do.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} dest
 * @param {object} layer
 * @param {number} [scale]  1 renders at document resolution.
 * @param {{pixels?: {width:number,height:number,data:Uint8ClampedArray}|null,
 *          onMissing?: (layer: object, reason: 'text'|'raster') => void}} [options]
 *   `pixels` REPLACES `layer.pixels` for raster layers whenever the key is
 *   PRESENT -- including when its value is null. Read with `in`, never with
 *   `||`: full-resolution export streams the real pixels this way, and under a
 *   proxy load `layer.pixels` is a 1024-edge thumbnail. Falling back to it at
 *   scale 1 would draw a correctly-sized, blurred layer, which is the one
 *   failure shape that looks like success.
 *   `onMissing` fires instead of the silent return when a layer yields no
 *   pixels, so export can make a vanished text layer fatal while leaving a
 *   pixel-less raster the same silent skip the preview gives it.
 *   `scratch` is the destination buffer the adjustment pass writes into --
 *   defaults to the shared preview one. Export passes its own, so a
 *   full-resolution buffer is not left alive by the editor afterwards.
 *   `stats` is a createRenderStats() object; when present, the counters are
 *   incremented for the passes THIS call actually ran.
 */
export function drawLayerInto(dest, layer, scale = 1, options = {}) {
  if (!layer.visible || layer.opacity <= 0) return;

  const rect = {
    left: Math.round(layer.x * scale),
    top: Math.round(layer.y * scale),
    width: Math.max(1, Math.round(layer.w * scale)),
    height: Math.max(1, Math.round(layer.h * scale)),
  };
  if (rect.left >= dest.width || rect.top >= dest.height) return;
  if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0) return;

  // A layer mask is a per-layer alpha multiplier and nothing else -- blendInto
  // multiplies `as` by it. It lives on exactly the same grid as `pixels`, so it
  // resamples to the same target from the same source dimensions and cannot
  // drift out of alignment under any transform at any scale.
  //
  // `disabled` is honoured: Photoshop saves switched-off masks, and applying
  // one is as wrong as ignoring an enabled one.
  if (layer.mask && !layer.mask.disabled)
    rect.mask = resampleMask(layer.mask, rect.width, rect.height);

  let pixels = null;
  let reason = 'raster';
  if (layer.kind === 'text' && layer.rerendered) {
    // Draw the glyphs at their final size. Rasterising once and resampling the
    // bitmap is what made scaled text look pixelated.
    reason = 'text';
    pixels = textPixelsAt(layer, rect.width, rect.height);
  } else {
    // Raster layers really are bitmaps — resampling is all there is.
    const source = 'pixels' in options ? options.pixels : layer.pixels;
    if (source && source.width && source.height) pixels = resample(source, rect.width, rect.height);
  }
  if (!pixels) {
    if (options.onMissing) options.onMissing(layer, reason);
    return;
  }

  if (options.stats) options.stats.layers++;

  // Adjustments are a property of THIS layer, evaluated on its own pixels,
  // after resampling and before blending. They never see the backdrop, never
  // see a neighbour, and never produce a new entry in the layer stack -- which
  // is what lets the one-layer-at-a-time export walk serve them with no second
  // implementation, and what keeps every operation tile-independent.
  //
  // AFTER resample, not before. Pointwise operations do not commute with
  // bilinear interpolation, so the order is a decision: the GPU forces it (a
  // fragment shader samples uSource and only THEN has a value to adjust), it
  // makes the pass cost proportional to the DESTINATION rect, and on the
  // default preview path the two orders coincide anyway because resample()
  // identity-returns and there is no interpolation to commute with.
  if (layer.adjust && !isNeutralAdjust(layer.adjust)) {
    // NEVER IN PLACE. resample() above returns its INPUT OBJECT when the
    // dimensions already match -- the default preview path -- and
    // textPixelsAt() returns layer.rendered itself. Adjusting in place would
    // overwrite the layer's original pixels permanently and compound on every
    // frame of a drag. applyAdjustments throws if this ever aliases; the
    // scratch is what stops it having to.
    const out = acquireScratch(options.scratch || DEFAULT_SCRATCH, rect.width, rect.height);
    applyAdjustments(pixels, layer.adjust, out, lutFor(layer));
    pixels = out;

    if (options.stats) {
      const cost = adjustCostOf(layer.adjust);
      if (cost.lut) options.stats.lut++;
      if (cost.hsl) options.stats.hsl++;
      if (cost.overlay) options.stats.overlay++;
    }
  }

  blendInto(dest, pixels.data, rect, layer.opacity, layer.blendMode);
}

/**
 * @param {object} project
 * @param {{scale?: number, stats?: object|null, scratch?: object|null}} [options]
 *   `scale` 1 renders at document resolution; lower values are for interactive preview.
 *   `stats` counts the adjustment passes this frame actually ran.
 *   `scratch` overrides the shared adjustment destination buffer.
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderProject(project, options = {}) {
  const { scale = 1, stats = null, scratch = null } = options;
  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));
  const dest = createBuffer(width, height);

  // bottom to top. `pixels` is deliberately ABSENT from the options object --
  // drawLayerInto reads it with `in`, so passing it as undefined would replace
  // every layer's pixels with nothing.
  for (const layer of project.layers) drawLayerInto(dest, layer, scale, { stats, scratch });

  return dest;
}
