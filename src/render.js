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
import { createBuffer, blendInto, parseBlendIf } from './composite.js';
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

/** A TextMetrics field, or null where the platform does not report it. */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Whether this layer's lines are the author's alone, or Photoshop's arithmetic.
 *
 * PSD text is one of two SHAPES and ag-psd reports which:
 *
 *   - **point** — an insertion point and a string. It breaks at the break
 *     characters the author typed and NOWHERE else. `text.src.psd` is one.
 *   - **box** (paragraph) — a rectangle the author drew, with the string poured
 *     into it. Photoshop WRAPS it to that rectangle's width, so most of the
 *     line breaks a reader sees were computed at layout time and appear
 *     nowhere in the stored string. `text-box.src.psd` is one, and its
 *     `boxBounds` is [0, 0, 128.99352, 49].
 *
 * Nothing here used to wrap, so a paragraph layer lost every computed break the
 * moment we started drawing it ourselves: a three-line headline collapsed onto
 * one line. That is a DIFFERENT bug from the CR/LF one above, with the same
 * user-visible symptom — "my line breaks are gone" — which is why fixing the
 * separators did not fix it.
 *
 * A width is required as well as a shape. `shapeType: 'box'` with no readable
 * `boxBounds` is a paragraph layer whose box we cannot measure, and wrapping to
 * a made-up width would produce confident, plausible, wrong line breaks — worse
 * than not wrapping, because nothing on screen says which it is.
 */
export const wrapsInBox = (text) =>
  text?.shapeType === 'box' && finite(text.boxWidth) !== null && text.boxWidth > 0;

/**
 * The width one line occupies, from the same metrics `measureText` composes its
 * box out of.
 *
 * The INK extent, not the advance, because the box the wrapped block has to fit
 * inside is an ink extent too — see the long note on measureText. Wrapping on
 * the advance and then reporting an ink width would let a line that "fits" come
 * out fractionally narrower than the box, which is harmless, or a line that
 * fits on advances overflow on ink, which is not. One quantity, both places.
 *
 * Falls back to the advance where a platform reports no glyph bounds, exactly
 * as measureText does.
 */
const lineWidth = (ctx, line) => {
  const m = ctx.measureText(line);
  const right = finite(m.actualBoundingBoxRight);
  if (right === null) return finite(m.width) ?? 0;
  return Math.max(0, finite(m.actualBoundingBoxLeft) ?? 0) + right;
};

/**
 * Greedy word wrap of ONE paragraph, against a measured width.
 *
 * Greedy — fill a line until the next word does not fit — is Photoshop's
 * single-line composer, which is what these fixtures use
 * (`paragraphStyle.everyLineComposer: false`). The every-line composer
 * rebalances a whole paragraph and would need a different algorithm; a file
 * that asks for it is not detected here and is noted in docs/BACKLOG.md.
 *
 * Breaks at WHITESPACE only. A word wider than the box overhangs its own line
 * rather than being split mid-word or dropped: we do not hyphenate, so a
 * mid-word break would be one Photoshop never makes, and losing a word is never
 * the better failure. The loop consumes exactly one token per iteration
 * whatever the widths, so an unfittable word cannot spin it.
 *
 * COST: one `ctx.measureText` per token. Kerning crosses the space between two
 * words, so a cached per-word width plus a space width is an approximation and
 * this is not; a 60-word paragraph is ~120 measurements per `measureText()`
 * call, which happens once per keystroke and once per cache miss in
 * `textPixelsAt` — not once per frame.
 */
function wrapParagraph(ctx, paragraph, maxWidth) {
  // An empty paragraph is still a line: it advances the baseline, and dropping
  // it would silently close up a deliberate blank line.
  if (!paragraph) return [''];

  const tokens = paragraph.split(/(\s+)/).filter((t) => t !== '');
  const lines = [];
  let line = '';

  for (const token of tokens) {
    const candidate = line + token;
    // Never break before the FIRST word on a line — that is the case where
    // the word alone is wider than the box, and breaking there either loops
    // forever or emits an empty line before every long word.
    if (line !== '' && !/^\s+$/.test(token) && lineWidth(ctx, candidate) > maxWidth) {
      lines.push(line.replace(/\s+$/, ''));
      line = token;
      continue;
    }
    line = candidate;
  }
  lines.push(line.replace(/\s+$/, ''));
  return lines;
}

