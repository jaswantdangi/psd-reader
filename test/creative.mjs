/**
 * Phase 4 — creative tools: created text layers and inserted image layers.
 *
 * Imports the engine modules DIRECTLY rather than through src/index.js: this
 * suite has to stay green while other work is landing in the barrel file, and
 * a transiently missing re-export there is not a failure of this code.
 *
 * What is testable here and what is not:
 *
 *   - Model and geometry: fully testable. Bounds, anchoring, field shape,
 *     identity, undo, counters, and the raster render path all run in Node.
 *   - Glyph rasterisation: NOT testable. `rasteriseTextAt` needs a real 2D
 *     surface and Node has none, so the stub below returns a transparent
 *     buffer. Every text assertion is about MEASUREMENT and GEOMETRY; none of
 *     them looks at a rendered glyph. Pixel-level text output needs a browser.
 */
import fs from 'fs';
import assert from 'node:assert/strict';

import { readDocument } from '../src/reader.js';
import { createProject, setLayer, undo, redo, findLayer, FONT_STACKS } from '../src/edit.js';
import { renderProject } from '../src/render.js';
import { buildExportOrder, assertIdentifiable, isSelfRendering, wantedIndices } from '../src/export/order.js';
import {
  removeLayer, nextLayerId,
  naturalTextSize, insertTextLayer, retypeText,
  insertImageLayer, replaceImage,
} from '../src/creative/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

/** A solid RGBA buffer, shaped exactly like a decoded layer's `imageData`. */
const solid = (width, height, [r, g, b, a]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width, height, data };
};

/**
 * A one-layer document in the shape `createProject` reads, so the layers under
 * test are built by the real `toLayer()` without paying for a PSD parse.
 */
const synth = () => createProject({
  width: 20,
  height: 20,
  warnings: [],
  children: [{ name: 'bg', left: 0, top: 0, right: 20, bottom: 20, imageData: solid(20, 20, [0, 0, 0, 255]) }],
}, 'synth.psd');

/** Read once at module scope: parsing a PSD needs no canvas, so it is not part of any stub. */
const textDoc = await readDocument(
  new Uint8Array(fs.readFileSync('fixtures/text.src.psd')), { pixels: 'eager', metadata: false });

const pixelAt = (buffer, x, y) => {
  const i = (y * buffer.width + x) * 4;
  return [buffer.data[i], buffer.data[i + 1], buffer.data[i + 2], buffer.data[i + 3]];
};

console.log('\ninserted layers\n');

test('an inserted image layer carries exactly the fields a PSD-loaded one does', () => {
  const project = synth();
  const loaded = project.layers[0];
  const inserted = insertImageLayer(project, { pixels: solid(4, 4, [255, 0, 0, 255]) });
  assert.deepEqual(
    Object.keys(inserted).sort(),
    Object.keys(loaded).sort(),
    'an extra or missing field makes the layer distinguishable from a file layer',
  );
  assert.equal(inserted.kind, 'raster');
});

test('an inserted layer gets an id that collides with nothing in the project', () => {
  const project = synth();
  const a = insertImageLayer(project, { pixels: solid(2, 2, [1, 2, 3, 255]) });
  const b = insertImageLayer(project, { pixels: solid(2, 2, [1, 2, 3, 255]) });
  const ids = project.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(a.id, b.id);
  assert.equal(findLayer(project, b.id), b);
});

test('inserts land on top by default and at an explicit index when asked', () => {
  const project = synth();
  const top = insertImageLayer(project, { pixels: solid(2, 2, [1, 1, 1, 255]) });
  assert.equal(project.layers[project.layers.length - 1], top);
  const bottom = insertImageLayer(project, { pixels: solid(2, 2, [1, 1, 1, 255]), index: 0 });
  assert.equal(project.layers[0], bottom);
});

