/**
 * The GPU draw plan: what a WebGL2 renderer would do for one frame, decided
 * without touching WebGL.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE RENDERER. Node has no WebGL, so nothing
 * in `npm test` can prove a pixel this path produces. What it CAN prove is the
 * decisions: which layers draw, in what order, through which program, at what
 * rect, where clip runs open and close, and what the whole frame would cost in
 * texture memory. Every one of those is a place where a GPU renderer silently
 * diverges from `renderProject` — and every one is checkable here, on a plain
 * object, before a single shader is compiled. The half that cannot be proven in
 * Node is deliberately not written yet.
 *
 * THE PLAN IS NOT AN OPTIMISATION. It is a transcription of the walk
 * `renderProject` runs, step for step:
 *
 *   - bottom to top, one CLIP RUN at a time, `clipRunEnd` deciding where each
 *     run stops. The run boundary is READ FROM render.js, not re-derived here.
 *     A second implementation of run-finding is the exact failure this project
 *     keeps hitting — `planSpill` and the export walk needed a pinning
 *     assertion to stop them drifting — and a plan that split a run would emit
 *     a clipped layer with no base alpha under it, which renders as an
 *     unclipped layer and looks like a success.
 *   - a run of one takes the plain single-layer path and allocates no group,
 *     exactly as `drawClipRunInto` does at `end === index + 1`.
 *   - the same skips `drawLayerInto` and `prepareLayer` take: not visible, zero
 *     opacity, no pixels, rect entirely off-canvas. A step planned for one of
 *     those would draw something `renderProject` does not.
 *   - a hidden or pixel-less BASE takes its whole run with it, because the
 *     clipped layers are visible only through the base's alpha.
 *
 * WHAT IT REFUSES, rather than approximating. Refusal is the whole point of the
 * `ok` / `reason` pair: `selectTier` can fall back to the JS tier, which is
 * correct and merely slower. Rendering a wrong frame is not recoverable.
 *
 *   - an overlay adjustment, which `ops.js` marks class P with `glsl: null` —
 *     there is no shader for it, and drawing the layer anyway would silently
 *     drop the gradient;
 *   - a layer carrying Blend If ranges, which `blendInto` applies from BOTH the
 *     source and the destination pixel and which glsl.js has no stage for. The
 *     GPU would render it as though the ranges were default: a plausible frame
 *     that disagrees with the inspector and with `renderProject`;
 *   - a canvas or a source texture past `maxTextureSize`, because tiled upload
 *     is not implemented and clamping would render the top-left corner of the
 *     document at full size and call it a frame;
 *   - a frame whose textures exceed the GPU budget.
 */
import { programNameFor } from './modes.js';
import { clipRunEnd } from '../render.js';
import { parseBlendIf } from '../composite.js';
import { isNeutralAdjust, adjustCostOf, lutFor } from '../adjust/lut.js';
import { HSL_BANDS } from '../adjust/ops.js';

const MB = 1024 * 1024;

/**
 * Texture bytes one frame may claim on the GPU.
 *
 * DELIBERATELY NOT DERIVED FROM `src/budget.js`. `memoryBudgetBytes` and
 * `estimatePeakBytes` budget HOST memory during a PSD decode — the file held
 * whole in one ArrayBuffer, the layer buffers, the clip scratch. Textures are
 * not those bytes: they live in driver memory, they are not visible to
 * `estimatePeakBytes` at all, and on a discrete GPU they are not even on the
 * same chip. Adding them to that total, or taking a fraction of it, would claim
 * a relationship that does not exist.
 *
 * They do interact in one direction only, and it is worth saying: an upload
 * transiently costs the host side too, so a plan that fits here can still be
 * refused by the host budget. The reverse does not hold.
 *
 * 256 MB is a deliberate low-end-mobile figure rather than a measured one — a
 * WebGL2 context on a 1 GB Android device starts losing the context well before
 * this. There is no `navigator.gpuMemory`, so any number here is a policy, and
 * a policy that refuses early costs a slower JS frame while one that refuses
 * late costs a lost context and a black canvas. Pass `budgetBytes` to override.
 */
export const GPU_BUDGET_BYTES = 256 * MB;

/**
 * WebGL2's guaranteed floor for MAX_TEXTURE_SIZE. Used only when the caller
 * does not pass the real one; a caller that has a context must pass
 * `gl.getParameter(gl.MAX_TEXTURE_SIZE)` instead, or documents this device
 * could have drawn get refused.
 */
const MIN_MAX_TEXTURE_SIZE = 2048;

/** RGBA8 256x1, the class-A LUT as the shader samples it. */
const LUT_BYTES = 256 * 4;

/**
 * The destination rect, byte for byte the arithmetic in `prepareLayer`.
 *
 * Not shared with it by import: `prepareLayer` is module-private in render.js
 * and also attaches the resampled mask to what it returns, which is a CPU
 * buffer this plan must not build. The four lines are pinned by
 * "the destination rect is prepareLayer arithmetic, at any scale" instead.
 */
