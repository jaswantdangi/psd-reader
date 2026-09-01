import assert from 'node:assert/strict';
import fs from 'fs';
import {
  createProject, setLayer, renderProject, createBuffer,
  loadProjectProxy, exportFullRes, createJsExportTarget, createMemorySpill,
  nextGestureKey,
} from '../src/index.js';
// Direct from edit.js, deliberately: these tests are about there being ONE
// undo, so they have to name the one in edit.js rather than a re-export.
import {
  undo as editUndo, redo as editRedo, discardTo as editDiscardTo,
  canvasSize, hitTest, toProjectJson, applyProjectJson,
} from '../src/edit.js';
import { fitView, clampView } from '../src/view.js';
import {
  ASPECT_RATIOS, RATIO_IDS, ratioOf, largestCentredRect, moveRect, resizeRect, MIN_FRAME_SIZE,
  fullFrame, frameOf, isCropped, setFrame, setRatio, undo, redo, discardTo,
  framedLayer, framedProject, framedTarget,
  CANVAS_ANCHORS, canvasRect, resizeCanvas,
  layerFate, framingReport,
} from '../src/frame/index.js';

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

const solid = (w, h, [r, g, b, a = 255]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
};

/**
 * 40x30, three opaque layers at three different places:
 *
 *   back  covers the whole document
 *   mid   is exactly the crop rect used throughout
 *   far   sits in the bottom-right corner, entirely outside that crop
 */
const doc = () => createProject({
  width: 40, height: 30,
  children: [
    { name: 'back', left: 0, top: 0, right: 40, bottom: 30, proxyData: solid(40, 30, [20, 20, 20]) },
    { name: 'mid', left: 8, top: 6, right: 24, bottom: 18, proxyData: solid(16, 12, [200, 40, 40]) },
    { name: 'far', left: 30, top: 20, right: 40, bottom: 30, proxyData: solid(10, 10, [40, 200, 40]) },
  ],
}, 'frame.psd');

const CROP = { x: 8, y: 6, width: 16, height: 12 };

/** The sub-rect of a rendered buffer, as its own buffer. */
function cropBuffer(buffer, rect) {
  const out = createBuffer(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++)
    for (let x = 0; x < rect.width; x++) {
      const s = ((y + rect.y) * buffer.width + (x + rect.x)) * 4;
      const d = (y * rect.width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = buffer.data[s + c];
    }
  return out;
}

const geometryOf = (project) => project.layers.map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h }));

console.log('\naspect ratios\n');

test('the preset list is free plus the four social ratios, and every id resolves', () => {
  assert.deepEqual(RATIO_IDS, ['free', '1:1', '4:5', '9:16', '16:9']);
  assert.equal(ASPECT_RATIOS.length, 5);
  assert.equal(ratioOf('free'), null);
  assert.equal(ratioOf('1:1'), 1);
  assert.equal(ratioOf('4:5'), 4 / 5);
  assert.equal(ratioOf('9:16'), 9 / 16);
  assert.equal(ratioOf('16:9'), 16 / 9);
  assert.equal(ratioOf('nonsense'), null, 'an unknown id is free, never NaN');
  for (const preset of ASPECT_RATIOS) assert.ok(Object.isFrozen(preset));
});

test('the largest centred rect for each preset, on 1000x800, to the pixel', () => {
  assert.deepEqual(largestCentredRect(1000, 800, null), { x: 0, y: 0, width: 1000, height: 800 });
  assert.deepEqual(largestCentredRect(1000, 800, 1), { x: 100, y: 0, width: 800, height: 800 });
  assert.deepEqual(largestCentredRect(1000, 800, 4 / 5), { x: 180, y: 0, width: 640, height: 800 });
  assert.deepEqual(largestCentredRect(1000, 800, 9 / 16), { x: 275, y: 0, width: 450, height: 800 });
  // 1000 / (16/9) is 562.5 exactly, so the derived side is the rounding case.
  assert.deepEqual(largestCentredRect(1000, 800, 16 / 9), { x: 0, y: 119, width: 1000, height: 563 });
});

