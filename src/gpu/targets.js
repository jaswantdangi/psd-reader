/**
 * Render targets: the canvas ping-pong pair, the group ping-pong pair, and the
 * R8 clip-alpha plane.
 *
 * WHY PING-PONG AT ALL, when a GPU has fixed-function blending. Because six of
 * the 26 modes are NON-SEPARABLE: `hue`, `saturation`, `color`, `luminosity`,
 * `darker color` and `lighter color` compute a result from all three backdrop
 * channels at once, and no `glBlendFunc` can express that. And because
 * `blendInto`'s composite is a straight-alpha divide by `ao`, which the fixed
 * function pipeline also cannot express -- the two tiers would diverge on every
 * partially transparent pixel of every mode, not just the six.
 *
 * So the fragment shader does the whole composite itself and needs to READ the
 * destination. Reading and writing one texture in a single draw is undefined in
 * WebGL2 -- not slow, undefined -- so every draw reads one target of the pair
 * and writes the other, and the pair swaps. This is why plan.js budgets TWO
 * full-canvas RGBA8 targets and not one.
 *
 * WHAT IT COSTS, stated because it is not free: every draw touches the whole
 * canvas, not just the layer's rect, since the fragment outside the rect must
 * carry the backdrop across to the other buffer. A 20-layer 2048x2048 frame is
 * therefore ~84 M fragments of mostly-copy. That is roughly a millisecond of
 * fill on the low-end mobile parts this targets, against 651 ms for the JS
 * tier, so it is bought deliberately -- but a future scissored variant that
 * copies only the dirty span is the obvious next optimisation, and it is not
 * implemented here.
 *
 * ONE GROUP PAIR FOR THE WHOLE FRAME, not one per run. Clip runs are
 * consecutive spans of a flat list, so they can never nest, and both render.js
 * and plan.js count it this way for the same reason.
 */

/**
 * One colour texture and the framebuffer that draws into it.
 *
 * The framebuffer is created WITH the texture and dies WITH it. A framebuffer
 * outliving its attachment is the leak that survives every resize: it is
 * invisible to any per-frame accounting because it is bounded by resizes rather
 * than by frames, and each one still pins driver-side state.
 */
function createTarget(gl, width, height, format) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // NEAREST, always. A target is sampled at 1:1 -- as a backdrop, as a clip
  // plane, or as a group being composited onto the canvas -- so every sample
  // lands on a texel centre and LINEAR would be an identity that still costs
  // four fetches. It would also stop being an identity the moment a viewport
  // rounded differently, which is a bug that only appears at odd sizes.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const rgba = format === 'rgba';
  gl.texImage2D(gl.TEXTURE_2D, 0, rgba ? gl.RGBA8 : gl.R8, width, height, 0,
    rgba ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, null);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  // Checked, not assumed. R8 is required to be colour-renderable in WebGL2 and
  // RGBA8 certainly is, but a driver that refuses one of them here is a device
  // that must go to the JS tier -- and finding that out at the first draw
  // instead means a frame of garbage rather than a fallback.
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return { texture: null, framebuffer: null, bytes: 0, status };
  }

  return { texture, framebuffer, bytes: width * height * (rgba ? 4 : 1), status };
}

const destroy = (gl, target) => {
  if (!target) return;
  if (target.framebuffer) gl.deleteFramebuffer(target.framebuffer);
  if (target.texture) gl.deleteTexture(target.texture);
};

/**
 * @param {WebGL2RenderingContext} gl
 * @returns {object} `ensure(width, height, needGroup)` allocates or reuses;
 *   `canvas` and `group` are ping-pong pairs with `read`/`write`/`swap()`;
 *   `clip` is the R8 plane. `reason` is set instead of throwing when a
 *   framebuffer comes back incomplete.
 */
export function createTargetStore(gl) {
  let width = 0;
  let height = 0;
  let canvasA = null, canvasB = null;
  let groupA = null, groupB = null;
  let clip = null;
  let canvasRead = 0;   // 0 -> canvasA is the backdrop, 1 -> canvasB is
  let groupRead = 0;
  let reason = null;
  let allocations = 0;

  const freeGroup = () => { destroy(gl, groupA); destroy(gl, groupB); destroy(gl, clip);
    groupA = groupB = clip = null; };

  const freeAll = () => { destroy(gl, canvasA); destroy(gl, canvasB); canvasA = canvasB = null; freeGroup(); };

  const make = (w, h, format) => {
    const target = createTarget(gl, w, h, format);
    if (!target.texture) {
      reason = reason || `a ${w}x${h} ${format} render target came back incomplete (status 0x${(target.status || 0).toString(16)})`;
      return null;
    }
    allocations++;
    return target;
  };

  return {
    /**
     * Size the frame's targets. Reallocates only on a size change -- a drag
     * holds one size for hundreds of frames, and reallocating a full-canvas
     * pair per frame is the allocation pattern that loses a mobile context.
     *
     * The group pair and the clip plane are allocated only when the plan says a
     * run needs them, and FREED when a later plan says it does not. A document
     * whose clipped layer is deleted must stop paying for the group; keeping it
     * "in case" is a third of the frame's memory held for nothing.
     */
    ensure(w, h, needGroup) {
      if (reason) return false;
      if (w !== width || h !== height) {
        freeAll();
        width = w; height = h;
        canvasA = make(w, h, 'rgba');
        canvasB = make(w, h, 'rgba');
        if (!canvasA || !canvasB) { freeAll(); return false; }
      }
      if (needGroup && !groupA) {
        groupA = make(w, h, 'rgba');
        groupB = make(w, h, 'rgba');
        clip = make(w, h, 'r8');
        if (!groupA || !groupB || !clip) { freeGroup(); return false; }
      } else if (!needGroup && groupA) {
        freeGroup();
      }
      canvasRead = 0;
      groupRead = 0;
      return true;
    },

    get width() { return width; },
    get height() { return height; },
    get reason() { return reason; },
    /** Render-target allocations since construction. A steady drag must add none. */
    get allocations() { return allocations; },
    /** Live render-target bytes. Uploads are counted separately, in textures.js. */
    get bytes() {
      return [canvasA, canvasB, groupA, groupB, clip]
        .reduce((sum, t) => sum + (t ? t.bytes : 0), 0);
    },

    canvasReadTarget: () => (canvasRead === 0 ? canvasA : canvasB),
    canvasWriteTarget: () => (canvasRead === 0 ? canvasB : canvasA),
    swapCanvas() { canvasRead ^= 1; },

    groupReadTarget: () => (groupRead === 0 ? groupA : groupB),
    groupWriteTarget: () => (groupRead === 0 ? groupB : groupA),
    swapGroup() { groupRead ^= 1; },

    clipTarget: () => clip,

    dispose() { freeAll(); width = height = 0; },
  };
}