const rectFor = (layer, scale) => ({
  left: Math.round(layer.x * scale),
  top: Math.round(layer.y * scale),
  width: Math.max(1, Math.round(layer.w * scale)),
  height: Math.max(1, Math.round(layer.h * scale)),
});

const onCanvas = (rect, width, height) =>
  rect.left < width && rect.top < height &&
  rect.left + rect.width > 0 && rect.top + rect.height > 0;

/** `prepareLayer` honours `disabled`; Photoshop saves switched-off masks. */
const maskOf = (layer) => (layer.mask && !layer.mask.disabled ? layer.mask : null);

/**
 * Which stages the adjustment pass would run, as a bitfield.
 *
 *   bit 0 (1) — the class-A LUT
 *   bit 1 (2) — the HSL stage
 *
 * Bit 0 is set whenever the pass runs AT ALL, including for an HSL-only
 * adjustment: `applyAdjustments` fetches the LUT unconditionally, and a shader
 * that skipped it for an HSL-only layer would diverge from the oracle by the
 * rounding of one table lookup. 0 means the stage does not run — a neutral
 * adjustment must cost exactly what no adjustment costs.
 */
const adjustFlagsFor = (adjust) => {
  if (!adjust || isNeutralAdjust(adjust)) return 0;
  return 1 | (adjustCostOf(adjust).hsl ? 2 : 0);
};

/** The HSL uniforms, packed in HSL_BANDS order — the order `bandWeights` reads. */
const hslUniformsFor = (adjust) => {
  const bands = new Float32Array(HSL_BANDS.length * 3);
  for (let i = 0; i < HSL_BANDS.length; i++) {
    const b = adjust.hsl.bands[i] || { h: 0, s: 0, l: 0 };
    bands[i * 3] = b.h;
    bands[i * 3 + 1] = b.s;
    bands[i * 3 + 2] = b.l;
  }
  return {
    centres: Float32Array.from(HSL_BANDS, (b) => b.centre),
    bands,
    saturation: adjust.hsl.saturation,
  };
};

/**
 * @param {object} project
 * @param {{scale?: number, maxTextureSize?: number, budgetBytes?: number}} [options]
 * @returns {{ok: boolean, reason: string|null, width: number, height: number,
 *            groups: number, bytes: number, steps: object[]}}
 *   `steps` is the frame in draw order. Kinds:
 *     `draw`        — one layer, into `target` ('canvas' | 'group'), with the
 *                     clip alpha plane bound when `clip` is true.
 *     `group-begin` — open a run's group target; the base draws into it at
 *                     opacity 1, mode normal.
 *     `clip-alpha`  — take the base's alpha, AFTER its mask and adjustments,
 *                     into the R8 clip plane.
 *     `group-end`   — composite the group onto the canvas with the BASE's own
 *                     opacity and blend mode, which belong to the whole run.
 *   `bytes` is what the frame would hold in texture memory; `groups` is how
 *   many clip runs needed a group target.
 */
