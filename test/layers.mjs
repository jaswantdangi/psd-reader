import assert from 'node:assert/strict';
import fs from 'fs';
import {
  layerRect, pixelRect, projectMask, downscaleMask, resampleMask,
  readDocument, createProject, loadProjectProxy,
  renderProject, compositeDocument, compareBuffers, flattenOnto,
  setLayer, undo, redo, nextGestureKey,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const bytesOf = (path) => new Uint8Array(fs.readFileSync(path));

/**
 * The mask implementation EXACTLY as it stood in composite.js before the move,
 * inlined here on purpose. Task 1 is a move, not a rewrite, and this is the
 * only thing that can prove it: if projectMask ever stops agreeing with this
 * byte for byte, the 21-fixture composite oracle has quietly changed meaning.
 */
function maskForOriginal(layer, rect) {
  const mask = layer.mask;
  if (!mask || !mask.imageData) return null;
  const mw = (mask.right ?? 0) - (mask.left ?? 0);
  const mh = (mask.bottom ?? 0) - (mask.top ?? 0);
  if (mw <= 0 || mh <= 0) return null;
  const fallback = mask.defaultColor ?? 0;
  const out = new Uint8Array(rect.width * rect.height).fill(fallback);
  const src = mask.imageData.data;
  for (let y = 0; y < rect.height; y++) {
    const my = rect.top + y - mask.top;
    if (my < 0 || my >= mh) continue;
    for (let x = 0; x < rect.width; x++) {
      const mx = rect.left + x - mask.left;
      if (mx < 0 || mx >= mw) continue;
      out[y * rect.width + x] = src[(my * mw + mx) * 4];
    }
  }
  return out;
}

/** A layer node carrying a 4x4 mask offset one pixel from its own bounds. */
const maskedNode = () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data[i * 4] = i * 16;   // masks are greyscale — red channel
  return {
    left: 1, top: 1, right: 5, bottom: 5,
    mask: { left: 0, top: 0, right: 4, bottom: 4, defaultColor: 200,
            imageData: { width: 4, height: 4, data } },
  };
};

console.log('\nmask projection\n');

test('layerRect derives width and height from the node bounds', () => {
  const r = layerRect({ left: -1, top: -1, right: 75, bottom: 76 });
  assert.deepEqual(r, { left: -1, top: -1, width: 76, height: 77 });
});

test('pixelRect keeps the origin but takes dimensions from the pixel buffer', () => {
  const r = pixelRect({ left: 10, top: 20 }, { width: 3, height: 7 });
  assert.deepEqual(r, { left: 10, top: 20, width: 3, height: 7 });
});

test('projectMask reproduces the compositor implementation byte for byte', () => {
  const node = maskedNode();
  const rect = layerRect(node);
  assert.deepEqual([...projectMask(node, rect)], [...maskForOriginal(node, rect)]);
});

test('projectMask fills outside the mask bounds with defaultColor', () => {
  const node = maskedNode();
  const out = projectMask(node, layerRect(node));
  // The layer starts at (1,1) and the mask ends at (4,4), so the layer's last
  // row and column fall outside the mask entirely and take defaultColor.
  assert.equal(out[3 * 4 + 3], 200, 'bottom-right corner is outside the mask');
  assert.equal(out[0], 16 * 5, 'top-left samples mask pixel (1,1)');
});

test('projectMask returns null when there is no mask raster', () => {
  assert.equal(
    projectMask({ left: 0, top: 0, right: 4, bottom: 4 }, { left: 0, top: 0, width: 4, height: 4 }),
    null,
  );
  assert.equal(
    projectMask(
      { mask: { left: 0, top: 0, right: 0, bottom: 0, imageData: { width: 0, height: 0, data: new Uint8ClampedArray(0) } } },
      { left: 0, top: 0, width: 4, height: 4 },
    ),
    null,
  );
});

