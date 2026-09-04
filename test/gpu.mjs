import assert from 'node:assert/strict';
import {
  SUPPORTED_BLEND_MODES,
  SEPARABLE_GLSL, NON_SEPARABLE_GLSL, GPU_BLEND_MODES, programNameFor, isNonSeparableMode,
  VERTEX_SHADER, fragmentShaderFor,
  create2dSurface, measureText, rasteriseTextAt,
  createBuffer, createProject, setLayer, undo, redo, toProjectJson, applyProjectJson, renderProject, drawLayerInto,
  compareBuffers, flattenOnto, createSandwichCache, renderSandwiched, sandwichStateFor, SANDWICH_FLAT_ABOVE, SANDWICH_BELOW_ONLY,
  conformancePattern, conformanceProject, compareRenders, verdictFor, CONFORMANCE_MODES,
  selectTier, tierOverrideFrom, probeCapabilities, TIER_WORKER_GPU, TIER_MAIN_GPU, TIER_JS,
} from '../src/index.js';
import { createAdjust, HSL_BANDS } from '../src/adjust/ops.js';
import { buildLut } from '../src/adjust/lut.js';
import { clipRunEnd } from '../src/render.js';
import { buildDrawPlan, GPU_BUDGET_BYTES } from '../src/gpu/plan.js';
// Not re-exported through src/index.js: these two are internal to the renderer,
// and the barrel is owned by another session.
import { CLIP_ALPHA_FRAGMENT_SHADER, PRESENT_FRAGMENT_SHADER } from '../src/gpu/glsl.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('\nblend mode table\n');

test('the GPU mode table covers exactly what the compositor implements', () => {
  // The regression this exists for: adding a mode to composite.js and
  // forgetting the shader, so the layer renders as `normal` on one code path
  // and correctly on the other. Asserted in both directions, because a mode
  // present here but absent there would render something nothing else can.
  const missing = SUPPORTED_BLEND_MODES.filter((m) => !GPU_BLEND_MODES.includes(m));
  const extra = GPU_BLEND_MODES.filter((m) => !SUPPORTED_BLEND_MODES.includes(m));
  assert.deepEqual(missing, [], 'implemented by composite.js but absent from the shader table');
  assert.deepEqual(extra, [], 'in the shader table but not implemented by composite.js');
  assert.equal(GPU_BLEND_MODES.length, 26);
});

test('separable and non-separable are disjoint, and together they are the whole table', () => {
  const both = Object.keys(SEPARABLE_GLSL).filter((m) => Object.hasOwn(NON_SEPARABLE_GLSL, m));
  assert.deepEqual(both, [], 'a mode cannot be both — the generator would emit two blendFn');
  assert.equal(Object.keys(SEPARABLE_GLSL).length, 20);
  assert.equal(Object.keys(NON_SEPARABLE_GLSL).length, 6);
});

test('dissolve and pass through compile to the normal program', () => {
  // blendInto does `const blend = fn || SEPARABLE.normal`, so both already
  // render as normal today. The GPU must not diverge from that.
  assert.equal(programNameFor('dissolve'), 'normal');
  assert.equal(programNameFor('pass through'), 'normal');
});

test('an unknown or missing blend mode falls through to normal', () => {
  assert.equal(programNameFor(undefined), 'normal');
  assert.equal(programNameFor(null), 'normal');
  assert.equal(programNameFor(''), 'normal');
  assert.equal(programNameFor('constructor'), 'normal', 'prototype keys must not resolve');
  assert.equal(programNameFor('multiply'), 'multiply');
  assert.equal(programNameFor('hue'), 'hue');
});

test('every separable body works in 0..1 — only hard mix mentions 255', () => {
  // composite.js is 0..255 integers. A formula left in that space would be
  // silently, hugely wrong on the GPU and would still compile.
  for (const [name, body] of Object.entries(SEPARABLE_GLSL)) {
    if (name === 'hard mix') {
      assert.match(body, /255\.0/, 'hard mix must compare in integer space');
      continue;
    }
    assert.ok(!/255/.test(body), `"${name}" still carries a 0..255 constant: ${body}`);
  }
  assert.equal(isNonSeparableMode('hue'), true);
  assert.equal(isNonSeparableMode('multiply'), false);
});

console.log('\nshader assembly\n');

/**
 * Comment-stripped source. The templates deliberately carry prose that names
 * the very constructs these tests forbid ("Do NOT rewrite as mix(...)"), so
 * asserting against raw text would fail on its own documentation.
 */
const code = (src) => src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const count = (s, ch) => s.split(ch).length - 1;

test('every mode produces a structurally complete fragment shader', () => {
  for (const mode of GPU_BLEND_MODES) {
    const src = fragmentShaderFor(mode);
    assert.ok(src.startsWith('#version 300 es'), `${mode}: #version must be the first characters`);
    assert.ok(src.includes('precision highp float;'), `${mode}: missing precision qualifier`);
    const body = code(src);
    assert.equal(count(body, 'void main()'), 1, `${mode}: expected exactly one main()`);
    assert.equal(count(body, 'vec3 blendFn('), 1, `${mode}: expected exactly one blendFn`);
    assert.equal(count(body, '{'), count(body, '}'), `${mode}: unbalanced braces`);
    assert.equal(count(body, '('), count(body, ')'), `${mode}: unbalanced parens`);
  }
});

test('multiply is transcribed, not paraphrased', () => {
  const src = code(fragmentShaderFor('multiply'));
  assert.ok(src.includes('float chan(float b, float s)'), 'separable modes go through chan()');
  assert.ok(src.includes('return b * s;'));
  assert.ok(src.includes('return vec3(chan(b.r, s.r), chan(b.g, s.g), chan(b.b, s.b));'));
});

test('a separable program carries no non-separable prelude', () => {
  // Dead code the driver still has to parse, on hardware where each compile
  // costs tens of ms.
  const src = code(fragmentShaderFor('screen'));
  assert.ok(!src.includes('setSat'), 'separable shaders must not carry setSat');
  assert.ok(!src.includes('clipColor'), 'separable shaders must not carry clipColor');
});

test("the composite expression keeps blendInto's association order", () => {
  for (const mode of GPU_BLEND_MODES) {
    const src = code(fragmentShaderFor(mode));
    assert.ok(src.includes('vec3 C = src.rgb + ab * (B - src.rgb);'),
      `${mode}: the blend-toward-backdrop step must stay in the JS association order`);
    assert.ok(src.includes('fragColor = vec4((as * C + ab * dst.rgb * (1.0 - as)) / ao, ao);'),
      `${mode}: the straight-alpha composite must stay in the JS association order`);
  }
});

