/**
 * Edge treatment for a coverage plane -- feather, shift, contrast, smooth, fade.
 *
 * These are Photoshop's Select-and-Mask controls, and they exist for the same
 * reason: a model's alpha boundary is nearly right, and the last few pixels are
 * a judgement call no model can make for you. A cut with a one-pixel halo needs
 * the edge pulled IN; a cut through hair needs it softened OUT; a cut composited
 * onto a busy background needs its transition hardened.
 *
 * ## Derived, never baked
 *
 * Nothing here mutates a mask. `applyEdge` takes the model's ORIGINAL output and
 * returns a new plane, so the sliders are re-runnable: drag feather to 8, then
 * back to 0, and you have exactly the bytes the model produced. The layer keeps
 * `mask.source` (what the model said) alongside `mask.data` (what is drawn), and
 * `mask.edge` is the recipe between them.
 *
 * That is the same shape `layer.adjust` already uses -- parameters stored, table
 * derived by `lutFor` -- and it is chosen for the same reason: storing only the
 * result means the next adjustment compounds on the last one, so dragging a
 * slider left then right does not return you to where you started.
 *
 * ## Order is not arbitrary
 *
 * smooth -> shift -> feather -> contrast -> fade.
 *
 * Smoothing first, because it removes the staircase the other steps would
 * otherwise amplify. Shift before feather, because shifting works by moving the
 * 0.5 crossing and a feathered edge has a wider, mushier crossing to move.
 * Contrast after feather, so it can tighten a transition feather just widened.
 * Fade last, because it is a global multiplier and anything after it would be
 * operating on a plane that no longer means "coverage".
 */

import { boxBlur } from './mask-ops.js';

/** A recipe that changes nothing. */
export const NEUTRAL_EDGE = Object.freeze({
  /** Blur the boundary, in pixels of the mask's own grid. 0..32 */
  feather: 0,
  /** Move the boundary in (-) or out (+). -1..1, where 1 is a full pixel-ish push. */
  shift: 0,
  /** Harden (>0) or soften (<0) the transition. -1..1 */
  contrast: 0,
  /** Remove staircase artefacts, in pixels. 0..8 */
  smooth: 0,
  /** Overall mask strength. 1 = full cut, 0 = no cut at all. */
  fade: 1,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Coerce anything into a usable recipe.
 *
 * A project file is text on a device and can carry anything, so every field is
 * clamped rather than trusted -- an out-of-range feather would be a blur radius
 * large enough to hang the tab.
 */
export function normaliseEdge(edge) {
  const e = edge ?? {};
  return Object.freeze({
    feather: clamp(Number(e.feather) || 0, 0, 32),
    shift: clamp(Number(e.shift) || 0, -1, 1),
    contrast: clamp(Number(e.contrast) || 0, -1, 1),
    smooth: clamp(Number(e.smooth) || 0, 0, 8),
    fade: clamp(e.fade === undefined ? 1 : Number(e.fade) || 0, 0, 1),
  });
}

/** True when the recipe would return its input unchanged — the caller can skip the work. */
export const isNeutralEdge = (edge) => {
  const e = normaliseEdge(edge);
  return e.feather === 0 && e.shift === 0 && e.contrast === 0 && e.smooth === 0 && e.fade === 1;
};

/**
 * Remap a 0..1 plane around its midpoint.
 *
 * `gain` above 1 pushes values away from 0.5 (a harder edge); below 1 pulls them
 * toward it (a softer one). Applied through a smoothstep rather than a straight
 * multiply so the result cannot develop a kink at the clamp, which shows up as a
 * visible contour line along the edge.
 */
function applyContrast(plane, amount) {
  if (amount === 0) return plane;
  // -1..1 -> a gain between 1/5 and 5, symmetric about no change.
  const gain = amount > 0 ? 1 + amount * 4 : 1 / (1 + -amount * 4);
  // Smoothstep ONLY when hardening. It is an S-curve, so applying it while
  // softening would undo the softening the gain just performed -- the two would
  // fight and the slider would go dead over half its travel.
  const ease = amount > 0;
  for (let i = 0; i < plane.length; i++) {
    const v = clamp((plane[i] - 0.5) * gain + 0.5, 0, 1);
    plane[i] = ease ? v * v * (3 - 2 * v) : v;
  }
  return plane;
}

/**
 * Turn the model's output into the plane that gets drawn.
 *
 * @param {Uint8Array} source  the model's own coverage plane, never modified
 * @param {number} width
 * @param {number} height
 * @param {object} edge        a recipe; missing fields take NEUTRAL_EDGE's
 * @returns {Uint8Array} a new plane of the same length
 */
export function applyEdge(source, width, height, edge) {
  const e = normaliseEdge(edge);
  if (isNeutralEdge(e)) return Uint8Array.from(source);

  let plane = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) plane[i] = source[i] / 255;

  // 1. Smooth. Blur, then re-harden: the blur removes the staircase and the
  //    re-hardening puts the edge back where it was instead of leaving it soft,
  //    which is what separates "smooth" from "feather".
  if (e.smooth > 0) {
    plane = boxBlur(plane, width, height, Math.round(e.smooth));
    applyContrast(plane, 0.75);
  }

  // 2. Shift. The boundary is wherever the plane crosses 0.5, so moving that
  //    threshold moves the boundary. It needs a GRADIENT to move through --
  //    on a hard binary mask there is nothing between 0 and 1 to re-threshold --
  //    so a working blur is applied first and then thresholded away again.
  if (e.shift !== 0) {
    const radius = Math.max(1, Math.round(Math.abs(e.shift) * 6));
    plane = boxBlur(plane, width, height, radius);
    const threshold = 0.5 - e.shift * 0.45;
    for (let i = 0; i < plane.length; i++)
      plane[i] = clamp((plane[i] - threshold) * 6 + 0.5, 0, 1);
  }

  // 3. Feather. The only step meant to leave a soft boundary behind.
  if (e.feather > 0) plane = boxBlur(plane, width, height, Math.round(e.feather));

  // 4. Contrast, to tighten or loosen whatever transition now exists.
  if (e.contrast !== 0) applyContrast(plane, e.contrast);

  // 5. Fade. A global multiplier: at 0 the mask stops hiding anything, which is
  //    the honest way to preview "how much of this cut do I actually want".
  const out = new Uint8Array(source.length);
  for (let i = 0; i < out.length; i++) {
    const v = clamp(1 - (1 - plane[i]) * e.fade, 0, 1);
    out[i] = Math.round(v * 255);
  }
  return out;
}
