/**
 * Crop-rect arithmetic, as pure functions.
 *
 * Every rect here is `{x, y, width, height}` in DOCUMENT coordinates and every
 * value is a whole document pixel. That shape — `width`/`height` rather than
 * the layer model's `w`/`h` — is deliberate: a frame becomes a document SIZE,
 * so it is named like one, and `intersectRect` in export/tiles.js already uses
 * it.
 *
 * Nothing in this file knows a viewport, a pointer or a project exists. A
 * caller converts a CSS-pixel touch target by dividing by `view.docScale`,
 * exactly as it already does for gesture.js.
 */
import { anchorFor } from '../gesture.js';

/** A frame may not be shrunk below one document pixel, on either axis. */
export const MIN_FRAME_SIZE = 1;

/**
 * The ratios a photo editor offers, as `width / height`.
 *
 * `free` is a first-class member rather than the absence of one: the crop sheet
 * has to render it as a chip alongside the rest, and a `null` ratio is the
 * value every function here already accepts for "do not lock".
 */
export const ASPECT_RATIOS = Object.freeze([
  { id: 'free', label: 'Free', ratio: null },
  { id: '1:1', label: 'Square', ratio: 1 },
  { id: '4:5', label: 'Portrait', ratio: 4 / 5 },
  { id: '9:16', label: 'Story', ratio: 9 / 16 },
  { id: '16:9', label: 'Wide', ratio: 16 / 9 },
].map((preset) => Object.freeze(preset)));

export const RATIO_IDS = Object.freeze(ASPECT_RATIOS.map((preset) => preset.id));

/**
 * @returns the ratio for a preset id, or `null` for free — including for an id
 *   that does not exist. A typo must land on "unlocked", never on NaN, because
 *   NaN propagates silently through every division below and comes out the far
 *   end as a rect of zeroes.
 */
export function ratioOf(id) {
  const preset = ASPECT_RATIOS.find((p) => p.id === id);
  return preset ? preset.ratio : null;
}

const usableRatio = (ratio) => (Number.isFinite(ratio) && ratio > 0 ? ratio : null);

const coord = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : 0;
};

const size = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(MIN_FRAME_SIZE, v) : MIN_FRAME_SIZE;
};

/** Round a rect to whole document pixels. Position may be negative; size may not be zero. */
export const normaliseRect = (rect) => ({
  x: coord(rect.x),
  y: coord(rect.y),
  width: size(rect.width),
  height: size(rect.height),
});

export const sameRect = (a, b) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/**
 * The largest rect of `ratio` that fits inside `width` x `height`, centred.
 *
 * What a ratio chip does when it is tapped. A `ratio` of `null` returns the
 * whole box, which is what `free` means.
 *
 * The derived side is ROUNDED, so the rect's true ratio can be off by up to
 * half a pixel — 1000 wide at 16:9 wants 562.5 rows and gets 563. A rect is
 * whole pixels because the document it becomes is; the alternative is a
 * fractional canvas size, which nothing downstream accepts.
 */
export function largestCentredRect(width, height, ratio) {
  const boxW = size(width);
  const boxH = size(height);
  const locked = usableRatio(ratio);
  if (!locked) return { x: 0, y: 0, width: boxW, height: boxH };

  let w = boxW;
  let h = Math.round(boxW / locked);
  if (h > boxH) { h = boxH; w = Math.round(boxH * locked); }

  w = Math.min(boxW, Math.max(MIN_FRAME_SIZE, w));
  h = Math.min(boxH, Math.max(MIN_FRAME_SIZE, h));

  return { x: Math.round((boxW - w) / 2), y: Math.round((boxH - h) / 2), width: w, height: h };
}

/**
 * Translate a rect, keeping it inside `bounds`.
 *
 * A rect BIGGER than its bounds pins to the bounds' origin rather than being
 * pushed to a negative coordinate — reachable whenever the canvas has been
 * extended and the user then drags the crop.
 */