test('no generated shader uses an interpolation builtin', () => {
  // mix(src.rgb, B, ab) is algebraically equal and differently rounded. So is
  // any other rearrangement. This is the assertion that stops a later tidy-up.
  for (const mode of GPU_BLEND_MODES)
    assert.ok(!/\bmix\s*\(/.test(code(fragmentShaderFor(mode))), `${mode} uses mix()`);
});

test("both of blendInto's early-outs survive into the shader", () => {
  const src = code(fragmentShaderFor('normal'));
  // Not optimisations. Without the first, a transparent source fragment runs
  // the straight-alpha divide and re-quantises the backdrop instead of leaving
  // it as an exact unorm8 round trip.
  assert.ok(src.includes('if (as <= 0.0) { fragColor = dst; return; }'));
  assert.ok(src.includes('if (ao <= 0.0) { fragColor = vec4(0.0); return; }'));
  // And the rect clamp, which reproduces the JS loop's x0..x1 / y0..y1 bounds.
  assert.ok(src.includes('any(lessThan(uv, vec2(0.0)))'));
  assert.ok(src.includes('any(greaterThanEqual(uv, vec2(1.0)))'));
});

test('hard mix compares in integer space, and nothing else does', () => {
  // Task 15's adjustment stage legitimately reads `* 255.0 + 0.5` in its LUT
  // fetch, in EVERY shader -- that is not what this test polices. Only the
  // blend-MODE body has to stay in 0..1 space, so the check now starts where
  // that body begins (`chan(`/`blendFn(`) rather than at the top of the file.
  const modeBodyOf = (mode) => {
    const src = code(fragmentShaderFor(mode));
    const marker = isNonSeparableMode(programNameFor(mode)) ? 'vec3 blendFn(' : 'float chan(';
    return src.slice(src.indexOf(marker));
  };
  assert.ok(modeBodyOf('hard mix').includes('floor(b * 255.0 + 0.5)'));
  for (const mode of GPU_BLEND_MODES) {
    if (mode === 'hard mix') continue;
    assert.ok(!/255/.test(modeBodyOf(mode)),
      `${mode} carries a 0..255 constant into the shader`);
  }
});

test('the vertex shader needs no attribute buffers and lands on texel centres', () => {
  assert.ok(VERTEX_SHADER.startsWith('#version 300 es'));
  assert.ok(VERTEX_SHADER.includes('gl_VertexID'), 'the full-canvas triangle is generated, not uploaded');
  assert.ok(!/^\s*in\s+vec/m.test(VERTEX_SHADER), 'declaring an attribute would need a VBO to feed it');
  assert.ok(VERTEX_SHADER.includes('vDstPx = c * uCanvas;'),
    'vDstPx must be a linear function of position so it interpolates to pixel centres');
});

console.log('\nnon-separable modes\n');

test('the six non-separable modes get the colour-space prelude', () => {
  for (const mode of Object.keys(NON_SEPARABLE_GLSL)) {
    const src = code(fragmentShaderFor(mode));
    assert.ok(src.includes('float lum(vec3 c)'), `${mode}: missing lum`);
    assert.ok(src.includes('float sat(vec3 c)'), `${mode}: missing sat`);
    assert.ok(src.includes('vec3 setLum(vec3 c, float l)'), `${mode}: missing setLum`);
    assert.ok(src.includes('vec3 setSat(vec3 c, float s)'), `${mode}: missing setSat`);
    assert.ok(src.includes('vec3 clipColor(vec3 c)'), `${mode}: missing clipColor`);
    assert.ok(src.includes(NON_SEPARABLE_GLSL[mode]), `${mode}: body not emitted`);
  }
  assert.ok(code(fragmentShaderFor('hue')).includes('LUM_W = vec3(0.3, 0.59, 0.11)'),
    'the luminance weights must match composite.js exactly');
});

test('setSat is the branch-free closed form, with no dynamic vector indexing', () => {
  const src = code(fragmentShaderFor('hue'));
  assert.ok(src.includes('(mx > mn) ? (c - mn) * (s / (mx - mn)) : vec3(0.0)'));
  // composite.js sorts three channel indices and writes back by index. GLSL ES
  // 3.00 permits that and compiles it to conditional moves or scratch memory,
  // with a history of driver bugs. The sort is an implementation artifact.
  assert.ok(!/\bc\s*\[/.test(src), 'dynamic vector indexing must not appear');
  assert.ok(!/\bsort\b/.test(src));
});

test('clipColor computes l, n and x once, before either branch', () => {
  const src = code(fragmentShaderFor('color'));
  const xAt = src.indexOf('float x = max(');
  const branchAt = src.indexOf('if (n < 0.0)');
  assert.ok(xAt > -1 && branchAt > -1, 'clipColor is not shaped as expected');
  assert.ok(xAt < branchAt,
    'x must be computed BEFORE the branch that mutates c. composite.js tests the ' +
    'STALE x; recomputing it would be tidier and would diverge from the oracle.');
});

test('both non-separable divides carry the NaN guard', () => {
  // In JS a 0/0 yields NaN, which Uint8ClampedArray stores as 0. In GLSL a NaN
  // written to a unorm8 target is undefined and has been observed as garbage.
  const src = code(fragmentShaderFor('saturation'));
  assert.ok(src.includes('max(l - n, EPS)'));
  assert.ok(src.includes('max(x - l, EPS)'));
  assert.ok(src.includes('const float EPS   = 1e-6;'));
});

console.log('\n2d surface\n');

test('Node has no 2D surface at all', () => {
  // Neither global exists here, and pretending otherwise would make
  // rasteriseTextAt return a buffer of nothing.
  assert.equal(create2dSurface(8, 8), null);
});

test('falls back to document when there is no OffscreenCanvas', () => {
  globalThis.document = { createElement: (tag) => ({ tag, width: 0, height: 0 }) };
  try {
    const surface = create2dSurface(7, 3);
    assert.equal(surface.tag, 'canvas');
    assert.equal(surface.width, 7);
    assert.equal(surface.height, 3);
  } finally { delete globalThis.document; }
});

test('prefers OffscreenCanvas over document', () => {
  // Order is load-bearing, in both directions. Reversing it would put a worker
  // on the document path -- the bug this file exists to fix. And checking
  // document first would break test/edit.mjs, which stubs globalThis.document
  // to observe setTransform/fillText and relies on that stub winning in Node.
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; this.offscreen = true; } };
  globalThis.document = { createElement: () => ({ tag: 'canvas', width: 0, height: 0 }) };
  try {
    const surface = create2dSurface(5, 5);
    assert.equal(surface.offscreen, true, 'a worker must get the OffscreenCanvas, not a DOM canvas');
  } finally { delete globalThis.OffscreenCanvas; delete globalThis.document; }
});