test('the largest centred rect for each preset, on 40x30, to the pixel', () => {
  assert.deepEqual(largestCentredRect(40, 30, 1), { x: 5, y: 0, width: 30, height: 30 });
  assert.deepEqual(largestCentredRect(40, 30, 4 / 5), { x: 8, y: 0, width: 24, height: 30 });
  assert.deepEqual(largestCentredRect(40, 30, 9 / 16), { x: 12, y: 0, width: 17, height: 30 });
  assert.deepEqual(largestCentredRect(40, 30, 16 / 9), { x: 0, y: 4, width: 40, height: 23 });
});

test('the largest centred rect never leaves the box it was asked to fit inside', () => {
  for (const [w, h] of [[1, 1], [3, 7], [17, 4], [1000, 999], [999, 1000], [5, 5]])
    for (const id of RATIO_IDS) {
      const r = largestCentredRect(w, h, ratioOf(id));
      assert.ok(r.width >= 1 && r.height >= 1, `${w}x${h} ${id} collapsed to ${r.width}x${r.height}`);
      assert.ok(r.x >= 0 && r.y >= 0, `${w}x${h} ${id} started outside`);
      assert.ok(r.x + r.width <= w && r.y + r.height <= h, `${w}x${h} ${id} overflowed`);
    }
});

console.log('\nnudging a crop rect\n');

const BOUNDS = { x: 0, y: 0, width: 40, height: 30 };

test('a move is clamped so the rect stays wholly inside the document', () => {
  const rect = { x: 5, y: 5, width: 20, height: 10 };
  assert.deepEqual(moveRect(rect, 3, 4, BOUNDS), { x: 8, y: 9, width: 20, height: 10 });
  assert.deepEqual(moveRect(rect, 100, -100, BOUNDS), { x: 20, y: 0, width: 20, height: 10 });
  assert.deepEqual(moveRect(rect, -100, 100, BOUNDS), { x: 0, y: 20, width: 20, height: 10 });
  assert.deepEqual(moveRect(rect, 0.4, 0.6, BOUNDS), { x: 5, y: 6, width: 20, height: 10 },
    'a rect is whole document pixels; a sub-pixel drag rounds, it does not accumulate a fraction');
});

test('a rect larger than its bounds pins to the origin rather than going negative', () => {
  assert.deepEqual(moveRect({ x: 0, y: 0, width: 50, height: 40 }, 10, 10, BOUNDS),
    { x: 0, y: 0, width: 50, height: 40 });
});

test('a free resize follows the finger and stops at the document edge', () => {
  const rect = { x: 5, y: 5, width: 20, height: 10 };
  assert.deepEqual(resizeRect(rect, 'se', 30, 27, { bounds: BOUNDS }),
    { x: 5, y: 5, width: 25, height: 22 });
  assert.deepEqual(resizeRect(rect, 'se', 100, 100, { bounds: BOUNDS }),
    { x: 5, y: 5, width: 35, height: 25 }, 'the anchor is nw at (5,5), so 35x25 is all there is');
  assert.deepEqual(resizeRect(rect, 'nw', -10, -10, { bounds: BOUNDS }),
    { x: 0, y: 0, width: 25, height: 15 }, 'nw drags against the se anchor at (25,15)');
});

test('a locked resize inscribes the ratio in the free-drag box', () => {
  const rect = { x: 5, y: 5, width: 20, height: 10 };
  assert.deepEqual(resizeRect(rect, 'se', 30, 27, { bounds: BOUNDS, ratio: 1 }),
    { x: 5, y: 5, width: 22, height: 22 }, 'the 25x22 free box contains a 22x22 square');
  assert.deepEqual(resizeRect(rect, 'se', 100, 100, { bounds: BOUNDS, ratio: 1 }),
    { x: 5, y: 5, width: 25, height: 25 }, 'clamped to 35x25 first, then inscribed');
  assert.deepEqual(resizeRect(rect, 'nw', -10, -10, { bounds: BOUNDS, ratio: 1 }),
    { x: 10, y: 0, width: 15, height: 15 }, 'the se anchor at (25,15) stays put');
});