/**
 * The lines this string actually draws as: the author's breaks, then the box's.
 *
 * Order matters and is not interchangeable. Photoshop composes each PARAGRAPH
 * independently, so an explicit break always starts a new line even mid-box;
 * wrapping first and splitting after would let a paragraph's tail share a line
 * with the next paragraph's head.
 */
function layoutLines(ctx, text) {
  const paragraphs = splitTextLines(text.content);
  if (!wrapsInBox(text)) return paragraphs;
  return paragraphs.flatMap((p) => wrapParagraph(ctx, p, text.boxWidth));
}

/**
 * Line advance where `fontBoundingBox*` is unavailable, as a multiple of the
 * font size.
 *
 * 1.2 is not invented: it is CSS `normal` for Latin faces, and it is
 * Photoshop's own auto-leading — fixtures/text.src.psd carries
 * `paragraphStyle.autoLeading: 1.2`. The 1.25 it replaces was a convention
 * with no such source. This is still only a fallback: every current browser
 * reports the real font box, and the real font box is what should be used.
 *
 * ASCENT_SHARE splits that fallback box either side of the baseline. Under it
 * a block measures exactly `lines * 1.2em` — the OLD line-box behaviour —
 * which is the right degradation: a platform that reports no glyph bounds
 * cannot be given an ink extent, only the box the glyphs are drawn in.
 */
const FALLBACK_LINE_HEIGHT = 1.2;
const FALLBACK_ASCENT_SHARE = 0.8;

/**
 * Measure re-drawn text so the layer box can follow the string as it's typed.
 * Returns null outside a browser — Node has no text rasteriser.
 *
 * ## What this returns is the INK, not a line box
 *
 * It used to return the widest advance by `lines * round(fontSize * 1.25)`.
 * That 1.25 was an invented convention and the result was a LINE BOX, while
 * Photoshop's layer bounds are the INK EXTENT of the glyphs. Measured on
 * fixtures/text.src.psd, "TEST" at fontSize 30: Photoshop's box is 60 x 21,
 * ours reported 77 x 38. The two HEIGHTS are close in reality — 21 is about
 * Arial's cap height at 30px — and were 1.8x apart only because they were
 * different quantities. So the first edit, which re-fits the box to our
 * measurement, made the text visibly jump in size: "size changes from the
 * exact". `actualBoundingBox{Left,Right,Ascent,Descent}` are the true inked
 * bounds and are directly comparable to what Photoshop stored, so that jump
 * becomes continuous.
 *
 * The WIDTH barely moves for this string — a left-aligned run's ink right edge
 * is its advance less one side bearing — and it does not become 60 either. It
 * cannot: `toLayer` substitutes the nearest stack it can draw for the file's
 * typeface — a PSD names a font and never ships one — so we are measuring
 * different glyphs. That residue is a font problem, not a metrics one, and the
 * substitution is now disclosed (`text.sourceFont`) rather than fixed here.
 *
 * ## Ink is not spacing
 *
 * The ink extent says nothing about the distance between baselines — two lines
 * of capitals would collide 0.7em apart. `fontBoundingBoxAscent/Descent` is
 * the font's own line advance and is what separates them, with the documented
 * FALLBACK_LINE_HEIGHT above where a platform does not report it.
 *
 * ## Where the box starts
 *
 * `left` is clamped at 0, so a glyph whose ink starts to the RIGHT of the pen
 * — nearly all Latin text — leaves the box starting at the pen, which is the
 * convention Photoshop's own bounds use (in the fixture, `bounds.left` and the
 * text transform's x are both 36). A glyph that inks to the LEFT of the pen,
 * an italic f or a swash J, grows the box leftwards instead of being clipped.
 *
 * @returns {{width:number,height:number,lineHeight:number,lines:string[],
 *            ascent:number,offsetX:number} | null}
 *   `ascent` is the first baseline's distance below the top of the box and
 *   `offsetX` the pen's distance right of its left edge — the two numbers
 *   `rasteriseTextAt` needs to place the glyphs back inside it.
 */
