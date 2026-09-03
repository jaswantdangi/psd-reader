import assert from 'node:assert/strict';
import fs from 'fs';
import zlib from 'node:zlib';
import {
  createProject, loadProjectProxy, readDocument, reorderLayer, setLayer,
  ExportError, isSelfRendering, buildExportOrder, wantedIndices, assertIdentifiable, isFastPath, planSpill,
  spillHeader, encodeSpill, decodeSpill, createMemorySpill, SPILL_MAGIC, SPILL_VERSION, SPILL_HEADER_BYTES,
  createBuffer, drawLayerInto, renderProject,
  estimatePeakBytes,
  EXPORT_PHASES, phaseFraction, isDeterminate,
  exportFullRes, createJsExportTarget,
  compareBuffers, flattenOnto,
  EXPORT_TILE_CAP, tileEdgeFor, partitionTiles, intersectRect,
  CANVAS_AREA_CAP, canUseCanvasEncoder, encodePngStored,
  SPILL_ROOT, newExportId, spillDirFor, sweepSpillDirectories,
  BRIDGE_CHUNK_BYTES, chunkRanges, bytesToBase64,
} from '../src/index.js';
// Direct imports: src/index.js is a shared barrel and other work is landing in
// it. A missing re-export there is not a failure of this code.
import { drawsOwnPixels } from '../src/export/order.js';
import { insertImageLayer } from '../src/creative/index.js';

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

/**
 * A 200x200 sticker: opaque on the left half, 50% alpha on the right, so a
 * dropped alpha or a resample would both show up in the oracle comparison.
 * A fresh buffer every call -- nothing may share one with the layer under test.
 */
const sticker200 = () => {
  const s = img(200, 200);
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      s.data[i] = 240; s.data[i + 1] = 90; s.data[i + 2] = 30;
      s.data[i + 3] = x < 100 ? 255 : 128;
    }
  return s;
};

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
  selfSupplied: s.selfSupplied ?? false,
  clipping: s.clipping ?? false,
  pixels: s.pixels ?? null,
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

/**
 * A clipping mask is POSITIONAL: a clipped layer is visible only through the
 * alpha of whatever lies directly under it. So the order has to be built out of
 * RUNS, not out of layers.
 *
 * Filtering layer by layer is the trap. Dropping a hidden BASE leaves its
 * clipped layers behind, and they then attach to whatever lands underneath --
 * a different picture, and a plausible-looking one, which is why nothing would
 * have caught it. `renderProject` drops the whole run, and export is the same
 * renderer or it is a bug.
 */
test('a hidden BASE takes its whole clip run with it, instead of re-attaching it', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0, name: 'backdrop' },
    { sourceIndex: 1, name: 'base', visible: false },
    { sourceIndex: 2, name: 'clipped', clipping: true },
    { sourceIndex: 3, name: 'top' },
  ));
  assert.deepEqual(order.map((l) => l.name), ['backdrop', 'top'],
    'dropping only the base silently re-clips "clipped" to "backdrop"');
});

test('a zero-opacity base takes its run with it too, for the same reason', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0, name: 'backdrop' },
    { sourceIndex: 1, name: 'base', opacity: 0 },
    { sourceIndex: 2, name: 'clip A', clipping: true },
    { sourceIndex: 3, name: 'clip B', clipping: true },
  ));
  assert.deepEqual(order.map((l) => l.name), ['backdrop']);
});

test('a hidden MEMBER is dropped alone, and the rest of the run still clips', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0, name: 'backdrop' },
    { sourceIndex: 1, name: 'base' },
    { sourceIndex: 2, name: 'clip A', clipping: true, visible: false },
    { sourceIndex: 3, name: 'clip B', clipping: true },
  ));
  assert.deepEqual(order.map((l) => l.name), ['backdrop', 'base', 'clip B']);
});

test('a run reaching the bottom of the stack has its lowest member as its base', () => {
  const specs = [
    { sourceIndex: 0, name: 'orphan', clipping: true },
    { sourceIndex: 1, name: 'also clipped', clipping: true },
    { sourceIndex: 2, name: 'plain' },
  ];
  assert.deepEqual(buildExportOrder(projectOf(...specs)).map((l) => l.name),
    ['orphan', 'also clipped', 'plain']);

  // Hiding it hides the run it is the base of, exactly as a base anywhere else.
  specs[0].visible = false;
  assert.deepEqual(buildExportOrder(projectOf(...specs)).map((l) => l.name), ['plain']);
});

test('a hidden base costs the stream nothing: neither it nor its run is decoded', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 },
    { sourceIndex: 1, visible: false },
    { sourceIndex: 2, clipping: true },
    { sourceIndex: 3, clipping: true },
    { sourceIndex: 4 },
  ));
  assert.deepEqual([...wantedIndices(order)], [0, 4],
    'decoding a layer that will never be drawn is pure waste on the critical path');
});

test('the members of a run stay contiguous in the order, whatever is hidden', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0, name: 'base 1' },
    { sourceIndex: 1, name: 'clip 1', clipping: true },
    { sourceIndex: 2, name: 'base 2', visible: false },
    { sourceIndex: 3, name: 'clip 2', clipping: true },
    { sourceIndex: 4, name: 'base 3' },
    { sourceIndex: 5, name: 'clip 3', clipping: true },
  ));
  assert.deepEqual(order.map((l) => l.name), ['base 1', 'clip 1', 'base 3', 'clip 3']);
  // The blend target reconstructs runs from `clipping` alone, so a clipped
  // layer must never land directly after a run it does not belong to.
  assert.deepEqual(order.map((l) => l.clipping), [false, true, false, true]);
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