test('downscaleMask takes its dimensions from the target buffer, not from a scale', () => {
  // A 10x10 mask against a target of 3x2. Any implementation that recomputed
  // round(10 * scale) would produce 3x3 and shear the mask against its layer
  // by a whole row. This is the assertion the alignment claim rests on.
  const data = new Uint8Array(100).fill(255);
  const out = downscaleMask(data, { width: 10, height: 10 }, { width: 3, height: 2 });
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.equal(out.data.length, 6);
});

test('downscaleMask box-averages rather than point-sampling', () => {
  // 2x1: fully covered beside fully clear. A point sample returns 255 or 0;
  // the average is the honest answer for a coverage plane.
  const out = downscaleMask(new Uint8Array([255, 0]), { width: 2, height: 1 }, { width: 1, height: 1 });
  assert.equal(out.data[0], 128);
});

test('downscaleMask keeps a fully covered mask fully covered', () => {
  const out = downscaleMask(new Uint8Array(64).fill(255), { width: 8, height: 8 }, { width: 3, height: 3 });
  assert.deepEqual([...out.data], new Array(9).fill(255));
});

test('downscaleMask returns the source array untouched when nothing shrinks', () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const out = downscaleMask(data, { width: 2, height: 2 }, { width: 2, height: 2 });
  assert.equal(out.data, data, 'a same-size "downscale" must not allocate');
});

test('resampleMask returns the source array itself when nothing changes size', () => {
  // The common case by a wide margin: a preview renders at proxyScale, where
  // rect.width/height already equal the proxy buffer's. Allocating a copy of
  // every mask on every frame would be pure waste.
  const mask = { width: 3, height: 2, data: new Uint8Array([0, 1, 2, 3, 4, 5]) };
  assert.equal(resampleMask(mask, 3, 2), mask.data);
});

test('resampleMask halves a mask without producing NaN or overflow', () => {
  const mask = { width: 4, height: 4, data: new Uint8Array(16).fill(120) };
  const out = resampleMask(mask, 2, 2);
  assert.equal(out.length, 4);
  for (const v of out) assert.equal(v, 120);
});

test('resampleMask upscales without leaving the 0..255 range', () => {
  const mask = { width: 2, height: 2, data: new Uint8Array([0, 255, 255, 0]) };
  const out = resampleMask(mask, 8, 8);
  assert.equal(out.length, 64);
  for (const v of out) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255, `out of range: ${v}`);
});

console.log('\nlayer model\n');

/** An eager read of the one fixture whose mask has a different origin from its layer. */
const maskedDoc = await readDocument(bytesOf('fixtures/vector-and-mask.src.psd'), { pixels: 'eager', metadata: false });
const maskedProject = createProject(maskedDoc, 'vector-and-mask.src.psd');

/** A hand-built document: one group with two leaves, one of which has no pixels. */
const grouped = () => ({
  width: 20, height: 10,
  children: [{
    name: 'Backgrounds', opacity: 0.5,
    children: [
      { name: 'Sky', left: 0, top: 0, right: 10, bottom: 10,
        proxyData: { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4) } },
      { name: 'empty', left: 0, top: 0, right: 0, bottom: 0 },
      { name: 'Clipped to sky', clipping: true, left: 0, top: 0, right: 10, bottom: 10,
        proxyData: { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4) } },
    ],
  }],
});

test('a masked layer carries its mask on the same grid as its pixels', () => {
  const layer = maskedProject.layers[0];
  assert.ok(layer.mask, 'vector-and-mask.src.psd must produce a masked layer');
  assert.equal(layer.mask.width, layer.pixels.width);
  assert.equal(layer.mask.height, layer.pixels.height);
  assert.equal(layer.mask.data.length, layer.pixels.width * layer.pixels.height);
});

test('mask.disabled is read from the file rather than assumed', () => {
  assert.equal(maskedProject.layers[0].mask.disabled, false);
});

