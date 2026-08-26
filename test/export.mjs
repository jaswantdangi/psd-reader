import assert from 'node:assert/strict';
import fs from 'fs';
import {
  createProject, loadProjectProxy, readDocument,
  ExportError, isSelfRendering, buildExportOrder, wantedIndices, assertIdentifiable, isFastPath, planSpill,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};
/** Async sibling of `test`. Every call site must `await` it, or failures escape. */
const atest = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const bytesOf = (path) => new Uint8Array(fs.readFileSync(path));
const img = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

console.log('\nlayer identity\n');

/**
 * A document shaped like one that has been streamed, with a pixel-less leaf in
 * the MIDDLE. No fixture has one — all 21 were checked, and the three with
 * dropped leaves drop only trailing ones, where positional matching still works
 * by accident. This is the only shape that discriminates.
 */
const gapDoc = () => ({
  width: 40, height: 10,
  children: [
    { name: 'bottom', left: 0,  top: 0, right: 10, bottom: 10, sourceIndex: 0, proxyData: img(2, 2) },
    { name: 'empty',  left: 0,  top: 0, right: 10, bottom: 10, sourceIndex: 1 },
    { name: 'top',    left: 10, top: 0, right: 20, bottom: 10, sourceIndex: 2, proxyData: img(2, 2) },
  ],
});

test('a pixel-less leaf keeps its slot, so the layer above it is index 2, not 1', () => {
  const project = createProject(gapDoc(), 'gap.psd');
  assert.equal(project.layers.length, 2, 'the empty leaf must still be dropped');
  assert.deepEqual(project.layers.map((l) => l.sourceIndex), [0, 2],
    'positional matching would say [0, 1] and blend the top layer with the wrong geometry');
});

test('a layer with no sourceIndex reports null, not undefined or 0', () => {
  const project = createProject({
    width: 10, height: 10,
    children: [{ name: 'eager', left: 0, top: 0, right: 10, bottom: 10, imageData: img(10, 10) }],
  }, 'eager.psd');
  assert.equal(project.layers[0].sourceIndex, null,
    'an eager read never streams, so there is no identity to carry — export must be able to tell');
});

const streamed = [];
await readDocument(bytesOf('fixtures/float-color.src.psd'), {
  pixels: 'stream', metadata: false,
  onLayer: (node) => { streamed.push(node.sourceIndex); if (node.imageData) node.proxyData = node.imageData; },
});

test('the reader stamps every leaf it streams, in order, starting at zero', () => {
  assert.deepEqual(streamed, [0, 1, 2], 'float-color.src.psd has three leaf nodes');
});

const floatColour = await loadProjectProxy(bytesOf('fixtures/float-color.src.psd'), {
  fileName: 'float-color.src.psd', proxyEdge: 128,
});

test('a streamed load carries the stamp all the way onto the project layer', () => {
  assert.equal(floatColour.layers.length, 2, 'one of the three leaves has no pixels and no text');
  for (const layer of floatColour.layers)
    assert.equal(typeof layer.sourceIndex, 'number', `layer "${layer.name}" lost its identity`);
});

console.log('\nselective decode\n');

const wantSeen = [];
const wantDecoded = [];
await readDocument(bytesOf('fixtures/shapes.src.psd'), {
  pixels: 'stream', metadata: false,
  wantLayer: (_layer, index) => index % 2 === 0,
  onLayer: (node) => {
    wantSeen.push(node.sourceIndex);
    wantDecoded.push(Boolean(node.imageData));
  },
});

test('wantLayer keeps onLayer from firing for layers the caller refused', () => {
  assert.deepEqual(wantSeen, [0, 2, 4, 6], 'shapes.src.psd has eight leaves; four were wanted');
});

test('a skipped layer still consumes its index, so nothing after it shifts', () => {
  // If the counter advanced only for decoded layers the indices would read
  // [0, 1, 2, 3] and every later layer would be matched to the wrong file layer.
  assert.equal(Math.max(...wantSeen), 6);
});

test('the layers that did arrive really were decoded', () => {
  assert.deepEqual(wantDecoded, [true, true, true, true]);
});

const withPatterns = await readDocument(bytesOf('fixtures/vectors.src.psd'), {
  pixels: 'none', metadata: false,
});
const withoutPatterns = await readDocument(bytesOf('fixtures/vectors.src.psd'), {
  pixels: 'none', metadata: false, patterns: false,
});
const isPatternWarning = (w) => /Pattern definitions/.test(w);

test('the pattern warning still fires by default, even under metadata: false', () => {
  assert.ok(withPatterns.warnings.some(isPatternWarning),
    'load must keep surfacing this -- the export path is the only caller that should opt out');
});

test('patterns: false skips the three whole-file byte scans', () => {
  assert.ok(!withoutPatterns.warnings.some(isPatternWarning));
});