test('a self-supplied layer needs no identity and is never awaited from the file', () => {
  // An inserted sticker or a replaced image. It never came from the file, so
  // no arrival will ever carry its pixels -- it already holds them.
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 },
    { sourceIndex: null, name: 'sticker', selfSupplied: true, pixels: img(4, 4) },
  ));
  assert.equal(drawsOwnPixels(order[1]), true);
  assert.doesNotThrow(() => assertIdentifiable(order));
  assert.deepEqual([...wantedIndices(order)], [0], 'index null must not be requested from the stream');
});

test('the self-supplied flag alone is not enough — there have to be pixels', () => {
  const order = buildExportOrder(projectOf({ sourceIndex: null, name: 'empty', selfSupplied: true }));
  assert.equal(drawsOwnPixels(order[0]), false);
  assert.throws(() => assertIdentifiable(order), (e) => e.code === 'NO_IDENTITY');
});

test('a file layer holding PROXY pixels is not self-supplying', () => {
  // The whole point of the flag. Every proxy-loaded layer has `pixels`; blending
  // a 256-edge buffer at scale 1 upscales a thumbnail into a correctly-sized,
  // blurred layer, which is the failure this module exists to prevent.
  const order = buildExportOrder(projectOf({ sourceIndex: 0, pixels: img(256, 256) }));
  assert.equal(drawsOwnPixels(order[0]), false);
  assert.deepEqual([...wantedIndices(order)], [0]);
});

test('a self-supplied layer at the bottom does not park the stack behind it', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: null, selfSupplied: true, pixels: img(4, 4) },
    { sourceIndex: 0 }, { sourceIndex: 1 },
  ));
  assert.equal(isFastPath(order), true, '`need` must step past it without waiting, exactly as it does for text');
  assert.deepEqual(planSpill(order).spill, []);
});

test('a self-supplied layer in the middle of a reorder does not change what spills', () => {
  const withSticker = buildExportOrder(projectOf(
    { sourceIndex: 2 },
    { sourceIndex: null, selfSupplied: true, pixels: img(4, 4) },
    { sourceIndex: 0 }, { sourceIndex: 1 },
  ));
  const without = buildExportOrder(projectOf({ sourceIndex: 2 }, { sourceIndex: 0 }, { sourceIndex: 1 }));
  assert.deepEqual(planSpill(withSticker).spill, planSpill(without).spill);
  assert.deepEqual(planSpill(withSticker).spill, [0, 1]);
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

test('a spill boundary CAN fall inside a clip run, and the plan says so', () => {
  // Swap two clipped layers and the run's own members arrive out of order, so
  // one of them goes to disk while its base is already in hand. That is a
  // MEMORY fact, not a correctness one: the run is composited once, when its
  // last member is in hand, whether that member came off the stream or off the
  // disk. Nothing splits.
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0, name: 'base' },
    { sourceIndex: 2, name: 'clip A', clipping: true },
    { sourceIndex: 1, name: 'clip B', clipping: true },
  ));
  assert.deepEqual(planSpill(order).spill, [1],
    'clip B arrives before clip A is needed, so clip B parks');
});

test('isFastPath and planSpill never disagree', () => {
  const cases = [[0, 1, 2], [2, 0, 1], [1, 0, 2], [0, 2, 1], [2, 1, 0], [0, 1, 2, 3], [3, 0, 1, 2]];
  for (const indices of cases) {
    const order = buildExportOrder(projectOf(...indices.map((sourceIndex) => ({ sourceIndex }))));
    assert.equal(isFastPath(order), planSpill(order).spill.length === 0,
      `disagreement on ${JSON.stringify(indices)} -- the walk would take one path and the plan predict the other`);
  }
});


console.log('\nspill codec\n');

const filled = (w, h, seed) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + seed) & 0xff;
  return { width: w, height: h, data };
};

test('a spill round-trips its dimensions and every byte', () => {
  const source = filled(5, 3, 11);
  const out = decodeSpill(encodeSpill(source));
  assert.equal(out.width, 5);
  assert.equal(out.height, 3);
  assert.deepEqual([...out.data], [...source.data]);
});

test('the header is sixteen bytes and starts with PSDX', () => {
  const header = spillHeader(5, 3);
  assert.equal(header.length, SPILL_HEADER_BYTES);
  assert.deepEqual([...header.subarray(0, 4)], [0x50, 0x53, 0x44, 0x58]);
});

test('a truncated spill raises instead of blending', () => {
  const bytes = encodeSpill(filled(5, 3, 2));
  assert.throws(() => decodeSpill(bytes.subarray(0, bytes.length - 4)),
    (e) => e.code === 'SPILL_TRUNCATED' && /truncated/.test(e.message));
});

test('a file that is not a spill raises instead of being read as one', () => {
  const bytes = encodeSpill(filled(2, 2, 0));
  bytes[0] = 0x51;
  assert.throws(() => decodeSpill(bytes), (e) => e.code === 'SPILL_CORRUPT');
});

test('a future spill version raises rather than being misread', () => {
  const bytes = encodeSpill(filled(2, 2, 0));
  bytes[4] = SPILL_VERSION + 1;
  assert.throws(() => decodeSpill(bytes), (e) => e.code === 'SPILL_CORRUPT');
});

test('a header shorter than sixteen bytes raises', () => {
  assert.throws(() => decodeSpill(new Uint8Array(8)), (e) => e.code === 'SPILL_TRUNCATED');
});

