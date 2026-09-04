/**
 * Layer compositor: stacks layers at their exact positions and order.
 *
 * A PSD also carries a pre-flattened composite (what Photoshop rendered on
 * save). That one is exact by definition. This is the other thing — building
 * the image from the layers ourselves, which is what an editor needs so the
 * canvas updates as layers change.
 *
 * Comparing the two is the accuracy test: `compareBuffers()`.
 *
 * NOT applied: adjustment layers, layer effects (fx), smart filters, and the
 * `dissolve` blend mode. Layers using those will differ from Photoshop's own
 * composite, and the difference is reported rather than hidden.
 */

import { projectMask, layerRect } from './mask.js';

/** ag-psd reports opacity 0..1. Layer order is bottom-to-top: children[0] is the bottom. */

// ---------------------------------------------------------------- blend modes

/** Separable modes operate per channel, on 0..255. */
const SEPARABLE = {
  'normal': (b, s) => s,
  'darken': (b, s) => (b < s ? b : s),
  'multiply': (b, s) => (b * s) / 255,
  'color burn': (b, s) => (b >= 255 ? 255 : s <= 0 ? 0 : 255 - Math.min(255, ((255 - b) * 255) / s)),
  'linear burn': (b, s) => (b + s < 255 ? 0 : b + s - 255),
  'lighten': (b, s) => (b > s ? b : s),
  'screen': (b, s) => 255 - ((255 - b) * (255 - s)) / 255,
  'color dodge': (b, s) => (b <= 0 ? 0 : s >= 255 ? 255 : Math.min(255, (b * 255) / (255 - s))),
  'linear dodge': (b, s) => (b + s > 255 ? 255 : b + s),
  'overlay': (b, s) => (b <= 127.5 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255),
  'hard light': (b, s) => (s <= 127.5 ? (2 * s * b) / 255 : 255 - (2 * (255 - s) * (255 - b)) / 255),
  'soft light': (b, s) => {
    const cb = b / 255;
    const cs = s / 255;
    const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
    return 255 * (cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (d - cb));
  },
  'vivid light': (b, s) =>
    s <= 127.5
      ? s <= 0 ? 0 : 255 - Math.min(255, ((255 - b) * 255) / (2 * s))
      : s >= 255 ? 255 : Math.min(255, (b * 255) / (2 * (255 - s))),
  'linear light': (b, s) => Math.max(0, Math.min(255, b + 2 * s - 255)),
  'pin light': (b, s) => (s <= 127.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 255)),
  'hard mix': (b, s) => (b + s >= 255 ? 255 : 0),
  'difference': (b, s) => Math.abs(b - s),
  'exclusion': (b, s) => b + s - (2 * b * s) / 255,
  'subtract': (b, s) => Math.max(0, b - s),
  'divide': (b, s) => (s <= 0 ? 255 : Math.min(255, (b * 255) / s)),
};

/** Non-separable modes need the whole pixel at once (W3C compositing spec). */
const NON_SEPARABLE = new Set(['hue', 'saturation', 'color', 'luminosity', 'darker color', 'lighter color']);

/**
 * Every blend mode this compositor actually implements.
 *
 * Derived from the tables above rather than hand-listed, so it cannot drift
 * from them. `edit.js` offers these in the UI, and a test asserts the two
 * agree — they had silently diverged by eight modes once already.
 */
export const SUPPORTED_BLEND_MODES = [...Object.keys(SEPARABLE), ...NON_SEPARABLE];

const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c) {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - n);
  if (x > 255) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (255 - l)) / (x - l);
  return c;
}

function setLum(c, l) {
  const d = l - lum(c[0], c[1], c[2]);
  c[0] += d; c[1] += d; c[2] += d;
  return clipColor(c);
}

const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c, s) {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [min, mid, max] = idx;
  if (c[max] > c[min]) {
    c[mid] = ((c[mid] - c[min]) * s) / (c[max] - c[min]);
    c[max] = s;
  } else {
    c[mid] = c[max] = 0;
  }
  c[min] = 0;
  return c;
}