test('clipping is carried onto the layer', () => {
  const layers = createProject(grouped(), 'grouped.psd').layers;
  assert.deepEqual(layers.map((l) => l.clipping), [false, true]);
});

test('groupPath records the groups a layer was flattened out of', () => {
  const layers = createProject(grouped(), 'grouped.psd').layers;
  assert.equal(layers[0].groupPath, 'Backgrounds');
  assert.equal(maskedProject.layers[0].groupPath, '', 'a top-level layer has no group path');
});

test('layers from a group that raised a warning are individually marked', () => {
  // The group blends at 50%, which flatten() already warns about. Without this
  // flag the warning says "somewhere in this document" and the panel cannot
  // point at the rows it is about.
  const project = createProject(grouped(), 'grouped.psd');
  assert.ok(project.warnings.some((w) => /Backgrounds/.test(w)));
  assert.deepEqual(project.layers.map((l) => l.groupWarned), [true, true]);
});

test('createProject counts the leaves flatten() dropped', () => {
  // Without this the "empty document" state is blank and inexplicable: every
  // leaf was pixel-less, and the screen can say so only if it knows how many.
  assert.equal(createProject(grouped(), 'grouped.psd').skippedLeaves, 1);
});

console.log('\nproxy masks\n');

let startInfo = null;
const progressTotals = [];
const proxyMasked = await loadProjectProxy(bytesOf('fixtures/vector-and-mask.src.psd'), {
  fileName: 'vector-and-mask.src.psd',
  proxyEdge: 48,                       // 101x98 document, so this really downscales
  onStart: (info) => { startInfo = info; },
  onProgress: (decoded, total) => { progressTotals.push([decoded, total]); },
});

test('a streamed masked load keeps the mask on the proxy pixel grid', () => {
  const layer = proxyMasked.layers[0];
  assert.ok(layer.mask, 'the mask was dropped by the streamed path');
  assert.equal(layer.mask.width, layer.pixels.width);
  assert.equal(layer.mask.height, layer.pixels.height);
  assert.ok(layer.pixels.width < layer.sourceW, 'proxyEdge 48 must actually downscale');
});

test('the proxy mask is one byte per pixel, not four', () => {
  // The whole memory argument. Sixty full-canvas masked layers at RGBA would
  // be ~189 MB of channels holding the same value.
  const layer = proxyMasked.layers[0];
  assert.ok(layer.mask.data instanceof Uint8Array);
  assert.equal(layer.mask.data.length, layer.mask.width * layer.mask.height);
});

test('onStart reports the leaf count before any layer is decoded', () => {
  assert.ok(startInfo, 'onStart never fired');
  assert.equal(startInfo.layers, 1, 'vector-and-mask.src.psd has one leaf');
  assert.equal(startInfo.width, 101);
});

test('onProgress reports the total alongside the running count', () => {
  // A determinate bar needs both numbers. Reporting only `decoded` is what
  // makes a 20-second wait indistinguishable from a hang.
  assert.deepEqual(progressTotals, [[1, 1]]);
});

console.log('\nmasked rendering\n');

/** renderProject against the compositor, which is the pixel-validated oracle. */
const oracle = async (file) => {
  const doc = await readDocument(bytesOf('fixtures/' + file), { pixels: 'eager', metadata: false });
  const ours = renderProject(createProject(doc, file), { scale: 1 });
  const theirs = compositeDocument(doc);
  return compareBuffers(flattenOnto(ours), flattenOnto(theirs));
};

const vectorAndMask = await oracle('vector-and-mask.src.psd');
const booleanOp = await oracle('boolean.src.psd');
const gradient = await oracle('gradient.src.psd');