test('a zero-sized spill is legal -- a wanted layer can decode to nothing', () => {
  const out = decodeSpill(encodeSpill({ width: 0, height: 0, data: new Uint8ClampedArray(0) }));
  assert.equal(out.width, 0);
  assert.equal(out.data.length, 0);
});

await atest('the memory adapter writes, reads, removes and disposes', async () => {
  const spill = createMemorySpill();
  const source = filled(4, 2, 3);
  await spill.write('7.rgba', [spillHeader(4, 2), source.data]);
  assert.deepEqual(spill.writes, ['7.rgba']);
  const out = decodeSpill(await spill.read('7.rgba'));
  assert.deepEqual([...out.data], [...source.data], 'chunked writes must concatenate in order');
  await spill.remove('7.rgba');
  assert.equal(spill.files.size, 0);
  await spill.dispose();
});

await atest('reading a spill that was never written names the file', async () => {
  const spill = createMemorySpill();
  await assert.rejects(() => spill.read('9.rgba'), (e) => e.code === 'SPILL_MISSING' && /9\.rgba/.test(e.message));
});


console.log('\ndrawLayerInto injection\n');

const solid = (w, h, [r, g, b, a]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a; }
  return { width: w, height: h, data };
};
const rasterLayer = (over) => ({
  id: 1, name: 'raster', kind: 'raster', visible: true, opacity: 1, blendMode: 'normal',
  x: 0, y: 0, w: 4, h: 4, pixels: solid(4, 4, [255, 0, 0, 255]), rerendered: false, rendered: null, text: null,
  ...over,
});

test('injected pixels replace the layer\'s own', () => {
  const dest = createBuffer(4, 4);
  drawLayerInto(dest, rasterLayer(), 1, { pixels: solid(4, 4, [0, 0, 255, 255]) });
  assert.deepEqual([...dest.data.subarray(0, 4)], [0, 0, 255, 255], 'the injected blue must win');
});

test('an explicit null means "no pixels", NOT "use the layer\'s"', () => {
  // This is the whole reason the option is read with `in`. Under a proxy load
  // layer.pixels is a 1024-edge thumbnail; falling back to it at scale 1 would
  // draw a full-size blurred layer, which looks like a working export.
  const dest = createBuffer(4, 4);
  const missed = [];
  drawLayerInto(dest, rasterLayer(), 1, { pixels: null, onMissing: (l, why) => missed.push(why) });
  assert.deepEqual([...dest.data.subarray(0, 4)], [0, 0, 0, 0], 'nothing may be drawn');
  assert.deepEqual(missed, ['raster']);
});

test('omitting the option keeps the existing behaviour exactly', () => {
  const dest = createBuffer(4, 4);
  drawLayerInto(dest, rasterLayer(), 1);
  assert.deepEqual([...dest.data.subarray(0, 4)], [255, 0, 0, 255]);
});

test('a re-rendered text layer with no drawing surface is reported, not skipped', () => {
  // Node has no canvas, so rasteriseTextAt returns null -- the same thing that
  // happens in a worker without 1B's OffscreenCanvas surface. Today that layer
  // silently vanishes from the output.
  const dest = createBuffer(4, 4);
  const missed = [];
  drawLayerInto(dest, {
    id: 2, name: 'headline', kind: 'text', visible: true, opacity: 1, blendMode: 'normal',
    x: 0, y: 0, w: 4, h: 4, pixels: null, rerendered: true, rendered: null,
    text: { content: 'hi', fontFamily: 'sans-serif', fontSize: 12, color: '#000', bold: false, italic: false, align: 'left' },
  }, 1, { pixels: null, onMissing: (l, why) => missed.push(`${l.name}:${why}`) });
  assert.deepEqual(missed, ['headline:text']);
});

test('a layer entirely off the canvas is not a missing layer', () => {
  const dest = createBuffer(4, 4);
  const missed = [];
  drawLayerInto(dest, rasterLayer({ x: 100, y: 100 }), 1, { pixels: null, onMissing: (l, why) => missed.push(why) });
  assert.deepEqual(missed, [], 'off-canvas culling happens before pixels are ever looked for');
});


console.log('\nprogress phases\n');

test('the phases tile 0 to 100 with no gap and no overlap', () => {
  assert.equal(EXPORT_PHASES[0].from, 0);
  assert.equal(EXPORT_PHASES[EXPORT_PHASES.length - 1].to, 100);
  for (let i = 0; i < EXPORT_PHASES.length - 1; i++)
    assert.equal(EXPORT_PHASES[i].to, EXPORT_PHASES[i + 1].from,
      `${EXPORT_PHASES[i].name} ends at ${EXPORT_PHASES[i].to} but ${EXPORT_PHASES[i + 1].name} starts at ${EXPORT_PHASES[i + 1].from}`);
});

test('decoding layers spans 15% to 85%, exactly', () => {
  assert.equal(phaseFraction('layers', 0, 10), 0.15);
  assert.equal(phaseFraction('layers', 5, 10), 0.5);
  assert.equal(phaseFraction('layers', 10, 10), 0.85);
});

test('progress never runs past the end of its own phase', () => {
  assert.equal(phaseFraction('layers', 40, 10), 0.85);
});

test('a phase with no known total sits at its own start', () => {
  assert.equal(phaseFraction('parse', 0, 0), 0.10);
});