export function measureText(text) {
  const surface = create2dSurface(1, 1);
  if (!surface) return null;
  const ctx = surface.getContext('2d');
  ctx.font = fontSpec(text);

  const lines = layoutLines(ctx, text);
  const metrics = lines.map((line) => ctx.measureText(line));

  // Font-box metrics are a property of the FONT, so any line reports them.
  const fontAscent = finite(metrics[0].fontBoundingBoxAscent);
  const fontDescent = finite(metrics[0].fontBoundingBoxDescent);
  const lineHeight = Math.max(1, Math.round(fontAscent !== null && fontDescent !== null
    ? fontAscent + fontDescent
    : text.fontSize * FALLBACK_LINE_HEIGHT));

  let left = 0, right = 0, advance = 0, ascent = 0, descent = 0;
  metrics.forEach((m, i) => {
    advance = Math.max(advance, finite(m.width) ?? 0);

    const inkRight = finite(m.actualBoundingBoxRight);
    // No glyph bounds on this platform: the advance is the only width there is.
    if (inkRight === null) right = Math.max(right, finite(m.width) ?? 0);
    else {
      right = Math.max(right, inkRight);
      left = Math.max(left, finite(m.actualBoundingBoxLeft) ?? 0);
    }

    // A blank line inks nothing, so it contributes no ascent or descent — only
    // the advance to the next baseline.
    if (lines[i] === '') return;
    const a = finite(m.actualBoundingBoxAscent) ?? fontAscent
      ?? text.fontSize * FALLBACK_LINE_HEIGHT * FALLBACK_ASCENT_SHARE;
    const d = finite(m.actualBoundingBoxDescent) ?? fontDescent
      ?? text.fontSize * FALLBACK_LINE_HEIGHT * (1 - FALLBACK_ASCENT_SHARE);
    if (i === 0) ascent = a;
    if (i === lines.length - 1) descent = d;
  });

  return {
    // A string that inks nothing — empty, or nothing but spaces — still has to
    // have a box the caret can live in, so it falls back to the advance and
    // then to one line.
    width: Math.ceil(left + right) || Math.ceil(advance) || 1,
    height: Math.ceil(ascent + (lines.length - 1) * lineHeight + descent) || lineHeight,
    lineHeight,
    lines,
    ascent,
    offsetX: left,
  };
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
 * PSD. `natural` used to be a LINE BOX while Photoshop's bounds are the INK
 * extent of the glyphs, so w/natural.width and h/natural.height differed by
 * ~1.4x on a layer nobody had touched, and treating their ratio as a scale was
 * a units error rather than a resize. measureText now returns the ink extent,
 * so the two rects are the same quantity — but the smaller ratio still wins,
 * because a box the user dragged non-uniformly is still a box the glyphs have
 * to FIT: the larger one would overflow and the canvas edge would clip it.
 * Whatever rectangle this is handed, glyph shape survives.
 *
 * The draw is anchored to the BASELINE, because that is what the ink metrics
 * are measured from: the first baseline sits `natural.ascent` below the top of
 * the box, and each later one one `lineHeight` below that. textBaseline 'top'
 * with an ink-extent box would sit the glyphs a whole ascent too low.
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
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = layer.text.align;

  // Left-aligned, the pen sits `offsetX` right of the box's left edge, which is
  // 0 for anything that inks to the right of its own origin. Centred and
  // right-aligned the canvas places each line itself, against the block's
  // measured width; the side bearings it does not know about are sub-pixel.
  const originX = layer.text.align === 'center' ? natural.width / 2
    : layer.text.align === 'right' ? natural.width : natural.offsetX;
  natural.lines.forEach((line, i) =>
    ctx.fillText(line, originX, natural.ascent + i * natural.lineHeight));

  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** Cached by target size — a resize drag re-rasterises, a static frame does not. */
function textPixelsAt(layer, width, height) {
  // shapeType and boxWidth are IN the key: they decide where the lines break,
  // so a layer whose box changed and whose string did not would otherwise keep
  // drawing the previous wrap until something else in the key happened to move.
  const key = `${width}x${height}|${layer.text.fontSize}|${layer.text.fontFamily}|${layer.text.color}` +
    `|${layer.text.align}|${layer.text.bold}|${layer.text.italic}` +
    `|${layer.text.shapeType}|${layer.text.boxWidth}|${layer.text.content}`;
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
  const prepared = prepareLayer(dest, layer, scale, options);
  if (!prepared) return;
  // Blend If: ONE implementation, composite.js's. It is another factor in the
  // same `as` product as opacity and the mask, and `dest` is the "underlying
  // layer" it reads -- see the blend-if note in composite.js.
  blendInto(dest, prepared.pixels.data, prepared.rect, layer.opacity, layer.blendMode,
    null, parseBlendIf(layer));
}

/**
 * Everything drawLayerInto does EXCEPT the final blend: the destination rect,
 * the resampled mask, the pixels (resampled, or re-rasterised for live text),
 * and the adjustment pass.
 *
 * Split out for exactly one caller -- `drawClipRunInto` below, which has to
 * blend the same pixels into a scratch group buffer rather than into `dest`,
 * and has to read the base layer's alpha AFTER the adjustment pass rather than
 * before it. Writing that second path out again is how this project ended up
 * needing a pinning assertion between `planSpill` and the export walk; one
 * body, two blend targets, no second implementation to drift.
 *
 * `dest` is consulted only for its dimensions, to reject a rect that lands
 * entirely off-canvas.
 *
 * WHAT IT RETURNS IS BORROWED. `pixels` may be `layer.pixels` itself (resample
 * identity-returns on the common path), `layer.rendered`, or a view into the
 * shared adjustment scratch -- which the NEXT prepareLayer call overwrites.
 * Blend it before preparing anything else, and never write into it.
 *
 * @returns {{pixels:{width:number,height:number,data:Uint8ClampedArray},
 *            rect:{left:number,top:number,width:number,height:number,mask?:Uint8Array}} | null}
 */
function prepareLayer(dest, layer, scale, options) {
  const rect = {
    left: Math.round(layer.x * scale),
    top: Math.round(layer.y * scale),
    width: Math.max(1, Math.round(layer.w * scale)),
    height: Math.max(1, Math.round(layer.h * scale)),
  };
  if (rect.left >= dest.width || rect.top >= dest.height) return null;
  if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0) return null;

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
    return null;
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

  return { pixels, rect };
}