test('measureText returns null where there is no surface', () => {
  assert.equal(measureText({ content: 'x', fontSize: 12, fontFamily: 'Arial' }), null);
});

test('rasteriseTextAt returns null where there is no surface', () => {
  const layer = { text: { content: 'x', fontSize: 12, fontFamily: 'Arial', color: '#000', align: 'left' } };
  assert.equal(rasteriseTextAt(layer, 10, 10), null);
});

console.log('\nrenderer extraction and revisions\n');

/**
 * Deterministic non-flat pixels: flat colour hides rounding differences.
 *
 * `alphaFloor` raises the alpha ramp's bottom end. Full-range alpha is the
 * better default, but the sandwich cache's `above` half divides by its own
 * accumulated alpha, so a near-transparent stack there amplifies quantisation
 * error out of the range the exactness test can bound. One test raises the
 * floor for exactly that reason and says so.
 */
const gradient = (w, h, seed, alphaFloor = 0) => {
  const buffer = createBuffer(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    buffer.data[i]     = (x * 11 + seed * 37) & 255;
    buffer.data[i + 1] = (y * 13 + seed * 61) & 255;
    buffer.data[i + 2] = (x * y + seed * 17) & 255;
    const a = (x * 9 + y * 5 + seed * 23) & 255;
    buffer.data[i + 3] = alphaFloor + Math.round((a * (255 - alphaFloor)) / 255);
  }
  return buffer;
};

const SIZE = 24;

/**
 * @param {{mode?:string, opacity?:number, hidden?:boolean,
 *          left?:number, top?:number, alphaFloor?:number}[]} specs
 */
const syntheticProject = (specs) => createProject({
  width: SIZE, height: SIZE,
  children: specs.map((s, i) => {
    const left = s.left ?? 0, top = s.top ?? 0;
    const w = SIZE - left, h = SIZE - top;
    return {
      name: `L${i}`, left, top, right: left + w, bottom: top + h,
      blendMode: s.mode ?? 'normal', opacity: s.opacity ?? 1, hidden: s.hidden === true,
      proxyData: gradient(w, h, i + 1, s.alphaFloor ?? 0),
    };
  }),
}, 'synthetic.psd');

test('renderProject is exactly a fold of drawLayerInto over the layer list', () => {
  const project = syntheticProject([{}, { mode: 'multiply' }, { left: 3, top: 5, opacity: 0.4 }]);
  const folded = createBuffer(SIZE, SIZE);
  for (const layer of project.layers) drawLayerInto(folded, layer, 1);
  assert.deepEqual(Array.from(folded.data), Array.from(renderProject(project, { scale: 1 }).data));
});

test('drawLayerInto skips hidden and zero-opacity layers', () => {
  const project = syntheticProject([{ hidden: true }, { opacity: 0 }]);
  const dest = createBuffer(SIZE, SIZE);
  for (const layer of project.layers) drawLayerInto(dest, layer, 1);
  assert.ok(dest.data.every((v) => v === 0), 'nothing visible should have been drawn');
});

test('commit bumps the project revision', () => {
  const project = syntheticProject([{}, {}]);
  assert.equal(project.revision, 0, 'a fresh project starts at 0');
  setLayer(project, project.layers[0].id, { x: 4 });
  assert.equal(project.revision, 1);
});

test('undo and redo bump it too — commit() alone does not cover them', () => {
  // undo() and redo() call applyCommand directly (src/edit.js:240-254). A cache
  // keyed on a commit-only counter would serve stale pixels after every undo.
  const project = syntheticProject([{}, {}]);
  setLayer(project, project.layers[0].id, { x: 4 });
  const after = project.revision;
  undo(project);
  assert.equal(project.revision, after + 1, 'undo must invalidate caches');
  redo(project);
  assert.equal(project.revision, after + 2, 'redo must invalidate caches');
});

test('the coalesced frames of a drag do not bump it', () => {
  // This asymmetry IS the sandwich cache. The first frame commits (one bump);
  // every frame after extends that entry through applyCommand and must leave
  // the counter alone, or the cache rebuilds 60 times a second.
  const project = syntheticProject([{}, {}]);
  const id = project.layers[0].id;
  setLayer(project, id, { x: 1 }, 'drag');
  const afterFirst = project.revision;
  for (let i = 2; i <= 10; i++) setLayer(project, id, { x: i }, 'drag');
  assert.equal(project.revision, afterFirst, 'a gesture is one bump, not ten');
});

test('applyProjectJson bumps it', () => {
  const project = syntheticProject([{}, {}]);
  const before = project.revision;
  applyProjectJson(project, JSON.parse(JSON.stringify(toProjectJson(project))));
  assert.ok(project.revision > before, 'every layer was just replaced');
});

console.log('\nsandwich cache\n');

test('the degraded path is byte-for-byte identical to a full render', () => {
  // Nothing is cached above the selection, so the same layers are blended onto
  // the same accumulator in the same order. There is no room for divergence.
  const project = syntheticProject([{}, { left: 2 }, { mode: 'multiply' }, { mode: 'difference' }]);
  assert.equal(sandwichStateFor(project, 1), SANDWICH_BELOW_ONLY);
  const frame = renderSandwiched(createSandwichCache(), project, 1, { scale: 1 });
  assert.deepEqual(Array.from(frame.data), Array.from(renderProject(project, { scale: 1 }).data));
});

