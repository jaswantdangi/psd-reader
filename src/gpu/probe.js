/**
 * The authoritative shader probe `selectTier` refuses a GPU tier without.
 *
 * `getContext('webgl2') !== null` says nothing about whether the driver's
 * shader compiler works, whether R8 is renderable, or whether readback returns
 * what was drawn. Without a probe that COMPILED, LINKED and READ BACK a real
 * composite, a GPU tier is a guess -- and the failure it hides is an all-black
 * canvas on one phone model, reported as "the app is broken" with nothing in
 * the console.
 *
 * SO THE PROBE IS THE RENDERER, not a reduced imitation of it. It builds a real
 * plan, runs it through `createGpuRenderer`, reads the result back and compares
 * it against `renderProject` -- the same oracle the conformance route uses. A
 * probe that compiled its own trivial shader would pass on a device where the
 * generated ones fail, which is the only failure that matters.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not measure parity: eight pixels
 * cannot. It answers one question -- does this driver produce the right answer
 * for a case where there is exactly one right answer -- and leaves the
 * measurement to /demo/conformance.html, which sweeps all 65 536 channel pairs
 * per mode.
 *
 * TINY ON PURPOSE. Tier selection runs before the first frame, on the main
 * thread, on a phone. Two 4x2 layers compile two programs and read back 64
 * bytes; the whole probe is a fraction of one compile.
 */
import { createProject } from '../edit.js';
import { createBuffer } from '../composite.js';
import { renderProject } from '../render.js';
import { buildDrawPlan } from './plan.js';
import { createGpuRenderer } from './renderer.js';
import { CONTEXT_ATTRIBUTES } from './detect.js';

const W = 4;
const H = 2;

/** Deterministic, and deliberately not grey: the non-separable modes need three unlike channels. */
function probePattern(seed) {
  const buffer = createBuffer(W, H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    buffer.data[o] = (i * 37 + seed * 11) & 255;
    buffer.data[o + 1] = (i * 71 + seed * 53) & 255;
    buffer.data[o + 2] = (i * 19 + seed * 97) & 255;
    // Includes 0 and 255: the `as <= 0` early-out and the `ao == 1` case are
    // the two branches most likely to be miscompiled or optimised away.
    buffer.data[o + 3] = [0, 90, 255, 200, 255, 30, 255, 128][i];
  }
  return buffer;
}

/**
 * The probe document.
 *
 * `luminosity` on top of `multiply` is chosen, not arbitrary: it forces one
 * SEPARABLE program and one NON-SEPARABLE one, which is the pair that proves
 * the generated prelude compiles -- `setSat`, `clipColor`, the two EPS guards.
 * A driver that miscompiles the prelude is exactly the driver that produces a
 * plausible-looking wrong frame rather than an error.
 */
const probeProject = () => createProject({
  width: W, height: H,
  children: [0, 1, 2].map((i) => ({
    name: `probe-${i}`, left: 0, top: 0, right: W, bottom: H,
    blendMode: ['normal', 'multiply', 'luminosity'][i],
    proxyData: probePattern(i),
  })),
}, 'probe.psd');

/**
 * Run the probe on an existing context.
 *
 * @param {WebGL2RenderingContext} gl
 * @returns {{ok: boolean, reason: string|null, maxDelta: number}}
 *   Shaped for `selectTier({probe})`, whose verdict prints `reason` verbatim on
 *   the harness -- so the reason has to be actionable on its own, carrying the
 *   driver's info log or the exact delta rather than "probe failed".
 */
export function probeShaders(gl) {
  if (!gl) return { ok: false, reason: 'no WebGL2 context', maxDelta: 255 };

  const renderer = createGpuRenderer(gl);
  try {
    const project = probeProject();
    const plan = buildDrawPlan(project);
    if (!plan.ok) return { ok: false, reason: `the probe plan was refused: ${plan.reason}`, maxDelta: 255 };

    const out = renderer.render(plan);
    if (!out.ok) return { ok: false, reason: out.reason, maxDelta: 255 };

    const gpu = createBuffer(plan.width, plan.height);
    if (!renderer.readInto(gpu))
      return { ok: false, reason: 'the probe rendered but could not be read back', maxDelta: 255 };

    // Compared RAW, not flattened. A probe is not a parity measurement, and
    // flattening would hide a GPU that wrote garbage into the RGB of a
    // transparent pixel -- which is precisely what an unguarded NaN does.
    const js = renderProject(project);
    let maxDelta = 0;
    for (let i = 0; i < gpu.data.length; i++) {
      const d = Math.abs(gpu.data[i] - js.data[i]);
      if (d > maxDelta) maxDelta = d;
    }

    // Tolerance 1, the same floor compareRenders uses: GLSL ES 3.00 has no
    // `precise` qualifier, so one greylevel of reassociation is expected. Two
    // is not, at eight pixels.
    if (maxDelta > 1)
      return {
        ok: false,
        reason: `the probe composite differs from renderProject by ${maxDelta} greylevels — ` +
          'this driver would render a wrong frame, not a slow one',
        maxDelta,
      };

    return { ok: true, reason: null, maxDelta };
  } catch (error) {
    return { ok: false, reason: `the probe threw: ${error && error.message}`, maxDelta: 255 };
  } finally {
    // ALWAYS. The probe's context is usually the compositor's own, and a probe
    // that left three textures and two framebuffers behind would leak them for
    // the life of the page while looking like a success.
    renderer.dispose();
  }
}

/**
 * Full capability detection, including the probe, on a throwaway context.
 *
 * `probeCapabilities` in detect.js deliberately stops short of this -- it is the
 * cheap half and leaves `probe` null so `selectTier` refuses a GPU tier until
 * somebody does the expensive half. This is that half, in the one shape a
 * caller with no context of its own can use.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} [canvas]  reuse the real one where
 *   there is one. Browsers cap WebGL contexts per page and evict the oldest, so
 *   probing on a throwaway can cost the compositor the context it is holding.
 * @returns {{webgl2: boolean, maxTextureSize: number, probe: object|null, ...}}
 */
export function probeGpu(canvas) {
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

  let surface = canvas;
  let borrowed = true;
  if (!surface) {
    if (typeof document === 'undefined') return caps;
    surface = document.createElement('canvas');
    surface.width = 1;
    surface.height = 1;
    borrowed = false;
  }

  let gl = null;
  try { gl = surface.getContext('webgl2', CONTEXT_ATTRIBUTES); } catch { gl = null; }
  if (!gl) return caps;

  caps.webgl2 = true;
  caps.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  caps.maxViewport = Math.min(...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  caps.probe = probeShaders(gl);

  // Only a context this function created is thrown away. Losing a caller's
  // context because it asked a question about it would be the worst kind of
  // helpful.
  if (!borrowed) gl.getExtension('WEBGL_lose_context')?.loseContext();

  return caps;
}
