/**
 * Executes a GPU draw plan on a WebGL2 context.
 *
 * WHAT THIS FILE IS AND IS NOT. `buildDrawPlan` already decided the frame:
 * which layers draw, in what order, through which program, at what rect, where
 * clip runs open and close, and whether the frame is affordable at all. This
 * file DOES those steps and decides nothing. Every place it would be tempting
 * to re-derive a decision -- a run boundary, a filter, an opacity, a program
 * name -- is a place the two halves can drift, and the plan's own docstring
 * names that as the failure this project keeps hitting.
 *
 * WHAT `npm test` CAN AND CANNOT SAY ABOUT IT. Node has no WebGL. The suite
 * drives this module against a recording fake context, which proves the
 * COMMAND SEQUENCE: that programs are compiled once per mode, that clipped
 * members bind the clip plane and the base does not, that a group pair is
 * allocated only for a run, that every resource created is deleted, that a
 * refused plan allocates nothing. It proves NOTHING about pixels. Pixel parity
 * against the JS oracle is measured on a device, by the conformance route, and
 * nowhere else.
 *
 * THE FRAME'S GPU COST, stated plainly because textures are invisible to
 * `estimatePeakBytes`:
 *
 *   - render targets: 2 x w x h x 4 for the canvas pair, plus, when the frame
 *     has at least one clip run, another 2 x w x h x 4 for the group pair and
 *     w x h for the R8 clip plane. At 2048x2048 that is 33.5 MB, or 50.3 MB
 *     with clipping. Freed when the canvas size changes, when the plan stops
 *     needing a group, and on `dispose()`.
 *   - uploads: one RGBA8 texture per DISTINCT source buffer, one R8 per
 *     distinct mask, 1 KB per distinct LUT. Cached across frames by buffer
 *     identity, so a drag uploads nothing after its first frame, and evicted
 *     least-recently-used down to the budget. `bytes` is the live total.
 *
 * A leaked texture per frame kills a phone in seconds, so nothing here
 * allocates a texture or a framebuffer per draw: every allocation is in
 * `textures.js` behind an identity cache, or in `targets.js` behind a size
 * check.
 *
 * NOTHING HERE THROWS. Context loss is a normal event on mobile -- the tab
 * backgrounds, the driver resets -- and a shader that will not compile is a
 * normal outcome on an unknown GPU. Both have a correct, slower JS tier behind
 * them. An exception escaping into a render loop would take the frame and often
 * the app with it, so every entry point returns `{ok: false, reason}` instead.
 */
import { buildDrawPlan } from './plan.js';
import { createProgramCache, UNIT } from './programs.js';
import { createTextureStore } from './textures.js';
import { createTargetStore } from './targets.js';

/**
 * The plan's own filter rule, for the one step that does not carry the field.
 *
 * `clip-alpha` reduces the SAME source at the SAME rect as the base draw step
 * immediately before it, so it must sample it the same way -- a base drawn
 * NEAREST and reduced LINEAR would put the run's alpha plane on a different
 * footing from the pixels it came from. test/gpu.mjs pins this against the
 * base step's own `filter` so the two cannot drift.
 */
const filterFor = (rect, source) =>
  (rect.width === source.width && rect.height === source.height ? 'nearest' : 'linear');

/**
 * @param {WebGL2RenderingContext} gl
 * @param {{budgetBytes?: number}} [options]  `budgetBytes` caps the UPLOAD
 *   cache only. Render targets are not evictable -- the frame cannot be drawn
 *   without them -- and are what `buildDrawPlan` refuses over.
 */