test('a mask whose origin differs from its layer renders exactly as the inspector does', () => {
  // THE assertion the whole mask ruling stands on. Before this task the fixture
  // differed on 855 of 9898 pixels beyond rounding (8.64%) with a max channel
  // delta of 255 -- the mask simply was not applied. The layer sits at [-1,-1]
  // and its mask at [0,0], so this is also the alignment case: get the
  // reprojection offset wrong and a one-pixel shear survives here.
  assert.equal(vectorAndMask.beyondRounding, 0,
    `expected an exact match, got ${vectorAndMask.beyondRounding} of ${vectorAndMask.total}`);
  assert.equal(vectorAndMask.maxDelta, 0);
});

test('a rasterised vector mask renders exactly as the inspector does', () => {
  // 166 of 90000 pixels wrong before this task, max channel delta 57.
  assert.equal(booleanOp.beyondRounding, 0,
    `expected an exact match, got ${booleanOp.beyondRounding} of ${booleanOp.total}`);
});

test('a fully opaque mask still renders exactly (regression guard only)', () => {
  // gradient.src.psd was already at 0 before the mask work, because its mask is
  // fully opaque inside the layer bounds. This can prove the change did no
  // HARM. It is not evidence that masks work -- do not quote it as such.
  assert.equal(gradient.beyondRounding, 0);
});

test('a disabled mask is not applied', () => {
  // Photoshop saves masks that are switched off. Applying one is wrong in the
  // opposite direction from ignoring an enabled one, and just as invisible.
  const node = (disabled) => ({
    width: 4, height: 4,
    children: [{
      name: 'masked', left: 0, top: 0, right: 4, bottom: 4,
      proxyData: { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) },
      proxyMask: new Uint8Array(16),          // fully masked out
      mask: { disabled },
    }],
  });
  const off = renderProject(createProject(node(true), 'x.psd'), { scale: 1 });
  const on = renderProject(createProject(node(false), 'x.psd'), { scale: 1 });
  assert.equal(off.data[3], 255, 'a disabled mask must leave the layer fully drawn');
  assert.equal(on.data[3], 0, 'an enabled all-zero mask must erase the layer');
});

test('at proxyScale the mask needs no resampling at all', () => {
  // Documents the fast path rather than correctness: when the render scale IS
  // the proxy scale, rect dimensions equal the proxy grid, so resampleMask's
  // identity early-return fires and no mask is copied per frame. If this ever
  // fails, resampleMask still renders correctly -- it just costs an allocation.
  const layer = proxyMasked.layers[0];
  const rectWidth = Math.max(1, Math.round(layer.w * proxyMasked.proxyScale));
  assert.equal(rectWidth, layer.pixels.width);
  assert.equal(resampleMask(layer.mask, rectWidth, layer.pixels.height), layer.mask.data);
});

console.log('\ndocument warnings\n');

/** Four leaves, three of them vector-masked with no mask raster at all. */
const vectorsDoc = await readDocument(bytesOf('fixtures/vectors.src.psd'), { pixels: 'eager', metadata: false });

test('the reader\'s own warnings reach the project', () => {
  // createProject took a doc and ignored a field on it. Every fixture carries
  // the Patt pattern warning, and until now the editor could not surface it.
  const project = createProject(maskedDoc, 'vector-and-mask.src.psd');
  assert.ok(maskedDoc.warnings.length > 0, 'fixture must carry reader warnings');
  for (const w of maskedDoc.warnings) assert.ok(project.warnings.includes(w), `dropped: ${w}`);
});

test('clipped layers raise a warning that says clipping is not applied', () => {
  const project = createProject(grouped(), 'grouped.psd');
  const w = project.warnings.find((x) => /clipped/i.test(x));
  assert.ok(w, 'a clipped layer must raise a document warning');
  assert.match(w, /1 layer/);
  assert.match(w, /not applied/i);
});

test('a document with nothing clipped raises no clipping warning', () => {
  const project = createProject(maskedDoc, 'vector-and-mask.src.psd');
  assert.equal(project.warnings.some((x) => /clipped/i.test(x)), false);
});