test('an unknown phase throws rather than sending the bar backwards', () => {
  assert.throws(() => phaseFraction('polish', 1, 1), /unknown export phase/i);
});

test('parse and encode are honest about having no interior progress', () => {
  assert.equal(isDeterminate('parse'), false);
  assert.equal(isDeterminate('encode'), false);
  assert.equal(isDeterminate('layers'), true);
  assert.equal(isDeterminate('write'), true);
});

console.log('\nthe export walk\n');

const FIXTURE = 'fixtures/vectors.src.psd';
const FIXTURE_SIZE = fs.statSync(FIXTURE).size;

/** A proxy-loaded project with a real, re-readable source handle. */
const openProxy = () => loadProjectProxy(bytesOf(FIXTURE), {
  fileName: 'vectors.src.psd',
  proxyEdge: 256,
  source: { uri: FIXTURE, name: 'vectors.src.psd', size: FIXTURE_SIZE, kind: 'blob' },
});

const runExport = (project, spill, extra = {}) => exportFullRes({
  project,
  readSource: async () => bytesOf(FIXTURE),
  spill,
  createTarget: createJsExportTarget,
  ...extra,
});

await atest('the fast path blends every layer as it streams and never touches disk', async () => {
  const project = await openProxy();
  const spill = createMemorySpill();
  const out = await runExport(project, spill);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1080);
  assert.deepEqual(spill.writes, [], 'an untouched order must not spill');
  assert.equal(spill.files.size, 0);
});

await atest('the spill path parks exactly what planSpill predicted', async () => {
  const project = await openProxy();
  reorderLayer(project, 3, 0);                 // top layer to the bottom
  const spill = createMemorySpill();
  await runExport(project, spill);
  const expected = planSpill(buildExportOrder(project)).spill.map((i) => `${i}.rgba`);
  assert.deepEqual(spill.writes, expected,
    'the walk and the plan must agree, or one of them is wrong and nothing would notice');
  assert.deepEqual(spill.writes, ['0.rgba', '1.rgba', '2.rgba']);
});

await atest('an inserted sticker exports without ever being awaited from the file', async () => {
  const project = await openProxy();
  const sticker = insertImageLayer(project, { pixels: sticker200(), name: 'sticker' });
  assert.equal(sticker.sourceIndex, null);

  const spill = createMemorySpill();
  const out = await runExport(project, spill);
  assert.equal(out.width, 1080, 'the sticker must not have blocked the export');
  assert.deepEqual(spill.writes, [], 'nothing arrives for it, so nothing behind it may park');
});

await atest('a sticker under a reorder still parks exactly what planSpill predicted', async () => {
  const project = await openProxy();
  // Sticker at the BOTTOM: `need` points at a layer no arrival can satisfy, so
  // if the walk waited for it every single arrival would spill.
  insertImageLayer(project, { pixels: sticker200(), name: 'sticker', index: 0 });
  reorderLayer(project, 4, 1);                 // top file layer to the bottom of the file layers
  const spill = createMemorySpill();
  await runExport(project, spill);
  const expected = planSpill(buildExportOrder(project)).spill.map((i) => `${i}.rgba`);
  assert.deepEqual(spill.writes, expected,
    'the walk and the plan must agree, or one of them is wrong and nothing would notice');
});

await atest('every spill file is gone when the export succeeds', async () => {
  const project = await openProxy();
  reorderLayer(project, 3, 0);
  const spill = createMemorySpill();
  await runExport(project, spill);
  assert.equal(spill.files.size, 0, 'success must leave zero bytes behind');
});

await atest('a hidden layer is never decoded and never spilled', async () => {
  const project = await openProxy();
  project.layers[1].visible = false;
  reorderLayer(project, 3, 0);
  const spill = createMemorySpill();
  await runExport(project, spill);
  assert.ok(!spill.writes.includes('1.rgba'), 'a hidden layer is pure waste on the critical path');
});

await atest('progress reports every phase and ends at 1', async () => {
  const project = await openProxy();
  const seen = [];
  await runExport(project, createMemorySpill(), { onProgress: (p) => seen.push(p) });
  const phases = [...new Set(seen.map((p) => p.phase))];
  assert.deepEqual(phases, ['read', 'parse', 'layers', 'readback']);
  assert.equal(seen[seen.length - 1].fraction, 0.92, 'readback is the last phase this plan owns');
  const layers = seen.filter((p) => p.phase === 'layers');
  assert.equal(layers.length, 4, 'one report per decoded layer, not one per file');
});

