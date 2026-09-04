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
import { TIER_JS } from './gpu/detect.js';

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
 * The JS-against-itself warning, kept as a constant because it is the sentence
 * that must appear whenever the device does not reach a GPU tier.
 *
 * It USED to say the GPU tier did not exist. It does now -- src/gpu/renderer.js
 * executes the plan -- so the claim moved from "there is no renderer" to "this
 * DEVICE did not get one", which is the only thing the route can honestly
 * assert at run time. `conformanceNoteFor` picks between this and the GPU
 * wording from the tier `selectTier` actually returned.
 *
 * Saying it is not optional: a green table that means nothing is worse than an
 * absent one.
 */
export const CONFORMANCE_TABLE_D_NOTE =
  'This device did not reach a GPU tier, so the tables are running the JS renderer against ' +
  'ITSELF as a regression baseline, not as a GPU comparison. Every row is green by ' +
  'construction, and nothing here says the GPU path is correct.';

/**
 * Table C: clip runs.
 *
 * WHY IT EXISTS. Tables A and D exercise one layer over one backdrop. A clip
 * run is a different machine entirely -- on the GPU it opens a second
 * ping-pong pair, runs a reduction pass into an R8 plane, binds that plane on
 * every member, and spends the base's opacity and blend mode on a final
 * composite -- and NONE of that is touched by a two-layer document. The 21 PSD
 * fixtures barely clip either. So the whole clipping path could be wrong on the
 * GPU and every other table would stay green.
 *
 * THE TWO ROWS THAT MATTER MOST, and why:
 *
 *   'masked-base'      -- `clipAlphaMap` stores into a Uint8Array, which
 *                         TRUNCATES, while a unorm8 render target ROUNDS. Every
 *                         partially masked pixel of the base is where that
 *                         disagreement shows. A GPU that skipped the floor()
 *                         is 1 LSB out here and nowhere else.
 *   'base-spends-late' -- the base's own opacity and blend mode belong to the
 *                         WHOLE run and are spent on the final composite. A
 *                         renderer that also applied them to the base draw
 *                         would apply them twice, which on a 0.6-opacity base
 *                         reads as 0.36 and looks merely "a bit light".
 */
export const CONFORMANCE_CLIPS = [
  { id: 'run-of-one', label: 'A run of one — the plain single-layer path, no group at all',
    members: [] },
  { id: 'run-of-two', label: 'Base plus one clipped member (multiply)',
    members: [{ blendMode: 'multiply' }] },
  { id: 'run-of-three', label: 'Base plus two members — the plane is bound twice',
    members: [{ blendMode: 'screen' }, { blendMode: 'overlay' }] },
  { id: 'masked-base', label: 'Masked base — the truncating alpha reduction',
    mask: true, members: [{ blendMode: 'normal' }] },
  { id: 'base-spends-late', label: 'Base opacity 0.6 mode screen — spent on group-end, once',
    base: { opacity: 0.6, blendMode: 'screen' }, members: [{ blendMode: 'multiply' }] },
  { id: 'non-separable-member', label: 'A member in `hue` — non-separable inside a run',
    members: [{ blendMode: 'hue' }] },
  { id: 'member-opacity', label: 'Member at opacity 0.35 — clip alpha times layer alpha',
    members: [{ blendMode: 'normal', opacity: 0.35 }] },
  { id: 'offset-member', label: 'Member inset by an eighth — the rect clamp meets the clip plane',
    members: [{ blendMode: 'multiply', inset: 0.125 }] },
  { id: 'inset-base', label: 'Base inset by an eighth — the plane is zero where the base is not',
    baseInset: 0.125, members: [{ blendMode: 'normal' }] },
  { id: 'adjusted-base', label: 'Adjusted base — the plane reads alpha AFTER the pass',
    baseAdjust: createAdjust({ contrast: 70 }), members: [{ blendMode: 'normal' }] },
];

/** A 0..255 ramp across the layer, so the mask is partial nearly everywhere. */
const rampMask = (width, height) => {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[y * width + x] = (x * 255 / Math.max(1, width - 1)) | 0;
  return out;
};

/**
 * A Table C document: an opaque backdrop, then a clip run on top of it.
 *
 * The backdrop layer underneath is not decoration. `group-end` composites the
 * whole run onto whatever is already on the canvas, and with nothing under it
 * the composite reduces to a copy -- which is the one case that would pass
 * however the base's blend mode were spent.
 */
export function conformanceClipProject(entry, size = CONFORMANCE_SIZE) {
  // Insets are FRACTIONS of the canvas, not pixels, so a row means the same
  // thing at the 256 the route runs and at the 32 the Node test runs.
  const layer = (name, options = {}) => {
    const inset = Math.round(size * (options.inset || 0));
    const w = size - inset * 2;
    const h = size - inset * 2;
    const node = {
      name, left: inset, top: inset, right: inset + w, bottom: inset + h,
      blendMode: options.blendMode || 'normal',
      opacity: options.opacity ?? 1,
      clipping: options.clipping === true,
      proxyData: conformancePattern(w, h, options.role || 'source'),
    };
    if (options.mask) node.proxyMask = rampMask(w, h);
    return node;
  };

  const children = [
    layer('backdrop', { role: 'backdrop' }),
    layer('base', { ...(entry.base || {}), inset: entry.baseInset, mask: entry.mask }),
    ...entry.members.map((m, i) => layer(`clip-${i}`, { ...m, clipping: true })),
  ];

  const project = createProject({ width: size, height: size, children },
    `conformance-clip-${entry.id}.psd`);
  if (entry.baseAdjust) project.layers[1].adjust = entry.baseAdjust;
  return project;
}

/**
 * What the conformance route must print above every table, given the tier it
 * actually got.
 *
 * A green table that means nothing is worse than an absent one -- so when the
 * device lands on the JS tier the route says, in the same words it always did,
 * that it is comparing JS against itself and every row is green by
 * construction. When a GPU tier IS selected the note says what tolerance 1
 * means and what it does not.
 *
 * @param {number} tier      TIER_WORKER_GPU | TIER_MAIN_GPU | TIER_JS
 * @param {string} verdict   selectTier's own words, printed verbatim
 */
export function conformanceNoteFor(tier, verdict) {
  if (tier === TIER_JS)
    return 'This device is on the JS tier (' + verdict + '), so the tables below are running ' +
      'the JS renderer against ITSELF as a regression baseline, not as a GPU comparison. ' +
      'Every row is green by construction. Nothing here says the GPU path is correct.';

  return 'Comparing the WebGL2 renderer against renderProject, the oracle the 21-fixture ' +
    'accuracy table is measured against (' + verdict + '). Tolerance 1 is a FLOOR, not a ' +
    'licence: GLSL ES 3.00 has no `precise` qualifier, so a driver may reassociate float ' +
    'expressions and bit-exactness can only be measured, never promised. Read percentReal, ' +
    'maxDelta and meanDelta beside every verdict — a shader that is uniformly one greylevel ' +
    'wrong reads as suspicious, not as green.';
}
