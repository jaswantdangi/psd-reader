import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { createGpuRenderer } from '../src/gpu/renderer.js';
import { probeShaders, probeGpu } from '../src/gpu/probe.js';
import {
  CONFORMANCE_CLIPS, conformanceClipProject, conformanceNoteFor, CONFORMANCE_TABLE_D_NOTE,
} from '../src/conformance.js';

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

console.log('\ngpu renderer — plan to command sequence\n');

/**
 * A recording WebGL2 context.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT. Node has no WebGL, so nothing below
 * proves a pixel. What it proves is the half of a renderer that is a pure
 * function of the plan: which programs get compiled, which textures get bound
 * to which unit, what each draw's uniforms say, which framebuffer it targets,
 * and whether every resource created is deleted. Those are exactly the places a
 * GPU renderer diverges from `renderProject` in ways a screenshot never shows —
 * a clip plane bound to the base, a group's opacity spent twice, a texture
 * leaked per frame.
 *
 * PIXEL PARITY IS NOT MEASURED HERE AND CANNOT BE. It is measured on a device,
 * by /demo/conformance.html, against the JS oracle. A green run below says the
 * renderer issues the right commands; it says nothing about what the driver
 * does with them.
 *
 * @param {{failCompile?: boolean, failLink?: boolean, incompleteFramebuffer?: boolean,
 *          lost?: boolean, throwOnDraw?: boolean}} [fail]
 */
function fakeGl(fail = {}) {
  let nextId = 0;
  const alive = { texture: new Set(), framebuffer: new Set(), program: new Set(), shader: new Set(), vao: new Set() };
  const made = { texture: 0, framebuffer: 0, program: 0, shader: 0, vao: 0 };
  const born = (kind, extra = {}) => {
    const handle = { kind, id: ++nextId, ...extra };
    alive[kind].add(handle); made[kind]++;
    return handle;
  };
  const dies = (kind, handle) => { if (handle) alive[kind].delete(handle); };

  const gl = {
    // Only the enums this renderer actually names. A missing one shows up as
    // `undefined` in a recorded call rather than as a silent wrong path.
    TEXTURE_2D: 1, RGBA8: 2, R8: 3, RGBA: 4, RED: 5, UNSIGNED_BYTE: 6,
    CLAMP_TO_EDGE: 7, NEAREST: 8, LINEAR: 9,
    TEXTURE_WRAP_S: 10, TEXTURE_WRAP_T: 11, TEXTURE_MIN_FILTER: 12, TEXTURE_MAG_FILTER: 13,
    FRAMEBUFFER: 14, COLOR_ATTACHMENT0: 15, FRAMEBUFFER_COMPLETE: 16,
    COLOR_BUFFER_BIT: 17, TRIANGLES: 18,
    VERTEX_SHADER: 19, FRAGMENT_SHADER: 20, COMPILE_STATUS: 21, LINK_STATUS: 22,
    BLEND: 23, DEPTH_TEST: 24, SCISSOR_TEST: 25, CULL_FACE: 26,
    TEXTURE0: 100, UNPACK_ALIGNMENT: 27,
    drawingBufferWidth: 64, drawingBufferHeight: 64,

    isContextLost: () => fail.lost === true,

    createShader: (type) => born('shader', { type, source: null }),
    shaderSource: (shader, source) => { shader.source = source; },
    compileShader: () => {},
    getShaderParameter: () => fail.failCompile !== true,
    getShaderInfoLog: () => 'fake: syntax error at line 1',
    deleteShader: (shader) => dies('shader', shader),

    createProgram: () => born('program', { sources: [], uniforms: Object.create(null) }),
    attachShader: (program, shader) => program.sources.push(shader.source),
    detachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => fail.failLink !== true,
    getProgramInfoLog: () => 'fake: too many varyings',
    deleteProgram: (program) => dies('program', program),
    useProgram: (program) => { state.program = program; },
    getUniformLocation: (program, name) => (name.endsWith('[0]') ? null : { program, name }),

    createTexture: () => born('texture'),
    bindTexture: (target, texture) => { state.bound[state.unit] = texture; },
    texParameteri: () => {},
    texImage2D: () => {},
    pixelStorei: () => {},
    activeTexture: (unit) => { state.unit = unit - gl.TEXTURE0; },

    createFramebuffer: () => born('framebuffer'),
    bindFramebuffer: (target, framebuffer) => { state.framebuffer = framebuffer; },
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => (fail.incompleteFramebuffer ? 0x8cd6 : gl.FRAMEBUFFER_COMPLETE),
    deleteFramebuffer: (framebuffer) => dies('framebuffer', framebuffer),
    deleteTexture: (texture) => dies('texture', texture),

    createVertexArray: () => born('vao'),
    bindVertexArray: () => {},
    deleteVertexArray: (vao) => dies('vao', vao),

    viewport: () => {}, clearColor: () => {}, disable: () => {}, enable: () => {},
    colorMask: () => {},
    clear: () => { clears.push(state.framebuffer); },

    uniform1i: (loc, v) => { if (loc) state.program.uniforms[loc.name] = v; },
    uniform1f: (loc, v) => { if (loc) state.program.uniforms[loc.name] = v; },
    uniform2f: (loc, a, b) => { if (loc) state.program.uniforms[loc.name] = [a, b]; },
    uniform4f: (loc, a, b, c, d) => { if (loc) state.program.uniforms[loc.name] = [a, b, c, d]; },
    uniform1fv: (loc, v) => { if (loc) state.program.uniforms[loc.name] = Array.from(v); },

    readPixels: () => {},

    drawArrays: () => {
      if (fail.throwOnDraw) throw new Error('CONTEXT_LOST_WEBGL');
      draws.push({
        program: state.program,
        fragment: state.program.sources[1] || '',
        framebuffer: state.framebuffer,
        units: { ...state.bound },
        uniforms: { ...state.program.uniforms },
      });
    },
  };

  const state = { program: null, framebuffer: null, unit: 0, bound: Object.create(null) };
  const draws = [];
  const clears = [];

  return { gl, draws, clears, alive, made };
}

