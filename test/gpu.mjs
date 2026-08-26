import assert from 'node:assert/strict';
import {
  SUPPORTED_BLEND_MODES,
  SEPARABLE_GLSL, NON_SEPARABLE_GLSL, GPU_BLEND_MODES, programNameFor, isNonSeparableMode,
  VERTEX_SHADER, fragmentShaderFor,
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
