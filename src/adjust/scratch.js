/**
 * One destination buffer per render context, grown monotonically.
 *
 * MANDATORY, not an optimisation. resample() returns its INPUT OBJECT when the
 * dimensions already match (src/render.js:20) -- and that is the DEFAULT
 * preview path, because an untransformed layer at proxyScale asks for exactly
 * the dimensions the proxy already has. textPixelsAt does the same with
 * layer.rendered, and export hands its streamed full-resolution buffer through
 * `options.pixels`. So an adjustment applied in place would overwrite the
 * layer's ORIGINAL pixels permanently, and -- because the next frame reads the
 * same buffer -- compound frame over frame until a held brightness slider ran
 * away to white. Non-destructive editing would become destructive with nothing
 * on screen to say so.
 *
 * One buffer for the whole frame rather than one per layer: O(1) allocations
 * instead of O(layers), at the cost of one buffer sized to the largest
 * destination rect. It only ever grows, because a frame that needed 4 MB once
 * will need it again next frame and shrinking would just re-allocate.
 *
 * LIFETIME: acquired by drawLayerInto, filled by applyAdjustments, consumed by
 * blendInto on the next line -- all synchronously, within one statement's
 * reach. NOTHING may retain a reference across a call. The next layer
 * overwrites it.
 */

export const createScratch = () => ({ data: null, bytes: 0, allocations: 0 });

/**
 * A destination view of exactly `width x height`.
 *
 * The subarray is the point: it is rect-sized, so bytes left over from a
 * previously larger layer are unreachable rather than merely unread.
 *
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function acquireScratch(scratch, width, height) {
  const need = width * height * 4;
  if (!scratch.data || scratch.bytes < need) {
    scratch.data = new Uint8ClampedArray(need);
    scratch.bytes = need;
    scratch.allocations++;
  }
  return { width, height, data: scratch.data.subarray(0, need) };
}

/**
 * Drop the buffer.
 *
 * Export calls this before the PNG encode peak -- the same place 1C already
 * drops the file bytes -- because at scale 1 the scratch has grown to the
 * largest layer in the document, which for the measured 4961x3508 poster is
 * ~66.4 MB that must not be resident while the encoder allocates.
 */
export function releaseScratch(scratch) {
  scratch.data = null;
  scratch.bytes = 0;
}

/**
 * The preview path's scratch.
 *
 * Module-level rather than per-render-call, because a per-call one would
 * allocate every frame -- exactly what this file exists to avoid. Export does
 * NOT use it: createJsExportTarget owns its own, so a full-resolution buffer
 * cannot be left alive by the editor after an export finishes.
 */
export const DEFAULT_SCRATCH = createScratch();
