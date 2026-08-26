import assert from 'node:assert/strict';
import fs from 'fs';
import {
  layerRect, pixelRect, projectMask, downscaleMask, resampleMask,
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