test('insert and remove both bump revision and mutation', () => {
  const project = synth();
  const revision = project.revision, mutation = project.mutation;
  const layer = insertImageLayer(project, { pixels: solid(2, 2, [1, 1, 1, 255]) });
  assert.equal(project.revision, revision + 1, 'a structural change must drop the sandwich cache');
  assert.equal(project.mutation, mutation + 1);

  const removed = removeLayer(project, layer.id);
  assert.equal(removed.index, 1);
  assert.equal(project.layers.length, 1);
  assert.equal(project.revision, revision + 2);
  assert.equal(project.mutation, mutation + 2);
  assert.equal(removeLayer(project, 9999), null, 'an unknown id removes nothing');
});

test('nextLayerId is derived from the project, not a module counter', () => {
  const project = synth();
  project.layers[0].id = 500;
  assert.equal(nextLayerId(project), 501);
});

console.log('\nsourceIndex identity\n');

test('an inserted image layer has no sourceIndex, and export refuses it loudly', () => {
  const project = synth();
  // A streamed load stamps this; an eager one leaves it null. Stamp it by hand
  // so the file layer is identifiable and the INSERTED layer is the only one
  // that is not.
  project.layers[0].sourceIndex = 0;
  const layer = insertImageLayer(project, { pixels: solid(4, 4, [255, 0, 0, 255]) });

  assert.equal(layer.sourceIndex, null, 'a number here would be matched to some other layer\'s pixels');
  assert.equal(wantedIndices(buildExportOrder(project)).has(null), false);
  assert.throws(
    () => assertIdentifiable(buildExportOrder(project)),
    /has no sourceIndex/,
    'export must refuse rather than draw a plausible wrong image',
  );
});

test('an inserted text layer is self-rendering, so export needs nothing from the file', () => {
  const project = synth();
  project.layers[0].sourceIndex = 0;
  const layer = insertTextLayer(project, { content: 'Hi', w: 40, h: 20 });

  assert.equal(layer.sourceIndex, null);
  assert.equal(layer.rerendered, true, 'a created text layer has no Photoshop pixels to fall back to');
  assert.equal(isSelfRendering(layer), true);
  assert.equal(wantedIndices(buildExportOrder(project)).size, 1, 'only the file layer is awaited');
  assert.doesNotThrow(() => assertIdentifiable(buildExportOrder(project)));
});

test('replacing an image drops sourceIndex, so export cannot serve the old picture', () => {
  const project = synth();
  const layer = project.layers[0];
  layer.sourceIndex = 0;
  replaceImage(project, layer.id, { pixels: solid(4, 4, [0, 255, 0, 255]) });

  assert.equal(layer.sourceIndex, null, 'keeping it would re-fetch the file\'s ORIGINAL pixels at export');
  assert.throws(() => assertIdentifiable(buildExportOrder(project)), /has no sourceIndex/);
});

console.log('\nimage layers\n');

test('a pixel buffer that is not a decoded image is rejected, not stored', () => {
  const project = synth();
  assert.throws(() => insertImageLayer(project, {}), /pixels/);
  assert.throws(
    () => insertImageLayer(project, { pixels: { width: 4, height: 4, data: new Uint8ClampedArray(16) } }),
    /4x4/,
  );
  assert.equal(project.layers.length, 1, 'a rejected insert must not have half-happened');
});

test('an inserted image defaults to its natural size, centred in the document', () => {
  const project = synth();                       // 20x20 document
  const layer = insertImageLayer(project, { pixels: solid(4, 6, [255, 0, 0, 255]) });
  assert.deepEqual([layer.w, layer.h], [4, 6]);
  assert.deepEqual([layer.x, layer.y], [8, 7]);
  assert.deepEqual([layer.sourceW, layer.sourceH], [4, 6]);
  assert.deepEqual([layer.proxyW, layer.proxyH], [4, 6]);
});

test('an inserted image actually renders, at the position it was given', () => {
  const project = synth();
  insertImageLayer(project, { pixels: solid(4, 4, [255, 0, 0, 255]), x: 2, y: 3 });
  const out = renderProject(project);
  assert.deepEqual(pixelAt(out, 3, 4), [255, 0, 0, 255], 'inside the sticker');
  assert.deepEqual(pixelAt(out, 1, 4), [0, 0, 0, 255], 'left of it, the background');
  assert.deepEqual(pixelAt(out, 3, 8), [0, 0, 0, 255], 'below it, the background');
});