export function moveRect(rect, dx, dy, bounds = null) {
  const out = normaliseRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
  if (!bounds) return out;
  return {
    x: Math.max(bounds.x, Math.min(out.x, bounds.x + bounds.width - out.width)),
    y: Math.max(bounds.y, Math.min(out.y, bounds.y + bounds.height - out.height)),
    width: out.width,
    height: out.height,
  };
}

/**
 * The rect produced by dragging one corner handle to a document point.
 *
 * The opposite corner is the anchor, taken from gesture.js so that a crop
 * handle and a layer handle cannot drift apart. NO FLIPS, for the same reason
 * as there: dragging past the anchor clamps at `min` rather than mirroring.
 *
 * With a `ratio`, the locked rect is INSCRIBED in the free-drag box — the
 * smaller of the two candidates. Choosing the larger would grow the crop past
 * the finger on whichever axis moved least, which reads as the rect fighting
 * the drag. The cost of inscribing is that a locked drag can only shrink to
 * reach its ratio, never overshoot the pointer.
 *
 * `bounds` limits THE SPACE THE ANCHOR HAS, before the ratio is applied, so a
 * locked drag slides along the document edge instead of stopping dead at it.
 *
 * Integers last, and the HEIGHT is the one that is floored: `w` is then derived
 * from an integer `h`, which holds `|w - h * ratio| <= 0.5` for every ratio.
 * Rounding `h` from `w` instead would scale that error by the ratio itself, and
 * a 16:9 crop would be up to 0.9 px off.
 *
 * @param {{x,y,width,height}} rect
 * @param {'nw'|'ne'|'se'|'sw'} handle
 * @param {{ratio?: number|null, bounds?: object|null, min?: number}} [options]
 */
export function resizeRect(rect, handle, docX, docY, options = {}) {
  const { ratio = null, bounds = null, min = MIN_FRAME_SIZE } = options;
  const anchor = anchorFor(handle, { x: rect.x, y: rect.y, w: rect.width, h: rect.height });
  const growsRight = handle === 'ne' || handle === 'se';
  const growsDown = handle === 'sw' || handle === 'se';
  const locked = usableRatio(ratio);

  const maxW = bounds
    ? Math.max(min, growsRight ? bounds.x + bounds.width - anchor.x : anchor.x - bounds.x)
    : Infinity;
  const maxH = bounds
    ? Math.max(min, growsDown ? bounds.y + bounds.height - anchor.y : anchor.y - bounds.y)
    : Infinity;

  let w = Math.min(Math.max(growsRight ? docX - anchor.x : anchor.x - docX, min), maxW);
  let h = Math.min(Math.max(growsDown ? docY - anchor.y : anchor.y - docY, min), maxH);

  if (locked) {
    if (w / h > locked) w = h * locked; else h = w / locked;
    // Inscribing can only shrink, so these only fire when `min` pushed a side
    // back out — a bounds too small to hold one min-sized ratio rect at all.
    if (w > maxW) { w = maxW; h = w / locked; }
    if (h > maxH) { h = maxH; w = h * locked; }

    h = Math.max(MIN_FRAME_SIZE, Math.min(Math.floor(h), Math.floor(maxH)));
    w = Math.max(MIN_FRAME_SIZE, Math.min(Math.round(h * locked), Math.floor(maxW)));
  } else {
    w = Math.max(MIN_FRAME_SIZE, Math.min(Math.round(w), Math.floor(maxW)));
    h = Math.max(MIN_FRAME_SIZE, Math.min(Math.round(h), Math.floor(maxH)));
  }

  const out = {
    x: growsRight ? anchor.x : anchor.x - w,
    y: growsDown ? anchor.y : anchor.y - h,
    width: w,
    height: h,
  };

  // A no-op for every reachable drag: the anchor arithmetic above already keeps
  // the rect inside. It is here for the one case it cannot — an anchor sitting
  // exactly on the bounds edge, where `min` and `bounds` are in direct conflict
  // and something has to give. Containment gives last.
  return bounds ? moveRect(out, 0, 0, bounds) : out;
}
