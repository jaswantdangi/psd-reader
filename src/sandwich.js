/**
 * Drag-time cache for the JS fallback tier.
 *
 * renderProject recomposites the whole stack on every change -- 651 ms for 20
 * layers on desktop, 3-5x that on a phone. During a drag only ONE layer moves,
 * so the composite of everything below it and everything above it can be built
 * once and reused for the rest of the gesture:
 *
 *     below = renderProject over layers [0 .. s-1]      cached
 *     live  = layers [s .. e], re-blended every frame
 *     above = renderProject over layers [e+1 .. n-1]    cached
 *
 * `s` and `e` are the selection index itself in every document that uses no
 * clipping mask. Where one IS used they are the ends of the selection's clip
 * run, because a clipped layer is not independent of the base it clips to and
 * the split may not fall between them -- see `sandwichRunFor`.
 *
 * The `above` half is only usable when every layer above the selection blends
 * `normal`. Source-over is associative, but 25 of the 26 modes read the
 * backdrop and `above` was composited onto a transparent buffer instead. When
 * one of them is present the cache DEGRADES: it keeps `below` and re-blends
 * [i .. n-1] live, which is slower and exact. `sandwichStateFor` reports which
 * of the two is in force, so the harness can show it.
 *
 * Both states composite the same stack in the same order. The flattened one is
 * exact in real arithmetic — source-over is associative — but differs from a
 * full render by **up to 2 LSB** on a minority of pixels, because `above` is
 * quantised to 8 bits once when it is flattened and again when it is blended,
 * and un-premultiplying by its alpha amplifies that error by `1/ao`. Measured,
 * not assumed: 7 of 576 pixels at 2 LSB on the fixture in test/gpu.mjs.
 *
 * That is why this state is named for WHAT IT DOES, not for being exact. An
 * earlier draft called it `SANDWICH_EXACT` and claimed <=1 LSB; both were
 * wrong, and a constant asserting a correctness property it does not have is
 * worse than a slower cache. Storing `above` in float would restore
 * bit-exactness at 4x the buffer cost — recorded in docs/BACKLOG.md, not done.
 *
 * This is a drag-preview path. The frame drawn when the gesture ends comes
 * from a full re-render, so nothing durable inherits the 2 LSB.
 */
import { createBuffer, blendInto } from './composite.js';
import { renderProject, drawClipRunInto, clipRunStart, clipRunEnd } from './render.js';

/** Everything above the selection is `normal`, so `above` is cached. */
export const SANDWICH_FLAT_ABOVE = 'flat-above';
/** A non-`normal` mode sits above the selection, so only `below` is cached. */
export const SANDWICH_BELOW_ONLY = 'below';

/** One cache per canvas. Reused across frames; rebuilt when its key changes. */
export const createSandwichCache = () => ({
  key: null, below: null, above: null, state: SANDWICH_FLAT_ABOVE, builds: 0,
  /**
   * The clip run the selection belongs to, inclusive. Equal to the selection
   * index at both ends whenever the selection is not part of one -- which is
   * every layer of every document that uses no clipping mask.
   */
  runStart: 0, runEnd: 0,
});

/**
 * The clip run the selection belongs to: the boundaries the split may fall on.
 *
 * A CLIP RUN IS ATOMIC HERE. `below` and `above` are flattened composites, and
 * a clipped layer is not independent of its base -- it is visible only through
 * the base's alpha. Split between them and `below` holds the base already
 * blended into the backdrop, where its alpha can no longer be recovered; the
 * live layer then draws in full, which is exactly the bug this whole change
 * exists to fix, reintroduced one layer at a time during every drag.
 *
 * SNAPPED, NOT DEGRADED. `SANDWICH_BELOW_ONLY` would not be enough on its own:
 * it keeps `below` = [0, selection) and re-blends everything from the selection
 * up, so selecting a CLIPPED layer still leaves its base flattened into
 * `below`. The boundary has to move regardless, and once it has moved down to
 * the base there is no reason not to move the upper one up to the run's end
 * too -- the slice above a run end begins with a base, so `above` stays
 * cacheable and the drag stays fast.
 *
 * Both slices are therefore always run-complete, which is why nothing else in
 * this file had to learn about clipping: `renderProject` handles the runs
 * inside each slice, exactly as it does for a full render.
 *
 * With no clipping in the document `start === end === selectionIndex` and every
 * line below behaves as it did before this existed.
 */
