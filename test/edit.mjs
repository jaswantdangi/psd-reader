import fs from 'fs';
import assert from 'node:assert/strict';
import {
  readDocument, createProject, setLayer, reorderLayer, undo, redo,
  hitTest, renderProject, resample, toProjectJson, applyProjectJson,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const bytes = new Uint8Array(fs.readFileSync('fixtures/effects.src.psd'));
const doc = await readDocument(bytes, { pixels: 'eager', metadata: false });
const project = createProject(doc, 'effects.src.psd');

console.log('\nedit model\n');

test('flattens the tree into an ordered layer list', () => {
  assert.ok(project.layers.length > 0);
  assert.equal(project.width, doc.width);
});

test('layers start at their original bounds', () => {
  const l = project.layers[0];
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
