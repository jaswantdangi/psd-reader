/**
 * Operations on a coverage plane.
 *
 * The plane is the same shape mask.js already defines: one byte per pixel,
 * 0..255, laid out row-major on the layer's PIXEL grid. Everything here takes
 * that and returns that, so a generated mask and a mask read from a PSD are the
 * same kind of object and render.js cannot tell them apart. That is the whole
 * design: nothing downstream of here learns a new type.
 *
 * All functions are pure and allocate their result. None of them mutate their
 * input, because a mask is held by an undo command -- `setLayer(project, id,
 * {mask})` captures the PREVIOUS mask object in `from`, and mutating it in
 * place would rewrite history rather than add to it.
 */

/** A plane covering everything -- the state a layer with no mask is already in. */
export const fullMask = (width, height) =>
  new Uint8Array(width * height).fill(255);

/** A plane covering nothing. */
export const emptyMask = (width, height) => new Uint8Array(width * height);

/** How a new mask meets the one already on the layer. */
export const MASK_MODES = ['replace', 'add', 'subtract', 'intersect'];

/**
 * Combine two coverage planes.
 *
 * `add` and `subtract` are what a click-refiner and a brush both need: the
 * model produced a mask, the user is amending it, and the amendment has to
 * compose with what is there rather than replace it. Photoshop's own selection
 * modifiers are the same four.
 *
 * Uses max/min rather than additive arithmetic. Adding two soft edges together
 * pushes their overlap past 255 and clips it to a hard line -- max keeps the
 * softer of the two, which is what "include this as well" means.
 */
export function combineMask(base, patch, mode = 'replace') {
  if (base.length !== patch.length)
    throw new Error(`mask size mismatch: ${base.length} vs ${patch.length}`);
  // A mode this does not recognise used to fall through the chain below and
  // silently become `intersect` -- so a typo did not throw, did not default to
  // `replace`, and quietly returned the one result the caller was least likely
  // to want. Fail closed, next to the length check that already does.
  if (!MASK_MODES.includes(mode))
    throw new Error(`unknown mask mode: ${JSON.stringify(mode)}`);

  const out = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    const b = patch[i];
    out[i] =
      mode === 'replace' ? b
      : mode === 'add' ? (a > b ? a : b)
      : mode === 'subtract' ? (a < 255 - b ? a : 255 - b)
      : /* intersect */ (a < b ? a : b);
  }
  return out;
}

/** Swap foreground for background. */
export function invertMask(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i];
  return out;
}

/**
 * A separable box blur over the plane, `radius` pixels each way.
 *
 * Two passes over a running sum, so cost is O(pixels) and independent of
 * radius. Used both to feather an edge and as the averaging step inside the
 * guided filter in refine.js -- one implementation, so a bug in it shows up in
 * both places at once rather than in only the one nobody looks at.
 *
 * Operates on Float32 so the guided filter can reuse it without quantising
 * between every step.
 */
export function boxBlur(src, width, height, radius) {
  if (radius < 1) return Float32Array.from(src);
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const span = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    // Seed the window with the clamped left edge, so pixel 0 is not darker
    // than its neighbours purely for being at the boundary.
    for (let i = -radius; i <= radius; i++)
      sum += src[row + Math.min(width - 1, Math.max(0, i))];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / span;
      const drop = row + Math.min(width - 1, Math.max(0, x - radius));
      const gain = row + Math.min(width - 1, Math.max(0, x + radius + 1));
      sum += src[gain] - src[drop];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++)
      sum += tmp[Math.min(height - 1, Math.max(0, i)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      const drop = Math.min(height - 1, Math.max(0, y - radius)) * width + x;
      const gain = Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x;
      sum += tmp[gain] - tmp[drop];
    }
  }
  return out;
}

/** Soften a hard edge by `radius` pixels. */
export function featherMask(mask, width, height, radius) {
  if (radius < 1) return Uint8Array.from(mask);
  const blurred = boxBlur(mask, width, height, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = clamp255(blurred[i]);
  return out;
}

/**
 * Paint a soft circular dab into a COPY of the plane.
 *
 * Returned rather than stamped in place for the history reason at the top of
 * this file. A stroke is many dabs, so the caller is expected to hold one
 * working buffer across a gesture and commit ONCE at pointer-up -- see
 * `strokeMask` below, which is the shape that actually wants using.
 *
 * `hardness` 0..1 sets how much of the radius is solid before the falloff
 * starts. At 1 the dab is a hard disc; at 0 it is a full gradient to the edge.
 */
export function stampBrush(mask, width, height, options) {
  const out = Uint8Array.from(mask);
  stampInto(out, width, height, options);
  return out;
}

/**
 * The in-place dab, for a caller that already owns a scratch buffer.
 *
 * This is the ONE mutating function in the file and it is exported separately
 * so that fact is visible at the call site rather than hidden in a parameter.
 */
export function stampInto(target, width, height, options) {
  const { x, y, radius, hardness = 0.5, erase = false, flow = 1 } = options;
  if (radius <= 0) return target;

  const x0 = Math.max(0, Math.floor(x - radius));
  const x1 = Math.min(width - 1, Math.ceil(x + radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const y1 = Math.min(height - 1, Math.ceil(y + radius));
  const solid = radius * Math.min(1, Math.max(0, hardness));
  const falloff = radius - solid;

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const d = Math.hypot(px - x, py - y);
      if (d > radius) continue;
      // Smoothstep across the falloff band rather than a linear ramp: a linear
      // brush leaves a visible ring at the solid boundary because the gradient
      // changes discontinuously there.
      const t = falloff <= 0 ? 1 : Math.min(1, Math.max(0, (radius - d) / falloff));
      const strength = t * t * (3 - 2 * t) * flow;
      const i = py * width + px;
      const value = erase ? target[i] * (1 - strength) : target[i] + 255 * strength;
      target[i] = clamp255(value);
    }
  }
  return target;
}

/**
 * Walk a pointer path and dab along it at a fixed spacing.
 *
 * Pointer events arrive far apart during a fast drag -- stamping only at the
 * reported positions leaves a dotted line, which reads as the brush being
 * broken. Interpolating here rather than in the UI keeps that fix in the engine
 * where it is testable without a pointer.
 */
export function strokeMask(mask, width, height, points, options) {
  const out = Uint8Array.from(mask);
  const spacing = Math.max(1, options.radius * 0.25);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      stampInto(out, width, height, {
        ...options,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
    }
  }
  if (points.length === 1) stampInto(out, width, height, { ...options, ...points[0] });
  return out;
}

/**
 * Does this plane actually mask anything?
 *
 * A model that finds nothing returns an all-255 plane, which is the same as no
 * mask at all. Committing that spends an undo step and changes no pixels, so
 * the caller checks this first and reports "nothing found" instead.
 */
export function isOpaque(mask) {
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 255) return false;
  return true;
}

/** Fraction of the plane that is fully or partly transparent, 0..1. */
export function cutFraction(mask) {
  // An empty mask divided 0 by 0 and returned NaN, which fails every
  // comparison a "did we find anything?" guard puts it in -- including
  // `fraction > 0`, so "nothing was cut" read as "nothing was cut" only by
  // accident, and `fraction < 1` read as false. Nothing cut out of nothing is
  // zero.
  if (mask.length === 0) return 0;
  let cut = 0;
  for (let i = 0; i < mask.length; i++) cut += (255 - mask[i]) / 255;
  return cut / mask.length;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