// ---------------------------------------------------------------- clipping

/**
 * Alpha coverage of a rendered layer, over the whole canvas.
 *
 * A LINE-FOR-LINE PORT of `alphaMap` in src/composite.js, which is the oracle
 * the 21-fixture accuracy table is measured against. Every detail of it is
 * load-bearing and none of it is idiomatic:
 *
 *   - `Uint8Array`, so a fractional coverage TRUNCATES. A Uint8ClampedArray
 *     would round instead, and the two renderers would disagree by 1 LSB on
 *     every partially covered pixel of every clipped layer.
 *   - `pixels[si + 3] * opacity` with NO /255 -- the plane is already 0..255.
 *   - the mask divides by 255 because it is a separate 0..255 plane.
 *
 * It is a port and not a call because composite.js does not export it, and this
 * module is not that module's owner. test/clip.mjs pins the two against each
 * other byte for byte on random input, exactly as test/layers.mjs pins
 * projectMask against the implementation it was moved out of.
 *
 * The ONE deliberate difference: the map is passed in, already zeroed, instead
 * of being allocated here. A full-canvas plane per clip run is precisely the
 * per-layer allocation the scratch below exists to stop.
 *
 * @param {Uint8Array} map  w*h, zeroed. Only the rect is written.
 */
export function clipAlphaMap(map, width, height, rect, pixels, mask, opacity) {
  const x1 = Math.min(width, rect.left + rect.width);
  const y1 = Math.min(height, rect.top + rect.height);
  for (let y = Math.max(0, rect.top); y < y1; y++) {
    for (let x = Math.max(0, rect.left); x < x1; x++) {
      const si = ((y - rect.top) * rect.width + (x - rect.left)) * 4;
      let a = pixels[si + 3] * opacity;
      if (mask) a *= mask[(y - rect.top) * rect.width + (x - rect.left)] / 255;
      map[y * width + x] = a;
    }
  }
  return map;
}