test('a locked resize holds the ratio to within one rounded pixel, everywhere it can reach', () => {
  const rect = { x: 10, y: 8, width: 12, height: 9 };
  for (const id of RATIO_IDS) {
    const ratio = ratioOf(id);
    if (!ratio) continue;
    for (const handle of ['nw', 'ne', 'se', 'sw'])
      for (let px = -20; px <= 60; px += 7)
        for (let py = -20; py <= 50; py += 7) {
          const out = resizeRect(rect, handle, px, py, { bounds: BOUNDS, ratio });
          assert.ok(out.width >= MIN_FRAME_SIZE && out.height >= MIN_FRAME_SIZE);
          assert.ok(out.x >= 0 && out.y >= 0 && out.x + out.width <= 40 && out.y + out.height <= 30,
            `${id} ${handle} at ${px},${py} left the document: ${JSON.stringify(out)}`);
          assert.ok(Number.isInteger(out.x) && Number.isInteger(out.width));
          // Rounding to whole pixels is a real error term. Half a pixel on the
          // derived side is the most it can ever be.
          assert.ok(Math.abs(out.width - out.height * ratio) <= 0.5 + 1e-9,
            `${id} ${handle} at ${px},${py} drifted: ${out.width}x${out.height}`);
        }
  }
});

test('a resize cannot be shrunk below one pixel, in either axis', () => {
  const rect = { x: 10, y: 10, width: 10, height: 10 };
  const out = resizeRect(rect, 'se', 10, 10, { bounds: BOUNDS });
  assert.deepEqual(out, { x: 10, y: 10, width: 1, height: 1 });
});

console.log('\nthe frame on a project\n');

test('a project with no frame reads as the whole document, and is not cropped', () => {
  const p = doc();
  assert.deepEqual(fullFrame(p), { x: 0, y: 0, width: 40, height: 30 });
  assert.deepEqual(frameOf(p), { x: 0, y: 0, width: 40, height: 30 });
  assert.equal(isCropped(p), false);
  // `createProject` now declares the field, so a reader of the project model
  // can see that a frame exists as a concept. `null` is the whole document.
  assert.equal(p.frame, null);
});

test('setFrame commits one history entry and freezes the rect it stored', () => {
  const p = doc();
  const before = p.revision;
  setFrame(p, CROP);
  assert.deepEqual(frameOf(p), CROP);
  assert.equal(isCropped(p), true);
  assert.equal(p.history.length, 1);
  assert.equal(p.revision, before + 1);
  assert.ok(Object.isFrozen(p.frame), 'undo captures `from` by reference; a mutable frame kills it');
});

test('a crop rounds to whole document pixels and refuses to collapse', () => {
  const p = doc();
  setFrame(p, { x: 3.4, y: 6.6, width: 10.2, height: 0 });
  assert.deepEqual(frameOf(p), { x: 3, y: 7, width: 10, height: 1 });
});

test('a crop touches NO layer: every pixel and every coordinate survives it', () => {
  const p = doc();
  const geometry = geometryOf(p);
  const pixels = p.layers.map((l) => l.pixels);
  setFrame(p, CROP);
  assert.deepEqual(geometryOf(p), geometry, 'layer geometry is the document frame, not the crop');
  p.layers.forEach((l, i) => assert.equal(l.pixels, pixels[i], 'the SAME buffer, not a copy of part of it'));
  assert.equal(p.width, 40);
  assert.equal(p.height, 30, 'project.width/height stay the source document; the frame is what changed');
});

test('cropping and then re-widening restores the document exactly', () => {
  const p = doc();
  const full = renderProject(p);
  setFrame(p, CROP);
  setFrame(p, { x: 0, y: 0, width: 40, height: 30 });
  const again = renderProject(framedProject(p));
  assert.equal(again.width, 40);
  assert.equal(again.height, 30);
  assert.deepEqual([...again.data], [...full.data], 'a crop that lost pixels could not do this');
});

