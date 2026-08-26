/**
 * Gesture rules and transform arithmetic, as pure functions.
 *
 * The pointer EVENTS belong to the component; the decisions do not. Putting
 * "which gesture is this" and "what rect does this drag produce" in a directive
 * is how a coordinate bug becomes untestable -- and a bug here mis-EDITS the
 * document rather than merely mis-drawing it.
 *
 * Every rect below is a layer's {x, y, w, h} in DOCUMENT coordinates, and every
 * radius is in document units. A caller converts a CSS-pixel touch target by
 * dividing by view.docScale; nothing in this file knows a viewport exists.
 */

/** Four corners. No rotation handle: the model has no field for an angle. */
export const HANDLES = ['nw', 'ne', 'se', 'sw'];

/** Half of a 44px touch target, in CSS px. Divide by docScale before use. */
export const HANDLE_HIT_CSS_PX = 22;

/** Movement below this, in CSS px, is a tap rather than a drag. */
export const TAP_SLOP_CSS_PX = 8;

/** A layer may not be shrunk below one document pixel, and may not cross zero. */
export const MIN_LAYER_SIZE = 1;

const cornersOf = (rect) => ({
  nw: { x: rect.x, y: rect.y },
  ne: { x: rect.x + rect.w, y: rect.y },
  se: { x: rect.x + rect.w, y: rect.y + rect.h },
  sw: { x: rect.x, y: rect.y + rect.h },
});

/** The nearest corner handle within `radiusDoc`, or null. First-wins on ties. */
export function handleAt(rect, docX, docY, radiusDoc) {
  const corners = cornersOf(rect);
  let best = null;
  let bestDistance = Infinity;
  for (const id of HANDLES) {
    const c = corners[id];
    const d = Math.hypot(docX - c.x, docY - c.y);
    if (d <= radiusDoc && d < bestDistance) { bestDistance = d; best = id; }
  }
  return best;
}

/**
 * Which gesture a pointer-down begins.
 *
 * The only arbitration with no ambiguous case and no mode:
 *
 *   2 pointers            -> the VIEW, always. Never a layer edit.
 *   1 on a handle         -> scale the selection from the opposite corner
 *   1 inside the selection-> move the selection
 *   1 anywhere else       -> pan the VIEW
 *
 * The cost is explicit and was chosen: the first move of any layer is
 * tap-then-drag. The alternative -- one finger always moves the selection --
 * makes two-finger gestures ambiguous between pan and pinch, makes one-handed
 * panning impossible, and turns every accidental drag across the canvas into an
 * undoable document mutation.
 *
 * @param {{pointerCount:number, selection:{x,y,w,h}|null,
 *          docPoint:{x:number,y:number}, handleRadius:number}} input
 */
export function arbitrate(input) {
  const { pointerCount, selection, docPoint, handleRadius = HANDLE_HIT_CSS_PX } = input;

  if (pointerCount >= 2) return { kind: 'view-pinch', handle: null };

  if (selection) {
    const handle = handleAt(selection, docPoint.x, docPoint.y, handleRadius);
    if (handle) return { kind: 'scale', handle };
    if (docPoint.x >= selection.x && docPoint.y >= selection.y &&
        docPoint.x < selection.x + selection.w && docPoint.y < selection.y + selection.h)
      return { kind: 'move', handle: null };
  }

  return { kind: 'view-pan', handle: null };
}