const out = [0, 0, 0];

function blendNonSeparable(mode, br, bg, bb, sr, sg, sb) {
  switch (mode) {
    case 'darker color': return lum(sr, sg, sb) < lum(br, bg, bb) ? [sr, sg, sb] : [br, bg, bb];
    case 'lighter color': return lum(sr, sg, sb) > lum(br, bg, bb) ? [sr, sg, sb] : [br, bg, bb];
    case 'hue': out[0] = sr; out[1] = sg; out[2] = sb;
      return setLum(setSat(out, sat([br, bg, bb])), lum(br, bg, bb));
    case 'saturation': out[0] = br; out[1] = bg; out[2] = bb;
      return setLum(setSat(out, sat([sr, sg, sb])), lum(br, bg, bb));
    case 'color': out[0] = sr; out[1] = sg; out[2] = sb;
      return setLum(out, lum(br, bg, bb));
    case 'luminosity': out[0] = br; out[1] = bg; out[2] = bb;
      return setLum(out, lum(sr, sg, sb));
    default: return [sr, sg, sb];
  }
}

// ------------------------------------------------------------------ blend if

/**
 * Photoshop's "Blend If" -- the file calls it layer blending ranges.
 *
 * Two sliders per channel. "This Layer" reads the layer's OWN pixel, "Underlying
 * Layer" reads the composite it is being blended onto; each has a black stop and
 * a white stop, and pixels outside the stops are dropped. Every stop can be
 * SPLIT into two halves (alt-drag in the dialog), which replaces the hard cut
 * with a linear feather between the halves. The split is not a nicety -- it is
 * what the feature is used for, and dropping it turns a gradient into a step.
 *
 * ## It is an alpha multiplier, and nothing else
 *
 * That is the whole reason this needs no new machinery. `blendInto` already
 * computes `as` as a product -- source alpha x opacity x mask x clipAlpha --
 * and blend-if is one more factor in it. Multiplication commutes, so where it
 * enters the product does not matter; WHICH TWO PIXELS it reads does.
 *
 * ## Which two pixels: "this layer" and "underlying layer"
 *
 * ONE RULE, no special cases: blend-if is evaluated at the `blendInto` call
 * where the layer's own opacity and blend mode are spent. "This layer" is the
 * source handed to that call, "underlying layer" is the buffer it is being
 * blended ONTO. Everything else follows from that:
 *
 *   - a plain layer: its own pixels against the canvas so far.
 *   - a layer CLIPPED to a base: its own pixels against the GROUP buffer, i.e.
 *     the base plus whatever clipped layers already went down on it. Not the
 *     canvas. A clipped layer is blended into the group, so the group is the
 *     thing underlying it -- reading the canvas instead would be reading a
 *     backdrop it never touches.
 *   - the BASE of a clip run: the group buffer against the canvas, at step 4,
 *     because that is where the base's opacity and mode are spent. Its "this
 *     layer" is therefore the composited run, not the base's own pixels. The
 *     run is blended as a unit and blend-if belongs to the unit.
 *   - a group: the group's flattened buffer against the canvas.
 *
 * NO FIXTURE EXERCISES THE CLIPPED CASES -- `blend-if.src.psd` is two unclipped
 * layers -- so the three readings above are a stated choice, not a measured
 * one. They are the reading that needs no branch anywhere.
 *
 * ## Cost
 *
 * NO PER-LAYER BUFFER. The factor depends on the destination pixel, which
 * `blendInto` is already holding when it needs it, so it is computed inline in
 * the loop that was already running. Per layer this costs one small parsed
 * object (~200 bytes, `parseBlendIf` below), and null on the twenty of
 * twenty-one fixtures whose ranges are all default -- so documents that do not
 * use blend-if pay one `if` per layer and nothing per pixel.
 */

