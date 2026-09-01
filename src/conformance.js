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
import { createAdjust } from './adjust/ops.js';

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

/**
 * Table D: the per-op adjustment matrix.
 *
 * Built the way Table A is -- a synthetic two-layer document over
 * conformancePattern(), which already sweeps every one of the 65 536
 * (backdrop, source) red pairs and eight alpha bands. Rendered by
 * renderProject and, on a device, by the GPU; flattenOnto both; compareRenders;
 * verdictFor.
 *
 * TWO ROWS ARE MANDATORY AND ARE THE POINT OF THE TABLE:
 *
 *   'neutral'            -- a neutral adjustment must be BIT-IDENTICAL to no
 *                           adjustment, on both tiers. Catches the whole class
 *                           of "the pass runs and quantises even when it should
 *                           do nothing", which is otherwise invisible.
 *   'steep-transformed'  -- a steep LUT on a TRANSFORMED layer, reported in its
 *                           own row. On a transformed layer the GPU samples
 *                           through LINEAR, whose weights mobile GPUs compute at
 *                           ~8 subtexel bits (1B's measured 1-2 LSB). A LUT is a
 *                           step function, and a steep one maps a 1-LSB index
 *                           difference to an arbitrarily large output
 *                           difference. The adjustment stage AMPLIFIES a
 *                           divergence 1B measured and accepted, and this row
 *                           exists so it is attributed correctly rather than
 *                           blamed on the blend maths.
 *
 * The tolerance is NOT raised to absorb that. 1B's reason stands: it would
 * forgive real bugs everywhere else.
 */
export const CONFORMANCE_ADJUSTMENTS = [
  { id: 'neutral', label: 'Neutral — must be bit-identical to none',
    adjust: createAdjust(), transformed: false },
  { id: 'brightness-max', label: 'Brightness +100',
    adjust: createAdjust({ brightness: 100 }), transformed: false },
  { id: 'brightness-min', label: 'Brightness −100',
    adjust: createAdjust({ brightness: -100 }), transformed: false },
  { id: 'contrast-max', label: 'Contrast +100 (steep)',
    adjust: createAdjust({ contrast: 100 }), transformed: false },
  { id: 'contrast-min', label: 'Contrast −100',
    adjust: createAdjust({ contrast: -100 }), transformed: false },
  { id: 'exposure-mid', label: 'Exposure +50',
    adjust: createAdjust({ exposure: 50 }), transformed: false },
  { id: 'temperature-tint', label: 'Temperature +80 / Tint −80',
    adjust: createAdjust({ temperature: 80, tint: -80 }), transformed: false },
  { id: 'stack', label: 'All five stacked (the LUT collapse)',
    adjust: createAdjust({ exposure: 30, temperature: -40, tint: 25, brightness: -20, contrast: 55 }),
    transformed: false },
  { id: 'hsl-global', label: 'HSL global saturation −60',
    adjust: createAdjust({ hsl: { saturation: -60, bands: [] } }), transformed: false },
  { id: 'hsl-bands', label: 'HSL band shifts (red, green, blue)',
    adjust: createAdjust({ hsl: { saturation: 0, bands: [
      { h: 60, s: 40, l: 20 }, {}, {}, { h: -50, s: -70, l: 0 }, {}, { h: 30, s: 80, l: -30 }, {}, {},
    ] } }), transformed: false },
  { id: 'overlay-linear', label: 'Overlay — linear, soft light',
    adjust: createAdjust({ overlay: { kind: 'linear', angle: 30, mode: 'soft light', opacity: 0.8,
      stops: [{ t: 0, r: 255, g: 120, b: 0, a: 1 }, { t: 1, r: 0, g: 60, b: 200, a: 0.4 }] } }),
    transformed: false },
  { id: 'overlay-radial', label: 'Overlay — radial, multiply',
    adjust: createAdjust({ overlay: { kind: 'radial', cx: 0.5, cy: 0.5, radius: 0.6,
      mode: 'multiply', opacity: 1,
      stops: [{ t: 0, r: 255, g: 255, b: 255, a: 0 }, { t: 1, r: 20, g: 0, b: 40, a: 0.9 }] } }),
    transformed: false },
  { id: 'steep-transformed', label: 'Steep LUT on a TRANSFORMED layer — amplification',
    adjust: createAdjust({ contrast: 100 }), transformed: true },
  { id: 'neutral-transformed', label: 'Neutral on a transformed layer — the control',
    adjust: createAdjust(), transformed: true },
];

/**
 * A Table D document: conformanceProject's two `normal` layers, with the
 * adjustment on the source layer.
 *
 * A `transformed` row shrinks the source layer's geometry so drawLayerInto
 * genuinely resamples it. Without that it would hit resample()'s identity
 * return and test the untransformed path under a misleading name -- exactly the
 * shape of failure 1C's docstring calls the worst available.
 */
export function conformanceAdjustProject(entry, size = CONFORMANCE_SIZE) {
  const project = conformanceProject('normal', size);
  const source = project.layers[1];
  source.adjust = entry.adjust;
  if (entry.transformed) {
    source.w = Math.round(size * 0.75);
    source.h = Math.round(size * 0.75);
  }
  return project;
}

/**
 * What the /conformance route must print above Table D.
 *
 * There is no GPU: selectTier returns TIER_JS with the verdict 'shader probe
 * not run', and Plan 1B-2 is not started. So the table runs JS against itself
 * as a regression baseline, and saying so is not optional -- a green table that
 * means nothing is worse than an absent one.
 */
export const CONFORMANCE_TABLE_D_NOTE =
  'No GPU tier exists yet (selectTier returns TIER_JS: shader probe not run, and Plan 1B-2 ' +
  'is not started). Table D is therefore running JS against itself as a regression baseline, ' +
  'not as a GPU comparison. Every row below is green by construction until a real tier lands.';