test('vector masks with no raster are counted and warned about', () => {
  // Those three layers render UNMASKED, everywhere, silently — until now.
  const w = createProject(vectorsDoc, 'vectors.src.psd').warnings.find((x) => /vector mask/i.test(x));
  assert.ok(w, 'a vector-masked layer must raise a document warning');
  assert.match(w, /3 layers/);
});

console.log('\ncommands and counters\n');

const draggable = () => createProject(grouped(), 'grouped.psd');

test('nextGestureKey mints a distinct key on every call', () => {
  const a = nextGestureKey('xform');
  const b = nextGestureKey('xform');
  assert.notEqual(a, b);
  assert.match(a, /^xform#\d+$/);
});

test('one gesture key collapses a whole drag into one undo entry', () => {
  const project = draggable();
  const id = project.layers[0].id;
  const key = nextGestureKey('xform');
  for (let x = 1; x <= 20; x++) setLayer(project, id, { x }, key);
  assert.equal(project.history.length, 1);
  assert.equal(project.layers[0].x, 20);
  undo(project);
  assert.equal(project.layers[0].x, 0, 'one drag must undo in one step');
});

test('two gestures are two undo entries, even on the same layer and field', () => {
  // The bug a literal coalesce key produces: two drags minutes apart merge into
  // one entry, and the first one becomes unreachable.
  const project = draggable();
  const id = project.layers[0].id;
  setLayer(project, id, { x: 10 }, nextGestureKey('xform'));
  setLayer(project, id, { x: 20 }, nextGestureKey('xform'));
  assert.equal(project.history.length, 2);
});

test('mutation advances on the coalesced frames of a drag', () => {
  const project = draggable();
  const id = project.layers[0].id;
  const key = nextGestureKey('xform');
  setLayer(project, id, { x: 1 }, key);
  const after = project.mutation;
  setLayer(project, id, { x: 2 }, key);
  assert.equal(project.mutation, after + 1, 'a coalesced frame still changed pixels');
});

test('revision does NOT advance on the coalesced frames of a drag', () => {
  // Load-bearing, and the reason there are two counters. sandwich.js:107 keys
  // its drag cache on `revision`; bumping it here would rebuild `below` and
  // `above` on every frame and delete the cache's entire purpose.
  const project = draggable();
  const id = project.layers[0].id;
  const key = nextGestureKey('xform');
  setLayer(project, id, { x: 1 }, key);
  const after = project.revision;
  setLayer(project, id, { x: 2 }, key);
  assert.equal(project.revision, after, 'the sandwich cache must survive a gesture');
});

test('mutation advances on undo and on redo', () => {
  const project = draggable();
  setLayer(project, project.layers[0].id, { x: 5 });
  const afterCommit = project.mutation;
  undo(project);
  assert.equal(project.mutation, afterCommit + 1);
  redo(project);
  assert.equal(project.mutation, afterCommit + 2);
});

const textDoc = await readDocument(bytesOf('fixtures/text.src.psd'), { pixels: 'eager', metadata: false });

test('resizing a text layer switches it to live rendering without the caller saying so', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  assert.ok(layer, 'text.src.psd must contain a text layer');
  assert.equal(layer.rerendered, false, 'should start on Photoshop pixels');
  setLayer(project, layer.id, { w: layer.w * 3, h: layer.h * 3 }, nextGestureKey('xform'));
  assert.equal(layer.rerendered, true, 'upscaling a text bitmap can only blur it');
});

test('resizing a raster layer leaves it on its own pixels', () => {
  const project = draggable();
  const layer = project.layers[0];
  setLayer(project, layer.id, { w: 40, h: 40 }, nextGestureKey('xform'));
  assert.equal(layer.rerendered, false);
});

test('undo restores the previous rerendered state', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  setLayer(project, layer.id, { w: layer.w * 3 }, nextGestureKey('xform'));
  undo(project);
  assert.equal(layer.rerendered, false, 'undo must return the layer to Photoshop pixels');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