export function sandwichRunFor(project, selectionIndex) {
  const start = clipRunStart(project.layers, selectionIndex);
  return { start, end: clipRunEnd(project.layers, start) - 1 };
}

/**
 * Whether the `above` half can be cached for everything above `index`.
 *
 * Layers renderProject would skip anyway -- hidden, or zero opacity -- cannot
 * make the cache wrong, so they do not degrade it. A non-`normal` mode BELOW
 * the index is likewise irrelevant: `below` is a real composite of those
 * layers, not an approximation of them.
 *
 * `rebuild` passes the END OF THE SELECTION'S CLIP RUN rather than the
 * selection, because that is where `above` actually starts. On a document with
 * no clipping mask the two are the same index and this reads exactly as it
 * always has.
 */
export function sandwichStateFor(project, selectionIndex) {
  for (let i = selectionIndex + 1; i < project.layers.length; i++) {
    const layer = project.layers[i];
    if (!layer.visible || layer.opacity <= 0) continue;
    if (layer.blendMode !== 'normal') return SANDWICH_BELOW_ONLY;
  }
  return SANDWICH_FLAT_ABOVE;
}

/**
 * renderProject reads only width, height and layers, so a slice of the stack
 * can be rendered without touching render.js.
 */
const sliceProject = (project, from, to) => ({
  width: project.width, height: project.height, layers: project.layers.slice(from, to),
});

function rebuild(cache, project, selectionIndex, scale, key) {
  const { start, end } = sandwichRunFor(project, selectionIndex);
  cache.runStart = start;
  cache.runEnd = end;
  // Asked about `end`, not the selection: the layers between them are the rest
  // of the selection's own clip run and are re-blended live every frame, so
  // they are not in `above` and their blend modes cannot make it wrong. On a
  // document with no clipping the two indices are the same one.
  cache.state = sandwichStateFor(project, end);
  cache.below = renderProject(sliceProject(project, 0, start), { scale });
  cache.above =
    cache.state === SANDWICH_FLAT_ABOVE && end + 1 < project.layers.length
      ? renderProject(sliceProject(project, end + 1, project.layers.length), { scale })
      : null;
  cache.key = key;
  cache.builds++;
}

/**
 * One drag frame.
 *
 * Falls back to a plain renderProject when the selection is out of range, so a
 * caller never has to special-case "nothing selected".
 *
 * @param {object} cache  from createSandwichCache(); reused across frames
 * @param {object} project
 * @param {number} selectionIndex  index into project.layers; 0 is the bottom
 * @param {{scale?: number, stats?: object|null}} [options]
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderSandwiched(cache, project, selectionIndex, options = {}) {
  const { scale = 1, stats = null } = options;

  if (!Number.isInteger(selectionIndex) || selectionIndex < 0 || selectionIndex >= project.layers.length)
    return renderProject(project, { scale, stats });

  // `revision` is bumped by commit, undo, redo and applyProjectJson, and NOT by
  // the coalesced frames of a drag -- which is what lets one gesture reuse a
  // single build. Layer count is in the key too, so a reorder cannot leave the
  // slice boundaries pointing at different layers.
  const key = `${selectionIndex}|${project.revision ?? 0}|${scale}|${project.layers.length}`;
  if (cache.key !== key) rebuild(cache, project, selectionIndex, scale, key);

  const frame = createBuffer(cache.below.width, cache.below.height);
  frame.data.set(cache.below.data);   // copy: `below` has to survive the next frame

  // The selection's WHOLE clip run, which is the selection alone unless the
  // document uses a clipping mask. Nothing between `below` and `above` may be
  // drawn a layer at a time -- drawLayerInto knows nothing about clipping, and
  // splitting a run across the two halves is what would put the pre-fix bug
  // back for the duration of every drag.
  drawClipRunInto(frame, project.layers, cache.runStart, scale, { stats });

  if (cache.state === SANDWICH_FLAT_ABOVE) {
    if (cache.above)
      blendInto(frame, cache.above.data,
        { left: 0, top: 0, width: frame.width, height: frame.height }, 1, 'normal');
  } else {
    for (let i = cache.runEnd + 1; i < project.layers.length; )
      i = drawClipRunInto(frame, project.layers, i, scale, { stats });
  }

  return frame;
}