export function buildDrawPlan(project, options = {}) {
  const {
    scale = 1,
    maxTextureSize = MIN_MAX_TEXTURE_SIZE,
    budgetBytes = GPU_BUDGET_BYTES,
  } = options;

  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));

  const steps = [];
  const layers = project.layers;
  let groups = 0;
  let reason = null;

  // Every distinct texture the frame uploads, by object identity: two layers
  // sharing one pixel buffer share one texture, and pay for it once.
  const sources = new Set();
  const masks = new Set();
  const luts = new Set();
  let oversize = null;

  /** null when this layer draws nothing — the same four skips prepareLayer takes. */
  const drawStepFor = (layer, index, target, clip) => {
    if (!layer.visible || layer.opacity <= 0) return null;
    const source = layer.pixels;
    if (!source || !source.width || !source.height) return null;
    const rect = rectFor(layer, scale);
    if (!onCanvas(rect, width, height)) return null;

    const mask = maskOf(layer);
    const flags = adjustFlagsFor(layer.adjust);

    if (adjustCostOf(layer.adjust).overlay && !reason)
      reason =
        `${layer.name} carries an overlay adjustment, which has no GPU program: ` +
        'a per-layer overlay blend mode multiplied by the layer\'s own is a 26x26 ' +
        'program matrix that programNameFor cannot express. Render this document on the JS tier.';

    // Blend If. `blendInto` multiplies `as` by a factor read from BOTH the
    // source and the destination pixel, through a four-stop ramp per channel
    // plus a Gray composite -- and glsl.js has no such stage, so a document
    // using it would render on the GPU exactly as if the ranges were default:
    // a plausible frame that disagrees with the inspector and with
    // renderProject, silently, which is the worst of the three outcomes.
    //
    // REFUSED RATHER THAN IMPLEMENTED, on purpose. The JS tier is correct and
    // merely slower, the fallback already exists and is tested, and a second
    // implementation of the ramp is exactly the drift this file's own docstring
    // exists to prevent.
    //
    // `parseBlendIf` is IMPORTED, never re-derived. What counts as a default
    // range (0/0/255/255, per stop, across the Gray pair and up to three
    // channel pairs) now has one implementation and has to keep having one; a
    // second copy here would decide differently the first time ag-psd's field
    // names or the channel-order assumption changed. It returns null and
    // allocates nothing on the twenty of twenty-one fixtures that do not use
    // the feature, so this check is free for everything that does not.
    if (!reason && parseBlendIf(layer))
      reason =
        `${layer.name} carries Blend If ranges, which have no GPU stage: the factor ` +
        'depends on the destination pixel through a per-channel four-stop ramp that ' +
        'glsl.js does not implement, and drawing the layer anyway would render it as ' +
        'though the ranges were default. Render this document on the JS tier.';

    if (source.width > maxTextureSize || source.height > maxTextureSize)
      oversize = oversize || { what: `${layer.name} source`, w: source.width, h: source.height };

    sources.add(source);
    if (mask) masks.add(mask);

    return {
      kind: 'draw',
      index,
      name: layer.name,
      target,
      // The base of a run is NOT clipped by its own alpha; only the members
      // above it are. A run reaching the bottom of the stack has no base under
      // it, so its lowest member becomes its own base and draws unclipped —
      // which is what clipRunStart already says and what renderList has always
      // done.
      clip,
      // The base's opacity and blend mode are spent on group-end, never here.
      program: target === 'group' && !clip ? 'normal' : programNameFor(layer.blendMode),
      opacity: target === 'group' && !clip ? 1 : layer.opacity,
      rect,
      // At 1:1 NEAREST lands on texel centres and the blit is bit-exact. This
      // is exactly the condition resample() identity-returns on, so the two
      // tiers agree on when interpolation happens at all.
      filter: rect.width === source.width && rect.height === source.height ? 'nearest' : 'linear',
      source,
      mask,
      adjustFlags: flags,
      lut: flags ? lutFor(layer) : null,
      hsl: flags & 2 ? hslUniformsFor(layer.adjust) : null,
    };
  };

  // Bottom to top, one clip run at a time. `clipRunEnd` is imported rather than
  // reimplemented so the plan cannot drift from the walk renderProject runs.
  for (let i = 0; i < layers.length; ) {
    const end = clipRunEnd(layers, i);
    const base = layers[i];

    if (end === i + 1) {
      const step = drawStepFor(base, i, 'canvas', false);
      if (step) steps.push(step);
      i = end;
      continue;
    }

    // A run. The base goes into a group at opacity 1 mode normal; its own
    // opacity and blend mode are spent on group-end. A base that draws nothing
    // takes the whole run with it — the clipped layers are visible only
    // through its alpha.
    const baseStep = drawStepFor(base, i, 'group', false);
    if (!baseStep) { i = end; continue; }

    groups++;
    steps.push({ kind: 'group-begin', index: i, width, height });
    steps.push(baseStep);
    // clipAlphaMap reads the base's alpha AFTER its mask and its adjustments,
    // at opacity 1 — the base's own opacity belongs to group-end. Same rect the
    // base was drawn with, or the plane would be offset from the pixels it came
    // from.
    steps.push({
      kind: 'clip-alpha',
      index: i,
      rect: baseStep.rect,
      source: baseStep.source,
      mask: baseStep.mask,
      opacity: 1,
    });

    for (let m = i + 1; m < end; m++) {
      const step = drawStepFor(layers[m], m, 'group', true);
      if (step) steps.push(step);
    }

    steps.push({
      kind: 'group-end',
      index: i,
      target: 'canvas',
      clip: false,
      program: programNameFor(base.blendMode),
      opacity: base.opacity,
    });
    i = end;
  }

  for (const step of steps) if (step.lut) luts.add(step.lut);

  const px = width * height;
  let bytes = 2 * px * 4;                       // the canvas ping-pong pair
  // ONE group pair for the whole frame, not one per run: clip runs are
  // consecutive spans of a flat list, so they can never nest, and render.js
  // finishes one before it starts the next. src/budget.js counts its CPU twin
  // the same way and for the same reason.
  if (groups > 0) bytes += 2 * px * 4 + px;     // group pair + the R8 clip alpha plane
  for (const s of sources) bytes += s.width * s.height * 4;
  for (const m of masks) bytes += m.width * m.height;   // one byte per source pixel, never four
  bytes += luts.size * LUT_BYTES;

  if (!reason && (width > maxTextureSize || height > maxTextureSize))
    oversize = oversize || { what: 'the canvas', w: width, h: height };

  if (!reason && oversize)
    reason =
      `${oversize.what} is ${oversize.w}x${oversize.h}, past this device's maximum texture size ` +
      `of ${maxTextureSize}. Tiled upload is not implemented, and clamping would render a corner ` +
      'of the document at full size.';

  if (!reason && bytes > budgetBytes)
    reason =
      `this frame would hold ${bytes} bytes of texture memory, past the GPU budget of ` +
      `${budgetBytes} bytes.`;

  return { ok: reason === null, reason, width, height, groups, bytes, steps };
}
