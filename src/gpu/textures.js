/**
 * Uploads, cached by the identity of the buffer they came from.
 *
 * WHY A CACHE AT ALL. `buildDrawPlan` names the same `layer.pixels` object on
 * every frame of a drag. Re-uploading a 4000x3000 layer at 60 Hz is 2.8 GB/s
 * over the bus for pixels that did not change -- which is not a slow frame, it
 * is a stalled one, because the driver must finish the previous frame's reads
 * before it can overwrite the texture.
 *
 * WHY IDENTITY IS THE RIGHT KEY, AND WHERE IT IS WRONG. Every producer in this
 * engine hands back a NEW buffer object: `resample` allocates, `buildLut`
 * allocates, `resampleMask` allocates. So a changed pixel is a changed object
 * and the cache misses, correctly. The exception is a caller that writes into
 * `source.data` IN PLACE -- there is no such caller today, and if one appears
 * it must call `invalidate(source)` or it will render last frame's pixels
 * forever. `data !== entry.data` is checked as a cheap partial guard: it catches
 * a swapped buffer on the same wrapper object, which is the likelier accident.
 *
 * WHY IT IS BOUNDED. An unbounded texture cache on a phone is a context loss a
 * few documents in, and a lost context is a black canvas. Entries are evicted
 * least-recently-used down to `budgetBytes`, and NEVER an entry used in the
 * frame being built -- evicting one of those would re-upload it moments later
 * and thrash. `bytes` is the live figure, so a caller can print what the GPU is
 * actually holding rather than what the plan predicted.
 */

/**
 * Upload alignment. The default is 4, and an R8 texture whose width is not a
 * multiple of 4 is then read back with per-row padding the caller never wrote:
 * a mask 130 px wide skews by two bytes per row and shears diagonally down the
 * layer. One byte per row costs nothing measurable and is always correct.
 */
const UNPACK_ALIGNMENT = 1;

const setFilter = (gl, filter) => {
  const mode = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode);
};

/**
 * CLAMP_TO_EDGE on both axes, always.
 *
 * `resample` in render.js clamps its source index with
 * `Math.min(src.width - 1, ...)` and `Math.max(0, ...)`, which IS
 * clamp-to-edge. REPEAT would wrap the far edge of a layer into its near one,
 * a bright seam one pixel wide along two sides of every transformed layer.
 * WebGL2 would also refuse REPEAT outright on a non-power-of-two texture, which
 * most layers are.
 */