test('undo of a crop restores the previous frame, including no frame at all', () => {
  const p = doc();
  setFrame(p, CROP);
  setFrame(p, { x: 0, y: 0, width: 4, height: 4 });
  assert.equal(undo(p), true);
  assert.deepEqual(frameOf(p), CROP);
  assert.equal(undo(p), true);
  assert.equal(isCropped(p), false);
  assert.equal(undo(p), false, 'nothing left to undo');
  assert.equal(redo(p), true);
  assert.deepEqual(frameOf(p), CROP);
  assert.equal(redo(p), true);
  assert.deepEqual(frameOf(p), { x: 0, y: 0, width: 4, height: 4 });
});

test('frame and layer commands share ONE history and undo in the order they were made', () => {
  const p = doc();
  const mid = p.layers[1];
  setLayer(p, mid.id, { x: 12 });
  setFrame(p, CROP);
  setLayer(p, mid.id, { opacity: 0.5 });

  assert.equal(p.history.length, 3);
  undo(p);
  assert.equal(mid.opacity, 1);
  assert.deepEqual(frameOf(p), CROP, 'the frame must not move when a layer command is undone');
  undo(p);
  assert.equal(isCropped(p), false);
  assert.equal(mid.x, 12, 'undoing the frame must not move a layer');
  undo(p);
  assert.equal(mid.x, 8);
  assert.equal(p.history.length, 0);
});

test('a crop drag coalesces into one history entry, and leaves `revision` alone', () => {
  const p = doc();
  const key = nextGestureKey('crop');
  const revision = p.revision;
  const mutation = p.mutation;
  for (let i = 1; i <= 4; i++) setFrame(p, { x: i, y: i, width: 20, height: 15 }, key);

  assert.equal(p.history.length, 1, 'four hundred pointer moves must be one undo step');
  assert.equal(p.revision, revision + 1, 'the sandwich cache keys on revision and must survive a gesture');
  assert.equal(p.mutation, mutation + 4, 'every applied frame still bumps mutation');
  assert.deepEqual(frameOf(p), { x: 4, y: 4, width: 20, height: 15 });

  undo(p);
  assert.equal(isCropped(p), false, 'one undo must unwind the whole gesture, back to where it started');
});

test('a second gesture on the same rect does not merge into the first', () => {
  const p = doc();
  setFrame(p, { x: 1, y: 1, width: 20, height: 15 }, nextGestureKey('crop'));
  setFrame(p, { x: 2, y: 2, width: 20, height: 15 }, nextGestureKey('crop'));
  assert.equal(p.history.length, 2);
});

test('setting the frame it already has is not a history entry', () => {
  const p = doc();
  setFrame(p, CROP);
  setFrame(p, { ...CROP });
  assert.equal(p.history.length, 1);
});

test('a ratio chip crops to the largest centred rect of the SOURCE document', () => {
  const p = doc();
  setRatio(p, '1:1');
  assert.deepEqual(frameOf(p), { x: 5, y: 0, width: 30, height: 30 });
  setRatio(p, '16:9');
  assert.deepEqual(frameOf(p), { x: 0, y: 4, width: 40, height: 23 });
  setRatio(p, '1:1');
  assert.deepEqual(frameOf(p), { x: 5, y: 0, width: 30, height: 30 },
    'chips are a reset, not a refinement — three taps must not shrink the crop to nothing');
  assert.equal(p.history.length, 3);
});

test('the free chip clears the frame, and so does an id that does not exist', () => {
  const p = doc();
  setRatio(p, '4:5');
  assert.deepEqual(frameOf(p), { x: 8, y: 0, width: 24, height: 30 });
  setRatio(p, 'free');
  assert.equal(isCropped(p), false);
  setRatio(p, '4:5');
  setRatio(p, 'nonsense');
  assert.equal(isCropped(p), false, 'an unknown id must not crop to NaN');
});

