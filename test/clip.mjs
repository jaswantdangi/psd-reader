/**
 * Clipping masks: the editor's renderer against the compositor's.
 *
 * `src/composite.js` has rendered clipping since it was written; `src/render.js`
 * ignored it. So a document with one clip run looked one way in the read-only
 * inspector and another in the editor -- in preview and in export -- and
 * nothing on screen said which was Photoshop's.
 *
 * NO FIXTURE IN `fixtures/` CONTAINS A CLIPPED LAYER. That was checked before
 * anything here was written: ag-psd reports `clipping` on all 82 nodes of all
 * 21 files and it is `false` on every one of them. So the documents below are
 * hand-built, and they are hand-built to be MEAN -- partial alpha on the base,
 * non-normal modes and sub-1 opacity inside the run, a mask on a clipped layer,
 * a run at the very bottom of the stack with no base under it.
 *
 * The oracle is `compositeDocument`, which is the same one the 21-fixture
 * accuracy table has always used. `percentReal === 0` is the bar the mask fix
 * cleared on `vector-and-mask.src.psd` (855 wrong pixels -> 0), and it is the
 * bar here.
 */
import assert from 'node:assert/strict';
import {
  compositeDocument, compareBuffers, flattenOnto,
  createProject, renderProject, reorderLayer, undo, redo,
  toProjectJson, applyProjectJson,
  clipAlphaMap, clipRunStart, clipRunEnd,
  createSandwichCache, renderSandwiched, sandwichStateFor,
  SANDWICH_FLAT_ABOVE, SANDWICH_BELOW_ONLY,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// ---------------------------------------------------------------- documents

const W = 48, H = 48;

/** RGBA of exactly `w x h`, filled by a per-pixel function returning [r,g,b,a]. */
function raster(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  return { width: w, height: h, data };
}

/** A leaf node in the shape `readDocument({ pixels: 'eager' })` produces. */
const leaf = (name, [left, top, right, bottom], fn, extra = {}) => ({
  name, left, top, right, bottom,
  imageData: raster(right - left, bottom - top, fn),
  ...extra,
});

/** A greyscale mask node on its own bounds, as ag-psd reports one. */
const maskOf = ([left, top, right, bottom], fn) => ({
  left, top, right, bottom, defaultColor: 0,
  imageData: raster(right - left, bottom - top, (x, y) => { const v = fn(x, y); return [v, v, v, 255]; }),
});

/** Opaque flat colour. */
const flat = (r, g, b) => () => [r, g, b, 255];

/**
 * A soft-edged disc. The point is PARTIAL ALPHA on the base: a hard-edged base
 * would make the clip a binary stencil, and every rounding difference between
 * the two implementations would cancel instead of showing up.
 */
const disc = (r, g, b, cx, cy, radius) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return [r, g, b, Math.max(0, Math.min(255, Math.round((radius - d) * 96)))];
};

/** A diagonal ramp, so a clipped layer differs from its base at every pixel. */
const ramp = (r, g, b) => (x, y) => [r, g, b, Math.min(255, (x + y) * 5)];

/**
 * The main document: backdrop, a soft base, two clipped layers on it, a plain
 * layer above the run, and a second independent run higher up.
 */
const clippedDoc = () => ({
  width: W, height: H,
  children: [
    leaf('backdrop', [0, 0, W, H], (x, y) => [30 + x * 2, 60, 200 - y, 255]),
    leaf('base', [6, 6, 38, 38], disc(240, 120, 40, 16, 16, 15)),
    leaf('clip A', [14, 2, 46, 34], ramp(20, 220, 90),
      { clipping: true, opacity: 0.8, blendMode: 'multiply' }),
    leaf('clip B', [0, 12, 40, 44], (x, y) => [200, 40 + y * 3, 255, 220],
      { clipping: true, blendMode: 'screen', mask: maskOf([2, 10, 42, 46], (x, y) => (x * 6 + y * 3) % 256) }),
    leaf('over', [20, 20, 44, 44], flat(255, 255, 0)),
    leaf('base 2', [4, 24, 30, 46], disc(10, 30, 210, 13, 11, 12), { opacity: 0.6, blendMode: 'overlay' }),
    leaf('clip C', [0, 20, W, H], ramp(255, 255, 255), { clipping: true }),
  ],
});

/**
 * A run that starts at the BOTTOM of the stack. The lowest member has nothing
 * under it, so it is its own base and draws unclipped; the one above it clips
 * to that. Photoshop does the same, and so has the compositor.
 */
const orphanRunDoc = () => ({
  width: W, height: H,
  children: [
    leaf('orphan', [4, 4, 40, 40], disc(220, 30, 30, 18, 18, 17), { clipping: true }),
    leaf('also clipped', [10, 10, 46, 46], ramp(0, 120, 255), { clipping: true }),
    leaf('plain', [0, 0, 24, 24], flat(60, 60, 60)),
  ],
});

/** A hidden base takes its whole run with it — the compositor has always done this. */
const hiddenBaseDoc = () => ({
  width: W, height: H,
  children: [
    leaf('backdrop', [0, 0, W, H], flat(90, 90, 90)),
    leaf('base', [6, 6, 38, 38], disc(240, 120, 40, 16, 16, 15), { hidden: true }),
    leaf('clip', [0, 0, W, H], ramp(255, 0, 0), { clipping: true }),
    leaf('top', [30, 30, 46, 46], flat(0, 255, 255)),
  ],
});