export function createGpuRenderer(gl, options = {}) {
  const programs = createProgramCache(gl);
  const textures = createTextureStore(gl, options);
  const targets = createTargetStore(gl);

  // An empty VAO. WebGL2 permits drawing with the default one, but a handful of
  // drivers validate attribute state against it and reject a draw with no
  // enabled arrays. The full-canvas triangle comes from gl_VertexID, so this
  // VAO stays empty for the life of the context.
  const vao = gl.createVertexArray();
  let readback = null;   // Uint8Array scratch, grown monotonically
  let disposed = false;
  let draws = 0;

  const lost = () => disposed || gl.isContextLost();

  const bind = (unit, texture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  };

  const useTarget = (target) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, targets.width, targets.height);
  };

  const clear = (target) => {
    useTarget(target);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  /**
   * One composite draw: source over backdrop, with the blend mode's program.
   *
   * `uOpacity`, `uRect` and the program all come from the step. A group's base
   * arrives here with opacity 1 and program `normal` because the plan already
   * moved its real opacity and mode onto `group-end`; recomputing either from
   * the layer would apply them twice.
   */
  const drawStep = (step, source, pair) => {
    const entry = programs.blend(step.program);
    if (!entry) return false;

    const read = pair.read();
    const write = pair.write();
    useTarget(write);
    gl.useProgram(entry.program);

    bind(UNIT.backdrop, read.texture);

    gl.activeTexture(gl.TEXTURE0 + UNIT.source);
    if (source.texture) gl.bindTexture(gl.TEXTURE_2D, source.texture);
    else textures.rgba(source.buffer, step.filter);

    gl.activeTexture(gl.TEXTURE0 + UNIT.mask);
    gl.bindTexture(gl.TEXTURE_2D,
      step.mask ? textures.r8(step.mask, step.filter) : textures.blankR8());

    bind(UNIT.clip, step.clip ? targets.clipTarget().texture : textures.blankR8());

    gl.activeTexture(gl.TEXTURE0 + UNIT.lut);
    gl.bindTexture(gl.TEXTURE_2D,
      step.adjustFlags & 1 ? textures.lut(step.lut) : textures.blankRgba());

    const at = entry.at;
    gl.uniform4f(at.uRect, step.rect.left, step.rect.top, step.rect.width, step.rect.height);
    gl.uniform2f(at.uCanvas, targets.width, targets.height);
    gl.uniform1f(at.uOpacity, step.opacity);
    gl.uniform1i(at.uUseMask, step.mask ? 1 : 0);
    gl.uniform1i(at.uUseClip, step.clip ? 1 : 0);
    gl.uniform1i(at.uAdjustFlags, step.adjustFlags);
    if (step.adjustFlags & 2) {
      gl.uniform1fv(at.uHslCentres, step.hsl.centres);
      gl.uniform1fv(at.uHslBands, step.hsl.bands);
      gl.uniform1f(at.uHslSaturation, step.hsl.saturation);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    draws++;
    pair.swap();
    return true;
  };

  /**
   * The `clip-alpha` reduction: the run base's alpha over the whole canvas.
   *
   * Writes the WHOLE plane, zero outside the rect, so it needs no clear -- and
   * must not be given one, because a clear plus a scissored draw would leave
   * the previous run's alpha wherever this run's base does not reach.
   */
  const clipAlphaStep = (step) => {
    const entry = programs.clipAlpha();
    if (!entry) return false;
    const filter = filterFor(step.rect, step.source);

    useTarget(targets.clipTarget());
    gl.useProgram(entry.program);

    gl.activeTexture(gl.TEXTURE0 + UNIT.source);
    textures.rgba(step.source, filter);

    gl.activeTexture(gl.TEXTURE0 + UNIT.mask);
    gl.bindTexture(gl.TEXTURE_2D, step.mask ? textures.r8(step.mask, filter) : textures.blankR8());

    const at = entry.at;
    gl.uniform4f(at.uRect, step.rect.left, step.rect.top, step.rect.width, step.rect.height);
    gl.uniform2f(at.uCanvas, targets.width, targets.height);
    gl.uniform1f(at.uOpacity, step.opacity);
    gl.uniform1i(at.uUseMask, step.mask ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    draws++;
    return true;
  };

  const canvasPair = {
    read: () => targets.canvasReadTarget(),
    write: () => targets.canvasWriteTarget(),
    swap: () => targets.swapCanvas(),
  };
  const groupPair = {
    read: () => targets.groupReadTarget(),
    write: () => targets.groupWriteTarget(),
    swap: () => targets.swapGroup(),
  };

  /**
   * Execute one plan.
   *
   * @param {object} plan  a `buildDrawPlan` result. A plan with `ok: false` is
   *   returned straight back, unexecuted and having allocated nothing: the
   *   refusal is the plan's decision, and second-guessing it here is how an
   *   over-budget document loses the context it was refused to protect.
   * @returns {{ok: boolean, reason: string|null, draws: number}}
   */
  const render = (plan) => {
    if (!plan || !plan.ok) return { ok: false, reason: (plan && plan.reason) || 'no plan', draws: 0 };
    if (lost()) return { ok: false, reason: 'the WebGL2 context is lost', draws: 0 };

    const before = draws;
    try {
      if (!targets.ensure(plan.width, plan.height, plan.groups > 0))
        return { ok: false, reason: targets.reason || 'render targets could not be allocated', draws: 0 };

      textures.beginFrame();

      // Blending, depth, scissor and culling all OFF. The fragment shader is
      // the entire composite -- `blendInto`'s straight-alpha divide by `ao` has
      // no glBlendFunc equivalent, so a fixed-function blend left enabled from
      // elsewhere would silently apply on top of it.
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);

      // Only the pair's READ side needs clearing. Every fragment of every draw
      // writes the WRITE side -- the rect clamp returns the backdrop rather
      // than discarding -- so the other buffer is fully overwritten before it
      // is ever read. A plan with no draws at all correctly yields this clear.
      clear(targets.canvasReadTarget());

      let pair = canvasPair;

      for (const step of plan.steps) {
        switch (step.kind) {
          case 'group-begin':
            clear(targets.groupReadTarget());
            pair = groupPair;
            break;

          case 'draw':
            if (!drawStep(step, { buffer: step.source }, pair))
              return { ok: false, reason: programs.reason, draws: draws - before };
            break;

          case 'clip-alpha':
            if (!clipAlphaStep(step))
              return { ok: false, reason: programs.reason, draws: draws - before };
            break;

          case 'group-end': {
            // The group, composited onto the canvas with the BASE's own opacity
            // and blend mode -- which belong to the whole run, exactly as
            // drawClipRunInto's final blendInto spends them.
            const group = targets.groupReadTarget();
            pair = canvasPair;
            const composite = {
              ...step,
              rect: { left: 0, top: 0, width: targets.width, height: targets.height },
              filter: 'nearest',
              mask: null,
              adjustFlags: 0,
            };
            if (!drawStep(composite, { texture: group.texture }, canvasPair))
              return { ok: false, reason: programs.reason, draws: draws - before };
            break;
          }

          default:
            // A plan kind this renderer does not implement is a refusal, never
            // a skip: skipping it would drop a layer and still report success.
            return { ok: false, reason: `unknown plan step kind: ${step.kind}`, draws: draws - before };
        }
      }

      if (lost()) return { ok: false, reason: 'the WebGL2 context was lost mid-frame', draws: draws - before };
      return { ok: true, reason: null, draws: draws - before };
    } catch (error) {
      // Includes a context lost between two calls, which surfaces as an
      // ordinary exception in some browsers rather than as isContextLost().
      return { ok: false, reason: `GPU render failed: ${error && error.message}`, draws: draws - before };
    }
  };

  /**
   * Read the finished accumulator back, row 0 first.
   *
   * NO FLIP, deliberately. `readPixels` starts at the framebuffer's lower-left,
   * which is where `vDstPx.y == 0` landed -- so the first row out is the first
   * row of the document, matching every Uint8ClampedArray in this engine. The Y
   * flip belongs to the present pass and only to it.
   *
   * Reads into a Uint8Array scratch and copies. `readPixels` is specified for
   * Uint8Array with UNSIGNED_BYTE, and Safari has rejected a Uint8ClampedArray
   * outright; one copy is cheaper than a browser-specific failure.
   *
   * @param {{width:number,height:number,data:Uint8ClampedArray}} buffer
   */
  const readInto = (buffer) => {
    if (lost() || !targets.width) return false;
    if (buffer.width !== targets.width || buffer.height !== targets.height) return false;
    try {
      const size = targets.width * targets.height * 4;
      if (!readback || readback.length < size) readback = new Uint8Array(size);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.canvasReadTarget().framebuffer);
      gl.readPixels(0, 0, targets.width, targets.height, gl.RGBA, gl.UNSIGNED_BYTE, readback);
      buffer.data.set(readback.subarray(0, size));
      return true;
    } catch (error) {
      return false;
    }
  };

  /**
   * Blit the accumulator to the visible drawing buffer, flipping Y.
   *
   * The source filter is chosen from the sizes and RESTORED to NEAREST
   * afterwards: the same texture is the next frame's backdrop, sampled at 1:1,
   * and leaving LINEAR on it would put four fetches and a driver's subtexel
   * precision between the compositor and an exact texel.
   */
  const present = () => {
    if (lost() || !targets.width) return false;
    const entry = programs.present();
    if (!entry) return false;
    try {
      const target = targets.canvasReadTarget();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const scaled = w !== targets.width || h !== targets.height;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.useProgram(entry.program);

      bind(UNIT.source, target.texture);
      const mode = scaled ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mode);

      gl.uniform2f(entry.at.uCanvas, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      draws++;

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return true;
    } catch (error) {
      return false;
    }
  };

  return {
    render,
    readInto,
    present,

    /** Plan and render one project in a single call. Used by the conformance route. */
    renderProject(project, planOptions = {}) {
      const plan = buildDrawPlan(project, planOptions);
      return { plan, ...render(plan) };
    },

    /** Live GPU bytes: render targets plus the upload cache. */
    get bytes() { return targets.bytes + textures.bytes; },
    get targetBytes() { return targets.bytes; },
    get uploadBytes() { return textures.bytes; },
    /** Programs compiled so far. A second frame in the same modes must add none. */
    get programsCompiled() { return programs.compiled; },
    /** Uploads performed so far. A steady drag must add none. */
    get uploads() { return textures.uploads; },
    get draws() { return draws; },
    get reason() { return programs.reason || targets.reason; },
    get lost() { return lost(); },

    /** Drop every cached upload but keep the targets. For closing a document. */
    releaseUploads() { textures.clearUploads(); },

    /**
     * Release everything this renderer holds on the GPU.
     *
     * MUST be called when the tier changes, the document closes, or the
     * component unmounts. Textures are invisible to `estimatePeakBytes` and to
     * the JS heap profiler, so a renderer left alive holds tens of megabytes
     * that nothing in the app can see or account for.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      programs.dispose();
      textures.dispose();
      targets.dispose();
      if (vao) gl.deleteVertexArray(vao);
      readback = null;
    },
  };
}
