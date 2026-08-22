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

// ---------------------------------------------------------------- buffers

export const createBuffer = (width, height) => ({
  width, height, data: new Uint8ClampedArray(width * height * 4),
});

/**
 * Source-over compositing with a blend function, straight (unassociated) alpha.
 * Iterates only the source rectangle, so cost scales with layer size, not canvas.
 */
function blendInto(dest, src, rect, opacity, mode, clipAlpha) {
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

/** Layer mask as a 0..255 array over the layer's own rect, or null. */
function maskFor(layer, rect) {
  const mask = layer.mask;
  if (!mask || !mask.imageData) return null;

  const mw = (mask.right ?? 0) - (mask.left ?? 0);
  const mh = (mask.bottom ?? 0) - (mask.top ?? 0);
  if (mw <= 0 || mh <= 0) return null;

  const fallback = mask.defaultColor ?? 0;
  const out = new Uint8Array(rect.width * rect.height).fill(fallback);
  const src = mask.imageData.data;

  for (let y = 0; y < rect.height; y++) {
    const my = rect.top + y - mask.top;
    if (my < 0 || my >= mh) continue;
    for (let x = 0; x < rect.width; x++) {
      const mx = rect.left + x - mask.left;
      if (mx < 0 || mx >= mw) continue;
      out[y * rect.width + x] = src[(my * mw + mx) * 4]; // masks are greyscale — red channel
    }
  }
  return out;
}

const rectOf = (layer) => ({
  left: layer.left ?? 0,
  top: layer.top ?? 0,
  width: (layer.right ?? 0) - (layer.left ?? 0),
  height: (layer.bottom ?? 0) - (layer.top ?? 0),
});

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

      if (mode === 'dissolve') ctx.warnings.add('`dissolve` blend mode is not implemented — rendered as normal.');
      if (layer.adjustment) ctx.warnings.add('Adjustment layers are not applied — the composite will differ where they appear.');
      if (layer.effects) ctx.warnings.add('Layer effects (drop shadow, stroke, glow…) are not applied.');

      if (layer.children) {
        const inner = renderList(layer.children, width, height, ctx);
        if (mode === 'pass through' && opacity === 1 && !clipped.length) {
          blendInto(dest, inner.data, { left: 0, top: 0, width, height }, 1, 'normal');
        } else {
          if (mode === 'pass through')
            ctx.warnings.add('A pass-through group has opacity or blending applied — rendered as a normal group.');
          blendInto(dest, inner.data, { left: 0, top: 0, width, height }, opacity,
            mode === 'pass through' ? 'normal' : mode);
        }
      } else if (layer.imageData) {
        const rect = rectOf(layer);
        if (rect.width > 0 && rect.height > 0) {
          rect.mask = maskFor(layer, rect);

          if (clipped.length) {
            // Render base into its own buffer, stack the clipped layers on it
            // restricted by its alpha, then blend the result into the backdrop.
            const group = createBuffer(width, height);
            blendInto(group, layer.imageData.data, rect, 1, 'normal');
            const base = alphaMap(width, height, rect, layer.imageData.data, rect.mask, 1);

            for (const c of clipped) {
              if (c.hidden === true || !c.imageData) continue;
              const cr = rectOf(c);
              if (cr.width <= 0 || cr.height <= 0) continue;
              cr.mask = maskFor(c, cr);
              blendInto(group, c.imageData.data, cr, c.opacity ?? 1, c.blendMode || 'normal', base);
            }
            blendInto(dest, group.data, { left: 0, top: 0, width, height }, opacity, mode);
          } else {
            blendInto(dest, layer.imageData.data, rect, opacity, mode);
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