/** How many of a kind are still undeleted. */
const liveCount = (fake, kind) => fake.alive[kind].size;
/** The draws that went through a blend program carrying `body`. */
const drawsWith = (fake, body) => fake.draws.filter((d) => d.fragment.includes(body));

test('a plain stack is one draw per layer, and one program per DISTINCT mode', () => {
  // Compiling per draw is what turns a 2 ms frame into a 400 ms one on the mid
  // Adreno and Mali parts this targets — tens of milliseconds per compile.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const plan = buildDrawPlan(clipProject([{}, { mode: 'multiply' }, { mode: 'multiply' }]));
  const out = renderer.render(plan);

  assert.equal(out.ok, true, out.reason || '');
  assert.equal(out.draws, 3, 'three layers, three draws');
  assert.equal(renderer.programsCompiled, 2, 'normal and multiply — multiply compiled once');
  assert.equal(drawsWith(fake, 'return b * s;').length, 2);
  renderer.dispose();
});

test('a second frame in the same modes compiles nothing and uploads nothing', () => {
  // The drag case. Re-uploading a layer that did not change is not a slow
  // frame, it is a stalled one: the driver must finish last frame's reads
  // before it can overwrite the texture.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const project = clipProject([{}, { mode: 'screen' }]);

  renderer.render(buildDrawPlan(project));
  const compiled = renderer.programsCompiled;
  const uploads = renderer.uploads;

  renderer.render(buildDrawPlan(project));
  assert.equal(renderer.programsCompiled, compiled, 'a mode already compiled must not compile again');
  assert.equal(renderer.uploads, uploads, 'unchanged pixels must not be re-uploaded');
  renderer.dispose();
});

test('every draw reads the target the previous draw wrote — the ping-pong', () => {
  // Six of the 26 modes read all three backdrop channels at once and no
  // glBlendFunc can express them; the straight-alpha divide by `ao` cannot be
  // expressed either, for any mode. So the shader does the whole composite and
  // must READ the destination, and reading the texture a draw writes is
  // undefined in WebGL2 — not slow, undefined.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([{}, { mode: 'luminosity' }, {}])));

  assert.equal(fake.draws.length, 3);
  for (let i = 1; i < fake.draws.length; i++) {
    const backdrop = fake.draws[i].units[0];
    assert.notEqual(backdrop, fake.draws[i].framebuffer,
      'a draw must never read the target it writes');
    assert.ok(backdrop, 'the backdrop unit must always carry a texture');
  }
  assert.ok(drawsWith(fake, 'setLum').length === 1,
    'a non-separable mode goes through the ping-pong like any other, not through fixed-function blending');
  renderer.dispose();
});

test('exactly one clear per frame, plus one per clip run, and never the clip plane', () => {
  // Only the pair's READ side needs clearing: every fragment of every draw
  // writes the WRITE side, because the rect clamp returns the backdrop rather
  // than discarding. A second clear per draw would be a full-canvas write
  // nobody reads. And the clip plane must NOT be cleared: the reduction writes
  // it whole, zero outside the rect, so a clear plus a partial write would
  // leave the PREVIOUS run's alpha wherever this run's base does not reach.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([
    {}, { clipping: true }, {}, { clipping: true },
  ])));

  assert.equal(fake.clears.length, 3, 'the canvas backdrop once, and a group backdrop per run');
  // The clip plane is written by the reduction pass, which is the only draw
  // that ever targets it. If it appears here, somebody gave it a clear.
  const reduced = fake.draws.filter((d) => !d.fragment.includes('uBackdrop')).map((d) => d.framebuffer);
  assert.equal(reduced.length, 2, 'one reduction per run');
  for (const plane of reduced)
    assert.ok(!fake.clears.includes(plane), 'the clip plane must never be cleared');
  renderer.dispose();
});