test('a ratio takes a number as readily as an id', () => {
  const p = doc();
  setRatio(p, 1);
  assert.deepEqual(frameOf(p), { x: 5, y: 0, width: 30, height: 30 });
});

test('discardTo rolls back frame and layer commands together, in one revision bump', () => {
  const p = doc();
  const mid = p.layers[1];
  const mark = p.history.length;
  const revision = p.revision;

  setLayer(p, mid.id, { x: 12 });
  setFrame(p, CROP, nextGestureKey('crop'));
  setLayer(p, mid.id, { opacity: 0.25 });
  setFrame(p, { x: 0, y: 0, width: 4, height: 4 });

  assert.equal(discardTo(p, mark), 4);
  assert.equal(p.history.length, mark);
  assert.equal(p.future.length, 0, 'a discarded experiment must not come back on redo');
  assert.equal(mid.x, 8);
  assert.equal(mid.opacity, 1);
  assert.equal(isCropped(p), false);
  assert.ok(p.revision > revision);
});

console.log('\napplying the frame\n');

test('framedLayer shifts the origin and identity-returns when there is nothing to shift', () => {
  const p = doc();
  const mid = p.layers[1];
  assert.equal(framedLayer(mid, fullFrame(p)), mid, 'an uncropped document must cost nothing');
  const shifted = framedLayer(mid, CROP);
  assert.notEqual(shifted, mid);
  assert.equal(shifted.x, 0);
  assert.equal(shifted.y, 0);
  assert.equal(shifted.w, 16, 'a crop moves a layer; it never resizes one');
  assert.equal(shifted.pixels, mid.pixels, 'the same buffer, by reference');
});

test('a framed copy writes its render caches through to the real layer', () => {
  // drawLayerInto stores a text raster on the layer it is handed. If that landed
  // on a per-frame copy, every frame of a crop drag would re-rasterise the text
  // -- and the cache would look like it was working.
  const p = doc();
  const mid = p.layers[1];
  const shifted = framedLayer(mid, CROP);
  shifted.rendered = 'raster';
  shifted.renderedKey = 'key';
  shifted.lut = 'table';
  shifted.lutKey = 'digest';
  assert.equal(mid.rendered, 'raster');
  assert.equal(mid.renderedKey, 'key');
  assert.equal(mid.lut, 'table');
  assert.equal(mid.lutKey, 'digest');
  assert.equal(shifted.rendered, 'raster', 'and reads back through the same window');
});

test('framedProject presents the crop as the document, and identity-returns uncropped', () => {
  const p = doc();
  assert.equal(framedProject(p), p);
  setFrame(p, CROP);
  const framed = framedProject(p);
  assert.equal(framed.width, 16);
  assert.equal(framed.height, 12);
  assert.deepEqual(framed.layers.map((l) => [l.x, l.y]), [[-8, -6], [0, 0], [22, 14]]);
  assert.equal(p.width, 40, 'the real project is untouched');
  assert.deepEqual(geometryOf(p), geometryOf(doc()));
});

test('rendering the framed project IS the crop of the full render, byte for byte', () => {
  const p = doc();
  const full = renderProject(p);
  setFrame(p, CROP);
  const framed = renderProject(framedProject(p));
  assert.equal(framed.width, 16);
  assert.equal(framed.height, 12);
  assert.deepEqual([...framed.data], [...cropBuffer(full, CROP).data]);
});

test('the same holds at proxy scale, so preview and export cannot disagree', () => {
  const p = doc();
  const full = renderProject(p, { scale: 0.5 });
  setFrame(p, CROP);
  const framed = renderProject(framedProject(p), { scale: 0.5 });
  assert.equal(framed.width, 8);
  assert.equal(framed.height, 6);
  assert.deepEqual([...framed.data], [...cropBuffer(full, { x: 4, y: 3, width: 8, height: 6 }).data]);
});