/**
 * The value a Gray range is compared against.
 *
 * Photoshop's own 8-bit RGB->grey weighting, as integers over 256. Same curve
 * as the `lum` the non-separable blend modes use (0.301/0.590/0.109 against
 * 0.30/0.59/0.11), but the weights sum to 256 EXACTLY, so a neutral grey comes
 * back as itself rather than as 127.99999999999999. A stop lands on an exact
 * integer, so a float that misses by 1e-14 is the difference between a pixel
 * being kept and being cut -- and `lum` misses.
 */
const blendIfGray = (r, g, b) => (r * 77 + g * 151 + b * 28) / 256;

/** A range is four bytes: black low, black high, white low, white high. */
const RANGE_IS_DEFAULT = (r) =>
  !r || r.length < 4 || (r[0] === 0 && r[1] === 0 && r[2] === 255 && r[3] === 255);

/**
 * One slider's contribution: 0 where the value is cut, 1 where it is kept, and
 * a ramp between the halves of a split stop.
 *
 * THE RAMP DIVIDES BY (b1 - b0 + 1), NOT (b1 - b0), and offsets the value by
 * half a step. That is not a fudge -- it was READ OFF the fixture. Averaging
 * Photoshop's own composite over every pixel of each underlying grey level
 * (blend-if.src.psd has ~1000 per level) gives an alpha curve that the naive
 * (v - b0) / (b1 - b0) misses by a consistent +0.7/255 near the black stop
 * while agreeing at the top, and that
 *
 *     f = (v - b0 + 0.5) / (b1 - b0 + 1)
 *
 * tracks to within 0.4/255 across the whole span. It is the ordinary
 * "N buckets, sample at the centre" quantisation: the stops are inclusive
 * integer bounds, so the ramp covers b1 - b0 + 1 values, not b1 - b0.
 * On the fixture the difference is 1.76% of pixels wrong versus 1.26%.
 *
 * AN UNSPLIT STOP IS A HARD CUT, and has to be its own branch rather than a
 * zero-width ramp: the bucket formula would put a value sitting exactly ON an
 * unsplit stop at half alpha, and the DEFAULT range is an unsplit stop at 0, so
 * every pure-black pixel in every document that has no blend-if at all would
 * come out 50% transparent.
 *
 * `v < b0`, not `<=`, for the same reason: a default black stop at 0 must keep
 * a pixel of value 0.
 *
 * At and above b1 the layer is fully visible -- the last half-step of the ramp
 * is dropped so that a fully white underlying pixel is exactly 1 rather than
 * 0.997. No fixture reaches the top of a ramp, so that is a stated choice.
 */
function rangeFactor(v, b0, b1, w0, w1) {
  let f = 1;
  if (b0 === b1) { if (v < b0) return 0; }
  else if (v < b1) {
    f = (v - b0 + 0.5) / (b1 - b0 + 1);
    if (f <= 0) return 0;
  }
  if (w0 === w1) { if (v > w0) return 0; }
  else if (v > w0) {
    const g = (w1 - v + 0.5) / (w1 - w0 + 1);
    if (g <= 0) return 0;
    f *= g;
  }
  return f;
}

/**
 * Read a layer's blending ranges into the smallest thing the inner loop can
 * use, or `null` when every stop is at its default and there is nothing to do.
 *
 * ag-psd's field names are its own, typo included:
 *   `compositeGrayBlendSource`            -- Gray, This Layer
 *   `compositeGraphBlendDestinationRange` -- Gray, Underlying Layer
 *   `ranges[i].sourceRange / .destRange`  -- per colour channel
 *
 * CHANNEL ORDER IS ASSUMED, NOT VERIFIED. `ranges` is written in the layer's
 * own channel order and no fixture here carries a non-default per-channel
 * range, so `ranges[0..2]` are taken to be R, G, B for an RGB document. A
 * document that does use them raises a warning saying so rather than rendering
 * a confident guess in silence.
 *
 * @returns {{graySrc:number[]|null, grayDst:number[]|null,
 *            chans:{i:number, src:number[]|null, dst:number[]|null}[]} | null}
 */