test('the cached path matches a full render everywhere at tolerance 2', () => {
  // `above` is composited onto a transparent buffer and then source-over'd, so
  // it quantises to 8 bits twice where the direct path quantises once. That is
  // the entire cost of the cache, and it is measured here rather than assumed.
  //
  // alphaFloor on the two layers above the selection is not decoration: `above`
  // stores straight-alpha RGB divided by its own accumulated alpha, so a
  // near-transparent stack up there amplifies half-LSB storage error by 1/ao
  // before flattenOnto damps it again.
  //
  // The bound is 2, not 1. An earlier draft of this test asserted 1 and said
  // ao > ~0.6 guaranteed it; that was wrong, and the measured truth is 7 of 576
  // pixels at exactly 2 LSB on this fixture. Raising 1 -> 2 here is NOT the
  // usual "relax the tolerance until it goes green": the cache is exact in real
  // arithmetic (source-over is associative), the residue is 8-bit double
  // quantisation, and this path only ever draws drag previews — the frame that
  // survives the gesture comes from a full re-render. If this ever exceeds 2,
  // that IS a real defect and must not be papered over the same way.
  const project = syntheticProject([
    {}, { left: 2 },
    { opacity: 0.55, alphaFloor: 200 },
    { top: 4, opacity: 0.8, alphaFloor: 200 },
  ]);
  assert.equal(sandwichStateFor(project, 1), SANDWICH_FLAT_ABOVE);
  const frame = renderSandwiched(createSandwichCache(), project, 1, { scale: 1 });
  // flattenOnto both first, and read percentReal — the same rule the rest of
  // this repo compares by. A failure here is a real defect in the cache, not a
  // tolerance to raise.
  const stat = compareBuffers(flattenOnto(frame), flattenOnto(renderProject(project, { scale: 1 })), 2);
  assert.equal(stat.percentReal, 0,
    `beyond rounding on ${stat.beyondRounding} px, maxDelta ${stat.maxDelta}, meanDelta ${stat.meanDelta}`);
  // Pin the ceiling: if the algorithm regresses, maxDelta climbs and this
  // catches it even though percentReal stays 0 at the wider tolerance.
  assert.ok(stat.maxDelta <= 2, `cache drifted to ${stat.maxDelta} LSB, above the measured bound of 2`);
});

test('state is exact when every layer above the selection is normal', () => {
  const project = syntheticProject([{ mode: 'multiply' }, {}, { opacity: 0.3 }, {}]);
  // A non-normal mode BELOW the selection is irrelevant — `below` is a real
  // composite of those layers, not an approximation of them.
  assert.equal(sandwichStateFor(project, 1), SANDWICH_FLAT_ABOVE);
});

test('a visible non-normal layer above degrades it', () => {
  const project = syntheticProject([{}, {}, { mode: 'hard mix' }]);
  assert.equal(sandwichStateFor(project, 1), SANDWICH_BELOW_ONLY);
});

test('a hidden or zero-opacity non-normal layer above does not', () => {
  // renderProject skips these entirely, so they cannot make the cache wrong.
  assert.equal(sandwichStateFor(syntheticProject([{}, {}, { mode: 'difference', hidden: true }]), 1),
    SANDWICH_FLAT_ABOVE);
  assert.equal(sandwichStateFor(syntheticProject([{}, {}, { mode: 'difference', opacity: 0 }]), 1),
    SANDWICH_FLAT_ABOVE);
});

test('the cache survives the frames of one drag', () => {
  // The load-bearing test. If this fails the feature does nothing at all.
  const project = syntheticProject([{}, {}, {}, {}]);
  const cache = createSandwichCache();
  const id = project.layers[1].id;

  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 1);
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 1, 'a second frame with nothing changed must reuse the cache');

  setLayer(project, id, { x: 1 }, 'drag');           // first frame of a gesture -> commit
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 2);

  for (let f = 2; f <= 12; f++) {
    setLayer(project, id, { x: f }, 'drag');         // coalesced -> no bump
    renderSandwiched(cache, project, 1, { scale: 1 });
  }
  assert.equal(cache.builds, 2, 'eleven more frames of one gesture must not rebuild it');
});

test('a commit rebuilds it', () => {
  const project = syntheticProject([{}, {}, {}]);
  const cache = createSandwichCache();
  renderSandwiched(cache, project, 1, { scale: 1 });
  setLayer(project, project.layers[2].id, { opacity: 0.5 });
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 2, 'a layer above the selection changed');
});

test('an undo rebuilds it', () => {
  const project = syntheticProject([{}, {}, {}]);
  const cache = createSandwichCache();
  setLayer(project, project.layers[2].id, { opacity: 0.5 });
  renderSandwiched(cache, project, 1, { scale: 1 });
  undo(project);
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 2);
});

test('selecting the top layer needs no above buffer', () => {
  const project = syntheticProject([{}, {}, {}]);
  const cache = createSandwichCache();
  const frame = renderSandwiched(cache, project, 2, { scale: 1 });
  assert.equal(cache.above, null, 'an empty slice must not allocate a full-canvas buffer');
  assert.deepEqual(Array.from(frame.data), Array.from(renderProject(project, { scale: 1 }).data));
});

test('an out-of-range selection falls back to the full render', () => {
  const project = syntheticProject([{}, {}]);
  const cache = createSandwichCache();
  const full = Array.from(renderProject(project, { scale: 1 }).data);
  for (const index of [-1, 2, null, undefined, 1.5])
    assert.deepEqual(Array.from(renderSandwiched(cache, project, index, { scale: 1 }).data), full);
  assert.equal(cache.builds, 0, 'nothing should have been cached');
});

console.log('\nconformance fixtures\n');

test('the pattern is deterministic', () => {
  assert.deepEqual(
    Array.from(conformancePattern(32, 32, 'source').data),
    Array.from(conformancePattern(32, 32, 'source').data),
  );
});

test('red sweeps every backdrop/source byte pair exactly once', () => {
  // This is what makes `hard mix`'s b + s == 255 diagonal impossible to miss:
  // 256 of the 65 536 pairs sit exactly on it.
  const backdrop = conformancePattern(256, 256, 'backdrop');
  const source = conformancePattern(256, 256, 'source');
  const seen = new Uint8Array(65536);
  for (let i = 0; i < 256 * 256; i++) seen[backdrop.data[i * 4] * 256 + source.data[i * 4]]++;
  assert.ok(seen.every((n) => n === 1), 'every (backdrop, source) red pair must occur exactly once');
});

test('both roles include a fully transparent and a fully opaque band', () => {
  for (const role of ['backdrop', 'source']) {
    const alphas = new Set();
    const pattern = conformancePattern(256, 256, role);
    for (let i = 0; i < 256 * 256; i++) alphas.add(pattern.data[i * 4 + 3]);
    assert.ok(alphas.has(0), `${role} must include alpha 0 — where JS continues and the GPU returns dst`);
    assert.ok(alphas.has(255), `${role} must include alpha 255 — where ao == 1`);
  }
});