test('the export walk, applied one layer at a time, equals the framed render', () => {
  // exportFullRes hands its target one layer at a time and never looks at a
  // neighbour. This is that walk, run against the same geometry.
  const p = doc();
  setFrame(p, CROP);
  const target = framedTarget(frameOf(p), createJsExportTarget)(p.width, p.height);
  for (const layer of p.layers) target.blend(layer, layer.pixels);

  return target.finish().then((out) => {
    assert.equal(out.width, 16);
    assert.equal(out.height, 12);
    assert.deepEqual([...out.data], [...renderProject(framedProject(p)).data]);
  });
});

console.log('\ncanvas resize\n');

test('the nine anchors place a smaller canvas exactly where they say', () => {
  const p = doc();
  assert.deepEqual(CANVAS_ANCHORS, ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se']);
  const at = (anchor) => canvasRect(p, 20, 10, anchor);
  assert.deepEqual(at('nw'), { x: 0, y: 0, width: 20, height: 10 });
  assert.deepEqual(at('n'), { x: 10, y: 0, width: 20, height: 10 });
  assert.deepEqual(at('ne'), { x: 20, y: 0, width: 20, height: 10 });
  assert.deepEqual(at('w'), { x: 0, y: 10, width: 20, height: 10 });
  assert.deepEqual(at('center'), { x: 10, y: 10, width: 20, height: 10 });
  assert.deepEqual(at('e'), { x: 20, y: 10, width: 20, height: 10 });
  assert.deepEqual(at('sw'), { x: 0, y: 20, width: 20, height: 10 });
  assert.deepEqual(at('s'), { x: 10, y: 20, width: 20, height: 10 });
  assert.deepEqual(at('se'), { x: 20, y: 20, width: 20, height: 10 });
  assert.deepEqual(at(undefined), at('center'), 'centre is the default');
});

test('a canvas can be made LARGER than the document, and the frame goes negative', () => {
  const p = doc();
  assert.deepEqual(canvasRect(p, 60, 50, 'center'), { x: -10, y: -10, width: 60, height: 50 });
  assert.deepEqual(canvasRect(p, 60, 50, 'nw'), { x: 0, y: 0, width: 60, height: 50 });
  assert.deepEqual(canvasRect(p, 60, 50, 'se'), { x: -20, y: -20, width: 60, height: 50 });
});

test('a canvas resize is relative to the CURRENT frame, not the source document', () => {
  const p = doc();
  setFrame(p, CROP);                                  // 16x12 at (8,6)
  assert.deepEqual(canvasRect(p, 8, 6, 'nw'), { x: 8, y: 6, width: 8, height: 6 });
  assert.deepEqual(canvasRect(p, 8, 6, 'center'), { x: 12, y: 9, width: 8, height: 6 });
});

test('an extended canvas adds transparent margin and moves nothing', () => {
  const p = doc();
  resizeCanvas(p, 60, 50, 'center');
  const out = renderProject(framedProject(p));
  assert.equal(out.width, 60);
  assert.equal(out.height, 50);
  assert.equal(out.data[3], 0, 'the top-left corner is new, empty canvas');
  // The document used to start at 0,0; it now starts at 10,10 and is unchanged.
  const inner = cropBuffer(out, { x: 10, y: 10, width: 40, height: 30 });
  const before = renderProject(doc());
  assert.deepEqual([...inner.data], [...before.data]);
});

test('a layer outside the frame is classified, never dropped', () => {
  const p = doc();
  const [back, mid, far] = p.layers;
  assert.equal(layerFate(back, CROP), 'clipped');
  assert.equal(layerFate(mid, CROP), 'inside');
  assert.equal(layerFate(far, CROP), 'outside');

  setFrame(p, CROP);
  const report = framingReport(p);
  assert.deepEqual(report.outside.map((l) => l.name), ['far']);
  assert.deepEqual(report.clipped.map((l) => l.name), ['back']);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /not deleted/i, 'the user must be told the pixels are still there');
  assert.equal(p.layers.length, 3, 'framing NEVER removes a layer');
});