test('replace fits the new image inside the existing box without distorting it', () => {
  const project = synth();
  const layer = project.layers[0];
  setLayer(project, layer.id, { x: 0, y: 0, w: 20, h: 20 });
  replaceImage(project, layer.id, { pixels: solid(10, 5, [0, 255, 0, 255]) });
  // 2:1 source into a 20x20 box -> 20x10, vertically centred.
  assert.deepEqual([layer.w, layer.h], [20, 10]);
  assert.deepEqual([layer.x, layer.y], [0, 5]);
  assert.deepEqual([layer.sourceW, layer.sourceH], [10, 5]);
});

test('replace with fit "stretch" keeps the box exactly as it was', () => {
  const project = synth();
  const layer = project.layers[0];
  const box = [layer.x, layer.y, layer.w, layer.h];
  replaceImage(project, layer.id, { pixels: solid(10, 5, [0, 255, 0, 255]), fit: 'stretch' });
  assert.deepEqual([layer.x, layer.y, layer.w, layer.h], box);
});

test('replace is undoable and never touches the outgoing pixel buffer', () => {
  const project = synth();
  const layer = project.layers[0];
  const original = layer.pixels;
  const before = original.data.slice(0, 32);

  replaceImage(project, layer.id, { pixels: solid(4, 4, [0, 255, 0, 255]) });
  assert.notEqual(layer.pixels, original);
  assert.deepEqual(original.data.slice(0, 32), before, 'the old buffer was written into');

  assert.ok(undo(project));
  assert.equal(layer.pixels, original);
  assert.equal(layer.sourceW, 20, 'undo restores the source dimensions too');
  assert.ok(redo(project));
  assert.equal(layer.pixels.width, 4);
});

test('replace drops the render cache KEY as well as the pixels', () => {
  const project = synth();
  const layer = project.layers[0];
  layer.rendered = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  layer.renderedKey = 'stale';
  replaceImage(project, layer.id, { pixels: solid(4, 4, [0, 0, 255, 255]) });
  assert.equal(layer.renderedKey, null, 'a stale key returns null pixels and the layer disappears');
  assert.equal(layer.rendered, null);
});

console.log('\ntext geometry without a drawing surface\n');

test('naturalTextSize reports null rather than guessing when there is no surface', () => {
  assert.equal(typeof document, 'undefined', 'this case only means anything before the stub is installed');
  assert.equal(naturalTextSize({ content: 'Hi', fontFamily: 'Arial', fontSize: 20 }), null);
});

test('creating text with no surface and no explicit box throws instead of inventing one', () => {
  const project = synth();
  assert.throws(() => insertTextLayer(project, { content: 'Hi' }), /measure/i);
  assert.equal(project.layers.length, 1, 'a rejected insert must not have half-happened');
});

test('an explicit box lets text be created anywhere, surface or not', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'Hi', x: 1, y: 2, w: 30, h: 12 });
  assert.deepEqual([layer.x, layer.y, layer.w, layer.h], [1, 2, 30, 12]);
});