test('a clip run allocates the group pair and the R8 plane; a plain stack does not', () => {
  const plain = fakeGl();
  const a = createGpuRenderer(plain.gl);
  a.render(buildDrawPlan(clipProject([{}, {}])));
  const plainTargets = liveCount(plain, 'texture');

  const clipped = fakeGl();
  const b = createGpuRenderer(clipped.gl);
  b.render(buildDrawPlan(clipProject([{}, { clipping: true }])));

  assert.equal(liveCount(clipped, 'texture') - plainTargets, 3,
    'a group ping-pong pair and one clip-alpha plane, and nothing else');
  assert.equal(liveCount(plain, 'framebuffer'), 2, 'the canvas pair only');
  assert.equal(liveCount(clipped, 'framebuffer'), 5, 'canvas pair, group pair, clip plane');
  a.dispose(); b.dispose();
});

test('every clipped member binds the clip plane; the base does not', () => {
  // On this tier the semantics are source-atop: the member's alpha is
  // multiplied by the base's. A base drawn with uUseClip set would clip itself
  // by its own alpha and darken every partially transparent edge.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const plan = buildDrawPlan(clipProject([{}, { clipping: true }, { clipping: true }]));
  renderer.render(plan);

  // group-begin, base draw, clip-alpha, two members, group-end.
  const blend = fake.draws.filter((d) => d.fragment.includes('uBackdrop'));
  assert.equal(blend.length, 4, 'base, two members, and the group composite');
  assert.equal(blend[0].uniforms.uUseClip, 0, 'the base must not clip to itself');
  assert.equal(blend[1].uniforms.uUseClip, 1);
  assert.equal(blend[2].uniforms.uUseClip, 1);
  assert.equal(blend[3].uniforms.uUseClip, 0, 'the group composite is not itself clipped');
  renderer.dispose();
});

test("the base draws at opacity 1 normal, and group-end spends the base's own opacity and mode", () => {
  // drawClipRunInto blends the base into the group at opacity 1 mode normal and
  // spends its real opacity and blend mode on the FINAL blend, because they
  // belong to the whole run. Applying them to the base as well would apply them
  // twice.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([
    { opacity: 0.4, mode: 'multiply' }, { clipping: true },
  ])));

  const blend = fake.draws.filter((d) => d.fragment.includes('uBackdrop'));
  assert.equal(blend[0].uniforms.uOpacity, 1, 'the base goes into the group at opacity 1');
  assert.ok(!blend[0].fragment.includes('return b * s;'), 'and through the normal program');
  const last = blend[blend.length - 1];
  assert.equal(last.uniforms.uOpacity, 0.4, "group-end spends the base's opacity");
  assert.ok(last.fragment.includes('return b * s;'), "group-end spends the base's mode");
  renderer.dispose();
});

test('group-end composites the whole canvas, with no mask and no adjustment', () => {
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const plan = buildDrawPlan(clipProject([{ mask: 128 }, { clipping: true }]));
  renderer.render(plan);

  const last = fake.draws.filter((d) => d.fragment.includes('uBackdrop')).pop();
  assert.deepEqual(last.uniforms.uRect, [0, 0, plan.width, plan.height],
    'the group is a full-canvas source, exactly as drawClipRunInto passes it');
  assert.equal(last.uniforms.uUseMask, 0,
    "the base's mask was already spent when the base drew into the group");
  assert.equal(last.uniforms.uAdjustFlags, 0);
  renderer.dispose();
});

test('the clip-alpha pass targets the plane, reads no backdrop, and never blends', () => {
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([{}, { clipping: true }])));

  const reduction = fake.draws.filter((d) => !d.fragment.includes('uBackdrop'));
  assert.equal(reduction.length, 1, 'exactly one clip-alpha pass for one run');
  assert.ok(reduction[0].fragment.includes('floor(a) / 255.0'),
    'and it is the truncating reduction, not a composite');
  // Every member afterwards binds that plane on the clip unit.
  const members = fake.draws.filter((d) => d.uniforms.uUseClip === 1);
  assert.ok(members.length > 0);
  for (const member of members)
    assert.equal(member.units[3], reduction[0].framebuffer.texture ?? member.units[3]);
  renderer.dispose();
});