test('a frame that contains everything reports nothing to disclose', () => {
  const p = doc();
  assert.deepEqual(framingReport(p).warnings, []);
  assert.deepEqual(framingReport(p).outside, []);
});

console.log('\nthe real export walk\n');

const FIXTURE = 'fixtures/vectors.src.psd';
const FIXTURE_SIZE = fs.statSync(FIXTURE).size;
const EXPORT_CROP = { x: 100, y: 200, width: 400, height: 300 };

const openProxy = () => loadProjectProxy(bytesOf(FIXTURE), {
  fileName: 'vectors.src.psd',
  proxyEdge: 256,
  source: { uri: FIXTURE, name: 'vectors.src.psd', size: FIXTURE_SIZE, kind: 'blob' },
});

const runExport = (project, createTarget) => exportFullRes({
  project,
  readSource: async () => bytesOf(FIXTURE),
  spill: createMemorySpill(),
  createTarget,
});

await atest('a cropped full-resolution export is the crop of the uncropped one, byte for byte', async () => {
  // Against a real PSD, through the real streaming walk -- not a stand-in for
  // it. The frame is applied per layer, inside the target, so the walk itself
  // never learns that a crop exists.
  const project = await openProxy();
  const full = await runExport(project, createJsExportTarget);
  assert.equal(full.width, 1080);

  setFrame(project, EXPORT_CROP);
  const cropped = await runExport(project, framedTarget(frameOf(project), createJsExportTarget));

  assert.equal(cropped.width, 400);
  assert.equal(cropped.height, 300);
  assert.deepEqual([...cropped.data], [...cropBuffer(full, EXPORT_CROP).data]);
});

await atest('a crop does not change which layers the walk reads, or its dimension check', async () => {
  // exportFullRes compares the FILE's dimensions against project.width/height.
  // Handing it a framed project would fail that check as SOURCE_MISMATCH, which
  // is exactly why the frame is applied in the target instead.
  const project = await openProxy();
  setFrame(project, EXPORT_CROP);
  const out = await runExport(project, framedTarget(frameOf(project), createJsExportTarget));
  assert.equal(out.width, 400);
  assert.equal(project.width, 1080, 'the project still describes the source document');
});

console.log('\none undo stack, one command model\n');

test('edit.js\'s own undo unwinds a frame command', () => {
  // The seam this closes: `undo` used to have two implementations, and a caller
  // importing edit.js's would step over a crop without applying its inverse.
  // Nobody gets that right, and it reads as "undo doesn't work sometimes".
  const project = doc();
  setFrame(project, CROP);
  assert.equal(editUndo(project), true);
  assert.equal(project.frame, null, 'edit.js must apply the frame command\'s inverse, not skip it');
  assert.equal(editRedo(project), true);
  assert.deepEqual(project.frame, CROP);
});

test('src/frame\'s undo and edit.js\'s are the same function', () => {
  assert.equal(undo, editUndo);
  assert.equal(redo, editRedo);
  assert.equal(discardTo, editDiscardTo);
});

test('edit.js\'s discardTo rolls a frame back with the layer edits around it', () => {
  const project = doc();
  const mark = project.history.length;
  setLayer(project, project.layers[0].id, { opacity: 0.5 });
  setFrame(project, CROP);
  setLayer(project, project.layers[1].id, { x: 99 });

  const revision = project.revision;
  assert.equal(editDiscardTo(project, mark), 3);
  assert.equal(project.frame, null);
  assert.equal(project.layers[0].opacity, 1);
  assert.equal(project.layers[1].x, 8);
  assert.equal(project.revision, revision + 1, 'one user action, one revision bump');
  assert.equal(project.future.length, 0);
});