/** A hidden layer INSIDE a run is skipped; the rest of the run still clips. */
const hiddenMemberDoc = () => ({
  width: W, height: H,
  children: [
    leaf('backdrop', [0, 0, W, H], flat(90, 90, 90)),
    leaf('base', [6, 6, 38, 38], disc(240, 120, 40, 16, 16, 15)),
    leaf('clip hidden', [0, 0, W, H], flat(255, 0, 0), { clipping: true, hidden: true }),
    leaf('clip shown', [8, 8, 40, 40], ramp(0, 255, 0), { clipping: true }),
  ],
});

/** Every difference against the compositor, flattened so invisible RGB cannot count. */
const divergence = (doc, tolerance = 1) => {
  const project = createProject(doc, 'synthetic.psd');
  return compareBuffers(
    flattenOnto(compositeDocument(doc)),
    flattenOnto(renderProject(project, { scale: 1 })),
    tolerance);
};

const shouldMatch = (name, doc) => test(name, () => {
  const stat = divergence(doc);
  assert.equal(stat.comparable, true, stat.reason);
  assert.equal(stat.percentReal, 0,
    `${stat.beyondRounding} of ${stat.total} px differ beyond rounding ` +
    `(maxDelta ${stat.maxDelta}, meanDelta ${stat.meanDelta.toFixed(2)})`);
});

console.log('\nclipping: the editor renderer against the compositor\n');

shouldMatch('two clipped layers on a soft base, then a second run above', clippedDoc());
shouldMatch('a run at the bottom of the stack uses its lowest member as the base', orphanRunDoc());
shouldMatch('a hidden base takes its whole run with it', hiddenBaseDoc());
shouldMatch('a hidden member of a run is skipped, the rest still clips', hiddenMemberDoc());

console.log('\nthe ported pieces, pinned against the originals\n');

/**
 * `alphaMap` EXACTLY as it stands in src/composite.js, inlined here on purpose.
 *
 * render.js could not import it -- composite.js does not export it -- so the
 * clip alpha plane is a PORT, and a port is only a port for as long as someone
 * checks. This is the same device test/layers.mjs uses to keep `projectMask`
 * honest against the compositor it was lifted out of: if the two ever stop
 * agreeing byte for byte, the 21-fixture oracle has quietly changed meaning and
 * the end-to-end comparison above would still pass on documents that happen not
 * to exercise the difference.
 */
function alphaMapOriginal(width, height, rect, pixels, mask, opacity) {
  const map = new Uint8Array(width * height);
  const x1 = Math.min(width, rect.left + rect.width);
  const y1 = Math.min(height, rect.top + rect.height);
  for (let y = Math.max(0, rect.top); y < y1; y++) {
    for (let x = Math.max(0, rect.left); x < x1; x++) {
      const si = ((y - rect.top) * rect.width + (x - rect.left)) * 4;
      let a = pixels[si + 3] * opacity;
      if (mask) a *= mask[(y - rect.top) * rect.width + (x - rect.left)] / 255;
      map[y * width + x] = a;
    }
  }
  return map;
}

test('the clip alpha plane reproduces the compositor implementation byte for byte', () => {
  // Deterministic pseudo-random, so a failure is reproducible. Rects that hang
  // off every edge are in the list because that is where the two loops' clamps
  // could differ and the end-to-end test would not notice.
  let seed = 20260903;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rects = [
    { left: 0, top: 0, width: 16, height: 16 },
    { left: -5, top: -7, width: 20, height: 20 },
    { left: 30, top: 30, width: 40, height: 40 },
    { left: 7, top: 3, width: 1, height: 1 },
  ];
  for (const rect of rects)
    for (const withMask of [false, true])
      for (const opacity of [1, 0.5, 0.37]) {
        const pixels = new Uint8ClampedArray(rect.width * rect.height * 4);
        for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(rnd() * 256);
        const mask = withMask
          ? Uint8Array.from({ length: rect.width * rect.height }, () => Math.floor(rnd() * 256))
          : null;
        assert.deepEqual(
          [...clipAlphaMap(new Uint8Array(W * H), W, H, rect, pixels, mask, opacity)],
          [...alphaMapOriginal(W, H, rect, pixels, mask, opacity)],
          `rect ${JSON.stringify(rect)} mask ${withMask} opacity ${opacity}`);
      }
});

test('run bounds are read off the current order, never stored', () => {
  const layers = [{}, {}, { clipping: true }, { clipping: true }, {}, { clipping: true }];
  // start: the base of the run containing i; end: one past its last member.
  assert.deepEqual(layers.map((_, i) => clipRunStart(layers, i)), [0, 1, 1, 1, 4, 4]);
  assert.deepEqual(layers.map((_, i) => clipRunEnd(layers, i)), [1, 4, 4, 4, 6, 6]);
});

test('a run reaching the bottom of the stack has its lowest member as the base', () => {
  const layers = [{ clipping: true }, { clipping: true }, {}];
  assert.equal(clipRunStart(layers, 1), 0, 'index 0 cannot clip to anything, so it IS the base');
  assert.equal(clipRunEnd(layers, 0), 2);
});

console.log(`\n${passed} passed`);
