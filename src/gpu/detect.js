/**
 * Which of the three render tiers this device gets, and why.
 *
 * Split deliberately: selectTier is pure and covered by `npm test`, while the
 * parts that need a real context are thin wrappers around it. Node has no
 * WebGL, so the decision logic is the only piece of tier selection a Node suite
 * can hold -- and it is the piece most likely to be wrong.
 */

/** WebGL2 in a worker: the worker owns the canvas via transferControlToOffscreen. */
export const TIER_WORKER_GPU = 1;
/** WebGL2 on the main thread, rendering straight to the visible canvas. */
export const TIER_MAIN_GPU = 2;
/** JS compositing plus the sandwich cache, wherever the pixels already are. */
export const TIER_JS = 3;

/**
 * Straight (unassociated) alpha end to end, matching blendInto.
 *
 * `failIfMajorPerformanceCaveat` is deliberately absent: it is inconsistently
 * implemented across browsers and would risk demoting working devices. Keeping
 * software WebGL2 out of tiers 1 and 2 is a named open question, not a decision.
 */
export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  premultipliedAlpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
});

/**
 * @param {{offscreenCanvas?: boolean, transferControl?: boolean, webgl2?: boolean,
 *          probe?: {ok: boolean, reason?: string} | null,
 *          override?: number | null}} [caps]
 * @returns {{tier: 1|2|3, verdict: string}} `verdict` is shown verbatim on /harness.
 */
export function selectTier(caps = {}) {
  const {
    offscreenCanvas = false, transferControl = false, webgl2 = false,
    probe = null, override = null,
  } = caps;

  if (override === TIER_WORKER_GPU || override === TIER_MAIN_GPU || override === TIER_JS)
    return { tier: override, verdict: `forced by ?tier=${override}` };

  if (!webgl2) return { tier: TIER_JS, verdict: 'no WebGL2 context' };

  // getContext('webgl2') !== null says nothing about whether the driver's shader
  // compiler works. Without a probe that compiled, linked and READ BACK a real
  // blend, a GPU tier is a guess -- and the failure it hides is an all-black
  // canvas on one phone model.
  if (!probe) return { tier: TIER_JS, verdict: 'shader probe not run' };
  if (!probe.ok) return { tier: TIER_JS, verdict: `shader probe failed: ${probe.reason || 'unknown'}` };

  if (!offscreenCanvas)
    return { tier: TIER_MAIN_GPU, verdict: 'no OffscreenCanvas — WebGL2 on the main thread' };

  // OffscreenCanvas and transferControlToOffscreen are SEPARATE features: Safari
  // shipped the constructor before the transfer method (16.4, 2023). Probing the
  // constructor alone would put older iOS Safari in tier 1 and give it a canvas
  // it cannot present.
  if (!transferControl)
    return {
      tier: TIER_MAIN_GPU,
      verdict: 'OffscreenCanvas without transferControlToOffscreen — WebGL2 on the main thread',
    };

  return { tier: TIER_WORKER_GPU, verdict: 'WebGL2 in a worker' };
}

/** `?tier=1|2|3` -> a number; anything else -> null. Pure, so it is tested. */
export function tierOverrideFrom(search) {
  const value = Number(new URLSearchParams(search || '').get('tier'));
  return value === TIER_WORKER_GPU || value === TIER_MAIN_GPU || value === TIER_JS ? value : null;
}

/**
 * The cheap main-thread half of detection.
 *
 * No shaders: it answers "is a GPU tier even worth probing", and reports the
 * device's own limits so a real phone can tell us what it supports rather than
 * us guessing. `probe` is left null on purpose -- selectTier refuses a GPU tier
 * until the authoritative probe has filled it in.
 *
 * The throwaway context is released immediately. Browsers cap contexts per page
 * and evict the oldest, and the compositor owns the only one that matters.
 */
export function probeCapabilities() {
  const caps = {
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    transferControl:
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
    webgl2: false,
    maxTextureSize: 0,
    maxViewport: 0,
    probe: null,
  };

  if (typeof document === 'undefined') return caps;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  if (!gl) return caps;

  caps.webgl2 = true;
  caps.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  caps.maxViewport = Math.min(...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  return caps;
}
