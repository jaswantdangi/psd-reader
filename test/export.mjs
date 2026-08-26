import assert from 'node:assert/strict';
import fs from 'fs';
import { createProject, loadProjectProxy, readDocument } from '../src/index.js';

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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