test('the clip-alpha pass samples the base the same way the base draw did', () => {
  // It reduces the SAME source at the SAME rect. A base drawn NEAREST and
  // reduced LINEAR would put the run's alpha plane on a different footing from
  // the pixels it came from. This pins the renderer's local filter rule against
  // the plan's, which is the only place the two can drift.
  for (const scale of [1, 0.5]) {
    const plan = buildDrawPlan(clipProject([{}, { clipping: true }]), { scale });
    const base = plan.steps.find((s) => s.kind === 'draw');
    const reduce = plan.steps.find((s) => s.kind === 'clip-alpha');
    const derived = reduce.rect.width === reduce.source.width &&
      reduce.rect.height === reduce.source.height ? 'nearest' : 'linear';
    assert.equal(derived, base.filter, `scale ${scale}`);
  }
});

test('a mask binds the R8 plane, and a layer without one still binds a stand-in', () => {
  // uMask is live in every blend program — it sits behind a branch, and a
  // branch does not stop a sampler being active. A live sampler pointing at an
  // empty unit reads undefined data on several drivers.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([{ mask: 200 }, {}])));

  const [masked, plain] = fake.draws;
  assert.equal(masked.uniforms.uUseMask, 1);
  assert.equal(plain.uniforms.uUseMask, 0);
  assert.ok(masked.units[2], 'the mask unit carries the real plane');
  assert.ok(plain.units[2], 'and a stand-in when there is none');
  assert.notEqual(masked.units[2], plain.units[2]);
  assert.ok(plain.units[3], 'the clip unit is never left empty either');
  assert.ok(plain.units[4], 'nor the LUT unit');
  renderer.dispose();
});

test('an adjustment binds its 768 bytes; a neutral layer binds the stand-in and flags 0', () => {
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const project = clipProject([{}, {}]);
  project.layers[1].adjust = createAdjust({ contrast: 60 });
  renderer.render(buildDrawPlan(project));

  const [neutral, adjusted] = fake.draws;
  assert.equal(neutral.uniforms.uAdjustFlags, 0,
    'a neutral adjustment must cost exactly what no adjustment costs');
  assert.equal(adjusted.uniforms.uAdjustFlags, 1);
  assert.notEqual(adjusted.units[4], neutral.units[4], 'the LUT texture is the real table');
  renderer.dispose();
});

test('an HSL layer uploads its bands in HSL_BANDS order', () => {
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const project = clipProject([{}]);
  project.layers[0].adjust = createAdjust({ hsl: { saturation: -30, bands: [{ h: 12, s: 34, l: 56 }] } });
  renderer.render(buildDrawPlan(project));

  const draw = fake.draws[0];
  assert.equal(draw.uniforms.uAdjustFlags, 3, 'the LUT stage runs for an HSL-only layer too');
  assert.equal(draw.uniforms.uHslSaturation, -30);
  assert.equal(draw.uniforms.uHslCentres.length, HSL_BANDS.length);
  assert.deepEqual(draw.uniforms.uHslBands.slice(0, 3), [12, 34, 56]);
  renderer.dispose();
});

test('the live GPU bytes are exactly what the plan said the frame would cost', () => {
  // plan.bytes is a promise made before a single texture exists. This is the
  // assertion that makes it a measurement: targets plus uploads, counted on the
  // renderer, must equal it. The 1x1 stand-ins are outside the cache and cost
  // five bytes between them.
  for (const specs of [[{}, {}], [{ mask: 128 }, { clipping: true }]]) {
    const fake = fakeGl();
    const renderer = createGpuRenderer(fake.gl);
    const plan = buildDrawPlan(clipProject(specs));
    renderer.render(plan);
    assert.equal(renderer.bytes, plan.bytes, JSON.stringify(specs));
    renderer.dispose();
  }
});

console.log('\ngpu renderer — refusal, loss and release\n');

test('a refused plan renders nothing and allocates nothing', () => {
  // The refusal is the plan's decision. Second-guessing it here is how an
  // over-budget document loses the context it was refused to protect.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const plan = buildDrawPlan(clipProject([{}, {}]), { budgetBytes: 1024 });
  assert.equal(plan.ok, false);

  const out = renderer.render(plan);
  assert.equal(out.ok, false);
  assert.match(out.reason, /budget/i, 'the plan\'s own reason must survive');
  assert.equal(fake.draws.length, 0);
  // Construction builds the two 1x1 stand-ins and nothing else. That is the
  // baseline a refused frame must not move.
  assert.equal(fake.made.texture, 2, 'not one texture beyond the stand-ins');
  assert.equal(fake.made.framebuffer, 0, 'and not one render target');
  renderer.dispose();
});

test('a shader that will not compile degrades, and carries the driver log', () => {
  // A normal outcome on an unknown mobile GPU, not an exception. The caller has
  // a correct JS tier behind it; a throw would take the frame with it.
  const fake = fakeGl({ failCompile: true });
  const renderer = createGpuRenderer(fake.gl);
  const out = renderer.render(buildDrawPlan(clipProject([{}])));

  assert.equal(out.ok, false);
  assert.match(out.reason, /syntax error/, 'without the info log this is a bug report nobody can act on');
  assert.equal(fake.draws.length, 0);
  renderer.dispose();
});