function newTexture(gl, filter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  setFilter(gl, filter);
  return texture;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {{budgetBytes?: number}} [options]
 */
export function createTextureStore(gl, options = {}) {
  const { budgetBytes = Infinity } = options;

  // Insertion-ordered, so the oldest entry is simply the first one. Each entry:
  // {texture, bytes, data, frame}.
  const entries = new Map();
  let bytes = 0;
  let frame = 0;
  let uploads = 0;

  /**
   * 1x1 stand-ins for the samplers a draw does not use.
   *
   * NOT an optimisation and not defensive coding. `uMask`, `uClip` and `uLut`
   * are live in every blend program -- they sit behind branches, and a branch
   * does not stop a sampler being active. A live sampler pointing at a unit
   * with no texture bound reads undefined data on several drivers, and on some
   * it is undefined even when the branch guarding it is false. White is the
   * identity for all three uses (a mask of 1, a clip alpha of 1, an unread LUT).
   *
   * BUILT EAGERLY, five bytes of GPU memory, and the eagerness is the point.
   * Creating a texture BINDS it to whatever unit happens to be active, so a
   * stand-in built lazily inside a draw silently replaces the binding of the
   * unit before it -- which cost a real bug: the mask unit was overwritten by
   * the clip stand-in, and every masked layer rendered with its mask ignored
   * while `uUseMask` still said 1. Built here, `blankR8`/`blankRgba` are pure
   * lookups that touch no binding at all.
   */
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, UNPACK_ALIGNMENT);
  const whiteR8 = newTexture(gl, 'nearest');
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
  const whiteRgba = newTexture(gl, 'nearest');
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]));

  const evictTo = (limit) => {
    for (const [key, entry] of entries) {
      if (bytes <= limit) break;
      // Never something this frame needs: it would be re-uploaded within the
      // same frame, which is strictly worse than being over budget.
      if (entry.frame === frame) continue;
      gl.deleteTexture(entry.texture);
      bytes -= entry.bytes;
      entries.delete(key);
    }
  };

  const touch = (key, entry) => {
    entry.frame = frame;
    // Move to the back: a Map iterates in insertion order, so re-inserting is
    // the whole LRU.
    entries.delete(key);
    entries.set(key, entry);
    return entry.texture;
  };

  /**
   * @param {object} key      the buffer object the upload came from
   * @param {number} size     bytes this upload occupies on the GPU
   * @param {*} data          the backing array, for the swapped-buffer guard
   * @param {(texture: WebGLTexture) => void} upload
   */
  const acquire = (key, size, data, upload) => {
    const found = entries.get(key);
    if (found && found.data === data) return touch(key, found);
    if (found) { gl.deleteTexture(found.texture); bytes -= found.bytes; entries.delete(key); }

    const texture = newTexture(gl, 'nearest');
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, UNPACK_ALIGNMENT);
    upload(texture);
    uploads++;

    const entry = { texture, bytes: size, data, frame };
    entries.set(key, entry);
    bytes += size;
    evictTo(budgetBytes);
    return texture;
  };

  return {
    /** A frame boundary. Everything touched after this call is protected from eviction. */
    beginFrame() { frame++; },

    /**
     * An RGBA8 layer or mask-bearing source, straight (unassociated) alpha.
     *
     * UNPACK_PREMULTIPLY_ALPHA_WEBGL is deliberately left off. The whole engine
     * is straight alpha, `CONTEXT_ATTRIBUTES` says `premultipliedAlpha: false`,
     * and premultiplying on upload would quantise every partially transparent
     * pixel twice before the shader ever saw it.
     */
    rgba(source, filter) {
      const texture = acquire(source, source.width * source.height * 4, source.data, () => {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, source.width, source.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, source.data);
      });
      gl.bindTexture(gl.TEXTURE_2D, texture);
      setFilter(gl, filter);
      return texture;
    },

    /** A layer mask: one byte per source pixel, never four. */
    r8(mask, filter) {
      const texture = acquire(mask, mask.width * mask.height, mask.data, () => {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0,
          gl.RED, gl.UNSIGNED_BYTE, mask.data);
      });
      gl.bindTexture(gl.TEXTURE_2D, texture);
      setFilter(gl, filter);
      return texture;
    },

    /**
     * The class-A table as the shader reads it: 256x1 RGBA8, texel i holding
     * (lut[i], lut[256 + i], lut[512 + i], 255).
     *
     * These are the EXACT 768 bytes `buildLut` produced -- re-laid-out, never
     * recomputed. Both tiers then read one table, so divergence in class A is
     * not reduced, it is structurally impossible. NEAREST always: the stage
     * reads it with texelFetch, and a LINEAR table would interpolate between
     * adjacent entries of a step function.
     */
    lut(bytes768) {
      return acquire(bytes768, 256 * 4, bytes768, () => {
        const rgba = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
          rgba[i * 4] = bytes768[i];
          rgba[i * 4 + 1] = bytes768[256 + i];
          rgba[i * 4 + 2] = bytes768[512 + i];
          rgba[i * 4 + 3] = 255;
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      });
    },

    /** The white 1x1 R8 stand-in for uMask and uClip. Binds nothing; see above. */
    blankR8: () => whiteR8,

    /** The white 1x1 RGBA stand-in for uLut when the adjustment stage is off. */
    blankRgba: () => whiteRgba,

    /** Drop one entry, for a caller that wrote into a buffer in place. */
    invalidate(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      gl.deleteTexture(entry.texture);
      bytes -= entry.bytes;
      entries.delete(key);
      return true;
    },

    /** What the GPU is holding for uploads right now, excluding render targets. */
    get bytes() { return bytes; },
    get size() { return entries.size; },
    /** Uploads performed. A steady frame should add none. */
    get uploads() { return uploads; },

    /**
     * Drop every cached upload, keeping the stand-ins. For closing a document:
     * the renderer stays usable and the next frame re-uploads what it needs.
     */
    clearUploads() {
      for (const entry of entries.values()) gl.deleteTexture(entry.texture);
      entries.clear();
      bytes = 0;
    },

    dispose() {
      this.clearUploads();
      gl.deleteTexture(whiteR8);
      gl.deleteTexture(whiteRgba);
    },
  };
}