test('green and blue are not copies of red', () => {
  // The six non-separable modes read all three channels at once. A grey pixel
  // exercises none of setSat's or clipColor's branches.
  const pattern = conformancePattern(64, 64, 'backdrop');
  let differing = 0;
  for (let i = 0; i < 64 * 64; i++) {
    const o = i * 4;
    if (pattern.data[o] !== pattern.data[o + 1] || pattern.data[o] !== pattern.data[o + 2]) differing++;
  }
  assert.ok(differing > 64 * 64 * 0.9, `only ${differing} of ${64 * 64} pixels are non-grey`);
});

test('all 26 modes render through the JS oracle and produce pixels', () => {
  for (const mode of CONFORMANCE_MODES) {
    const out = renderProject(conformanceProject(mode, 64), { scale: 1 });
    assert.equal(out.width, 64, `${mode}: wrong canvas size`);
    assert.ok(out.data.some((v) => v !== 0), `${mode}: rendered nothing at all`);
  }
  assert.equal(CONFORMANCE_MODES.length, 26);
});

test('a render compared against itself is a PASS at maxDelta 0', () => {
  // Proves the comparison harness is not itself reporting spurious differences
  // before it is ever pointed at a GPU.
  const out = renderProject(conformanceProject('overlay', 64), { scale: 1 });
  const stat = compareRenders(out, out);
  assert.equal(stat.maxDelta, 0);
  assert.equal(verdictFor(stat), 'PASS');
});

test('the verdict table', () => {
  assert.equal(verdictFor({ comparable: true, percentReal: 0, maxDelta: 1 }), 'PASS');
  assert.equal(verdictFor({ comparable: true, percentReal: 0.05, maxDelta: 2 }), 'WARN');
  assert.equal(verdictFor({ comparable: true, percentReal: 0.05, maxDelta: 3 }), 'FAIL');
  assert.equal(verdictFor({ comparable: true, percentReal: 0.5, maxDelta: 2 }), 'FAIL');
  assert.equal(verdictFor({ comparable: false, reason: '2x2 vs 3x3' }), 'FAIL');
  assert.equal(verdictFor(null), 'FAIL');
});

console.log('\ntier selection\n');

const FULL = { offscreenCanvas: true, transferControl: true, webgl2: true, probe: { ok: true } };

test('a tier override wins over every capability', () => {
  for (const tier of [1, 2, 3]) {
    const decision = selectTier({ ...FULL, override: tier });
    assert.equal(decision.tier, tier);
    assert.match(decision.verdict, /forced/);
  }
  assert.equal(selectTier({ webgl2: false, override: 1 }).tier, 1, 'an override bypasses the probe too');
});

test('an out-of-range override is ignored', () => {
  for (const bad of [0, 4, -1, 1.5, '2', null, undefined])
    assert.equal(selectTier({ ...FULL, override: bad }).tier, TIER_WORKER_GPU, `override ${bad} leaked through`);
});

test('no WebGL2 lands on the JS tier, and says so', () => {
  const decision = selectTier({ offscreenCanvas: true, transferControl: true, webgl2: false });
  assert.equal(decision.tier, TIER_JS);
  assert.match(decision.verdict, /WebGL2/);
});

test('a failed probe lands on the JS tier and carries the driver reason', () => {
  const decision = selectTier({ ...FULL, probe: { ok: false, reason: 'link failed: hue' } });
  assert.equal(decision.tier, TIER_JS);
  assert.match(decision.verdict, /link failed: hue/, 'the harness has to be able to show why');
});

test('an unprobed context never reaches a GPU tier', () => {
  // getContext('webgl2') !== null says nothing about whether the shader
  // compiler works. Trusting it renders black on the phones that matter.
  const decision = selectTier({ ...FULL, probe: null });
  assert.equal(decision.tier, TIER_JS);
  assert.match(decision.verdict, /probe/);
});

test('OffscreenCanvas without transferControlToOffscreen is tier 2, not tier 1', () => {
  // Two separate features. Safari shipped the constructor before the transfer
  // method (16.4, 2023); probing the constructor alone gives older iOS Safari a
  // canvas it cannot present.
  const decision = selectTier({ ...FULL, transferControl: false });
  assert.equal(decision.tier, TIER_MAIN_GPU);
  assert.match(decision.verdict, /transferControlToOffscreen/);

  assert.equal(selectTier({ ...FULL, offscreenCanvas: false, transferControl: false }).tier, TIER_MAIN_GPU);
});

test('the full capability set reaches tier 1', () => {
  const decision = selectTier(FULL);
  assert.equal(decision.tier, TIER_WORKER_GPU);
  assert.ok(decision.verdict.length > 0);
});

test('probeCapabilities reports no GPU in Node, and selectTier agrees', () => {
  const caps = probeCapabilities();
  assert.equal(caps.webgl2, false);
  assert.equal(caps.probe, null);
  assert.equal(selectTier(caps).tier, TIER_JS);
  assert.equal(tierOverrideFrom('?tier=2'), 2);
  assert.equal(tierOverrideFrom('?tier=9'), null);
  assert.equal(tierOverrideFrom('?other=1'), null);
  assert.equal(tierOverrideFrom(''), null);
  assert.equal(tierOverrideFrom(undefined), null);
});


// ---------------------------------------------------------------- gpu plan
//
// The GPU internals are imported from their own modules rather than from
// src/index.js: they are not part of the engine's public surface, and index.js
// is contended by four agents.

console.log('\ngpu draw plan\n');

/**
 * A project whose layers can carry clipping, masks and adjustments.
 *
 * `pixels: null` means a LAYER WITH NO PIXELS, and it is built in two moves on
 * purpose. A NODE with no pixels never becomes a layer at all -- createProject's
 * flatten counts it as skipped (src/edit.js: "Counted, not silently dropped")
 * -- so building it that way would delete the layer and shift every index above
 * it, and the assertions below would be reading a different stack than the one
 * they name. The node carries pixels so the layer survives; the layer then has
 * them taken off, which is the state prepareLayer actually skips and the state
 * a streaming load really produces.
 */
const clipProject = (specs) => {
  const project = createProject({
    width: SIZE, height: SIZE,
    children: specs.map((s, i) => {
      const left = s.left ?? 0, top = s.top ?? 0;
      const w = s.w ?? SIZE - left, h = s.h ?? SIZE - top;
      const node = {
        name: `L${i}`, left, top, right: left + w, bottom: top + h,
        blendMode: s.mode ?? 'normal', opacity: s.opacity ?? 1, hidden: s.hidden === true,
        clipping: s.clipping === true,
        proxyData: gradient(w, h, i + 1),
      };
      if (s.mask) node.proxyMask = new Uint8Array(w * h).fill(s.mask);
      return node;
    }),
  }, 'clip.psd');
  specs.forEach((s, i) => { if (s.pixels === null) project.layers[i].pixels = null; });
  return project;
};

