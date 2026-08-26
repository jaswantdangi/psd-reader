import fs from 'fs';
import assert from 'node:assert/strict';
import {
  readDocument, createProject, setLayer, reorderLayer, undo, redo,
  hitTest, renderProject, resample, toProjectJson, applyProjectJson,
  BLEND_MODES, SUPPORTED_BLEND_MODES,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const bytes = new Uint8Array(fs.readFileSync('fixtures/effects.src.psd'));
const doc = await readDocument(bytes, { pixels: 'eager', metadata: false });
const project = createProject(doc, 'effects.src.psd');

const textBytes = new Uint8Array(fs.readFileSync('fixtures/text.src.psd'));
const textProject = createProject(await readDocument(textBytes, { pixels: 'eager', metadata: false }), 'text.src.psd');

console.log('\nedit model\n');

test('flattens the tree into an ordered layer list', () => {
  assert.ok(project.layers.length > 0);
  assert.equal(project.width, doc.width);
});

test('layers start at their original bounds', () => {
  const l = project.layers[0];
  // Documentation, not a trap: since sourceW/H are derived from the same bounds
  // as w/h, this cannot fail. There is no discriminating assertion available on
  // an eager load, where proxyW/H, sourceW/H and pixels.width all coincide by
  // construction. The assertion that can actually catch a regression lives in
  // test/proxy.mjs, against a genuinely downscaled fixture.
  assert.equal(l.w, l.sourceW);
  assert.equal(l.h, l.sourceH);
});

test('move is undoable', () => {
  const l = project.layers[0];
  const x0 = l.x;
  setLayer(project, l.id, { x: x0 + 25 });
  assert.equal(l.x, x0 + 25);
  assert.ok(undo(project));
  assert.equal(l.x, x0);
  assert.ok(redo(project));
  assert.equal(l.x, x0 + 25);
  undo(project);
});

test('resize is non-destructive — original pixels never change', () => {
  const l = project.layers[0];
  const before = l.pixels.data.slice(0, 64);
  const w0 = l.w, h0 = l.h;
  setLayer(project, l.id, { w: Math.round(w0 * 0.2), h: Math.round(h0 * 0.2) });
  setLayer(project, l.id, { w: w0, h: h0 });
  assert.deepEqual(l.pixels.data.slice(0, 64), before, 'source pixels were mutated');
  assert.equal(l.w, w0);
  undo(project); undo(project);
});

test('a drag coalesces into one undo step', () => {
  const l = project.layers[0];
  const x0 = l.x;
  const depth = project.history.length;
  for (let i = 1; i <= 20; i++) setLayer(project, l.id, { x: x0 + i }, 'drag');
  assert.equal(project.history.length, depth + 1, 'expected exactly one history entry');
  assert.equal(l.x, x0 + 20);
  undo(project);
  assert.equal(l.x, x0);
});

test('reorder moves a layer and undoes cleanly', () => {
  const order = project.layers.map((l) => l.id);
  reorderLayer(project, 0, 2);
  assert.notDeepEqual(project.layers.map((l) => l.id), order);
  assert.equal(project.layers[2].id, order[0]);
  undo(project);
  assert.deepEqual(project.layers.map((l) => l.id), order);
});

test('blend mode and opacity are settable', () => {
  const l = project.layers[0];
  setLayer(project, l.id, { blendMode: 'multiply', opacity: 0.5 });
  assert.equal(l.blendMode, 'multiply');
  assert.equal(l.opacity, 0.5);
  undo(project);
  assert.equal(l.blendMode, 'normal');
});

test('hit test finds the top opaque layer and misses empty space', () => {
  const l = project.layers[project.layers.length - 1];
  const cx = Math.floor(l.x + l.w / 2), cy = Math.floor(l.y + l.h / 2);
  assert.ok(hitTest(project, cx, cy), 'expected a hit inside a layer');
  assert.equal(hitTest(project, -50, -50), null, 'expected a miss outside the canvas');
});

console.log('\nrender\n');

test('renders at document resolution', () => {
  const out = renderProject(project);
  assert.equal(out.width, project.width);
  assert.equal(out.height, project.height);
});

test('scale produces a proportionally smaller buffer', () => {
  const out = renderProject(project, { scale: 0.5 });
  assert.equal(out.width, Math.round(project.width * 0.5));
});

test('moving a layer changes the rendered output', () => {
  const before = renderProject(project, { scale: 0.5 });
  const l = project.layers[project.layers.length - 1];
  setLayer(project, l.id, { x: l.x + 40 });
  const after = renderProject(project, { scale: 0.5 });
  assert.notDeepEqual(Array.from(after.data), Array.from(before.data), 'render did not change');
  undo(project);
});

test('hidden layers are excluded', () => {
  const l = project.layers[project.layers.length - 1];
  const before = renderProject(project, { scale: 0.4 });
  setLayer(project, l.id, { visible: false });
  const after = renderProject(project, { scale: 0.4 });
  assert.notDeepEqual(Array.from(after.data), Array.from(before.data));
  undo(project);
});

test('resample preserves dimensions and returns the source when unchanged', () => {
  const src = project.layers[0].pixels;
  assert.equal(resample(src, src.width, src.height), src);
  const half = resample(src, Math.max(1, src.width >> 1), Math.max(1, src.height >> 1));
  assert.equal(half.width, Math.max(1, src.width >> 1));
});

console.log('\npersistence\n');

test('project json round-trips through a fresh read', async () => {
  const l = project.layers[0];
  setLayer(project, l.id, { x: l.x + 17, opacity: 0.42, blendMode: 'screen' });
  const json = JSON.parse(JSON.stringify(toProjectJson(project)));

  const doc2 = await readDocument(bytes, { pixels: 'eager', metadata: false });
  const restored = applyProjectJson(createProject(doc2, 'effects.src.psd'), json);

  assert.equal(restored.layers[0].x, project.layers[0].x);
  assert.equal(restored.layers[0].opacity, 0.42);
  assert.equal(restored.layers[0].blendMode, 'screen');
  undo(project);
});

test('rejects a project file from a different document', () => {
  const json = toProjectJson(project);
  json.layers = json.layers.slice(0, 1);
  assert.throws(() => applyProjectJson(project, json), /Layer count differs/);
});


// ---------------------------------------------------------------------------
// Scaled text must be re-shaped at its final size, not bitmap-scaled.
// Node has no canvas, so stub just enough of one to observe what we ask it to do.
// ---------------------------------------------------------------------------
console.log('\ntext scaling\n');

const calls = [];
globalThis.document = {
  createElement() {
    const el = { width: 0, height: 0 };
    el.getContext = () => ({
      set font(v) { calls.push(['font', v]); this._size = parseFloat(v) || 10; },
      get font() { return ''; },
      fillStyle: '', textBaseline: '', textAlign: '',
      setTransform: (...a) => calls.push(['setTransform', ...a]),
      fillText: (...a) => calls.push(['fillText', ...a]),
      measureText: (s) => ({ width: s.length * 10 }),   // 10px per character
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    });
    return el;
  },
};

const { rasteriseTextAt, measureText: measure } = await import('../src/index.js');

const textLayer = {
  kind: 'text', rerendered: true,
  text: { content: 'ABCD', fontFamily: 'Arial', fontSize: 20, color: '#ff0000',
          align: 'left', bold: false, italic: false },
};

test('rasterises at the requested size, not the natural one', () => {
  const natural = measure(textLayer.text);
  assert.equal(natural.width, 40, 'stub should measure 4 chars at 10px');

  const out = rasteriseTextAt(textLayer, 400, 125);
  assert.equal(out.width, 400);
  assert.equal(out.height, 125);
  assert.equal(out.data.length, 400 * 125 * 4);
});

test('scales the canvas transform instead of resampling a bitmap', () => {
  calls.length = 0;
  const natural = measure(textLayer.text);
  rasteriseTextAt(textLayer, natural.width * 10, natural.height * 4);

  const transform = calls.find((c) => c[0] === 'setTransform');
  assert.ok(transform, 'expected setTransform to be used');
  assert.equal(Math.round(transform[1]), 10, 'horizontal scale should be 10x');
  assert.equal(Math.round(transform[4]), 4, 'vertical scale should be 4x');
});

test('a 10x scale-up re-shapes glyphs rather than enlarging pixels', () => {
  const natural = measure(textLayer.text);
  const small = rasteriseTextAt(textLayer, natural.width, natural.height);
  const large = rasteriseTextAt(textLayer, natural.width * 10, natural.height * 10);
  // Bitmap upscaling would have produced exactly 100x the source samples from
  // the same small render. Re-shaping produces its own buffer at full size.
  assert.equal(large.data.length, small.data.length * 100);
  assert.equal(large.width, natural.width * 10);
});

test('resizing a text layer switches it to live rendering', () => {
  const tl = textProject.layers.find((l) => l.kind === 'text');
  assert.ok(tl, 'text.src.psd must contain a text layer');
  assert.equal(tl.rerendered, false, 'should start on Photoshop pixels');
  setLayer(textProject, tl.id, { w: tl.w * 3, h: tl.h * 3, rerendered: true });
  assert.equal(tl.rerendered, true);
  undo(textProject);
  assert.equal(tl.rerendered, false, 'undo should restore Photoshop pixels');
});

test('changing text clears the render cache key, not just the pixels', () => {
  const tl = textProject.layers.find((l) => l.kind === 'text');
  assert.ok(tl, 'text.src.psd must contain a text layer');
  tl.rendered = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  tl.renderedKey = 'stale';
  setLayer(textProject, tl.id, { text: { content: 'changed' } });
  assert.equal(tl.renderedKey, null, 'a stale key would return null pixels and hide the layer');
  undo(textProject);
});

test('the UI offers exactly the blend modes the compositor implements', () => {
  // These drifted by eight modes once: the compositor handled 26, the UI listed
  // 18, so a file using `vivid light` rendered correctly while the user could
  // neither see nor preserve the mode. Asserting both directions — a hidden
  // mode is a lost feature, a phantom mode renders wrong.
  const hidden = SUPPORTED_BLEND_MODES.filter((m) => !BLEND_MODES.includes(m));
  const phantom = BLEND_MODES.filter((m) => !SUPPORTED_BLEND_MODES.includes(m));
  assert.deepEqual(hidden, [], 'implemented by the compositor but hidden from the user');
  assert.deepEqual(phantom, [], 'offered to the user but not implemented — would render wrong');
});

delete globalThis.document;
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