export function parseBlendIf(layer) {
  const br = layer && layer.blendingRanges;
  if (!br) return null;

  const graySrc = RANGE_IS_DEFAULT(br.compositeGrayBlendSource) ? null : br.compositeGrayBlendSource;
  const grayDst = RANGE_IS_DEFAULT(br.compositeGraphBlendDestinationRange)
    ? null : br.compositeGraphBlendDestinationRange;

  const chans = [];
  const ranges = br.ranges || [];
  for (let i = 0; i < ranges.length && i < 3; i++) {
    const src = RANGE_IS_DEFAULT(ranges[i].sourceRange) ? null : ranges[i].sourceRange;
    const dst = RANGE_IS_DEFAULT(ranges[i].destRange) ? null : ranges[i].destRange;
    if (src || dst) chans.push({ i, src, dst });
  }

  if (!graySrc && !grayDst && !chans.length) return null;
  return { graySrc, grayDst, chans };
}

/**
 * The alpha multiplier for one pixel: source RGB against destination RGB.
 *
 * Every active slider multiplies, so a layer restricted on both Gray and Red
 * shows only where both agree. Photoshop's dialog offers one channel at a time
 * but keeps what you set on the others, and the file stores all of them.
 *
 * @returns {number} 0..1
 */
export function blendIfFactor(bi, sr, sg, sb, dr, dg, db) {
  let f = 1;
  if (bi.graySrc) {
    f = rangeFactor(blendIfGray(sr, sg, sb), bi.graySrc[0], bi.graySrc[1], bi.graySrc[2], bi.graySrc[3]);
    if (f <= 0) return 0;
  }
  if (bi.grayDst) {
    f *= rangeFactor(blendIfGray(dr, dg, db), bi.grayDst[0], bi.grayDst[1], bi.grayDst[2], bi.grayDst[3]);
    if (f <= 0) return 0;
  }
  for (let k = 0; k < bi.chans.length; k++) {
    const c = bi.chans[k];
    const s = c.i === 0 ? sr : c.i === 1 ? sg : sb;
    const d = c.i === 0 ? dr : c.i === 1 ? dg : db;
    if (c.src) { f *= rangeFactor(s, c.src[0], c.src[1], c.src[2], c.src[3]); if (f <= 0) return 0; }
    if (c.dst) { f *= rangeFactor(d, c.dst[0], c.dst[1], c.dst[2], c.dst[3]); if (f <= 0) return 0; }
  }
  return f;
}

// ---------------------------------------------------------------- buffers

export const createBuffer = (width, height) => ({
  width, height, data: new Uint8ClampedArray(width * height * 4),
});

/**
 * Source-over compositing with a blend function, straight (unassociated) alpha.
 * Iterates only the source rectangle, so cost scales with layer size, not canvas.
 *
 * `blendIf` is a parseBlendIf() descriptor or null. It is one more factor in
 * the same `as` product as opacity, the mask and clipAlpha -- see the blend-if
 * section above for which two pixels it reads and why it needs no buffer.
 */