// ---------------------------------------------------------------------------
// Everything below needs a text measurer. Node has none, so stub the same
// minimal canvas test/edit.mjs uses: 10px per character, 1.25 line height.
// This measures GEOMETRY only — getImageData returns transparent pixels, so no
// assertion below reads a glyph.
// ---------------------------------------------------------------------------
globalThis.document = {
  createElement() {
    const el = { width: 0, height: 0 };
    el.getContext = () => ({
      font: '', fillStyle: '', textBaseline: '', textAlign: '',
      setTransform() {}, fillText() {},
      measureText: (s) => ({ width: s.length * 10 }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    });
    return el;
  },
};

console.log('\ntext layers\n');

test('a created text layer carries exactly the fields a PSD text layer does', () => {
  const loaded = createProject(textDoc, 'text.src.psd').layers.find((l) => l.kind === 'text');
  assert.ok(loaded, 'text.src.psd must contain a text layer');

  const created = insertTextLayer(synth(), { content: 'Hi' });
  assert.deepEqual(Object.keys(created).sort(), Object.keys(loaded).sort());
  assert.deepEqual(Object.keys(created.text).sort(), Object.keys(loaded.text).sort());
  assert.equal(created.text.fontFamily, FONT_STACKS[0]);
});

test('a created text layer is sized from the measurer and centred', () => {
  const project = synth();                       // 20x20 document
  const layer = insertTextLayer(project, { content: 'ABCD', fontSize: 20 });
  assert.equal(layer.w, 40, 'four characters at 10px each');
  assert.equal(layer.h, 25, 'one line at 1.25 * 20px');
  assert.deepEqual([layer.x, layer.y], [-10, -2]);
  assert.equal(layer.pixels, null, 'created text has no Photoshop bitmap');
  assert.deepEqual([layer.sourceW, layer.sourceH], [40, 25]);
});

test('a two-line string measures as two lines', () => {
  const layer = insertTextLayer(synth(), { content: 'AB\nCDE', fontSize: 20 });
  assert.equal(layer.w, 30, 'the widest line');
  assert.equal(layer.h, 50);
});

test('retyping grows the box with the string and holds the left edge', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'AB', x: 5, y: 5 });
  assert.equal(layer.w, 20);
  retypeText(project, layer.id, { content: 'ABCD' });
  assert.equal(layer.w, 40);
  assert.equal(layer.x, 5, 'left-aligned text grows rightwards');
  assert.equal(layer.y, 5);
});

test('centred text grows about its centre; right-aligned about its right edge', () => {
  const project = synth();
  const centre = insertTextLayer(project, { content: 'AB', x: 10, y: 0, align: 'center' });
  retypeText(project, centre.id, { content: 'ABCD' });
  assert.equal(centre.x, 0, 'centre stays at 20');

  const right = insertTextLayer(project, { content: 'AB', x: 10, y: 0, align: 'right' });
  retypeText(project, right.id, { content: 'ABCD' });
  assert.equal(right.x, -10, 'right edge stays at 30');
});

test('retyping preserves a box the user has resized by hand', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'AB', x: 0, y: 0, fontSize: 20 });
  setLayer(project, layer.id, { w: layer.w * 3, h: layer.h * 3 });   // 60 x 75
  retypeText(project, layer.id, { content: 'ABCD' });
  assert.equal(layer.w, 120, 'still 3x the natural width');
  assert.equal(layer.h, 75, 'height unchanged — still one line');
});

test('a style change reflows the box too', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'AB', fontSize: 20 });
  assert.deepEqual([layer.w, layer.h], [20, 25]);
  retypeText(project, layer.id, { fontSize: 40 });
  assert.equal(layer.h, 50, 'line height follows the font size');
});

test('retyping is one undo step, and coalesces across a typing burst', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'A' });
  const depth = project.history.length;

  retypeText(project, layer.id, { content: 'AB' });
  assert.equal(project.history.length, depth + 1);
  assert.ok(undo(project));
  assert.equal(layer.text.content, 'A');
  assert.equal(layer.w, 10, 'undo restores the box, not just the string');

  for (const s of ['AB', 'ABC', 'ABCD']) retypeText(project, layer.id, { content: s }, 'type#1');
  assert.equal(project.history.length, depth + 1, 'a typing burst is one history entry');
  assert.equal(layer.w, 40);
});

test('retyping invalidates the render cache key', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'AB' });
  layer.rendered = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  layer.renderedKey = 'stale';
  retypeText(project, layer.id, { content: 'ABC' });
  assert.equal(layer.renderedKey, null);
});

test('retyping a PSD text layer switches it off Photoshop pixels', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  assert.ok(layer, 'text.src.psd must contain a text layer');
  assert.equal(layer.rerendered, false);

  retypeText(project, layer.id, { content: 'retyped' });
  assert.equal(layer.rerendered, true);
  assert.equal(isSelfRendering(layer), true, 'export must now generate it rather than await the file');
  assert.ok(undo(project));
  assert.equal(layer.rerendered, false, 'undo returns it to Photoshop pixels');
});

test('retyping a raster layer is refused', () => {
  const project = synth();
  assert.throws(() => retypeText(project, project.layers[0].id, { content: 'x' }), /not a text layer/);
});

delete globalThis.document;
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
