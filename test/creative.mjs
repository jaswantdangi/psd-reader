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
import { buildExportOrder, assertIdentifiable, isSelfRendering, drawsOwnPixels, wantedIndices } from '../src/export/order.js';
import {
  removeLayer, nextLayerId,
  naturalTextSize, insertTextLayer, retypeText, liveTextRect,
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

console.log('\ninsert and remove are commands\n');

test('an inserted layer can be undone and redone, and keeps its id', () => {
  const project = synth();
  const layer = insertImageLayer(project, { pixels: solid(4, 4, [255, 0, 0, 255]) });
  const id = layer.id;
  assert.equal(project.history.length, 1, 'adding a sticker must be a history entry, not a silent mutation');

  assert.equal(undo(project), true);
  assert.equal(project.layers.length, 1, 'undo must take the sticker back out');
  assert.equal(findLayer(project, id), null);

  assert.equal(redo(project), true);
  assert.equal(project.layers.length, 2);
  // Same id, not a fresh one: the panel's selection and the sandwich cache's
  // slice boundaries both name layers by id, and a renumbered layer points
  // them at something else.
  assert.equal(project.layers[1].id, id, 'a re-inserted layer must be the SAME layer, not a copy with a new id');
  assert.equal(findLayer(project, id), layer);
});

test('undo puts a removed layer back where it was, with its pixels', () => {
  const project = synth();
  const bottom = insertImageLayer(project, { pixels: solid(4, 4, [0, 0, 255, 255]), index: 0 });
  const pixels = bottom.pixels;

  const removed = removeLayer(project, bottom.id);
  assert.equal(removed.index, 0);
  assert.equal(project.layers.length, 1);

  assert.equal(undo(project), true);
  assert.equal(project.layers.length, 2);
  assert.equal(project.layers[0].id, bottom.id, 'it must come back at index 0, not on top');
  assert.equal(project.layers[0].pixels, pixels, 'undo of a delete has to restore the buffer, not an empty layer');

  assert.equal(redo(project), true);
  assert.equal(project.layers.length, 1);
});

test('a structural command moves both counters exactly once per step', () => {
  const project = synth();
  const revision = project.revision, mutation = project.mutation;

  insertImageLayer(project, { pixels: solid(2, 2, [1, 1, 1, 255]) });
  assert.deepEqual([project.revision, project.mutation], [revision + 1, mutation + 1]);

  undo(project);
  assert.deepEqual([project.revision, project.mutation], [revision + 2, mutation + 2],
    'undo bumps revision itself -- it calls applyCommand, not commit');

  redo(project);
  assert.deepEqual([project.revision, project.mutation], [revision + 3, mutation + 3]);
});

test('inserting after an undo clears the redo stack', () => {
  const project = synth();
  const first = insertImageLayer(project, { pixels: solid(2, 2, [1, 1, 1, 255]) });
  undo(project);
  assert.equal(project.future.length, 1);

  const second = insertImageLayer(project, { pixels: solid(2, 2, [2, 2, 2, 255]) });
  assert.equal(project.future.length, 0, 'a new action must not leave the old branch reachable');
  assert.equal(redo(project), false);
  assert.equal(project.layers.length, 2);
  assert.equal(project.layers[1], second, 'the undone layer must not come back');
  assert.notEqual(project.layers[1], first);
  // `second` reuses `first`'s id, because nextLayerId reads the LIVE stack and
  // `first` is no longer in it. Harmless: history is linear, so the abandoned
  // layer can never be spliced back in beside its namesake.
});

console.log('\nsourceIndex identity\n');

test('an inserted image layer has no sourceIndex, and supplies its own pixels instead', () => {
  const project = synth();
  // A streamed load stamps this; an eager one leaves it null. Stamp it by hand
  // so the file layer is identifiable and the INSERTED layer is the only one
  // that is not.
  project.layers[0].sourceIndex = 0;
  const layer = insertImageLayer(project, { pixels: solid(4, 4, [255, 0, 0, 255]) });

  assert.equal(layer.sourceIndex, null, 'a number here would be matched to some other layer\'s pixels');
  assert.equal(layer.selfSupplied, true, 'it never came from the file, so nothing will ever arrive for it');
  assert.equal(drawsOwnPixels(layer), true);
  assert.equal(wantedIndices(buildExportOrder(project)).has(null), false);
  assert.equal(wantedIndices(buildExportOrder(project)).size, 1, 'only the file layer is awaited');
  assert.doesNotThrow(
    () => assertIdentifiable(buildExportOrder(project)),
    'a layer holding its own full-resolution pixels needs no identity in the file',
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
  assert.equal(layer.selfSupplied, true, 'the NEW pixels are the full-resolution material now');
  assert.equal(wantedIndices(buildExportOrder(project)).size, 0, 'the file has nothing this project wants');
  assert.doesNotThrow(() => assertIdentifiable(buildExportOrder(project)));
});

test('undoing a replace restores the file identity as well as the pixels', () => {
  const project = synth();
  const layer = project.layers[0];
  layer.sourceIndex = 0;
  const original = layer.pixels;
  replaceImage(project, layer.id, { pixels: solid(4, 4, [0, 255, 0, 255]) });

  undo(project);
  assert.equal(layer.pixels, original);
  assert.equal(layer.sourceIndex, 0, 'the layer is the file\'s again, so export must await its arrival');
  assert.equal(layer.selfSupplied, false, 'a stale flag here would blend PROXY pixels at full resolution');
  assert.deepEqual([...wantedIndices(buildExportOrder(project))], [0]);
});

test('a layer whose pixels are only a proxy is never treated as self-supplying', () => {
  // The trap the whole flag exists for: a file layer under a proxy load holds a
  // 256-edge buffer for a 1080px layer. Blending that at scale 1 upscales a
  // thumbnail into a correctly-sized, blurred image -- the failure stream.js
  // exists to prevent, and the one that looks like it worked.
  const project = synth();
  project.layers[0].sourceIndex = 0;
  assert.equal(project.layers[0].selfSupplied, false);
  assert.equal(drawsOwnPixels(project.layers[0]), false, 'it has pixels, but they are the file\'s to re-supply');
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
// minimal canvas test/edit.mjs uses, modelling a plausible Latin face:
//
//   advance     10px per character, whatever the size
//   cap height  0.70em of INK above the baseline, and none below it
//   font box    0.90em above the baseline + 0.20em below = 1.10em of leading
//
// Those proportions are an ASSUMPTION about what a browser reports, not a
// measurement of one. They keep the arithmetic in these assertions legible;
// they do not prove any real font agrees.
//
// This measures GEOMETRY only — getImageData returns transparent pixels, so no
// assertion below reads a glyph.
// ---------------------------------------------------------------------------
const CHAR_ADVANCE = 10, CAP_HEIGHT = 0.7, FONT_ASCENT = 0.9, FONT_DESCENT = 0.2;
globalThis.document = {
  createElement() {
    const el = { width: 0, height: 0 };
    el.getContext = () => ({
      set font(v) { this._size = parseFloat(/([\d.]+)px/.exec(v)?.[1]) || 10; },
      get font() { return ''; },
      fillStyle: '', textBaseline: '', textAlign: '',
      setTransform() {}, fillText() {},
      measureText(str) {
        return {
          width: str.length * CHAR_ADVANCE,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: str.length * CHAR_ADVANCE,
          actualBoundingBoxAscent: str === '' ? 0 : this._size * CAP_HEIGHT,
          actualBoundingBoxDescent: 0,
          fontBoundingBoxAscent: this._size * FONT_ASCENT,
          fontBoundingBoxDescent: this._size * FONT_DESCENT,
        };
      },
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
  assert.equal(layer.h, 14, 'the INK of one line -- 0.7 * 20 -- not a 1.25 line box');
  assert.deepEqual([layer.x, layer.y], [-10, 3]);
  assert.equal(layer.pixels, null, 'created text has no Photoshop bitmap');
  assert.deepEqual([layer.sourceW, layer.sourceH], [40, 14]);
});

test('a two-line string measures as two lines', () => {
  const layer = insertTextLayer(synth(), { content: 'AB\nCDE', fontSize: 20 });
  assert.equal(layer.w, 30, 'the widest line');
  assert.equal(layer.h, 36, 'ink of the first line (14) plus one font-box advance (22)');
});

test('a PSD line break is normalised to LF on the way in', () => {
  // Photoshop writes CR. A textarea always hands its value back as LF. If the
  // model kept both conventions, the same layer would measure as two lines
  // before the first keystroke and one line after it -- which is exactly the
  // reported "editing destroys my line breaks". One convention, chosen at the
  // door: \n, because that is the one the editing surface can produce.
  //
  // SYNTHETIC: none of the 21 fixtures contains a multi-line text layer, so
  // the source node below is hand-built in the shape toLayer() reads.
  const project = createProject({
    width: 20, height: 20, warnings: [],
    children: [{
      name: 'two lines', left: 0, top: 0, right: 60, bottom: 40,
      text: {
        text: 'AB\rCD',
        style: { fontSize: 20, fillColor: { r: 0, g: 0, b: 0 } },
        paragraphStyle: { justification: 'left' },
      },
    }],
  }, 'synth.psd');

  const layer = project.layers[0];
  assert.equal(layer.text.content, 'AB\nCD');
  assert.equal(layer.text.originalContent, layer.text.content,
    'normalising one and not the other would report an untouched layer as edited');
  assert.equal(naturalTextSize(layer.text).height, naturalTextSize({ ...layer.text, content: 'AB\nCD' }).height);
});

test('a multi-line box does not collapse when the layer is first retyped', () => {
  // The user-visible bug: the breaks render from the file, then vanish on the
  // first edit. Retyping with the SAME string must leave the box exactly where
  // measurement already put it.
  const project = synth();
  const layer = insertTextLayer(project, { content: 'AB\nCD', fontSize: 20 });
  const before = [layer.w, layer.h];
  retypeText(project, layer.id, { content: 'AB\nCD' });
  assert.deepEqual([layer.w, layer.h], before, 'a no-op edit must not resize the box');
  assert.ok(layer.h > naturalTextSize({ ...layer.text, content: 'ABCD' }).height,
    'two lines stay two lines');
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
  setLayer(project, layer.id, { w: layer.w * 3, h: layer.h * 3 });   // 60 x 42
  retypeText(project, layer.id, { content: 'ABCD' });
  assert.equal(layer.w, 120, 'still 3x the natural width');
  assert.equal(layer.h, 42, 'height unchanged — still one line');
});

test('a style change reflows the box too', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'AB', fontSize: 20 });
  assert.deepEqual([layer.w, layer.h], [20, 14]);
  retypeText(project, layer.id, { fontSize: 40 });
  assert.equal(layer.h, 28, 'the ink scales with the font size');
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

console.log('\nPhotoshop bounds against ours\n');

/**
 * The two bugs, in numbers.
 *
 * Photoshop bounds "TEST" at 30px as 60 x 21 -- the INK extent of the caps.
 * We used to answer with a LINE BOX: the widest advance by
 * lines * round(fontSize * 1.25) = 38 tall. Two different quantities, so the
 * ratio between them was a units error and not a scale -- it squashed the
 * glyphs 1.4x harder vertically than horizontally -- and once the first edit
 * stopped applying that ratio and re-fitted the box instead, the same 38
 * became a visible jump in SIZE on the first keystroke.
 *
 * measureText now reports the ink extent, so both boxes are the same quantity
 * and the height stops moving: 21 in the file, 21 from us. The WIDTH still
 * moves -- 60 in the file, 40 under this stub -- and that is not a units
 * problem but a font one: toLayer() substitutes FONT_STACKS[0] for whatever
 * the file used, so we are honestly measuring a different typeface.
 */
test('editing a PSD text layer re-fits the box to metrics that agree with the file', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  assert.deepEqual([layer.x, layer.y, layer.w, layer.h], [36, 45, 60, 21], 'the bounds the file carried');

  retypeText(project, layer.id, { content: 'TEST!' });

  assert.equal(layer.h, 21, "the file's own height -- both are the ink extent now");
  assert.equal(layer.y, 45, 'so the re-centre has nothing to correct and the top does not move');
  assert.equal(layer.w, 50, "five characters at the stub's 10px, at scale 1");
  assert.equal(layer.x, 36, 'left-aligned, so the left edge is the anchor');
});

test('the first edit does not resize a PSD text layer vertically', () => {
  // "size changes from the exact": re-fitting the box to a LINE BOX resized a
  // layer nobody had resized. Retyping "TEST" to "TEST" has to leave the
  // geometry alone. Width is excluded on purpose -- see above: we substitute
  // the font, so the string's own width legitimately differs.
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  const before = [layer.x, layer.y, layer.h];

  retypeText(project, layer.id, { content: 'TEST' });
  assert.deepEqual([layer.x, layer.y, layer.h], before, 'no jump on the first keystroke');
});

test('a second edit grows the box to fit the string, never re-applying a stale stretch', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  retypeText(project, layer.id, { content: 'TEST!' });
  const y = layer.y;

  retypeText(project, layer.id, { content: 'TE' });
  assert.deepEqual([layer.w, layer.h], [20, 21], 'still scale 1 on both axes');
  assert.equal(layer.y, y, 'the top is ours now and stays put');
});

test('undo puts the bounds the file carried back together with its pixels', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  retypeText(project, layer.id, { content: 'TEST!' });
  assert.ok(undo(project));
  assert.deepEqual([layer.x, layer.y, layer.w, layer.h], [36, 45, 60, 21]);
  assert.equal(layer.rerendered, false);
});

test('liveTextRect is the rect a resize drag on a PSD text layer must start from', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');

  // Exactly the box the first edit would produce, without performing an edit:
  // a corner drag reads it at pointer-down so the drag scales OUR rectangle
  // rather than the file's, which the renderer would otherwise read as a 1.4x
  // vertical squash on the very first frame.
  assert.deepEqual(liveTextRect(layer), { x: 36, y: 45, w: 40, h: 21 });

  retypeText(project, layer.id, { content: 'TEST' });
  assert.equal(liveTextRect(layer), null, 'the box is already ours; there is nothing to re-fit');
  assert.equal(liveTextRect(project.layers[0]), null, 'raster layers have no natural size');
});

test('a hand resize survives typing as ONE uniform scale, not an X/Y stretch', () => {
  const project = synth();
  const layer = insertTextLayer(project, { content: 'AB', x: 0, y: 0, fontSize: 20 });
  setLayer(project, layer.id, { w: 60, h: 42 });            // 3x, uniform
  retypeText(project, layer.id, { content: 'ABCD' });
  assert.deepEqual([layer.w, layer.h], [120, 42], 'still 3x natural');

  // A corner drag does not lock aspect, so a box CAN end up non-uniform. The
  // glyphs are fitted inside it undistorted, and the next edit normalises the
  // box back to one scale rather than carrying the stretch forward forever.
  setLayer(project, layer.id, { w: 200, h: 42 });
  retypeText(project, layer.id, { content: 'ABCD' });
  assert.deepEqual([layer.w, layer.h], [120, 42], 'the extra width was empty space, not a stretch');
});

test('retyping a raster layer is refused', () => {
  const project = synth();
  assert.throws(() => retypeText(project, project.layers[0].id, { content: 'x' }), /not a text layer/);
});

delete globalThis.document;
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