export function blendInto(dest, src, rect, opacity, mode, clipAlpha, blendIf) {
  const fn = SEPARABLE[mode];
  const nonSep = NON_SEPARABLE.has(mode);
  const blend = fn || SEPARABLE.normal;

  const x0 = Math.max(0, rect.left);
  const y0 = Math.max(0, rect.top);
  const x1 = Math.min(dest.width, rect.left + rect.width);
  const y1 = Math.min(dest.height, rect.top + rect.height);

  for (let y = y0; y < y1; y++) {
    const sy = y - rect.top;
    for (let x = x0; x < x1; x++) {
      const si = (sy * rect.width + (x - rect.left)) * 4;
      const di = (y * dest.width + x) * 4;

      let as = (src[si + 3] / 255) * opacity;
      if (rect.mask) as *= rect.mask[sy * rect.width + (x - rect.left)] / 255;
      if (clipAlpha) as *= clipAlpha[y * dest.width + x] / 255;
      // Reads the destination pixel, so it has to be here rather than in a
      // precomputed plane -- the destination is what this loop is writing.
      if (blendIf) as *= blendIfFactor(blendIf, src[si], src[si + 1], src[si + 2],
        dest.data[di], dest.data[di + 1], dest.data[di + 2]);
      if (as <= 0) continue;

      const ab = dest.data[di + 3] / 255;
      const ao = as + ab * (1 - as);
      if (ao <= 0) continue;

      const br = dest.data[di], bg = dest.data[di + 1], bb = dest.data[di + 2];
      const sr = src[si], sg = src[si + 1], sb = src[si + 2];

      let mr, mg, mb;
      if (nonSep) { const c = blendNonSeparable(mode, br, bg, bb, sr, sg, sb); mr = c[0]; mg = c[1]; mb = c[2]; }
      else { mr = blend(br, sr); mg = blend(bg, sg); mb = blend(bb, sb); }

      // Blend result only applies where the backdrop is opaque; elsewhere use source.
      const cr = sr + ab * (mr - sr);
      const cg = sg + ab * (mg - sg);
      const cb2 = sb + ab * (mb - sb);

      dest.data[di] = (as * cr + ab * br * (1 - as)) / ao;
      dest.data[di + 1] = (as * cg + ab * bg * (1 - as)) / ao;
      dest.data[di + 2] = (as * cb2 + ab * bb * (1 - as)) / ao;
      dest.data[di + 3] = ao * 255;
    }
  }
}

// ---------------------------------------------------------------- layers