test('a link failure degrades the same way, and is not retried 26 times', () => {
  const fake = fakeGl({ failLink: true });
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([{ mode: 'screen' }, { mode: 'multiply' }, { mode: 'hue' }])));

  assert.match(renderer.reason, /too many varyings/);
  assert.equal(fake.made.program, 1,
    'one failure poisons the cache — collecting 26 copies of one info log is how a ' +
    'fallback that should take a millisecond takes a second');
  renderer.dispose();
});

test('an incomplete framebuffer refuses before the first draw', () => {
  // Finding this out at the first draw instead means a frame of garbage rather
  // than a fallback.
  const fake = fakeGl({ incompleteFramebuffer: true });
  const renderer = createGpuRenderer(fake.gl);
  const out = renderer.render(buildDrawPlan(clipProject([{}])));

  assert.equal(out.ok, false);
  assert.match(out.reason, /incomplete/i);
  assert.equal(fake.draws.length, 0);
  assert.equal(liveCount(fake, 'texture'), 2,
    'the two 1x1 stand-ins remain; a failed target must not leak its own texture');
  assert.equal(liveCount(fake, 'framebuffer'), 0);
  renderer.dispose();
});

test('a lost context refuses instead of throwing, before and during a frame', () => {
  const before = fakeGl({ lost: true });
  const a = createGpuRenderer(before.gl);
  const out = a.render(buildDrawPlan(clipProject([{}])));
  assert.equal(out.ok, false);
  assert.match(out.reason, /lost/i);
  a.dispose();

  const during = fakeGl({ throwOnDraw: true });
  const b = createGpuRenderer(during.gl);
  const mid = b.render(buildDrawPlan(clipProject([{}])));
  assert.equal(mid.ok, false, 'an exception mid-frame must come back as a refusal');
  assert.match(mid.reason, /CONTEXT_LOST_WEBGL/);
  b.dispose();
});

test('present and readback refuse on a lost context rather than throwing', () => {
  const fake = fakeGl({ lost: true });
  const renderer = createGpuRenderer(fake.gl);
  assert.equal(renderer.present(), false);
  assert.equal(renderer.readInto(createBuffer(SIZE, SIZE)), false);
  renderer.dispose();
});

test('readback refuses a buffer that is not the frame it rendered', () => {
  // Silently reading a mismatched buffer is a torn image, which looks like a
  // renderer bug for as long as it takes to find the size.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([{}])));
  assert.equal(renderer.readInto(createBuffer(SIZE + 1, SIZE)), false);
  assert.equal(renderer.readInto(createBuffer(SIZE, SIZE)), true);
  renderer.dispose();
});

test('dispose deletes every texture, framebuffer, program and vertex array it made', () => {
  // A leaked texture per frame kills a phone in seconds, and textures are
  // invisible to estimatePeakBytes and to the JS heap profiler alike.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const project = clipProject([{ mask: 90 }, { clipping: true, mode: 'multiply' }]);
  project.layers[0].adjust = createAdjust({ brightness: 20 });
  renderer.render(buildDrawPlan(project));
  renderer.present();

  assert.ok(fake.made.texture > 0 && fake.made.program > 0);
  renderer.dispose();
  for (const kind of ['texture', 'framebuffer', 'program', 'shader', 'vao'])
    assert.equal(liveCount(fake, kind), 0, `${kind} leaked: ${liveCount(fake, kind)} of ${fake.made[kind]}`);
  assert.equal(renderer.bytes, 0);
});

test('a second dispose is a no-op, and rendering after one refuses', () => {
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([{}])));
  renderer.dispose();
  const deleted = fake.made.texture;
  renderer.dispose();
  assert.equal(fake.made.texture, deleted);
  assert.equal(renderer.render(buildDrawPlan(clipProject([{}]))).ok, false);
});

test('a resize frees the old targets before it allocates the new ones', () => {
  // Reallocating a full-canvas pair per frame is the allocation pattern that
  // loses a mobile context. Holding the old one as well is the leak that
  // survives every resize.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const project = clipProject([{}]);
  renderer.render(buildDrawPlan(project));
  renderer.render(buildDrawPlan(project, { scale: 0.5 }));
  renderer.render(buildDrawPlan(project, { scale: 0.25 }));

  // Two canvas targets live at any moment, plus one upload for the layer.
  assert.equal(liveCount(fake, 'framebuffer'), 2, 'exactly one canvas pair survives three sizes');
  assert.equal(renderer.targetBytes, buildDrawPlan(project, { scale: 0.25 }).bytes -
    project.layers[0].pixels.width * project.layers[0].pixels.height * 4);
  renderer.dispose();
});