/**
 * The two full-canvas buffers one clip run needs, reused across every run of
 * every frame.
 *
 * Same rule as src/adjust/scratch.js and for the same reason: a buffer per
 * clipped layer is O(layers) allocations of the WHOLE CANVAS. One pair, grown
 * monotonically, is O(1). It is a separate store from the adjustment scratch
 * for two reasons that are not stylistic -- the alpha plane must be a
 * `Uint8Array` and `acquireScratch` hands back `Uint8ClampedArray`, and these
 * two must be ZEROED on acquire where the adjustment scratch is fully
 * overwritten by its pass and must not be.
 *
 * COST, at the sizes that actually occur: `w * h * 5` bytes. 5 MB for a
 * 1024x1024 proxy, 87 MB for a 4961x3508 poster at scale 1. EXACTLY ONE PAIR
 * IS EVER LIVE: clip runs are consecutive spans of a flat list, so they are
 * sequential and can never nest, and `renderProject` finishes one before it
 * starts the next.
 *
 * ALLOCATED LAZILY. A document with no clipped layer never calls this, so it
 * pays nothing at all -- which is every one of the 21 fixtures.
 */
export const createClipScratch = () => ({ group: null, alpha: null, pixels: 0, allocations: 0 });

/** @returns {{group:{width:number,height:number,data:Uint8ClampedArray}, alpha:Uint8Array}} */
export function acquireClipScratch(store, width, height) {
  const need = width * height;
  if (!store.group || store.pixels < need) {
    store.group = new Uint8ClampedArray(need * 4);
    store.alpha = new Uint8Array(need);
    store.pixels = need;
    store.allocations++;
  }
  // Zeroed, not merely rect-sized: `createBuffer` in the compositor hands the
  // group a transparent canvas, and a reused buffer still holding the previous
  // run would blend that run's pixels into this one.
  const group = { width, height, data: store.group.subarray(0, need * 4) };
  group.data.fill(0);
  const alpha = store.alpha.subarray(0, need);
  alpha.fill(0);
  return { group, alpha };
}

/** Drop both buffers. Export calls this before the encode peak, as 1C does. */
export function releaseClipScratch(store) {
  store.group = null;
  store.alpha = null;
  store.pixels = 0;
}

/** The preview path's clip scratch. Module-level for the same reason DEFAULT_SCRATCH is. */
export const DEFAULT_CLIP_SCRATCH = createClipScratch();

/**
 * How far the clip run starting at `index` extends: the index one PAST its last
 * member.
 *
 * A clipping mask is POSITIONAL, not a group. A clipped layer clips to whatever
 * lies directly below it, so a run is simply a base plus the consecutive
 * `clipping` layers above it, read off the current order every time. There is
 * nothing stored, nothing to keep in step with a reorder, and no run to lock:
 * move a layer and it clips to its new neighbour, which is what Photoshop does.
 */
export function clipRunEnd(layers, index) {
  let end = index + 1;
  while (end < layers.length && layers[end].clipping === true) end++;
  return end;
}

/**
 * The index of the base of the run CONTAINING `index` -- itself, when it is not
 * a clipped layer.
 *
 * A run whose members reach the bottom of the stack has no base under it. Its
 * lowest member becomes its own base and draws unclipped, which is both what
 * Photoshop does and what `renderList` in composite.js has always done.
 */
export function clipRunStart(layers, index) {
  let start = index;
  while (start > 0 && layers[start].clipping === true) start--;
  return start;
}