await atest('cancelling mid-stream throws CANCELLED and leaves nothing behind', async () => {
  const project = await openProxy();
  reorderLayer(project, 3, 0);
  const spill = createMemorySpill();
  const signal = { cancelled: false };
  await assert.rejects(
    () => runExport(project, spill, {
      signal,
      onProgress: (p) => { if (p.phase === 'layers') signal.cancelled = true; },
    }),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(spill.files.size, 0, 'the finally must clean up on cancel too');
});

await atest('a source file of the wrong size is refused before it is parsed', async () => {
  const project = await openProxy();
  project.source.size = FIXTURE_SIZE + 1;
  await assert.rejects(
    () => runExport(project, createMemorySpill()),
    (e) => e.code === 'SOURCE_CHANGED' && /vectors\.src\.psd/.test(e.message),
  );
});

await atest('a source file of the wrong dimensions is refused before it is blended', async () => {
  const project = await openProxy();
  project.width = 999;
  await assert.rejects(
    () => exportFullRes({
      project,
      readSource: async () => bytesOf(FIXTURE),
      spill: createMemorySpill(),
      createTarget: createJsExportTarget,
    }),
    (e) => e.code === 'SOURCE_MISMATCH' && /999/.test(e.message),
  );
});

await atest('a project whose layers have no identity is refused before the file is read', async () => {
  const doc = await readDocument(bytesOf(FIXTURE), { pixels: 'eager', metadata: false });
  const eager = createProject(doc, 'vectors.src.psd');
  let read = false;
  await assert.rejects(
    () => exportFullRes({
      project: eager,
      readSource: async () => { read = true; return bytesOf(FIXTURE); },
      spill: createMemorySpill(),
      createTarget: createJsExportTarget,
    }),
    (e) => e.code === 'NO_IDENTITY',
  );
  assert.equal(read, false, 'refusing must cost nothing');
});

await atest('a re-rendered text layer that cannot be drawn is fatal, not silently dropped', async () => {
  // Node has no canvas, so this is the worker-without-OffscreenCanvas case.
  const project = await openProxy();
  const layer = project.layers[1];
  layer.kind = 'text';
  layer.rerendered = true;
  layer.text = { content: 'headline', fontFamily: 'sans-serif', fontSize: 24, color: '#000', bold: false, italic: false, align: 'left' };
  layer.name = 'headline';
  await assert.rejects(
    () => runExport(project, createMemorySpill()),
    (e) => e.code === 'TEXT_MISSING' && /headline/.test(e.message),
  );
});

console.log('\nthe oracle\n');

/** The same file, read eagerly, with every layer at full resolution. */
const openEager = async () => createProject(
  await readDocument(bytesOf(FIXTURE), { pixels: 'eager', metadata: false }),
  'vectors.src.psd',
);

const matches = (got, want) => {
  const stat = compareBuffers(flattenOnto(got), flattenOnto(want));
  assert.ok(stat.comparable, stat.reason);
  assert.equal(stat.percentReal, 0,
    `${stat.beyondRounding} of ${stat.total} pixels differ by more than 1 (max ${stat.maxDelta})`);
};

await atest('an untouched export matches the full-resolution reference', async () => {
  const proxy = await openProxy();
  const eager = await openEager();
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a reordered export matches — this is the spill path under test', async () => {
  const proxy = await openProxy();
  const eager = await openEager();
  reorderLayer(proxy, 3, 0);
  reorderLayer(eager, 3, 0);

  const spill = createMemorySpill();
  matches(await runExport(proxy, spill), renderProject(eager, { scale: 1 }));
  assert.deepEqual(spill.writes, ['0.rgba', '1.rgba', '2.rgba'], 'the spill path really was exercised');
});

await atest('an inserted sticker exports at FULL resolution, in its stack position', async () => {
  // The strongest form of the question: the export output has to be identical
  // to the same document composited at scale 1 from full-resolution pixels.
  // A sticker dropped, drawn at proxy scale, or blended out of order fails here.
  const proxy = await openProxy();
  const eager = await openEager();
  for (const project of [proxy, eager])
    insertImageLayer(project, { pixels: sticker200(), name: 'sticker', x: 300, y: 400, index: 2 });

  const spill = createMemorySpill();
  matches(await runExport(proxy, spill), renderProject(eager, { scale: 1 }));
  assert.deepEqual(spill.writes, [], 'the sticker sits in arrival order, so nothing needs parking');
});

await atest('a reordered export with a sticker matches, spill path and all', async () => {
  const proxy = await openProxy();
  const eager = await openEager();
  for (const project of [proxy, eager]) {
    insertImageLayer(project, { pixels: sticker200(), name: 'sticker', x: 100, y: 100, index: 0 });
    reorderLayer(project, 4, 1);
  }

  const spill = createMemorySpill();
  matches(await runExport(proxy, spill), renderProject(eager, { scale: 1 }));
  assert.ok(spill.writes.length > 0, 'the spill path really was exercised');
});

await atest('a transform re-applies to FULL-RESOLUTION pixels, not the proxy', async () => {
  // The proxy is 256-edge; the layer is 417 px and is being scaled to 626.
  // If export ever fell back to layer.pixels this would upscale a thumbnail
  // by 2.4x and differ from the reference on nearly every pixel.
  const proxy = await openProxy();
  const eager = await openEager();
  for (const project of [proxy, eager])
    setLayer(project, project.layers[3].id, { w: 626, h: 626 });
  reorderLayer(proxy, 3, 0);
  reorderLayer(eager, 3, 0);

  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a moved layer exports at its new position', async () => {
  const proxy = await openProxy();
  const eager = await openEager();
  for (const project of [proxy, eager])
    setLayer(project, project.layers[2].id, { x: 40, y: 700 });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

console.log('\nclipping at full resolution\n');

/**
 * NO FIXTURE CONTAINS A CLIPPED LAYER. All 21 were read and `clipping` is false
 * on every one of the 82 nodes, so there is no fixture coverage here and none
 * is claimed. `clipping` is a PROJECT field, though -- the file is streamed
 * back by `sourceIndex` either way -- so stamping it onto both sides of the
 * oracle builds a real clipped document out of a real file, and the comparison
 * is the same one every unclipped test above makes.
 *
 * Shaped to be mean rather than convenient. The clipped layers overlap the base
 * only PARTLY, so a run that is not clipped shows outside the base's alpha
 * instead of coincidentally matching. The base carries its own opacity and
 * blend mode, which belong to the WHOLE run and are spent once at the end, not
 * per layer. One clipped layer is `multiply` at 0.8, so a run composited in
 * the wrong order differs from one composited in the right one.
 *
 * `screen` and `overlay` are deliberately NOT used: this fixture's backdrop
 * is white, both modes are identities against white, and a document shaped with
 * them measured 0 divergence while the export was still ignoring clipping
 * entirely -- a test that could never have failed.
 */
const clipShape = (project) => {
  setLayer(project, project.layers[2].id, { x: 60, y: 60 });
  setLayer(project, project.layers[3].id, { x: 150, y: 150 });
  Object.assign(project.layers[1], { opacity: 0.7, blendMode: 'multiply' });
  Object.assign(project.layers[2], { clipping: true, opacity: 0.8, blendMode: 'multiply' });
  Object.assign(project.layers[3], { clipping: true });
  return project;
};

/** The proxy under test and the full-resolution reference, shaped identically. */
const clipPair = async (extra = null) => {
  const proxy = clipShape(await openProxy());
  const eager = clipShape(await openEager());
  if (extra) { extra(proxy); extra(eager); }
  return { proxy, eager };
};

await atest('a clip run exports the way the preview renders it', async () => {
  const { proxy, eager } = await clipPair();
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a run whose members arrive out of order is still composited whole', async () => {
  // The two clipped layers swap, so one of them is parked on disk while its
  // base is already in hand. If a spill boundary split the run, the layer read
  // back would draw unclipped.
  const { proxy, eager } = await clipPair((p) => reorderLayer(p, 3, 2));
  const spill = createMemorySpill();
  matches(await runExport(proxy, spill), renderProject(eager, { scale: 1 }));
  assert.deepEqual(spill.writes, planSpill(buildExportOrder(proxy)).spill.map((i) => i + '.rgba'));
  assert.ok(spill.writes.length > 0, 'the spill path really was exercised inside the run');
});

await atest('a hidden base takes its whole run with it, exactly as the preview does', async () => {
  const { proxy, eager } = await clipPair((p) => { p.layers[1].visible = false; });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a zero-opacity base takes its whole run with it too', async () => {
  const { proxy, eager } = await clipPair((p) => { p.layers[1].opacity = 0; });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a hidden member is skipped and the rest of the run still clips', async () => {
  const { proxy, eager } = await clipPair((p) => { p.layers[2].visible = false; });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

/** A ramp, so the base's alpha is partial and rounding cannot cancel out. */
const rampMask = (w, h) => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = (x * 3 + y * 5) % 256;
  return { width: w, height: h, data };
};

await atest('a MASKED base clips through its mask, to the last bit', async () => {
  // The one case that separates a real `clipAlphaMap` from the shortcut of
  // reading the group buffer's own alpha channel. With no mask the two agree
  // exactly; with one, `blendInto` writes into a Uint8ClampedArray and ROUNDS
  // where `clipAlphaMap` writes into a Uint8Array and TRUNCATES, and they part
  // company by 1 on roughly half the partially covered pixels.
  const mask = rampMask(310, 310);
  const { proxy, eager } = await clipPair((p) => { p.layers[1].mask = mask; });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a self-supplied sticker can be the BASE of a run, at full resolution', async () => {
  const { proxy, eager } = await clipPair((p) => {
    insertImageLayer(p, { pixels: sticker200(), name: 'sticker', x: 200, y: 200, index: 3 });
    p.layers[4].clipping = true;               // the Circle now clips to the sticker
  });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a sticker clipped to a file layer is clipped, not drawn whole', async () => {
  const { proxy, eager } = await clipPair((p) => {
    insertImageLayer(p, { pixels: sticker200(), name: 'sticker', x: 120, y: 120, index: 2 }).clipping = true;
  });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

/**
 * The run is assembled INSIDE the target, from `clipping` alone, because
 * `framedTarget` rewrites each layer's geometry one call at a time and that
 * is all the interface offers. So the target cannot see a run END -- and the
 * walk closes it, the moment the last member is blended.
 *
 * That is a memory rule, not a correctness one. Without it the target holds the
 * last blended layer's full-resolution pixels while the reader decodes the next
 * one, which is a second full-resolution layer resident on EVERY export,
 * clipped or not.
 */
await atest('the walk closes each run as it ends, never one decode later', async () => {
  const events = [];
  const spy = (w, h) => {
    const inner = createJsExportTarget(w, h);
    return {
      blend: (layer, pixels) => { events.push(layer.clipping === true ? 'clip' : 'base'); inner.blend(layer, pixels); },
      flush: () => { events.push('flush'); inner.flush(); },
      finish: () => inner.finish(),
      dispose: () => inner.dispose(),
    };
  };
  const { proxy } = await clipPair();
  await runExport(proxy, createMemorySpill(), { createTarget: spy });
  assert.deepEqual(events, ['base', 'flush', 'base', 'clip', 'clip', 'flush'],
    'a flush INSIDE a run would strand the next clipped layer as a base of its own');
});

await atest('the clip scratch is one lazily grown pair, and an unclipped export never allocates it', async () => {
  let plain = null;
  await runExport(await openProxy(), createMemorySpill(),
    { createTarget: (w, h) => (plain = createJsExportTarget(w, h)) });
  assert.equal(plain.clipScratch.allocations, 0,
    'every document with no clipping mask -- which is all 21 fixtures -- must pay nothing');

  let clipped = null;
  const { proxy } = await clipPair((p) => {
    insertImageLayer(p, { pixels: sticker200(), name: 'sticker', x: 200, y: 200, index: 3 });
    p.layers[4].clipping = true;               // a SECOND run, so two runs in one export
  });
  await runExport(proxy, createMemorySpill(), { createTarget: (w, h) => (clipped = createJsExportTarget(w, h)) });
  assert.equal(clipped.clipScratch.allocations, 1, 'two runs, one pair of buffers');
  assert.equal(clipped.clipScratch.group, null, 'finish() drops them before the encode peak');
  assert.equal(clipped.clipScratch.alpha, null);
});

console.log('\nwhat a clip run costs\n');

const MB = 1024 * 1024;

/**
 * The documented peak was `file bytes + one full-res layer + proxy total`,
 * and it held because exactly ONE full-resolution layer was ever resident: the
 * walk blended each arrival and released it.
 *
 * A clip run breaks that, and there is no way around it that is not a second
 * clipping implementation. The run is composited as a unit, so every member's
 * pixels have to be in hand at the same moment -- and the group and alpha
 * buffers join them while it is drawn.
 */
test('the peak is unchanged, to the byte, for a document with no clip run', () => {
  const base = { fileBytes: 303 * MB, largestLayerBytes: 66.4 * MB, proxyTotalBytes: 17 * MB };
  assert.equal(estimatePeakBytes(base), 303 * MB + 66.4 * MB + 17 * MB);
  assert.equal(estimatePeakBytes({ ...base, clipRunBytes: 0, clipScratchBytes: 0 }), estimatePeakBytes(base),
    'a document with no clipping mask must pay nothing for one');
});

test('the largest clip run REPLACES the single-layer term, and never shrinks it', () => {
  assert.equal(estimatePeakBytes({ largestLayerBytes: 10 * MB, clipRunBytes: 25 * MB }), 25 * MB,
    'three 8 MB layers in one run are 25 MB resident, not 10');
  assert.equal(estimatePeakBytes({ largestLayerBytes: 30 * MB, clipRunBytes: 25 * MB }), 30 * MB,
    'the biggest single layer can sit outside every run, and still has to fit');
});

test('the group and alpha pair is w * h * 5 and is a term of its own', () => {
  const poster = 4961 * 3508 * 5;
  assert.equal(poster, 87015940, '83.0 MiB on the measured 4961x3508 poster');
  assert.equal(estimatePeakBytes({ fileBytes: 303 * MB, largestLayerBytes: 66.4 * MB, clipScratchBytes: poster }),
    303 * MB + 66.4 * MB + poster,
    'the pair is live at the same time as the run, so the terms add');
});

console.log('\ntile arithmetic\n');

test('the tile edge is the minimum of every limit, not just the texture size', () => {
  assert.equal(tileEdgeFor({ maxTextureSize: 4096, maxRenderbufferSize: 1024, maxViewportDims: [4096, 4096] }), 1024);
  assert.equal(tileEdgeFor({ maxTextureSize: 4096, maxRenderbufferSize: 4096, maxViewportDims: [4096, 512] }), 512);
});

test('the cap wins when the hardware is generous', () => {
  assert.equal(tileEdgeFor({ maxTextureSize: 16384, maxRenderbufferSize: 16384, maxViewportDims: [16384, 16384] }), EXPORT_TILE_CAP);
  assert.equal(EXPORT_TILE_CAP, 2048);
});

test('an explicit cap overrides the default, for the device sweep', () => {
  assert.equal(tileEdgeFor({ maxTextureSize: 8192, maxRenderbufferSize: 8192, maxViewportDims: [8192, 8192], cap: 4096 }), 4096);
});

test('an unprobed context falls back to the cap rather than to zero', () => {
  assert.equal(tileEdgeFor({}), EXPORT_TILE_CAP);
  assert.equal(tileEdgeFor(), EXPORT_TILE_CAP);
});

test('the poster partitions into six tiles with correct edge remainders', () => {
  const tiles = partitionTiles(4961, 3508, 2048);
  assert.equal(tiles.length, 6, '3 across x 2 down');
  assert.deepEqual(tiles[0], { x: 0, y: 0, width: 2048, height: 2048 });
  assert.deepEqual(tiles[2], { x: 4096, y: 0, width: 865, height: 2048 });
  assert.deepEqual(tiles[5], { x: 4096, y: 2048, width: 865, height: 1460 });
});

test('the tiles cover the canvas exactly once', () => {
  const tiles = partitionTiles(4961, 3508, 2048);
  const area = tiles.reduce((sum, t) => sum + t.width * t.height, 0);
  assert.equal(area, 4961 * 3508);
});

test('a canvas inside the tile edge is one tile', () => {
  assert.deepEqual(partitionTiles(1080, 1080, 2048), [{ x: 0, y: 0, width: 1080, height: 1080 }]);
});

test('intersection clips a layer rect to a tile', () => {
  const tile = { x: 2048, y: 0, width: 2048, height: 2048 };
  assert.deepEqual(intersectRect({ x: 1900, y: 100, width: 400, height: 200 }, tile),
    { x: 2048, y: 100, width: 252, height: 200 });
});

test('a layer that misses a tile returns null, so the tile is skipped entirely', () => {
  const tile = { x: 2048, y: 0, width: 2048, height: 2048 };
  assert.equal(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, tile), null);
  assert.equal(intersectRect({ x: 2048, y: 2048, width: 10, height: 10 }, tile), null,
    'touching an edge is not overlapping it');
});

console.log('\nPNG writer\n');

/** Independent decoder: node:zlib for inflate and CRC, so nothing checks itself. */
function decodePng(png) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) assert.equal(png[i], signature[i], `signature byte ${i}`);

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat = [];
  let header = null;
  let p = 8;
  let sawEnd = false;

  while (p < png.length) {
    const length = view.getUint32(p, false);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    assert.equal(view.getUint32(p + 8 + length, false), zlib.crc32(png.subarray(p + 4, p + 8 + length)),
      `CRC32 of the ${type} chunk`);
    if (type === 'IHDR')
      header = {
        width: view.getUint32(p + 8, false), height: view.getUint32(p + 12, false),
        depth: png[p + 16], colour: png[p + 17], interlace: png[p + 20],
      };
    if (type === 'IDAT') idat.push(Buffer.from(png.subarray(p + 8, p + 8 + length)));
    if (type === 'IEND') sawEnd = true;
    p += 12 + length;
  }

  assert.ok(sawEnd, 'the file must end with IEND');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = 1 + header.width * 4;
  const data = new Uint8ClampedArray(header.width * header.height * 4);
  for (let y = 0; y < header.height; y++) {
    assert.equal(raw[y * stride], 0, `scanline ${y} must use filter 0`);
    data.set(raw.subarray(y * stride + 1, y * stride + stride), y * header.width * 4);
  }
  return { ...header, data };
}

test('the poster is over the iOS canvas area cap, which is why this exists', () => {
  assert.equal(CANVAS_AREA_CAP, 16777216);
  assert.equal(4961 * 3508, 17403188);
  assert.equal(canUseCanvasEncoder(4961, 3508), false);
  assert.equal(canUseCanvasEncoder(1080, 1080), true);
});

test('a small image round-trips through zlib byte for byte', () => {
  const source = filled(3, 2, 5);
  const decoded = decodePng(encodePngStored(source));
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.depth, 8);
  assert.equal(decoded.colour, 6, 'colour type 6 is 8-bit RGBA');
  assert.equal(decoded.interlace, 0);
  assert.deepEqual([...decoded.data], [...source.data]);
});

test('an image needing more than one stored block round-trips too', () => {
  // 200x200 raw is 200 * (1 + 800) = 160,200 bytes, so three stored blocks.
  const source = filled(200, 200, 31);
  const decoded = decodePng(encodePngStored(source));
  assert.deepEqual([...decoded.data], [...source.data]);
});

test('a 1x1 image is legal', () => {
  const source = filled(1, 1, 9);
  assert.deepEqual([...decodePng(encodePngStored(source)).data], [...source.data]);
});

console.log('\nspill sweep\n');

const fakeFs = (tree) => ({
  removed: [],
  async readdir(path) {
    if (!(path in tree)) throw new Error(`no such directory: ${path}`);
    return tree[path];
  },
  async rmdir(path) {
    if (path.endsWith('locked')) throw new Error('resource busy');
    this.removed.push(path);
  },
});

test('an export id is unique per export and file-name safe', () => {
  const a = newExportId(1756200000000, () => 0.5);
  const b = newExportId(1756200000000, () => 0.75);
  assert.notEqual(a, b, 'two exports started in the same millisecond must not collide');
  assert.match(a, /^[a-z0-9-]+$/);
  assert.equal(spillDirFor(a), `${SPILL_ROOT}/${a}`);
});

await atest('the sweep deletes every orphaned export directory', async () => {
  const fs2 = fakeFs({ [SPILL_ROOT]: ['abc', 'def'] });
  const removed = await sweepSpillDirectories(fs2);
  assert.deepEqual(removed, ['abc', 'def']);
  assert.deepEqual(fs2.removed, [`${SPILL_ROOT}/abc`, `${SPILL_ROOT}/def`]);
});

await atest('the sweep leaves a live export alone', async () => {
  const fs2 = fakeFs({ [SPILL_ROOT]: ['abc', 'live'] });
  assert.deepEqual(await sweepSpillDirectories(fs2, { keep: ['live'] }), ['abc']);
});

await atest('a first run with no spill root is not an error', async () => {
  assert.deepEqual(await sweepSpillDirectories(fakeFs({})), []);
});

await atest('one undeletable directory does not abort the sweep', async () => {
  const fs2 = fakeFs({ [SPILL_ROOT]: ['locked', 'abc'] });
  assert.deepEqual(await sweepSpillDirectories(fs2), ['abc']);
});

console.log('\nbridge chunking\n');

test('the chunk size is divisible by three, so only the last chunk pads', () => {
  assert.equal(BRIDGE_CHUNK_BYTES % 3, 0);
  assert.ok(BRIDGE_CHUNK_BYTES <= 4 * 1024 * 1024);
});

test('ranges tile the whole buffer with no gap and no overlap', () => {
  const ranges = chunkRanges(10, 4);
  assert.deepEqual(ranges, [[0, 4], [4, 8], [8, 10]]);
});

test('an exact multiple produces no empty trailing range', () => {
  assert.deepEqual(chunkRanges(8, 4), [[0, 4], [4, 8]]);
});

test('an empty buffer produces no ranges at all', () => {
  assert.deepEqual(chunkRanges(0, 4), []);
});

test('a 303 MB file is 76 bridge calls, and that cost is worth stating', () => {
  const ranges = chunkRanges(303 * 1024 * 1024);
  assert.equal(ranges.length, 76);
});

test('base64 matches Node\'s own encoder for every tail length', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 6, 255, 256, 1000]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${length}`);
  }
});

test('base64 handles the high bytes that a naive shift would sign-extend', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x00]);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