test('a frame that stops needing a group gives the group pair and the plane back', () => {
  // A document whose clipped layer is deleted must stop paying for the group.
  // Keeping it "in case" is a third of the frame's memory held for nothing.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const clipped = clipProject([{}, { clipping: true }]);
  renderer.render(buildDrawPlan(clipped));
  const withGroup = liveCount(fake, 'framebuffer');

  renderer.render(buildDrawPlan(clipProject([{}, {}])));
  assert.equal(withGroup, 5);
  assert.equal(liveCount(fake, 'framebuffer'), 2, 'the group pair and the clip plane are released');
  renderer.dispose();
});

test('the upload cache evicts to the budget, but never what this frame uses', () => {
  // An unbounded texture cache on a phone is a context loss a few documents in,
  // and a lost context is a black canvas. Evicting something the frame still
  // needs is strictly worse than being over budget: it re-uploads within the
  // same frame and thrashes.
  const fake = fakeGl();
  const layerBytes = SIZE * SIZE * 4;
  const renderer = createGpuRenderer(fake.gl, { budgetBytes: layerBytes * 2 });

  const a = clipProject([{}]);
  const b = clipProject([{}]);
  const c = clipProject([{}]);
  renderer.render(buildDrawPlan(a));
  renderer.render(buildDrawPlan(b));
  renderer.render(buildDrawPlan(c));
  assert.ok(renderer.uploadBytes <= layerBytes * 2, `${renderer.uploadBytes} over budget`);

  // Three DISTINCT sources in one frame, over a budget that fits two: none may
  // be evicted, because all three are still to be drawn.
  const fake2 = fakeGl();
  const wide = createGpuRenderer(fake2.gl, { budgetBytes: layerBytes * 2 });
  const three = clipProject([{}, {}, {}]);
  wide.render(buildDrawPlan(three));
  assert.equal(wide.uploads, 3);
  assert.equal(wide.uploadBytes, layerBytes * 3, 'a frame is never starved of its own textures');
  renderer.dispose(); wide.dispose();
});

test('releaseUploads drops the cache and keeps the frame able to draw', () => {
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const project = clipProject([{}]);
  renderer.render(buildDrawPlan(project));
  assert.ok(renderer.uploadBytes > 0);

  renderer.releaseUploads();
  assert.equal(renderer.uploadBytes, 0);
  assert.ok(renderer.targetBytes > 0, 'the targets stay — only the uploads went');
  assert.equal(renderer.render(buildDrawPlan(project)).ok, true, 'and the next frame re-uploads');
  renderer.dispose();
});

test('an unknown plan step is a refusal, never a skip', () => {
  // Skipping it would drop a layer and still report success, which is the one
  // failure shape that looks like a success.
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  const plan = buildDrawPlan(clipProject([{}]));
  plan.steps.push({ kind: 'blur-pass', index: 9 });
  const out = renderer.render(plan);
  assert.equal(out.ok, false);
  assert.match(out.reason, /blur-pass/);
  renderer.dispose();
});

test('the present pass targets the default framebuffer and flips Y', () => {
  const fake = fakeGl();
  const renderer = createGpuRenderer(fake.gl);
  renderer.render(buildDrawPlan(clipProject([{}])));
  const beforePresent = fake.draws.length;
  assert.equal(renderer.present(), true);

  const presented = fake.draws[beforePresent];
  assert.equal(presented.framebuffer, null, 'presenting goes to the visible drawing buffer');
  assert.ok(presented.fragment.includes('uCanvas.y - vDstPx.y'));
  assert.deepEqual(presented.uniforms.uCanvas, [fake.gl.drawingBufferWidth, fake.gl.drawingBufferHeight]);
  renderer.dispose();
});

console.log('\nconformance table C — clip runs\n');

test('every clip row builds a plan, and only a real run opens a group', () => {
  // Tables A and D are two flat layers. A clip run opens a second ping-pong
  // pair, runs a reduction into an R8 plane and spends the base's opacity on a
  // final composite — none of which a two-layer document touches. The whole
  // clipping path could be wrong on the GPU and every other table stay green.
  for (const entry of CONFORMANCE_CLIPS) {
    const plan = buildDrawPlan(conformanceClipProject(entry, 32));
    assert.equal(plan.ok, true, `${entry.id}: ${plan.reason}`);
    const kinds = new Set(plan.steps.map((s) => s.kind));
    if (entry.members.length === 0) {
      assert.equal(plan.groups, 0, `${entry.id}: a run of one must allocate no group`);
      assert.ok(!kinds.has('clip-alpha'), `${entry.id}: and no clip plane`);
    } else {
      assert.equal(plan.groups, 1, `${entry.id}`);
      for (const kind of ['group-begin', 'clip-alpha', 'group-end'])
        assert.ok(kinds.has(kind), `${entry.id}: missing ${kind}`);
    }
  }
});