/**
 * Draw the layer at `index` together with every layer clipped to it.
 *
 * PORTED FROM `renderList` in src/composite.js, step for step, because a
 * second differently-written clipping implementation is the failure this
 * project keeps hitting. The order of the four steps is the whole algorithm:
 *
 *   1. blend the base into a full-canvas group buffer at opacity 1, mode
 *      `normal` -- its own opacity and blend mode belong to the WHOLE run and
 *      are spent in step 4;
 *   2. take the base's alpha, after its mask and after its adjustments;
 *   3. blend each clipped layer into the group with that as `clipAlpha`, which
 *      `blendInto` has always accepted;
 *   4. blend the group into `dest` with the base's opacity and blend mode.
 *
 * A HIDDEN BASE TAKES THE WHOLE RUN WITH IT. In composite.js the clipped block
 * sits inside `if (layer.hidden !== true)`, so nothing in the run is drawn --
 * and that is right, not incidental: the clipped layers are visible only
 * through the base's alpha, and a hidden base has none.
 *
 * `options.pixels` is deliberately NOT honoured here. It names ONE layer's
 * pixels and a run is several, so there is no reading of it that is not a
 * guess; the streaming export path calls `drawLayerInto` per layer instead.
 *
 * @returns {number} the index to continue the walk from -- one past the run.
 */
export function drawClipRunInto(dest, layers, index, scale = 1, options = {}) {
  const base = layers[index];
  const end = clipRunEnd(layers, index);

  // No clipped layers above: the ordinary single-layer path, byte for byte.
  if (end === index + 1) {
    drawLayerInto(dest, base, scale, options);
    return end;
  }

  if (!base.visible || base.opacity <= 0) return end;
  const prepared = prepareLayer(dest, base, scale, options);
  if (!prepared) return end;

  const { group, alpha } = acquireClipScratch(
    options.clipScratch || DEFAULT_CLIP_SCRATCH, dest.width, dest.height);

  // NO blend-if here. The base's own is spent in step 4 below, with its
  // opacity and blend mode, against the canvas it actually blends onto -- the
  // group buffer is empty at this point and would be no backdrop at all.
  blendInto(group, prepared.pixels.data, prepared.rect, 1, 'normal');
  // BEFORE any further prepareLayer call. `prepared.pixels` can be a view into
  // the shared adjustment scratch, which the next clipped layer overwrites.
  clipAlphaMap(alpha, dest.width, dest.height, prepared.rect,
    prepared.pixels.data, prepared.rect.mask, 1);

  for (let i = index + 1; i < end; i++) {
    const layer = layers[i];
    if (!layer.visible || layer.opacity <= 0) continue;
    const clipped = prepareLayer(group, layer, scale, options);
    if (!clipped) continue;
    // "Underlying" for a clipped layer is `group`, the buffer it is blending
    // onto -- base plus whatever clipped layers already went down on it.
    blendInto(group, clipped.pixels.data, clipped.rect, layer.opacity, layer.blendMode,
      alpha, parseBlendIf(layer));
  }

  blendInto(dest, group.data, { left: 0, top: 0, width: dest.width, height: dest.height },
    base.opacity, base.blendMode, null, parseBlendIf(base));
  return end;
}

/**
 * @param {object} project
 * @param {{scale?: number, stats?: object|null, scratch?: object|null,
 *          clipScratch?: object|null}} [options]
 *   `scale` 1 renders at document resolution; lower values are for interactive preview.
 *   `stats` counts the adjustment passes this frame actually ran.
 *   `scratch` overrides the shared adjustment destination buffer.
 *   `clipScratch` overrides the shared clip-run group and alpha buffers.
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderProject(project, options = {}) {
  const { scale = 1, stats = null, scratch = null, clipScratch = null } = options;
  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));
  const dest = createBuffer(width, height);

  // bottom to top, one CLIP RUN at a time -- a run of one, which is every layer
  // in a document that uses no clipping mask, is the plain single-layer draw.
  // `pixels` is deliberately ABSENT from the options object -- drawLayerInto
  // reads it with `in`, so passing it as undefined would replace every layer's
  // pixels with nothing.
  for (let i = 0; i < project.layers.length; )
    i = drawClipRunInto(dest, project.layers, i, scale, { stats, scratch, clipScratch });

  return dest;
}
