/**
 * Deterministic inputs and the pass rule for the GPU conformance route.
 *
 * Lives in src/ rather than in the app for one reason: the JS half runs as a
 * Node test, so the oracle the GPU is measured against is itself covered by
 * `npm test`. The GPU half runs on a device, at /conformance.
 *
 * The 21 PSD fixtures exercise only the modes Photoshop's own feature tests
 * happen to use -- most of the 26 are not among them, and a broken setSat would
 * sail straight through a fixtures-only suite. This synthetic matrix is what
 * actually covers the mode table.
 */
import { createBuffer, compareBuffers, flattenOnto, SUPPORTED_BLEND_MODES } from './composite.js';
import { createProject } from './edit.js';

/** Both extremes are present: 0 is where JS `continue`s, 255 is where ao == 1. */
const ALPHA_BANDS = [0, 1, 64, 127, 128, 200, 254, 255];

export const CONFORMANCE_SIZE = 256;

/** All 26, so the route's table has a row per implemented mode. */
export const CONFORMANCE_MODES = SUPPORTED_BLEND_MODES;

/**
 * A full-canvas pattern that sweeps all four channels.
 *
 * @param {number} [width]
 * @param {number} [height]
 * @param {'backdrop'|'source'} [role]
 */
export function conformancePattern(width = CONFORMANCE_SIZE, height = CONFORMANCE_SIZE, role = 'backdrop') {
  const buffer = createBuffer(width, height);
  const source = role === 'source';

  for (let y = 0; y < height; y++) {
    // Offset between the roles so a pixel rarely carries the same alpha in both:
    // ao == 1, ao == 0 and everything between all need exercising.
    const alpha = ALPHA_BANDS[((source ? (y >> 5) + 4 : y >> 5) & 7)];

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // RED is the exhaustive sweep: backdrop.r = x, source.r = y, so across a
      // 256x256 buffer every one of the 65 536 (backdrop, source) byte pairs
      // occurs exactly once. `hard mix`'s b + s == 255 diagonal is 256 of them.
      buffer.data[i] = (source ? y : x) & 255;
      // Green and blue are deliberately unlike red. The six non-separable modes
      // read all three channels at once, and a grey pixel exercises none of
      // setSat's or clipColor's branches.
      buffer.data[i + 1] = (source ? x * 7 + 33 : y * 13 + 91) & 255;
      buffer.data[i + 2] = (source ? x + y * 5 : x * 3 + y) & 255;
      buffer.data[i + 3] = alpha;
    }
  }

  return buffer;
}

/**
 * Two full-canvas layers: a `normal` backdrop and a source in `mode`.
 *
 * Built through createProject rather than as object literals so the layers have
 * exactly the shape toLayer() produces and cannot drift from it.
 */
export function conformanceProject(mode, size = CONFORMANCE_SIZE) {
  return createProject({
    width: size,
    height: size,
    children: [
      {
        name: 'backdrop', left: 0, top: 0, right: size, bottom: size,
        blendMode: 'normal', proxyData: conformancePattern(size, size, 'backdrop'),
      },
      {
        name: 'source', left: 0, top: 0, right: size, bottom: size,
        blendMode: mode, proxyData: conformancePattern(size, size, 'source'),
      },
    ],
  }, `conformance-${mode}.psd`);
}

/**
 * Compare two renders the way test/composite.mjs already does.
 *
 * flattenOnto FIRST, always. GPU and JS write different RGB beneath fully
 * transparent pixels -- JS `continue`s and leaves zero, while the GPU's
 * `as <= 0` path writes the backdrop's stored RGB straight through. Comparing
 * raw reports large differences in pixels nobody can see; that mistake once made
 * a correct compositor look 5/21 right instead of 12/21.
 */
export const compareRenders = (a, b) => compareBuffers(flattenOnto(a), flattenOnto(b), 1);

/**
 * Tolerance 1 is a floor, not a licence.
 *
 * GLSL ES 3.00 has no `precise` qualifier, so a compiler may reassociate float
 * expressions and bit-exactness cannot be promised, only measured. The caller
 * prints percent, percentReal, maxDelta and meanDelta beside this verdict, so a
 * shader that is uniformly one greylevel wrong reads as suspicious (high
 * percent, meanDelta 1) rather than simply green.
 *
 * Do NOT raise the tolerance to make the transformed pass go green. Bilinear
 * filter divergence is reported in its own pass for exactly that reason.
 */
export function verdictFor(stat) {
  if (!stat || !stat.comparable) return 'FAIL';
  if (stat.percentReal === 0) return 'PASS';
  if (stat.percentReal < 0.1 && stat.maxDelta <= 2) return 'WARN';
  return 'FAIL';
}