const kinds = (plan) => plan.steps.map((s) => s.kind);
const indices = (plan) => plan.steps.filter((s) => s.kind === 'draw').map((s) => s.index);

test('a plain stack plans one draw per layer, straight onto the canvas', () => {
  const plan = buildDrawPlan(clipProject([{}, { mode: 'multiply' }, { opacity: 0.5 }]));
  assert.equal(plan.ok, true, plan.reason || '');
  assert.deepEqual(kinds(plan), ['draw', 'draw', 'draw']);
  assert.deepEqual(indices(plan), [0, 1, 2]);
  assert.ok(plan.steps.every((s) => s.target === 'canvas'));
  assert.ok(plan.steps.every((s) => s.clip === false));
  assert.equal(plan.steps[1].program, 'multiply');
  assert.equal(plan.steps[2].opacity, 0.5);
  assert.equal(plan.groups, 0, 'nothing clips, so no group target is needed');
});

test('hidden, zero-opacity and pixel-less layers are planned out', () => {
  // Exactly what drawLayerInto and prepareLayer skip. A step planned for one of
  // these would draw something renderProject does not.
  const plan = buildDrawPlan(clipProject([
    {}, { hidden: true }, { opacity: 0 }, { pixels: null }, {},
  ]));
  assert.deepEqual(indices(plan), [0, 4]);
});

test('a layer entirely off-canvas is planned out, on all four sides', () => {
  for (const move of [
    { x: SIZE, w: 4 }, { y: SIZE, h: 4 }, { x: -8, w: 8 }, { y: -8, h: 8 },
  ]) {
    const project = clipProject([{ w: 8, h: 8 }]);
    Object.assign(project.layers[0], move);
    assert.deepEqual(indices(buildDrawPlan(project)), [], JSON.stringify(move));
  }
});

test('the destination rect is prepareLayer arithmetic, at any scale', () => {
  const project = clipProject([{ left: 3, top: 5, w: 9, h: 7 }]);
  const layer = project.layers[0];
  for (const scale of [1, 0.5, 0.61, 2]) {
    const plan = buildDrawPlan(project, { scale });
    assert.deepEqual(plan.steps[0].rect, {
      left: Math.round(layer.x * scale),
      top: Math.round(layer.y * scale),
      width: Math.max(1, Math.round(layer.w * scale)),
      height: Math.max(1, Math.round(layer.h * scale)),
    }, `scale ${scale}`);
    assert.equal(plan.width, Math.max(1, Math.round(SIZE * scale)));
    assert.equal(plan.height, Math.max(1, Math.round(SIZE * scale)));
  }
});

test('a clip run plans group-begin, the base, the clip alpha, its members, group-end', () => {
  const plan = buildDrawPlan(clipProject([{}, { clipping: true }, { clipping: true }]));
  assert.deepEqual(kinds(plan), ['group-begin', 'draw', 'clip-alpha', 'draw', 'draw', 'group-end']);
  assert.deepEqual(indices(plan), [0, 1, 2]);
  assert.equal(plan.groups, 1);
});

test('the base opacity and mode are spent on group-end, never on the base draw', () => {
  // Step 1 of drawClipRunInto: the base goes into the group at opacity 1, mode
  // normal. Its own opacity and blend mode belong to the WHOLE run.
  const plan = buildDrawPlan(clipProject([{ opacity: 0.4, mode: 'multiply' }, { clipping: true }]));
  const base = plan.steps.find((s) => s.kind === 'draw');
  assert.equal(base.opacity, 1);
  assert.equal(base.program, 'normal');
  assert.equal(base.target, 'group');
  const end = plan.steps.at(-1);
  assert.equal(end.kind, 'group-end');
  assert.equal(end.opacity, 0.4);
  assert.equal(end.program, 'multiply');
});

test('a hidden or pixel-less base takes its whole run out of the plan', () => {
  for (const base of [{ hidden: true }, { opacity: 0 }, { pixels: null }]) {
    const plan = buildDrawPlan(clipProject([base, { clipping: true }, { clipping: true }, {}]));
    assert.deepEqual(indices(plan), [3], JSON.stringify(base));
    assert.equal(plan.groups, 0);
  }
});

test('a hidden member of a run is planned out; the rest still clips', () => {
  const plan = buildDrawPlan(clipProject([
    {}, { clipping: true, hidden: true }, { clipping: true },
  ]));
  assert.deepEqual(indices(plan), [0, 2]);
  assert.deepEqual(kinds(plan), ['group-begin', 'draw', 'clip-alpha', 'draw', 'group-end']);
});

test('a run of one is the plain single-layer draw: no group, no clip texture', () => {
  const plan = buildDrawPlan(clipProject([{}, {}, {}]));
  assert.ok(!kinds(plan).includes('group-begin'));
  assert.ok(!kinds(plan).includes('clip-alpha'));
  assert.equal(plan.groups, 0);
});

test('every clipped member draws with the clip texture bound, and the base does not', () => {
  const plan = buildDrawPlan(clipProject([{}, { clipping: true }, { clipping: true }, {}]));
  const draws = plan.steps.filter((s) => s.kind === 'draw');
  assert.deepEqual(draws.map((s) => s.clip), [false, true, true, false]);
  assert.deepEqual(draws.map((s) => s.target), ['group', 'group', 'group', 'canvas']);
});

test('a run reaching the bottom of the stack has no base under it', () => {
  // clipRunStart already says so; the plan must agree with it and not invent a
  // base. Layer 0 becomes its own base and draws unclipped.
  const project = clipProject([{ clipping: true }, { clipping: true }, {}]);
  const plan = buildDrawPlan(project);
  assert.deepEqual(kinds(plan), ['group-begin', 'draw', 'clip-alpha', 'draw', 'group-end', 'draw']);
  assert.deepEqual(indices(plan), [0, 1, 2]);
  assert.equal(plan.steps[1].clip, false, 'the lowest member is its own base');
});

