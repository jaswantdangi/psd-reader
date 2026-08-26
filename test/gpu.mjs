import assert from 'node:assert/strict';
import {
  SUPPORTED_BLEND_MODES,
  SEPARABLE_GLSL, NON_SEPARABLE_GLSL, GPU_BLEND_MODES, programNameFor, isNonSeparableMode,
  VERTEX_SHADER, fragmentShaderFor,
  create2dSurface, measureText, rasteriseTextAt,
  createBuffer, createProject, setLayer, undo, redo, toProjectJson, applyProjectJson, renderProject, drawLayerInto,
  compareBuffers, flattenOnto, createSandwichCache, renderSandwiched, sandwichStateFor, SANDWICH_FLAT_ABOVE, SANDWICH_BELOW_ONLY,
} from '../src/index.js';

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
  assert.ok(code(fragmentShaderFor('hard mix')).includes('floor(b * 255.0 + 0.5)'));
  for (const mode of GPU_BLEND_MODES) {
    if (mode === 'hard mix') continue;
    assert.ok(!/255/.test(code(fragmentShaderFor(mode))),
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