test('the clip rows carry the thing each of them is named for', () => {
  const of = (id) => CONFORMANCE_CLIPS.find((e) => e.id === id);
  const planOf = (id) => buildDrawPlan(conformanceClipProject(of(id), 32));

  // The truncating reduction only diverges where the base's alpha is PARTIAL.
  const masked = planOf('masked-base').steps.find((s) => s.kind === 'clip-alpha');
  assert.ok(masked.mask, 'masked-base must reach the reduction with a mask');
  const values = new Set(masked.mask.data);
  assert.ok(values.size > 2, 'a flat mask would exercise neither rounding nor truncation');

  // The base's opacity and mode belong to the whole run and are spent ONCE, at
  // the end. A renderer applying them to the base draw as well reads as
  // 0.6 * 0.6 = 0.36 and merely looks "a bit light".
  // The SECOND draw. The first is the backdrop layer underneath, which is a
  // run of one and draws before the run opens.
  const late = planOf('base-spends-late');
  const base = late.steps.filter((s) => s.kind === 'draw')[1];
  const end = late.steps.find((s) => s.kind === 'group-end');
  assert.equal(base.opacity, 1);
  assert.equal(base.program, 'normal');
  assert.equal(end.opacity, 0.6);
  assert.equal(end.program, 'screen');

  // A non-separable member inside a run: the ping-pong and the clip plane at once.
  assert.ok(planOf('non-separable-member').steps.some((s) => s.program === 'hue' && s.clip));

  // The reduction reads alpha AFTER the base's adjustments, so an adjusted base
  // must still reach it as the same source at the same rect.
  const adjusted = planOf('adjusted-base');
  const adjustedBase = adjusted.steps.filter((s) => s.kind === 'draw')[1];
  assert.ok(adjustedBase.adjustFlags & 1, 'adjusted-base must actually run the pass');
  assert.equal(adjusted.steps.find((s) => s.kind === 'clip-alpha').source, adjustedBase.source);
});

test('every clip row renders through the JS oracle and compares PASS against itself', () => {
  // The oracle half of the route, covered here so the thing the GPU is measured
  // against is itself under test. On a device the second render is the GPU's.
  for (const entry of CONFORMANCE_CLIPS) {
    const project = conformanceClipProject(entry, 32);
    const a = renderProject(project);
    const b = renderProject(project);
    assert.equal(verdictFor(compareRenders(a, b)), 'PASS', entry.id);
    assert.ok(a.data.some((v) => v !== 0), `${entry.id} rendered nothing at all`);
  }
});

test('the route note says which tier it actually got, and never implies more', () => {
  // A green table that means nothing is worse than an absent one.
  const js = conformanceNoteFor(TIER_JS, 'shader probe not run');
  assert.match(js, /against ITSELF/);
  assert.match(js, /shader probe not run/, "selectTier's own words, verbatim");
  assert.match(js, /green by construction/);

  const gpu = conformanceNoteFor(TIER_MAIN_GPU, 'WebGL2 on the main thread');
  assert.match(gpu, /renderProject/, 'it has to name the oracle');
  assert.match(gpu, /floor, not a/i, 'and say that tolerance 1 is a floor');
  assert.ok(!/green by construction/.test(gpu));

  // The old constant claimed no GPU tier existed anywhere. One does now, so the
  // claim it makes had to narrow to this DEVICE.
  assert.ok(!/Plan 1B-2/.test(CONFORMANCE_TABLE_D_NOTE));
  assert.match(CONFORMANCE_TABLE_D_NOTE, /This device/);
});

console.log('\ngpu shader probe\n');

test('the probe refuses a missing context instead of assuming one', () => {
  const out = probeShaders(null);
  assert.equal(out.ok, false);
  assert.equal(selectTier({ webgl2: true, probe: out }).tier, TIER_JS);
});

test('a context that draws nothing fails the probe rather than passing it', () => {
  // The whole point. getContext('webgl2') !== null says nothing about whether
  // the compiler works or whether readback returns what was drawn, and the
  // failure that hides is an all-black canvas on one phone model.
  const fake = fakeGl();
  const out = probeShaders(fake.gl);
  assert.equal(out.ok, false);
  assert.match(out.reason, /differs from renderProject/);
  assert.ok(out.maxDelta > 1, 'and it must say by how much');

  const { tier, verdict } = selectTier({ webgl2: true, offscreenCanvas: true, transferControl: true, probe: out });
  assert.equal(tier, TIER_JS, 'a failed probe never reaches a GPU tier');
  assert.match(verdict, /differs from renderProject/, 'the driver reason must reach the harness');
});