test('the walk is clipRunEnd run by run, bottom to top', () => {
  // Pinned against the function renderProject itself walks with, so the two
  // cannot drift.
  const project = clipProject([{}, { clipping: true }, {}, {}, { clipping: true }]);
  const runs = [];
  for (let i = 0; i < project.layers.length; ) { runs.push(i); i = clipRunEnd(project.layers, i); }
  assert.deepEqual(runs, [0, 2, 3]);
  assert.deepEqual(indices(buildDrawPlan(project)), [0, 1, 2, 3, 4]);
  assert.deepEqual(kinds(buildDrawPlan(project)), [
    'group-begin', 'draw', 'clip-alpha', 'draw', 'group-end',
    'draw',
    'group-begin', 'draw', 'clip-alpha', 'draw', 'group-end',
  ]);
});

console.log('\ngpu sampling, masks and adjustments\n');

test('a 1:1 layer samples NEAREST; a resampled one samples LINEAR', () => {
  const plan = buildDrawPlan(clipProject([{}]), { scale: 1 });
  assert.equal(plan.steps[0].filter, 'nearest',
    'at 1:1 NEAREST lands on texel centres and the blit is bit-exact');
  assert.equal(buildDrawPlan(clipProject([{}]), { scale: 0.5 }).steps[0].filter, 'linear');
});

test('the mask is bound only when present and enabled', () => {
  assert.equal(buildDrawPlan(clipProject([{}])).steps[0].mask, null);
  const masked = buildDrawPlan(clipProject([{ mask: 128 }])).steps[0];
  assert.ok(masked.mask, 'an enabled mask must reach the shader');
  assert.equal(masked.mask.width, SIZE);

  // Photoshop saves switched-off masks. Applying one is as wrong as ignoring
  // an enabled one -- prepareLayer reads `disabled`, so this must too.
  const project = clipProject([{ mask: 128 }]);
  project.layers[0].mask.disabled = true;
  assert.equal(buildDrawPlan(project).steps[0].mask, null);
});

test('the clip-alpha step carries the base mask, because clipAlphaMap does', () => {
  const plan = buildDrawPlan(clipProject([{ mask: 200 }, { clipping: true }]));
  const alpha = plan.steps.find((s) => s.kind === 'clip-alpha');
  assert.ok(alpha.mask, 'clipAlphaMap multiplies by the base mask; so must the GPU');
  assert.deepEqual(alpha.rect, plan.steps[1].rect, 'the same rect the base was drawn with');
});

test('adjustment flags mirror isNeutralAdjust and the hsl test exactly', () => {
  const flagsOf = (adjust) => {
    const project = clipProject([{}]);
    project.layers[0].adjust = adjust;
    return buildDrawPlan(project).steps[0].adjustFlags;
  };
  assert.equal(flagsOf(null), 0);
  assert.equal(flagsOf(createAdjust()), 0, 'a neutral adjustment must not run the stage at all');
  assert.equal(flagsOf(createAdjust({ brightness: 40 })), 1);
  assert.equal(flagsOf(createAdjust({ hsl: { saturation: -60, bands: [] } })), 3,
    'applyAdjustments runs the LUT unconditionally, so bit 0 is set whenever the pass runs');
  assert.equal(flagsOf(createAdjust({ brightness: 40, hsl: { saturation: -60, bands: [] } })), 3);
});

test('a layer carrying a LUT plans its 768 bytes, and a neutral one plans none', () => {
  const project = clipProject([{}]);
  project.layers[0].adjust = createAdjust({ contrast: 100 });
  const step = buildDrawPlan(project).steps[0];
  assert.equal(step.lut.length, 768, 'exactly the bytes buildLut produced, uploaded as 256x1 RGBA');
  assert.deepEqual(Array.from(step.lut), Array.from(buildLut(project.layers[0].adjust)));
  assert.equal(buildDrawPlan(clipProject([{}])).steps[0].lut, null);
});

test('the HSL uniforms are packed in HSL_BANDS order', () => {
  const project = clipProject([{}]);
  project.layers[0].adjust = createAdjust({ hsl: {
    saturation: -60, bands: [{ h: 60, s: 40, l: 20 }, {}, {}, {}, {}, {}, {}, {}],
  } });
  const step = buildDrawPlan(project).steps[0];
  assert.deepEqual(Array.from(step.hsl.centres), HSL_BANDS.map((b) => b.centre));
  assert.equal(step.hsl.bands.length, 24, '8 bands x (h, s, l)');
  assert.deepEqual(Array.from(step.hsl.bands.slice(0, 3)), [60, 40, 20]);
  assert.equal(step.hsl.saturation, -60);
});

console.log('\ngpu refusals and memory\n');

test('an overlay adjustment refuses the tier instead of rendering without it', () => {
  // ops.js marks overlay class P with `glsl: null` -- there IS no shader for it.
  // Drawing the layer anyway would silently drop the gradient.
  const project = clipProject([{}, {}]);
  project.layers[1].adjust = createAdjust({ overlay: {
    kind: 'linear', angle: 30, mode: 'soft light', opacity: 0.8,
    stops: [{ t: 0, r: 255, g: 120, b: 0, a: 1 }, { t: 1, r: 0, g: 60, b: 200, a: 0.4 }],
  } });
  const plan = buildDrawPlan(project);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /overlay/i);
  assert.match(plan.reason, /L1/, 'the reason has to name the layer so it is actionable');
});