test('a crop drag still coalesces into one step and holds revision still', () => {
  const project = doc();
  const key = nextGestureKey('crop');
  const revision = project.revision, mutation = project.mutation;
  for (const w of [30, 25, 20, 16]) setFrame(project, { ...CROP, width: w }, key);

  assert.equal(project.history.length, 1, 'four pointer moves, one undo step');
  assert.equal(project.revision, revision + 1, 'the sandwich cache must survive the gesture');
  assert.equal(project.mutation, mutation + 4);
  editUndo(project);
  assert.equal(project.frame, null, 'one undo unwinds the whole gesture');
});

console.log('\npersistence\n');

test('a saved project carries its frame, and reopening restores it', () => {
  const project = doc();
  setFrame(project, CROP);
  const json = JSON.parse(JSON.stringify(toProjectJson(project)));
  assert.deepEqual(json.frame, CROP, 'a crop that is not written is a crop silently lost on reopen');

  const reopened = applyProjectJson(doc(), json);
  assert.deepEqual(frameOf(reopened), CROP);
  assert.equal(isCropped(reopened), true);
  assert.ok(Object.isFrozen(reopened.frame), 'the undo entry captures it by reference');
});

test('an uncropped project writes a null frame and reopens uncropped', () => {
  const json = JSON.parse(JSON.stringify(toProjectJson(doc())));
  assert.equal(json.frame, null);
  const reopened = applyProjectJson(doc(), json);
  assert.equal(reopened.frame, null);
  assert.equal(isCropped(reopened), false);
});

test('reopening a cropped session onto an uncropped project clears nothing by accident', () => {
  // The reverse direction: a save made BEFORE the crop must un-crop the project
  // it is applied to, not leave the old frame standing.
  const saved = JSON.parse(JSON.stringify(toProjectJson(doc())));
  const target = doc();
  setFrame(target, CROP);
  applyProjectJson(target, saved);
  assert.equal(target.frame, null);
});

console.log('\ntwo sizes, one name\n');

test('canvasSize is the frame, not the source document', () => {
  const project = doc();
  assert.deepEqual(canvasSize(project), { width: 40, height: 30 });
  setFrame(project, CROP);
  assert.deepEqual(canvasSize(project), { width: 16, height: 12 });
  assert.equal(project.width, 40, 'the source document is unchanged, which is what makes the crop reversible');
});

test('fitView scales the CANVAS into the viewport, not the uncropped document', () => {
  const project = doc();
  setFrame(project, CROP);
  const viewport = { left: 0, top: 0, width: 160, height: 160 };
  const view = fitView(project, viewport, { margin: 0 });
  // 160/16 = 10 and 160/12 = 13.3; the canvas is 16x12, so 10 fits.
  assert.equal(view.docScale, 10, 'sizing to 40x30 would fit the crop at 4x and leave it tiny');
  assert.equal(view.panX, 0);
  assert.equal(view.panY, (160 - 12 * 10) / 2);
});

test('clampView keeps the CANVAS on screen', () => {
  const project = doc();
  setFrame(project, CROP);
  const viewport = { left: 0, top: 0, width: 100, height: 100 };

  // Panned far off to the left: the canvas is 16x12, so its origin may go no
  // further than `minVisible - size`. Sized to the 40x30 document those bounds
  // would be -36 and -26, and the canvas would be dragged clean off screen.
  const off = clampView({ docScale: 1, panX: -10000, panY: -10000 }, project, viewport, { minVisible: 4 });
  assert.equal(off.panX, 4 - 16);
  assert.equal(off.panY, 4 - 12);

  const far = clampView({ docScale: 1, panX: 10000, panY: 10000 }, project, viewport, { minVisible: 4 });
  assert.equal(far.panX, 96);
  assert.equal(far.panY, 96);
});

test('hitTest reads canvas coordinates, so a tap lands on the layer under it', () => {
  const project = doc();
  setFrame(project, CROP);
  // (2, 2) in the canvas is (10, 8) in the document, which is inside `mid`.
  const hit = hitTest(project, 2, 2);
  assert.ok(hit, 'a tap inside the canvas must hit something');
  assert.equal(hit.name, 'mid', 'reading the tap as a DOCUMENT point would land on `back` instead');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