/** The corner a scale gesture holds still. */
export function anchorFor(handle, rect) {
  const corners = cornersOf(rect);
  return corners[{ nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' }[handle]];
}

/**
 * The rect produced by dragging `handle` to a document point.
 *
 * Aspect ratio is NOT locked: there is no second finger free to unlock it, and
 * the model supports non-uniform w/h (as does rasteriseTextAt, deliberately --
 * sx and sy are independent there).
 *
 * NO FLIPS. Dragging past the anchor clamps at `min` rather than mirroring the
 * layer to the other side. w/h have no sign in the project model, renderProject
 * does Math.max(1, round(w * scale)), and resample() would not survive a
 * negative dimension -- so a flip would preview one thing and export another.
 */
export function resizeFrom(rect, handle, docX, docY, options = {}) {
  const { min = MIN_LAYER_SIZE } = options;
  const anchor = anchorFor(handle, rect);
  const growsRight = handle === 'ne' || handle === 'se';
  const growsDown = handle === 'sw' || handle === 'se';

  const w = Math.max(min, Math.round(growsRight ? docX - anchor.x : anchor.x - docX));
  const h = Math.max(min, Math.round(growsDown ? docY - anchor.y : anchor.y - docY));

  return {
    x: growsRight ? anchor.x : anchor.x - w,
    y: growsDown ? anchor.y : anchor.y - h,
    w,
    h,
  };
}

/** Translate a rect by a document-space delta, snapped to whole pixels. */
export const moveBy = (rect, dx, dy) => ({
  x: Math.round(rect.x + dx),
  y: Math.round(rect.y + dy),
  w: rect.w,
  h: rect.h,
});

/** Movement under the slop is a tap -- select, or deselect on a miss. */
export const isTap = (dx, dy, slop = TAP_SLOP_CSS_PX) => Math.hypot(dx, dy) < slop;

/**
 * Frame budget for one drag frame, in ms.
 *
 * A CHOSEN threshold, not a measurement: roughly where a drag stops reading as
 * direct manipulation and starts reading as a sequence of jumps. It is a
 * constant so a device report can move it.
 */
export const FRAME_BUDGET_MS = 100;

/** Composite at proxyScale * this during gestures on the bottom rung only. */
export const REDUCED_INTERACTION_SCALE = 0.5;

/**
 * Pick a rung of the degradation ladder, ONCE, at pointer-down.
 *
 *   Live     full recomposite per frame                          exact
 *   Sandwich 1B's cache: below + live layer + above              see sandwichStateFor
 *   Ghost    freeze below/above at pointer-down, overlay the layer
 *   Reduced  as Ghost, composited at REDUCED_INTERACTION_SCALE
 *
 * Held for the whole gesture: escalating mid-drag makes the image jump at the
 * worst possible moment. A rung with no measurement yet (`null`) is TRIED, not
 * skipped -- otherwise the first gesture on any device would fall to the bottom
 * and stay there.
 *
 * `pill` is what the selection HUD must show. `null` means nothing to disclose;
 * `'ghost'` means fidelity is reduced but the composite is right; `'preview'`
 * means the canvas is showing where the layer WILL be, not what it will look
 * like. The sandwich's own <=2 LSB quantisation is disclosed separately, by
 * 1B's `sandwichStateFor` -- it is not this function's to report.
 *
 * NOTHING IN THIS LADDER HAS BEEN MEASURED ON A PHONE.
 */
export function chooseRenderMode(measured = {}, context = {}) {
  const { liveMs = null, sandwichMs = null, ghostMs = null, budgetMs = FRAME_BUDGET_MS } = measured;
  const { aboveAllNormal = true, liveModeIsNormal = true } = context;

  const over = (ms) => ms !== null && ms > budgetMs;

  if (!over(liveMs)) return { mode: 'live', scale: 1, pill: null };
  if (!over(sandwichMs)) return { mode: 'sandwich', scale: 1, pill: null };
  if (!over(ghostMs))
    return {
      mode: 'ghost',
      scale: 1,
      // Ghost composites the live layer over frozen halves. That is exact only
      // when the layer blends `normal` AND nothing non-`normal` sits above it;
      // otherwise it is a position preview and has to say so.
      pill: aboveAllNormal && liveModeIsNormal ? 'ghost' : 'preview',
    };

  return { mode: 'reduced', scale: REDUCED_INTERACTION_SCALE, pill: 'preview' };
}