test('a canvas or a source beyond MAX_TEXTURE_SIZE refuses, rather than rendering a corner', () => {
  // Tiled uploads are not implemented. Clamping silently would render the top
  // left of the document at full size and call it a frame.
  const plan = buildDrawPlan(clipProject([{}]), { maxTextureSize: 8 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /texture size/i);
  assert.equal(buildDrawPlan(clipProject([{}]), { maxTextureSize: SIZE }).ok, true,
    'exactly at the limit is fine');
});

test('gpu bytes are the ping-pong pair plus every distinct texture', () => {
  const plan = buildDrawPlan(clipProject([{}, { left: 4 }]));
  const px = plan.width * plan.height;
  // Two full-canvas RGBA8 targets, because every draw reads the backdrop it writes.
  const layers = SIZE * SIZE * 4 + (SIZE - 4) * SIZE * 4;
  assert.equal(plan.bytes, 2 * px * 4 + layers);
});

test('a clip run adds the group pair and the clip alpha plane, and only then', () => {
  const plain = buildDrawPlan(clipProject([{}, {}]));
  const clipped = buildDrawPlan(clipProject([{}, { clipping: true }]));
  const px = plain.width * plain.height;
  assert.equal(clipped.bytes - plain.bytes, 2 * px * 4 + px,
    'a second ping-pong pair for the group, and one R8 plane for the base alpha');
  assert.equal(plain.groups, 0);
});

test('a mask costs one byte per source pixel, never four', () => {
  const plain = buildDrawPlan(clipProject([{}]));
  const masked = buildDrawPlan(clipProject([{ mask: 128 }]));
  assert.equal(masked.bytes - plain.bytes, SIZE * SIZE);
});

test('a plan over the budget refuses, and says what it would have cost', () => {
  const plan = buildDrawPlan(clipProject([{}, {}]), { budgetBytes: 1024 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /budget/i);
  assert.match(plan.reason, /\d/, 'the refusal has to carry the number');
  assert.ok(GPU_BUDGET_BYTES > 0);
});

console.log('\nmask, clip and present shaders\n');

test('the mask and the clip plane multiply into as in blendInto\'s order', () => {
  // blendInto: as = (a/255) * opacity, then *= mask/255, then *= clipAlpha/255,
  // and only then the `if (as <= 0) continue`. Float multiplication does not
  // associate, so a shader that folded the mask in after the early-out, or
  // multiplied the two planes together first, would round differently on every
  // partially masked pixel of every clipped run.
  const src = code(fragmentShaderFor('normal'));
  const opacityAt = src.indexOf('float as = src.a * uOpacity;');
  const maskAt = src.indexOf('if (uUseMask) as *= texture(uMask, uv).r;');
  const clipAt = src.indexOf('if (uUseClip) as *= texture(uClip, vDstPx / uCanvas).r;');
  const earlyAt = src.indexOf('if (as <= 0.0)');
  assert.ok(opacityAt > -1 && maskAt > -1 && clipAt > -1 && earlyAt > -1,
    'the four steps are not all present');
  assert.ok(opacityAt < maskAt && maskAt < clipAt && clipAt < earlyAt,
    'opacity, then mask, then clip, then the early-out');
});

test('the mask rides the source uv and the clip plane the canvas uv', () => {
  // A mask lives on exactly the same grid as the layer's pixels -- render.js
  // resamples it to the same rect from the same source dimensions. The clip
  // plane is full-canvas, because clipAlphaMap writes it in canvas coordinates.
  // Swapping the two spaces is a silent misregistration, not an error.
  const src = code(fragmentShaderFor('multiply'));
  assert.ok(src.includes('texture(uMask, uv).r'), 'the mask must sample at the SOURCE uv');
  assert.ok(src.includes('texture(uClip, vDstPx / uCanvas).r'),
    'the clip plane must sample at the CANVAS uv');
});

test('every mode carries both planes and both switches', () => {
  for (const mode of GPU_BLEND_MODES) {
    const src = code(fragmentShaderFor(mode));
    for (const decl of ['uniform sampler2D uMask;', 'uniform sampler2D uClip;',
      'uniform bool  uUseMask;', 'uniform bool  uUseClip;'])
      assert.ok(src.includes(decl), mode + ': missing ' + decl);
  }
});

test('adding the two planes did not put a 0..255 constant in a mode body', () => {
  // The existing rule, re-run against the enlarged main(): only `hard mix` may
  // mention 255 anywhere after the blend body begins.
  for (const mode of GPU_BLEND_MODES) {
    if (mode === 'hard mix') continue;
    const src = code(fragmentShaderFor(mode));
    const marker = isNonSeparableMode(programNameFor(mode)) ? 'vec3 blendFn(' : 'float chan(';
    assert.ok(!/255/.test(src.slice(src.indexOf(marker))), mode + ' carries a 0..255 constant');
  }
});

test('the clip-alpha pass truncates, because clipAlphaMap writes a Uint8Array', () => {
  const src = code(CLIP_ALPHA_FRAGMENT_SHADER);
  assert.ok(src.startsWith('#version 300 es'));
  // A unorm8 render target ROUNDS. Uint8Array TRUNCATES. Without floor() every
  // partially masked pixel of every clipped run would sit 1 LSB off the oracle.
  assert.ok(src.includes('fragColor = vec4(floor(a) / 255.0, 0.0, 0.0, 1.0);'),
    'the final store must truncate');
  // `pixels[si + 3] * opacity` is already 0..255 and does NOT divide; the mask
  // is a separate 0..255 plane and does.
  assert.ok(src.includes('float a = floor(texture(uSource, uv).a * 255.0 + 0.5) * uOpacity;'));
  assert.ok(src.includes('floor(texture(uMask, uv).r * 255.0 + 0.5) / 255.0'));
  // Outside the rect, zero -- what the zeroed scratch plane holds where
  // clipAlphaMap never reaches.
  assert.ok(src.includes('fragColor = vec4(0.0); return;'));
  assert.equal(count(src, '{'), count(src, '}'));
  assert.equal(count(src, '('), count(src, ')'));
});

test('the clip-alpha pass never blends: it has no backdrop at all', () => {
  // It is a reduction, not a composite. A uBackdrop here would mean somebody
  // had turned it into a draw, and the plane would accumulate across runs.
  assert.ok(!code(CLIP_ALPHA_FRAGMENT_SHADER).includes('uBackdrop'));
  assert.ok(!code(CLIP_ALPHA_FRAGMENT_SHADER).includes('blendFn'));
});

test('the Y flip lives in the present pass and nowhere else', () => {
  // Every internal target is row-major with row 0 at the top, matching every
  // Uint8ClampedArray in this engine and matching readPixels -- so compositing
  // and readback need no flip and conformance compares like for like. The
  // default framebuffer is the one surface with y running the other way.
  assert.ok(code(PRESENT_FRAGMENT_SHADER).includes('uCanvas.y - vDstPx.y'),
    'the present pass must flip Y');
  for (const mode of GPU_BLEND_MODES)
    assert.ok(!code(fragmentShaderFor(mode)).includes('uCanvas.y - vDstPx.y'),
      mode + ' flips Y, which would flip the accumulator against readPixels');
  assert.ok(!code(CLIP_ALPHA_FRAGMENT_SHADER).includes('uCanvas.y - vDstPx.y'));
});

test('the present pass is a copy, not a composite', () => {
  const src = code(PRESENT_FRAGMENT_SHADER);
  assert.ok(src.startsWith('#version 300 es'));
  assert.ok(!src.includes('uBackdrop'), 'presenting must not read a backdrop');
  assert.ok(!src.includes('uOpacity'), 'presenting must not scale alpha');
  assert.equal(count(src, 'void main()'), 1);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