console.log('\nexport order and spill planning\n');

/** A stand-in project: only the fields buildExportOrder and planSpill read. */
const orderOf = (...specs) => specs.map((s, i) => ({
  id: i + 1,
  name: s.name ?? `layer ${i}`,
  kind: s.kind ?? 'raster',
  visible: s.visible ?? true,
  opacity: s.opacity ?? 1,
  rerendered: s.rerendered ?? false,
  sourceIndex: s.sourceIndex,
}));
const projectOf = (...specs) => ({ width: 10, height: 10, layers: orderOf(...specs) });

test('the order is bottom to top, minus the invisible and the zero-opacity', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 },
    { sourceIndex: 1, visible: false },
    { sourceIndex: 2, opacity: 0 },
    { sourceIndex: 3 },
  ));
  assert.deepEqual(order.map((l) => l.sourceIndex), [0, 3]);
});

test('a hidden layer is not wanted from the stream at all', () => {
  const order = buildExportOrder(projectOf({ sourceIndex: 0 }, { sourceIndex: 1, visible: false }));
  assert.deepEqual([...wantedIndices(order)], [0]);
});

test('a re-rendered text layer draws itself and is never awaited from the file', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 },
    { sourceIndex: 1, kind: 'text', rerendered: true },
  ));
  assert.equal(isSelfRendering(order[1]), true);
  assert.deepEqual([...wantedIndices(order)], [0], 'index 1 must not be requested from the stream');
});

test('an UNTOUCHED Photoshop text layer is a raster and IS awaited from the file', () => {
  // render.js gates the sharp path on `rerendered`, which starts false. At
  // proxy scale that is harmless; at scale 1 it would upscale a 1024-edge
  // raster. Export must stream its full-resolution pixels like any other layer.
  const order = buildExportOrder(projectOf({ sourceIndex: 0, kind: 'text', rerendered: false }));
  assert.equal(isSelfRendering(order[0]), false);
  assert.deepEqual([...wantedIndices(order)], [0]);
});

test('a layer with no identity is refused before a single byte is read', () => {
  const order = buildExportOrder(projectOf({ sourceIndex: null, name: 'orphan' }));
  assert.throws(() => assertIdentifiable(order), (e) => e.code === 'NO_IDENTITY' && /orphan/.test(e.message));
});

test('untouched order is the fast path and spills nothing', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 }, { sourceIndex: 1 }, { sourceIndex: 2 }, { sourceIndex: 3 },
  ));
  assert.equal(isFastPath(order), true);
  assert.deepEqual(planSpill(order).spill, []);
});

test('moving the BOTTOM layer to the top spills exactly one', () => {
  // order = [1, 2, 3, 0]. Arrival 0 comes first and is needed last, so it parks;
  // 1, 2, 3 then arrive in the order they are needed and never touch disk.
  const order = buildExportOrder(projectOf(
    { sourceIndex: 1 }, { sourceIndex: 2 }, { sourceIndex: 3 }, { sourceIndex: 0 },
  ));
  assert.equal(isFastPath(order), false);
  assert.deepEqual(planSpill(order).spill, [0]);
});

test('moving the TOP layer to the bottom spills all but one', () => {
  // order = [3, 0, 1, 2]. The first thing needed is the LAST thing to arrive,
  // so everything before it parks. The spec's prose has these two cases the
  // wrong way round; the arithmetic here is what the walk actually does.
  const order = buildExportOrder(projectOf(
    { sourceIndex: 3 }, { sourceIndex: 0 }, { sourceIndex: 1 }, { sourceIndex: 2 },
  ));
  assert.deepEqual(planSpill(order).spill, [0, 1, 2]);
});

test('a full reversal is the worst case and still spills only n-1', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 3 }, { sourceIndex: 2 }, { sourceIndex: 1 }, { sourceIndex: 0 },
  ));
  assert.deepEqual(planSpill(order).spill, [0, 1, 2]);
});

test('a self-rendering layer at the bottom is satisfied before the first arrival', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0, kind: 'text', rerendered: true },
    { sourceIndex: 1 }, { sourceIndex: 2 },
  ));
  assert.deepEqual(planSpill(order).spill, [], 'nothing needs parking -- the text draws itself first');
});

test('isFastPath and planSpill never disagree', () => {
  const cases = [[0, 1, 2], [2, 0, 1], [1, 0, 2], [0, 2, 1], [2, 1, 0], [0, 1, 2, 3], [3, 0, 1, 2]];
  for (const indices of cases) {
    const order = buildExportOrder(projectOf(...indices.map((sourceIndex) => ({ sourceIndex }))));
    assert.equal(isFastPath(order), planSpill(order).spill.length === 0,
      `disagreement on ${JSON.stringify(indices)} -- the walk would take one path and the plan predict the other`);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