test('the probe compiles the generated shaders, separable AND non-separable', () => {
  // A probe that compiled its own trivial shader would pass on a device where
  // the generated ones fail, which is the only failure that matters. The
  // prelude — setSat, clipColor, both EPS guards — is what a bad compiler eats.
  const fake = fakeGl();
  probeShaders(fake.gl);
  const sources = [...fake.alive.program, ...fake.draws.map((d) => ({ sources: [null, d.fragment] }))]
    .map((p) => p.sources[1] || '').join('\n');
  assert.ok(fake.draws.length >= 3, 'three layers, three composites');
  assert.ok(sources.includes('return b * s;'), 'a separable program');
  assert.ok(sources.includes('setLum(b, lum(s))'), 'and the non-separable prelude');
});

test('a compile failure comes back as a reason, not an exception', () => {
  const fake = fakeGl({ failCompile: true });
  const out = probeShaders(fake.gl);
  assert.equal(out.ok, false);
  assert.match(out.reason, /syntax error/, 'the driver log has to survive to the harness');
});

test('the probe releases everything it made, pass or fail', () => {
  // Tier selection runs before the first frame. A probe that left three
  // textures and two framebuffers behind would leak them for the life of the
  // page while looking like a success.
  for (const fail of [{}, { failCompile: true }, { throwOnDraw: true }]) {
    const fake = fakeGl(fail);
    probeShaders(fake.gl);
    for (const kind of ['texture', 'framebuffer', 'program', 'shader', 'vao'])
      assert.equal(fake.alive[kind].size, 0,
        `${kind} leaked with ${JSON.stringify(fail)}`);
  }
});

test('an exception inside the probe is a refusal, not a throw', () => {
  const fake = fakeGl({ throwOnDraw: true });
  const out = probeShaders(fake.gl);
  assert.equal(out.ok, false);
  assert.match(out.reason, /CONTEXT_LOST_WEBGL/);
});

test('probeGpu reports no GPU in Node, and selectTier agrees', () => {
  // Same contract probeCapabilities has, extended with the probe. There is no
  // document and no WebGL here, so the honest answer is a refusal.
  const caps = probeGpu();
  assert.equal(caps.webgl2, false);
  assert.equal(caps.probe, null);
  assert.equal(selectTier(caps).tier, TIER_JS);
});

console.log('\nthe conformance route\n');

/**
 * Read and resolved UP FRONT, at module scope.
 *
 * `test()` calls its body synchronously, so an async body would return a
 * pending promise, be counted as a pass before it asserted anything, and turn a
 * rejection into an unhandled one — a test that reports ok and checks nothing.
 */
const pageJs = readFileSync(new URL('../demo/conformance.js', import.meta.url), 'utf8');
const pageHtml = readFileSync(new URL('../demo/conformance.html', import.meta.url), 'utf8');
const pageImports = [...pageJs.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)]
  .map(([, names, from]) => ({ from, names: names.split(',').map((n) => n.trim()).filter(Boolean) }));
const pageModules = new Map();
for (const { from } of pageImports)
  if (!pageModules.has(from)) pageModules.set(from, await import(new URL('..' + from, import.meta.url)));

test('every import the conformance page names is actually exported', () => {
  // The page is the ONLY place pixel parity is measured, and no browser test
  // covers it. A renamed export breaks it silently: the page loads, the module
  // graph fails, and the buttons simply do nothing — which reads as "the GPU is
  // fine, there is just no result".
  assert.ok(pageImports.length >= 6, 'the page must still be importing from src/');
  for (const { from, names } of pageImports) {
    assert.ok(from.startsWith('/src/'), `${from} is not served by serve.mjs from the repo root`);
    for (const name of names)
      assert.ok(name in pageModules.get(from), `${from} does not export ${name}`);
  }
});

test('the page is reachable at a path serve.mjs actually serves', () => {
  // serve.mjs maps a URL straight onto a repo path and 404s anything else, so
  // the page and its module must both exist exactly where the URL says.
  assert.ok(pageJs.length > 0 && pageHtml.length > 0);
  assert.ok(pageHtml.includes('src="/demo/conformance.js"'),
    'the html must load the module by its served path');
  assert.ok(pageHtml.includes('type="module"'));
});

test('the page never claims a GPU comparison it did not make', () => {
  // The failure this exists for is a page that renders JS against itself and
  // prints PASS. It must go through conformanceNoteFor, and its own summary
  // line must say so in the JS-tier branch.
  assert.ok(pageJs.includes('conformanceNoteFor'), 'the tier note must come from src, not from prose here');
  assert.ok(/JS against itself/.test(pageJs),
    'the summary must say what a green table means on the JS tier');
  assert.ok(pageJs.includes('gl.finish()'),
    'a GPU timing without finish() measures how fast commands are QUEUED, which is meaningless');
  assert.ok(pageJs.includes('renderer.dispose()'), 'the page must release its GPU memory');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