/** Alpha coverage of a rendered layer, over the whole canvas — used for clipping. */
function alphaMap(width, height, rect, pixels, mask, opacity) {
  const map = new Uint8Array(width * height);
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

function renderList(list, width, height, ctx) {
  const dest = createBuffer(width, height);

  for (let i = 0; i < list.length; i++) {
    const layer = list[i];

    // Clipped layers above attach to this one as their base.
    const clipped = [];
    let j = i + 1;
    while (j < list.length && list[j].clipping) clipped.push(list[j]), j++;

    if (layer.hidden !== true) {
      const opacity = layer.opacity ?? 1;
      const mode = layer.blendMode || 'normal';

      // One descriptor per layer, per composite. Null on every document that
      // does not use blend-if, which is twenty of the twenty-one fixtures.
      const blendIf = parseBlendIf(layer);
      if (blendIf && blendIf.chans.length)
        ctx.warnings.add('A per-channel Blend If range is applied under an assumed R,G,B channel order — no fixture verifies it.');

      if (mode === 'dissolve') ctx.warnings.add('`dissolve` blend mode is not implemented — rendered as normal.');
      if (layer.adjustment) ctx.warnings.add('Adjustment layers are not applied — the composite will differ where they appear.');
      if (layer.effects) ctx.warnings.add('Layer effects (drop shadow, stroke, glow…) are not applied.');

      if (layer.children) {
        const inner = renderList(layer.children, width, height, ctx);
        if (mode === 'pass through' && opacity === 1 && !clipped.length && !blendIf) {
          blendInto(dest, inner.data, { left: 0, top: 0, width, height }, 1, 'normal');
        } else {
          if (mode === 'pass through')
            ctx.warnings.add('A pass-through group has opacity or blending applied — rendered as a normal group.');
          blendInto(dest, inner.data, { left: 0, top: 0, width, height }, opacity,
            mode === 'pass through' ? 'normal' : mode, null, blendIf);
        }
      } else if (layer.imageData) {
        const rect = layerRect(layer);
        if (rect.width > 0 && rect.height > 0) {
          rect.mask = projectMask(layer, rect);

          if (clipped.length) {
            // Render base into its own buffer, stack the clipped layers on it
            // restricted by its alpha, then blend the result into the backdrop.
            const group = createBuffer(width, height);
            blendInto(group, layer.imageData.data, rect, 1, 'normal');
            const base = alphaMap(width, height, rect, layer.imageData.data, rect.mask, 1);

            for (const c of clipped) {
              if (c.hidden === true || !c.imageData) continue;
              const cr = layerRect(c);
              if (cr.width <= 0 || cr.height <= 0) continue;
              cr.mask = projectMask(c, cr);
              // "Underlying" for a clipped layer is `group` -- the buffer it is
              // actually blending onto -- not `dest`. See the blend-if note.
              blendInto(group, c.imageData.data, cr, c.opacity ?? 1, c.blendMode || 'normal',
                base, parseBlendIf(c));
            }
            // The base's blend-if is spent HERE, with its opacity and mode, so
            // its "this layer" is the composited run rather than its own pixels.
            blendInto(dest, group.data, { left: 0, top: 0, width, height }, opacity, mode, null, blendIf);
          } else {
            blendInto(dest, layer.imageData.data, rect, opacity, mode, null, blendIf);
          }
        }
      }
    }
    i = j - 1;
  }
  return dest;
}

/**
 * Composite a document read with `pixels: 'eager'`.
 *
 * @param {{width:number,height:number,children:object[]}} doc
 * @returns {{width:number,height:number,data:Uint8ClampedArray,warnings:string[]}}
 */
export function compositeDocument(doc) {
  const ctx = { warnings: new Set() };
  const buffer = renderList(doc.children || [], doc.width, doc.height, ctx);
  return { ...buffer, warnings: [...ctx.warnings] };
}

/**
 * Compare two RGBA buffers. Used to check our composite against the one
 * Photoshop embedded in the file.
 */
export function compareBuffers(a, b, tolerance = 1) {
  if (a.width !== b.width || a.height !== b.height)
    return { comparable: false, reason: `${a.width}x${a.height} vs ${b.width}x${b.height}` };

  const total = a.width * a.height;
  let differing = 0, beyondRounding = 0, maxDelta = 0, sum = 0;

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    let worst = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data[o + c] - b.data[o + c]);
      if (d > worst) worst = d;
    }
    if (worst > 0) { differing++; sum += worst; if (worst > maxDelta) maxDelta = worst; }
    if (worst > tolerance) beyondRounding++;
  }

  return {
    comparable: true,
    total,
    differing,
    percent: (differing / total) * 100,
    // Photoshop and we round intermediate blend results differently, so a
    // delta of 1 is noise. This is the number that means something.
    beyondRounding,
    percentReal: (beyondRounding / total) * 100,
    maxDelta,
    meanDelta: differing ? sum / differing : 0,
  };
}

/** Absolute per-channel difference, amplified so small errors are visible. */
export function differenceBuffer(a, b, gain = 8) {
  const out = createBuffer(a.width, a.height);
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) out.data[o + c] = Math.min(255, Math.abs(a.data[o + c] - b.data[o + c]) * gain);
    out.data[o + 3] = 255;
  }
  return out;
}

/**
 * Flatten straight-alpha RGBA onto an opaque background.
 *
 * Needed before comparing against Photoshop's embedded composite: it stores
 * white in the RGB channels of fully transparent pixels, we store zero. Both
 * are equally invisible, so comparing raw RGB reports differences nobody can
 * see. Flattening both onto the same background compares what a viewer sees.
 */
export function flattenOnto(buffer, background = [255, 255, 255]) {
  const out = createBuffer(buffer.width, buffer.height);
  for (let i = 0; i < buffer.width * buffer.height; i++) {
    const o = i * 4;
    const a = buffer.data[o + 3] / 255;
    for (let c = 0; c < 3; c++)
      out.data[o + c] = buffer.data[o + c] * a + background[c] * (1 - a);
    out.data[o + 3] = 255;
  }
  return out;
}
