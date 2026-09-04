/**
 * src/segment/ -- the pure pixel operations.
 *
 * SCOPE. This file tests ONLY `src/segment/mask-ops.js` and
 * `src/segment/refine.js`, imported directly rather than through `src/index.js`
 * or `src/segment/index.js`. `cutout.js`, `models.js`, `edge.js` and both
 * barrels are being edited in another session; a test that imports them pins a
 * moving target, so `resampleLogits`, `buildCutout`, `applyCutout`, `paintMask`,
 * `clearCutout` and `setMaskEdge` are deliberately left untested here.
 * `resampleLogits` in particular lives in `cutout.js`, not in either file below.
 *
 * Everything here is a property or an identity rather than a golden number. A
 * golden value copied out of today's output pins whatever the code currently
 * does, bug included; `invert(invert(m)) === m` names exactly what broke.
 */

import assert from 'node:assert/strict';
import {
  fullMask, emptyMask, MASK_MODES, combineMask, invertMask,
  boxBlur, featherMask, stampBrush, stampInto, strokeMask,
  isOpaque, cutFraction,
} from '../src/segment/mask-ops.js';
import { guidedRefine, decontaminate, refineCutout } from '../src/segment/refine.js';

let passed = 0;
/** Synchronous by design -- an async body would report a failure as a pass. */
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

/** A coverage plane built from a per-pixel function. */
const plane = (w, h, fn) => {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = fn(x, y) & 255;
  return m;
};

/** An RGBA image built from a per-pixel function returning [r,g,b,a]. */
const image = (w, h, fn) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  return { width: w, height: h, data };
};

/** A deterministic pseudo-random plane -- same bytes on every run, no seed library. */
const noisePlane = (w, h) => plane(w, h, (x, y) => (x * 73 + y * 151 + ((x * y) & 31)) * 7);

const copyOf = (a) => (a instanceof Float32Array ? Float32Array.from(a) : Uint8Array.from(a));
const same = (a, b) => assert.deepEqual([...a], [...b]);

// ---------------------------------------------------------------------------
console.log('\nthe two constant planes\n');

test('fullMask is 255 everywhere and emptyMask is 0 everywhere, at every shape', () => {
  for (const [w, h] of [[1, 1], [1, 9], [9, 1], [4, 4], [17, 3]]) {
    const full = fullMask(w, h);
    const none = emptyMask(w, h);
    assert.equal(full.length, w * h, `full ${w}x${h} length`);
    assert.equal(none.length, w * h, `empty ${w}x${h} length`);
    assert.ok(full instanceof Uint8Array && none instanceof Uint8Array);
    for (let i = 0; i < w * h; i++) {
      assert.equal(full[i], 255, `full ${w}x${h} at ${i}`);
      assert.equal(none[i], 0, `empty ${w}x${h} at ${i}`);
    }
  }
});

test('a zero-area plane is a zero-length plane, not a throw', () => {
  // A degenerate layer must not take out the whole cut-out path with a
  // RangeError from `new Uint8Array(-0)`.
  for (const [w, h] of [[0, 0], [0, 8], [8, 0]]) {
    assert.equal(fullMask(w, h).length, 0, `full ${w}x${h}`);
    assert.equal(emptyMask(w, h).length, 0, `empty ${w}x${h}`);
  }
});

test('each call allocates a FRESH buffer, never a shared constant', () => {
  // Two layers masked "select all" must not end up sharing one plane; the
  // second one's brush stroke would appear on the first.
  const a = fullMask(4, 4);
  const b = fullMask(4, 4);
  assert.notEqual(a, b);
  a[0] = 0;
  assert.equal(b[0], 255, 'writing to one plane changed the other');
  assert.notEqual(a.buffer, b.buffer);
});

// ---------------------------------------------------------------------------
console.log('\ncombineMask\n');

test('MASK_MODES lists exactly four modes and every one is distinguishable', () => {
  // Not four labels -- four behaviours. The implementation is a ternary chain,
  // so a mode that fell through to a neighbour would still "work" and would
  // silently do the wrong thing to the user's selection.
  assert.deepEqual([...MASK_MODES], ['replace', 'add', 'subtract', 'intersect']);
  const seen = new Set();
  for (const mode of MASK_MODES) {
    const lo = combineMask(new Uint8Array([100]), new Uint8Array([200]), mode)[0];
    const hi = combineMask(new Uint8Array([200]), new Uint8Array([100]), mode)[0];
    seen.add(`${lo}/${hi}`);
  }
  assert.equal(seen.size, 4, `two modes behave identically: ${[...seen].join(' ')}`);
});

test('each mode computes the operation its name claims, over the whole byte range', () => {
  const base = plane(16, 16, (x, y) => x * 17 + y);
  const patch = plane(16, 16, (x, y) => 255 - (y * 17 + x));
  const expect = {
    replace: (a, b) => b,
    add: (a, b) => Math.max(a, b),
    subtract: (a, b) => Math.min(a, 255 - b),
    intersect: (a, b) => Math.min(a, b),
  };
  for (const mode of MASK_MODES) {
    const out = combineMask(base, patch, mode);
    for (let i = 0; i < base.length; i++)
      assert.equal(out[i], expect[mode](base[i], patch[i]), `${mode} at ${i}`);
  }
});

test('the default mode is replace', () => {
  const base = noisePlane(8, 8);
  const patch = invertMask(base);
  same(combineMask(base, patch), patch);
  same(combineMask(base, patch), combineMask(base, patch, 'replace'));
});

test('the identity element of EACH mode leaves the base untouched, byte for byte', () => {
  // The identity that matters at the call site: a refiner that found nothing,
  // or a brush that painted nothing, must not alter the mask already on the
  // layer. One of these per mode, so a failure names the mode.
  const base = noisePlane(12, 7);
  const none = emptyMask(12, 7);
  const all = fullMask(12, 7);
  same(combineMask(base, none, 'add'), base);          // max(a, 0) = a
  same(combineMask(base, none, 'subtract'), base);     // min(a, 255) = a
  same(combineMask(base, all, 'intersect'), base);     // min(a, 255) = a
  same(combineMask(base, base, 'replace'), base);      // replace's identity is itself
});

test('the ANNIHILATOR of each mode is the plane its name implies', () => {
  const base = noisePlane(12, 7);
  const none = emptyMask(12, 7);
  const all = fullMask(12, 7);
  same(combineMask(base, all, 'add'), all);            // adding everything selects everything
  same(combineMask(base, all, 'subtract'), none);      // subtracting everything selects nothing
  same(combineMask(base, none, 'intersect'), none);
});

test('add and intersect are idempotent and commutative; the base survives either way', () => {
  const a = noisePlane(9, 9);
  const b = plane(9, 9, (x, y) => (x + y) * 13);
  for (const mode of ['add', 'intersect']) {
    same(combineMask(a, a, mode), a);                                  // idempotent
    same(combineMask(a, b, mode), combineMask(b, a, mode));            // commutative
    same(combineMask(combineMask(a, b, mode), b, mode),
         combineMask(a, b, mode));                                     // absorbing
  }
});

test('subtract is add-of-the-inverse under intersect -- the two agree exactly', () => {
  // min(a, 255-b) is "intersect with the inverse of the patch". Pinning the
  // algebra rather than the expression means a rewrite of one has to keep
  // agreeing with the other.
  const a = noisePlane(11, 5);
  const b = plane(11, 5, (x, y) => x * 23 + y * 3);
  same(combineMask(a, b, 'subtract'), combineMask(a, invertMask(b), 'intersect'));
});

test('no mode can ever push a soft overlap past 255 into a hard line', () => {
  // The reason the file uses max/min rather than additive arithmetic. Two soft
  // edges at 200 each would sum to 400 and clip flat; max keeps 200.
  const a = plane(8, 8, () => 200);
  const b = plane(8, 8, () => 200);
  for (const mode of MASK_MODES) {
    const out = combineMask(a, b, mode);
    for (let i = 0; i < out.length; i++)
      assert.ok(out[i] >= 0 && out[i] <= 255, `${mode} at ${i} -> ${out[i]}`);
  }
  assert.equal(combineMask(a, b, 'add')[0], 200, 'add clipped a soft overlap to a hard edge');
});

test('a size mismatch THROWS rather than masking a sheared region', () => {
  assert.throws(() => combineMask(emptyMask(4, 4), emptyMask(4, 3), 'add'), /mismatch/);
  assert.throws(() => combineMask(emptyMask(4, 3), emptyMask(4, 4)), /mismatch/);
});

test('combineMask returns a fresh plane and mutates NEITHER argument', () => {
  const base = noisePlane(8, 8);
  const patch = noisePlane(8, 8).map((v) => 255 - v);
  const baseBefore = copyOf(base);
  const patchBefore = copyOf(patch);
  for (const mode of MASK_MODES) {
    const out = combineMask(base, patch, mode);
    assert.notEqual(out, base);
    assert.notEqual(out, patch);
    same(base, baseBefore);
    same(patch, patchBefore);
  }
});

test('zero-length planes combine to a zero-length plane under every mode', () => {
  for (const mode of MASK_MODES)
    assert.equal(combineMask(new Uint8Array(0), new Uint8Array(0), mode).length, 0, mode);
});

test('an unrecognised mode throws instead of quietly intersecting', () => {
  // Was a FINDING, now fixed. The ternary chain used to end in the intersect
  // branch with no guard, so a typo'd or future mode string neither threw nor
  // fell back to `replace` -- it INTERSECTED, which for a fresh selection over
  // an empty mask yields nothing at all and reads to the user as "the tool did
  // not work". Failing closed is the only one of the three that cannot be
  // mistaken for a working tool.
  const base = plane(4, 1, (x) => x * 60);
  const patch = plane(4, 1, () => 128);
  assert.throws(() => combineMask(base, patch, 'ADD'), /unknown mask mode/);
  assert.throws(() => combineMask(base, patch, 'union'), /unknown mask mode/);
  assert.throws(() => combineMask(base, patch, null), /unknown mask mode/);
  // undefined is still the parameter default, which is a legitimate call.
  same(combineMask(base, patch, undefined), combineMask(base, patch, 'replace'),
    'an explicit undefined still takes the parameter default');
  for (const mode of MASK_MODES)
    assert.doesNotThrow(() => combineMask(base, patch, mode), mode);
});

// ---------------------------------------------------------------------------
console.log('\ninvertMask\n');

test('inverting twice is the identity, on every byte value 0..255', () => {
  const m = plane(16, 16, (x, y) => y * 16 + x);         // every value exactly once
  same(invertMask(invertMask(m)), m);
});

test('invert maps the endpoints to each other and is its own mirror', () => {
  same(invertMask(fullMask(6, 6)), emptyMask(6, 6));
  same(invertMask(emptyMask(6, 6)), fullMask(6, 6));
  const m = noisePlane(7, 7);
  const inv = invertMask(m);
  for (let i = 0; i < m.length; i++) assert.equal(m[i] + inv[i], 255, `at ${i}`);
});

test('invert returns a fresh plane and does not mutate its input', () => {
  const m = noisePlane(5, 5);
  const before = copyOf(m);
  const out = invertMask(m);
  assert.notEqual(out, m);
  assert.notEqual(out.buffer, m.buffer);
  same(m, before);
});

test('inverting a zero-length plane gives a zero-length plane', () => {
  assert.equal(invertMask(new Uint8Array(0)).length, 0);
});

// ---------------------------------------------------------------------------
console.log('\nboxBlur\n');

test('a constant plane blurs to the SAME constant -- no edge darkening anywhere', () => {
  // The whole point of seeding the running sum with the clamped edge. If the
  // window were zero-padded, every border pixel would come out darker than its
  // neighbour purely for being at the boundary, and featherMask would eat a
  // rim off every mask in the document.
  for (const [w, h] of [[1, 1], [1, 12], [12, 1], [9, 7], [16, 16]])
    for (const radius of [1, 2, 5, 40]) {
      const out = boxBlur(plane(w, h, () => 200), w, h, radius);
      for (let i = 0; i < w * h; i++)
        assert.ok(Math.abs(out[i] - 200) < 1e-3, `${w}x${h} r${radius} at ${i} -> ${out[i]}`);
    }
});

test('a radius below 1 is a copy, not the input, and not a blur', () => {
  const src = noisePlane(8, 8);
  for (const radius of [0, 0.4, -3]) {
    const out = boxBlur(src, 8, 8, radius);
    assert.ok(out instanceof Float32Array, `r${radius} must still return Float32`);
    assert.notEqual(out.buffer, src.buffer, `r${radius} aliased its input`);
    for (let i = 0; i < src.length; i++) assert.equal(out[i], src[i], `r${radius} at ${i}`);
  }
});

test('the output never leaves the input\'s own min..max envelope', () => {
  // An average cannot exceed its extremes. A window index that ran off the row
  // and picked up the next row's bytes would break exactly this.
  const src = noisePlane(13, 11);
  let lo = 255, hi = 0;
  for (const v of src) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const radius of [1, 3, 6]) {
    const out = boxBlur(src, 13, 11, radius);
    for (let i = 0; i < out.length; i++)
      assert.ok(out[i] >= lo - 1e-4 && out[i] <= hi + 1e-4, `r${radius} at ${i} -> ${out[i]}`);
  }
});

test('a single bright pixel spreads only within the radius, and never wraps a row', () => {
  // The classic off-by-one in a separable blur is a horizontal window that
  // crosses the row boundary; it shows up as a smear appearing on the far side
  // of the image, one row down.
  const w = 16, h = 16, radius = 2;
  const src = plane(w, h, (x, y) => (x === 0 && y === 8 ? 255 : 0));
  const out = boxBlur(src, w, h, radius);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const reachable = Math.abs(y - 8) <= radius && x <= radius;
      if (!reachable)
        assert.equal(out[y * w + x], 0, `leaked to (${x},${y}) -> ${out[y * w + x]}`);
    }
  assert.ok(out[8 * w + 0] > 0, 'the pixel itself vanished');
  assert.ok(out[8 * w + 15] === 0, 'the left edge wrapped to the right edge');
});

test('total mass is preserved away from the edges', () => {
  // Sum in equals sum out for an impulse placed far enough from every border
  // that no clamped duplication happens. This is the strongest single check on
  // the running-sum bookkeeping.
  const w = 21, h = 21, radius = 3;
  const src = plane(w, h, (x, y) => (x === 10 && y === 10 ? 255 : 0));
  const out = boxBlur(src, w, h, radius);
  let sum = 0;
  for (const v of out) sum += v;
  assert.ok(Math.abs(sum - 255) < 1e-2, `mass ${sum}, expected 255`);
});

test('boxBlur does not mutate its source, for either input type', () => {
  const u8 = noisePlane(8, 8);
  const u8Before = copyOf(u8);
  boxBlur(u8, 8, 8, 3);
  same(u8, u8Before);

  const f32 = Float32Array.from(u8, (v) => v / 255);
  const f32Before = copyOf(f32);
  boxBlur(f32, 8, 8, 3);
  same(f32, f32Before);
});

// ---------------------------------------------------------------------------
console.log('\nfeatherMask\n');

test('radius below 1 is a byte-identical COPY -- a no-op that is still a fresh buffer', () => {
  // The no-op has to allocate anyway: the previous mask is held by an undo
  // entry, so handing the same object back would let the next stroke rewrite
  // history rather than add to it.
  const src = noisePlane(10, 6);
  for (const radius of [0, 0.9, -2]) {
    const out = featherMask(src, 10, 6, radius);
    assert.notEqual(out, src, `r${radius} returned its input`);
    assert.notEqual(out.buffer, src.buffer, `r${radius} aliased its input`);
    same(out, src);
  }
});

test('feathering a solid plane changes nothing -- no rim eaten off any edge', () => {
  for (const [w, h] of [[1, 1], [1, 10], [10, 1], [8, 8]])
    for (const radius of [1, 3, 25]) {
      same(featherMask(fullMask(w, h), w, h, radius), fullMask(w, h));
      same(featherMask(emptyMask(w, h), w, h, radius), emptyMask(w, h));
    }
});

test('a step edge feathers into a MONOTONIC ramp, never an overshoot', () => {
  // "Does not crash" is not the property. A soft edge that is not monotonic has
  // a bright or dark line in it, which is exactly what a feather is meant to
  // remove.
  const w = 24, h = 1, radius = 4;
  const step = plane(w, h, (x) => (x < 12 ? 0 : 255));
  const out = featherMask(step, w, h, radius);
  for (let x = 1; x < w; x++)
    assert.ok(out[x] >= out[x - 1], `not monotonic at x=${x}: ${out[x - 1]} -> ${out[x]}`);
  assert.equal(out[0], 0, 'the far side of the ramp must stay fully cut');
  assert.equal(out[w - 1], 255, 'the near side of the ramp must stay fully covered');
  assert.ok(out[11] > 0 && out[12] < 255, 'the edge never actually softened');
});

test('the ramp is symmetric about the step, so the edge does not migrate', () => {
  // An asymmetric feather moves the boundary by half a radius. On a cut-out
  // that reads as the subject having been shaved, and it compounds every time
  // the slider is touched.
  const w = 24, radius = 4;
  const step = plane(w, 1, (x) => (x < 12 ? 0 : 255));
  const out = featherMask(step, w, 1, radius);
  for (let d = 1; d <= radius + 1; d++)
    assert.equal(out[12 - d] + out[11 + d], 255, `asymmetric at distance ${d}`);
});

test('every feathered byte stays inside 0..255, at every radius', () => {
  const src = noisePlane(17, 13);
  for (const radius of [1, 2, 7, 100]) {
    const out = featherMask(src, 17, 13, radius);
    assert.equal(out.length, src.length);
    for (let i = 0; i < out.length; i++)
      assert.ok(Number.isInteger(out[i]) && out[i] >= 0 && out[i] <= 255,
        `r${radius} at ${i} -> ${out[i]}`);
  }
});

test('a huge radius flattens toward the mean rather than to zero or to 255', () => {
  // A radius larger than the plane is reachable from a slider. The clamped
  // window must keep averaging the real pixels, not run off into padding.
  const w = 8, h = 8;
  const half = plane(w, h, (x) => (x < 4 ? 0 : 255));
  const out = featherMask(half, w, h, 200);
  for (let i = 0; i < out.length; i++)
    assert.ok(out[i] > 60 && out[i] < 195, `at ${i} -> ${out[i]}`);
});

test('featherMask does not mutate its input', () => {
  const src = noisePlane(9, 9);
  const before = copyOf(src);
  featherMask(src, 9, 9, 3);
  same(src, before);
});

// ---------------------------------------------------------------------------
console.log('\nthe brush\n');

const dab = (m, w, h, options) => stampBrush(m, w, h, options);

test('ALIASING: stampBrush returns a fresh plane; stampInto MUTATES its target', () => {
  // The one mutating function in the file, exported under its own name so the
  // fact is visible at the call site. Both halves pinned, because a caller that
  // guessed wrong either loses the stroke or destroys the undo entry.
  const src = emptyMask(8, 8);
  const before = copyOf(src);
  const out = stampBrush(src, 8, 8, { x: 4, y: 4, radius: 3 });
  assert.notEqual(out, src);
  assert.notEqual(out.buffer, src.buffer);
  same(src, before);
  assert.ok(out[4 * 8 + 4] > 0, 'the dab never landed');

  const target = emptyMask(8, 8);
  const returned = stampInto(target, 8, 8, { x: 4, y: 4, radius: 3 });
  assert.equal(returned, target, 'stampInto must return the very buffer it wrote');
  assert.ok(target[4 * 8 + 4] > 0, 'stampInto did not write in place');
});

test('a non-positive radius is a no-op that still hands back the buffer', () => {
  for (const radius of [0, -1]) {
    const target = noisePlane(6, 6);
    const before = copyOf(target);
    assert.equal(stampInto(target, 6, 6, { x: 3, y: 3, radius }), target, `r${radius}`);
    same(target, before);
    same(stampBrush(before, 6, 6, { x: 3, y: 3, radius }), before);
  }
});

test('hardness 1 paints a HARD disc -- inside is 255, outside is untouched', () => {
  const w = 16, h = 16, r = 4;
  const out = dab(emptyMask(w, h), w, h, { x: 8, y: 8, radius: r, hardness: 1 });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - 8, y - 8);
      const v = out[y * w + x];
      if (d <= r) assert.equal(v, 255, `inside at (${x},${y}) -> ${v}`);
      else assert.equal(v, 0, `outside at (${x},${y}) -> ${v}`);
    }
});

test('hardness 0 falls off MONOTONICALLY with distance, reaching 0 at the rim', () => {
  // A linear ramp leaves a visible ring where the gradient breaks; the
  // smoothstep is there to remove it. Monotonicity is the checkable part.
  const w = 33, h = 33, r = 12;
  const out = dab(emptyMask(w, h), w, h, { x: 16, y: 16, radius: r, hardness: 0 });
  let previous = 256;
  for (let x = 16; x <= 16 + r; x++) {
    const v = out[16 * w + x];
    assert.ok(v <= previous, `rose again at x=${x}: ${previous} -> ${v}`);
    previous = v;
  }
  assert.equal(out[16 * w + 16], 255, 'the centre is not solid');
  assert.equal(out[16 * w + 16 + r], 0, 'the rim is not fully transparent');
  assert.equal(out[16 * w + 16 + r + 1], 0, 'paint escaped past the radius');
});

test('the dab is radially symmetric in all four directions', () => {
  const w = 21, h = 21, r = 7;
  const out = dab(emptyMask(w, h), w, h, { x: 10, y: 10, radius: r, hardness: 0.3 });
  for (let d = 1; d <= r; d++) {
    const east = out[10 * w + 10 + d];
    assert.equal(out[10 * w + 10 - d], east, `west differs at ${d}`);
    assert.equal(out[(10 + d) * w + 10], east, `south differs at ${d}`);
    assert.equal(out[(10 - d) * w + 10], east, `north differs at ${d}`);
  }
});

test('erase drives coverage DOWN and never below zero', () => {
  const w = 12, h = 12;
  const out = dab(fullMask(w, h), w, h, { x: 6, y: 6, radius: 4, hardness: 1, erase: true });
  assert.equal(out[6 * w + 6], 0, 'the centre was not erased');
  assert.equal(out[0], 255, 'erasing spread outside the radius');
  for (const v of out) assert.ok(v >= 0 && v <= 255);
});

test('an out-of-range flow CLAMPS rather than wrapping around the byte', () => {
  // 200 + 255*5 is 1475. A Uint8Array store would keep 1475 & 255 = 195 --
  // DARKER than where it started, from a stroke that was meant to paint.
  const w = 4, h = 4;
  const base = plane(w, h, () => 200);
  const painted = dab(base, w, h, { x: 2, y: 2, radius: 2, hardness: 1, flow: 5 });
  assert.equal(painted[2 * w + 2], 255, 'flow overflowed the byte');
  const erased = dab(base, w, h, { x: 2, y: 2, radius: 2, hardness: 1, flow: 5, erase: true });
  assert.equal(erased[2 * w + 2], 0, 'erase underflowed the byte');
});

test('a centre outside the canvas is CLIPPED, never wrapped to the other side', () => {
  // x0/x1 are clamped per axis, so the run cannot walk off the end of a row
  // into the start of the next one. This is the single most likely off-by-one
  // in the whole file.
  const w = 12, h = 12;
  for (const centre of [{ x: -50, y: 6 }, { x: 61, y: 6 }, { x: 6, y: -50 }, { x: 6, y: 61 }]) {
    const out = dab(emptyMask(w, h), w, h, { ...centre, radius: 3, hardness: 1 });
    for (let i = 0; i < out.length; i++)
      assert.equal(out[i], 0, `centre ${centre.x},${centre.y} painted pixel ${i}`);
  }
});

test('a dab straddling the left edge paints that edge and NOTHING on the right', () => {
  const w = 12, h = 12;
  const out = dab(emptyMask(w, h), w, h, { x: 0, y: 6, radius: 3, hardness: 1 });
  assert.equal(out[6 * w + 0], 255, 'the edge column was skipped');
  for (let y = 0; y < h; y++)
    assert.equal(out[y * w + (w - 1)], 0, `wrapped onto the right edge at row ${y}`);
});

test('repeated dabs accumulate but never exceed 255', () => {
  const w = 8, h = 8;
  let m = emptyMask(w, h);
  let previous = 0;
  for (let i = 0; i < 12; i++) {
    m = dab(m, w, h, { x: 4, y: 4, radius: 3, hardness: 0, flow: 0.3 });
    const v = m[4 * w + 4 + 2];
    assert.ok(v >= previous, `coverage went backwards on pass ${i}`);
    previous = v;
    for (const b of m) assert.ok(b >= 0 && b <= 255);
  }
  assert.ok(previous > 0, 'twelve passes of a flow brush deposited nothing');
});

// ---------------------------------------------------------------------------
console.log('\nstrokeMask\n');

test('strokeMask returns a fresh plane and does not mutate its input', () => {
  const src = emptyMask(16, 16);
  const before = copyOf(src);
  const out = strokeMask(src, 16, 16, [{ x: 2, y: 8 }, { x: 12, y: 8 }],
    { radius: 3, hardness: 1 });
  assert.notEqual(out, src);
  assert.notEqual(out.buffer, src.buffer);
  same(src, before);
});

test('a one-point stroke still stamps -- a tap is not silently dropped', () => {
  // The loop starts at index 1, so a single pointerdown with no move would
  // paint nothing at all without the explicit tail case.
  const w = 16, h = 16;
  const out = strokeMask(emptyMask(w, h), w, h, [{ x: 8, y: 8 }], { radius: 3, hardness: 1 });
  assert.equal(out[8 * w + 8], 255, 'a tap painted nothing');
});

test('an EMPTY point list is a no-op copy rather than a throw', () => {
  const src = noisePlane(8, 8);
  const out = strokeMask(src, 8, 8, [], { radius: 3 });
  assert.notEqual(out, src);
  same(out, src);
});

test('the path is INTERPOLATED, so a fast drag is a line and not two dots', () => {
  // The defect this function exists to prevent: pointer events arrive far
  // apart, and stamping only at the reported positions leaves a dotted line
  // that reads as the brush being broken.
  const w = 40, h = 16;
  const out = strokeMask(emptyMask(w, h), w, h,
    [{ x: 4, y: 8 }, { x: 34, y: 8 }], { radius: 3, hardness: 1 });
  for (let x = 4; x <= 34; x++)
    assert.equal(out[8 * w + x], 255, `gap in the stroke at x=${x}`);
  assert.equal(out[8 * w + 19], 255, 'the midpoint between two events was never stamped');
});

test('the stroke stays inside its own radius, both across and along', () => {
  const w = 40, h = 20, r = 3;
  const out = strokeMask(emptyMask(w, h), w, h,
    [{ x: 4, y: 10 }, { x: 34, y: 10 }], { radius: r, hardness: 1 });
  for (let x = 0; x < w; x++) {
    assert.equal(out[(10 + r + 1) * w + x], 0, `bled below the stroke at x=${x}`);
    assert.equal(out[(10 - r - 1) * w + x], 0, `bled above the stroke at x=${x}`);
  }
  assert.equal(out[10 * w + (34 + r + 1)], 0, 'ran past the end of the path');
});

test('a multi-segment path is continuous ACROSS the joins', () => {
  const w = 32, h = 32;
  const points = [{ x: 4, y: 4 }, { x: 27, y: 4 }, { x: 27, y: 27 }, { x: 4, y: 27 }];
  const out = strokeMask(emptyMask(w, h), w, h, points, { radius: 2, hardness: 1 });
  for (let x = 4; x <= 27; x++) assert.equal(out[4 * w + x], 255, `top edge gap at x=${x}`);
  for (let y = 4; y <= 27; y++) assert.equal(out[y * w + 27], 255, `right edge gap at y=${y}`);
  for (let x = 4; x <= 27; x++) assert.equal(out[27 * w + x], 255, `bottom edge gap at x=${x}`);
  assert.equal(out[16 * w + 16], 0, 'the interior was filled -- this is a stroke, not a fill');
});

test('a zero-length segment does not spin -- steps is floored at one', () => {
  // Two identical pointer samples give hypot 0, and `ceil(0/spacing)` is 0.
  // Without the Math.max the inner loop would simply not run; with duplicated
  // points at the START it would also skip the tap case.
  const w = 12, h = 12;
  const out = strokeMask(emptyMask(w, h), w, h,
    [{ x: 6, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 6 }], { radius: 3, hardness: 1 });
  assert.equal(out[6 * w + 6], 255, 'a stationary drag painted nothing');
});

test('a stroke that leaves the canvas paints what is visible and no more', () => {
  const w = 16, h = 16;
  const out = strokeMask(emptyMask(w, h), w, h,
    [{ x: -20, y: 8 }, { x: 36, y: 8 }], { radius: 2, hardness: 1 });
  for (let x = 0; x < w; x++) assert.equal(out[8 * w + x], 255, `gap at x=${x}`);
  for (let x = 0; x < w; x++) assert.equal(out[0 * w + x], 0, `bled to the top row at x=${x}`);
});

test('erase mode works through strokeMask too, and clears only the path', () => {
  const w = 24, h = 12;
  const out = strokeMask(fullMask(w, h), w, h,
    [{ x: 4, y: 6 }, { x: 19, y: 6 }], { radius: 2, hardness: 1, erase: true });
  for (let x = 4; x <= 19; x++) assert.equal(out[6 * w + x], 0, `not erased at x=${x}`);
  assert.equal(out[0], 255, 'the erase spread off the path');
});

// ---------------------------------------------------------------------------
console.log('\nisOpaque and cutFraction\n');

test('isOpaque is true for a full plane and false the instant one byte moves', () => {
  // A model that finds nothing returns all-255. Committing that spends an undo
  // step and changes no pixels, so the caller reports "nothing found" instead.
  const w = 8, h = 8;
  assert.equal(isOpaque(fullMask(w, h)), true);
  assert.equal(isOpaque(emptyMask(w, h)), false);
  for (const i of [0, 1, 31, 62, 63]) {
    const m = fullMask(w, h);
    m[i] = 254;
    assert.equal(isOpaque(m), false, `a single 254 at ${i} still read as opaque`);
  }
});

test('cutFraction is 0 for a full plane, 1 for an empty one, and 0.5 for half', () => {
  assert.equal(cutFraction(fullMask(10, 10)), 0);
  assert.equal(cutFraction(emptyMask(10, 10)), 1);
  assert.equal(cutFraction(plane(10, 10, (x) => (x < 5 ? 0 : 255))), 0.5);
});

test('cutFraction stays inside 0..1 for every plane, and is exactly linear', () => {
  const w = 16, h = 16;
  for (let v = 0; v <= 255; v++) {
    const f = cutFraction(plane(w, h, () => v));
    assert.ok(f >= 0 && f <= 1, `uniform ${v} -> ${f}`);
    assert.ok(Math.abs(f - (255 - v) / 255) < 1e-12, `uniform ${v} is not linear: ${f}`);
  }
  const noisy = cutFraction(noisePlane(23, 19));
  assert.ok(noisy >= 0 && noisy <= 1, `noise -> ${noisy}`);
});

test('cutFraction and isOpaque agree at the one point where they can', () => {
  const cases = [fullMask(6, 6), emptyMask(6, 6), noisePlane(6, 6)];
  for (const m of cases)
    assert.equal(isOpaque(m), cutFraction(m) === 0, 'the two disagree about "masks nothing"');
});

test('neither reads or writes past the plane, and neither mutates it', () => {
  const m = noisePlane(9, 4);
  const before = copyOf(m);
  isOpaque(m);
  cutFraction(m);
  same(m, before);
});

test('cutFraction of a ZERO-LENGTH plane is 0, not NaN', () => {
  // Was a FINDING, now fixed. `cut / mask.length` was 0/0, so a degenerate
  // layer produced a "fraction cut" that failed every comparison it was put
  // into -- a `< 0.01` "nothing found" guard read false, and a percentage
  // reached the UI as NaN. Nothing cut out of nothing is zero.
  assert.equal(cutFraction(new Uint8Array(0)), 0);
  // The comparisons the NaN used to break, asserted directly.
  assert.equal(cutFraction(new Uint8Array(0)) < 0.01, true, 'a "nothing found" guard now reads true');
  assert.equal(isOpaque(new Uint8Array(0)), true, 'unchanged, and the safe direction');
});

// ---------------------------------------------------------------------------
console.log('\nguidedRefine\n');

/** A flat grey guide -- no edges anywhere for the filter to snap to. */
const flatGuide = (w, h, level = 128) => image(w, h, () => [level, level, level, 255]);

test('a mask/guide size mismatch THROWS rather than refining a sheared plane', () => {
  assert.throws(() => guidedRefine(emptyMask(8, 7), flatGuide(8, 8)), /mismatch/);
  assert.throws(() => guidedRefine(emptyMask(9, 8), flatGuide(8, 8)), /mismatch/);
});

test('a radius below 1 is a byte-identical copy, and a FRESH buffer', () => {
  const m = noisePlane(8, 8);
  for (const radius of [0, 0.5, -4]) {
    const out = guidedRefine(m, flatGuide(8, 8), { radius });
    assert.notEqual(out, m, `r${radius} returned its input`);
    assert.notEqual(out.buffer, m.buffer, `r${radius} aliased its input`);
    same(out, m);
  }
});

test('a UNIFORM mask survives refinement unchanged, whatever the guide shows', () => {
  // The identity the whole filter has to satisfy: with no variation in `p`,
  // the local fit is a = 0, b = mean, so the output is the constant back.
  // Anything else means the filter is inventing coverage out of image texture.
  const w = 24, h = 24;
  const textured = image(w, h, (x, y) => {
    const v = ((x >> 2) + (y >> 2)) % 2 ? 20 : 235;
    return [v, v, v, 255];
  });
  for (const level of [0, 64, 128, 200, 255]) {
    const out = guidedRefine(plane(w, h, () => level), textured, { radius: 4 });
    for (let i = 0; i < out.length; i++)
      assert.ok(Math.abs(out[i] - level) <= 1, `level ${level} at ${i} -> ${out[i]}`);
  }
});

test('the endpoints are EXACT: an all-255 mask stays 255 and an all-0 mask stays 0', () => {
  const w = 16, h = 16;
  const guide = image(w, h, (x, y) => [x * 16, y * 16, 128, 255]);
  same(guidedRefine(fullMask(w, h), guide, { radius: 3 }), fullMask(w, h));
  same(guidedRefine(emptyMask(w, h), guide, { radius: 3 }), emptyMask(w, h));
});

test('every refined byte is an integer inside 0..255, at every radius and eps', () => {
  const w = 20, h = 14;
  const m = noisePlane(w, h);
  const guide = image(w, h, (x, y) => [(x * 31) & 255, (y * 47) & 255, (x * y) & 255, 255]);
  for (const radius of [1, 2, 4, 9, 60])
    for (const eps of [1e-6, 1e-4, 1e-2, 1]) {
      const out = guidedRefine(m, guide, { radius, eps });
      assert.equal(out.length, w * h);
      for (let i = 0; i < out.length; i++)
        assert.ok(Number.isInteger(out[i]) && out[i] >= 0 && out[i] <= 255,
          `r${radius} eps${eps} at ${i} -> ${out[i]}`);
    }
});

test('a large eps degenerates to a BLUR of the mask -- it stops following the guide', () => {
  // The documented meaning of the parameter, made checkable. At eps large the
  // fit collapses to the local mean, which is a double box blur of the mask and
  // has nothing to do with the image.
  const w = 24, h = 1;
  const m = plane(w, h, (x) => (x < 12 ? 0 : 255));
  const guideA = image(w, h, (x) => [x < 12 ? 0 : 255, x < 12 ? 0 : 255, x < 12 ? 0 : 255, 255]);
  const guideB = flatGuide(w, h);
  const a = guidedRefine(m, guideA, { radius: 3, eps: 1e6 });
  const b = guidedRefine(m, guideB, { radius: 3, eps: 1e6 });
  for (let i = 0; i < w; i++)
    assert.ok(Math.abs(a[i] - b[i]) <= 1, `guide still mattered at ${i}: ${a[i]} vs ${b[i]}`);
  assert.ok(a[11] > 0 && a[12] < 255, 'a huge eps did not soften the step at all');
});

test('a small eps SNAPS the mask onto the edge the pixels show', () => {
  // The whole point of the pass. The mask boundary is at x=8; the real image
  // edge is at x=12. A guided filter with a tight eps pulls the alpha toward
  // the image edge; a plain blur would leave it at 8.
  const w = 32, h = 32;
  const m = plane(w, h, (x) => (x < 8 ? 0 : 255));
  const guide = image(w, h, (x) => (x < 12 ? [10, 10, 10, 255] : [245, 245, 245, 255]));
  const tight = guidedRefine(m, guide, { radius: 6, eps: 1e-6 });
  const loose = guidedRefine(m, guide, { radius: 6, eps: 1e6 });
  const midpoint = (out) => {
    for (let x = 0; x < w; x++) if (out[16 * w + x] >= 128) return x;
    return w;
  };
  assert.ok(midpoint(tight) > midpoint(loose),
    `tight eps ${midpoint(tight)} did not move toward the image edge past loose ${midpoint(loose)}`);
});

test('guidedRefine mutates NEITHER the mask nor the guide pixels', () => {
  const w = 12, h = 12;
  const m = noisePlane(w, h);
  const guide = image(w, h, (x, y) => [x * 20, y * 20, 90, 255]);
  const maskBefore = copyOf(m);
  const pixelsBefore = Uint8ClampedArray.from(guide.data);
  const out = guidedRefine(m, guide, { radius: 3 });
  assert.notEqual(out, m);
  assert.notEqual(out.buffer, m.buffer);
  same(m, maskBefore);
  same(guide.data, pixelsBefore);
});

test('the guide\'s ALPHA channel is ignored -- only luminance steers the filter', () => {
  // The guide is the layer's colour. Reading alpha here would make the filter
  // chase the mask it is meant to correct.
  const w = 16, h = 16;
  const m = plane(w, h, (x) => (x < 8 ? 0 : 255));
  const opaque = image(w, h, (x) => [x * 15, x * 15, x * 15, 255]);
  const varied = image(w, h, (x, y) => [x * 15, x * 15, x * 15, (y * 17) & 255]);
  same(guidedRefine(m, opaque, { radius: 3 }), guidedRefine(m, varied, { radius: 3 }));
});

test('a one-pixel plane refines to itself rather than dividing by an empty window', () => {
  for (const v of [0, 77, 255]) {
    const out = guidedRefine(new Uint8Array([v]), image(1, 1, () => [30, 60, 90, 255]),
      { radius: 4 });
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0] - v) <= 1, `1x1 at ${v} -> ${out[0]}`);
  }
});

test('FINDING: eps 0 over a BLACK guide divides 0 by 0 and returns an all-zero mask', () => {
  // varI and covIP are both exactly 0 where the guide has no signal at all, so
  // `a` is NaN, `b` is NaN, and `Math.round(NaN)` stored into a Uint8Array is
  // 0 -- silently. The mask is destroyed with no error anywhere. eps is a
  // pass-through option from the caller (cutout.js hands `options` straight
  // through to refineCutout), so a UI that ever exposes a "0 = off" strength
  // slider reaches this. There is no guard on eps and no NaN check on `q`.
  const w = 8, h = 8;
  const black = image(w, h, () => [0, 0, 0, 255]);
  const out = guidedRefine(fullMask(w, h), black, { radius: 2, eps: 0 });
  same(out, emptyMask(w, h));
  // The default eps is fine on the very same input -- this is purely eps 0.
  same(guidedRefine(fullMask(w, h), black, { radius: 2 }), fullMask(w, h));
});

// ---------------------------------------------------------------------------
console.log('\ndecontaminate\n');

/**
 * A vertical background/foreground boundary with one mixed column.
 * Left of x=5 is pure blue background; right of x=5 is pure red foreground;
 * column 5 is the 50/50 mix a camera actually records at an edge.
 */
const spillScene = (w = 12, h = 6) => {
  const px = image(w, h, (x) =>
    x < 5 ? [0, 0, 255, 255] : x === 5 ? [128, 0, 128, 128] : [255, 0, 0, 255]);
  const mask = plane(w, h, (x) => (x < 5 ? 0 : x === 5 ? 128 : 255));
  return { px, mask, w, h };
};

test('decontaminate returns FRESH pixel data and never touches the source buffer', () => {
  // `layer.pixels` is what the whole editor treats as immutable source. An
  // in-place matte would overwrite the originals permanently, and because the
  // next pass reads the same buffer it would compound on every re-run.
  const { px, mask } = spillScene();
  const before = Uint8ClampedArray.from(px.data);
  const out = decontaminate(px, mask, { radius: 3 });
  assert.notEqual(out, px);
  assert.notEqual(out.data, px.data);
  assert.notEqual(out.data.buffer, px.data.buffer);
  assert.ok(out.data instanceof Uint8ClampedArray);
  same(px.data, before);
});

test('the returned image keeps the source dimensions and byte length', () => {
  for (const [w, h] of [[1, 1], [1, 8], [8, 1], [12, 6]]) {
    const px = image(w, h, () => [10, 20, 30, 128]);
    const out = decontaminate(px, plane(w, h, () => 128), { radius: 2 });
    assert.equal(out.width, w);
    assert.equal(out.height, h);
    assert.equal(out.data.length, w * h * 4);
  }
});

test('a radius below 1 is a byte-identical copy, still in a fresh buffer', () => {
  const { px, mask } = spillScene();
  for (const radius of [0, 0.5, -2]) {
    const out = decontaminate(px, mask, { radius });
    assert.notEqual(out.data, px.data, `r${radius} aliased the source`);
    same(out.data, px.data);
  }
});

test('the ALPHA channel is never rewritten -- decontamination is a colour pass', () => {
  // The mask is the coverage; this pass only removes spill from the colour. If
  // it wrote alpha, the mask and the pixels would each carry half the cut and
  // every downstream consumer would have to know which.
  const { px, mask } = spillScene();
  const out = decontaminate(px, mask, { radius: 3 });
  for (let i = 0; i < px.width * px.height; i++)
    assert.equal(out.data[i * 4 + 3], px.data[i * 4 + 3], `pixel ${i}`);
});

test('the solid INTERIOR and the fully-cut region are left exactly as recorded', () => {
  // Rewriting an opaque pixel tints solid regions for no reason, and it looks
  // like a colour-management bug rather than a matting one.
  const { px, mask, w, h } = spillScene();
  const out = decontaminate(px, mask, { radius: 3, threshold: 8 });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x === 5) continue;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++)
        assert.equal(out.data[o + c], px.data[o + c], `(${x},${y}) channel ${c}`);
    }
});

test('the mixed edge pixel is pulled TOWARD the foreground and away from the background', () => {
  // The direction is the claim; the exact number is a function of the
  // neighbourhood estimate and would be a golden value pinning today's window.
  const { px, mask, w } = spillScene();
  const out = decontaminate(px, mask, { radius: 3, threshold: 8 });
  const o = 5 * 4;
  assert.ok(out.data[o] > px.data[o],
    `red did not rise: ${px.data[o]} -> ${out.data[o]}`);
  assert.ok(out.data[o + 2] < px.data[o + 2],
    `blue spill was not removed: ${px.data[o + 2]} -> ${out.data[o + 2]}`);
  assert.equal(out.data[o + 1], 0, 'green was invented from nothing');
  assert.equal(out.data[o + 3], 128, 'alpha moved');
  for (let y = 1; y < px.height; y++)
    assert.equal(out.data[(y * w + 5) * 4], out.data[o], `row ${y} differs from row 0`);
});

test('every output byte stays inside 0..255 even where the linear model breaks', () => {
  // Dividing by a small alpha amplifies the estimate's own error. The
  // Uint8ClampedArray store is the intended fallback; this pins that nothing
  // wraps instead.
  const w = 24, h = 8;
  const px = image(w, h, (x, y) => [(x * 37) & 255, (y * 91) & 255, (x * y * 13) & 255, 255]);
  const mask = plane(w, h, (x, y) => 9 + ((x * 7 + y * 3) % 237));   // all inside the band
  for (const threshold of [0, 4, 8, 40]) {
    const out = decontaminate(px, mask, { radius: 4, threshold });
    for (let i = 0; i < out.data.length; i++)
      assert.ok(Number.isInteger(out.data[i]) && out.data[i] >= 0 && out.data[i] <= 255,
        `threshold ${threshold} byte ${i} -> ${out.data[i]}`);
  }
});

test('threshold widens the SKIPPED band from both ends, monotonically', () => {
  const w = 32, h = 4;
  const px = image(w, h, (x) => [x * 8, 40, 200, 255]);
  const mask = plane(w, h, (x) => x * 8);            // 0..248 across the row
  const touched = (threshold) => {
    const out = decontaminate(px, mask, { radius: 3, threshold });
    let n = 0;
    for (let i = 0; i < w * h; i++)
      if (out.data[i * 4] !== px.data[i * 4] || out.data[i * 4 + 2] !== px.data[i * 4 + 2]) n++;
    return n;
  };
  const wide = touched(60);
  const narrow = touched(2);
  assert.ok(narrow > wide, `a wider threshold touched more pixels: ${narrow} vs ${wide}`);
  assert.equal(touched(128), 0, 'a threshold covering the whole range still rewrote pixels');
});

test('a scene with NO background nearby is left exactly as the camera recorded it', () => {
  // sumW below 1e-3 means there is nothing to estimate B from. Inventing a
  // colour there is worse than leaving the spill in.
  const w = 8, h = 8;
  const px = image(w, h, () => [200, 100, 50, 255]);
  const mask = plane(w, h, () => 128);               // partial everywhere, no background at all
  const out = decontaminate(px, mask, { radius: 3 });
  same(out.data, px.data);
});

test('an all-opaque mask makes the pass a pure copy', () => {
  const { px } = spillScene();
  const out = decontaminate(px, fullMask(px.width, px.height), { radius: 3 });
  same(out.data, px.data);
});

test('a short mask throws rather than blackening the tail of the image', () => {
  // Was a FINDING, now fixed, and it was the worst of the four. guidedRefine
  // has always thrown `mask/guide mismatch`; this read straight off the end,
  // where `mask[i]` is undefined -- so both threshold comparisons were false
  // (the pixel was not skipped), the weight was NaN, the rewritten colour was
  // NaN, and Uint8ClampedArray stores NaN as 0. The tail of the image went
  // BLACK with alpha left at 255, so it did not even read as transparent:
  // silent, and indistinguishable from a legitimately dark image.
  const w = 8, h = 8;
  const px = image(w, h, () => [200, 150, 100, 255]);
  const short = fullMask(w, h - 4);                  // half the plane it should be
  assert.throws(() => decontaminate(px, short, { radius: 2 }), /mask\/pixels mismatch/);
  // A correctly sized mask still works, so the guard is a guard and not a wall.
  assert.doesNotThrow(() => decontaminate(px, fullMask(w, h), { radius: 2 }));
});

// ---------------------------------------------------------------------------
console.log('\nrefineCutout\n');

test('the two passes run in the documented order, and each gets the right input', () => {
  // Refinement FIRST: decontamination divides by the alpha, so it must see the
  // FINAL alpha. Pinned by composition rather than by a golden buffer -- the
  // result has to equal the two functions called by hand in that order.
  const { px, mask } = spillScene();
  const options = { radius: 3, eps: 1e-4, threshold: 8 };
  const out = refineCutout(mask, px, options);

  const expectedMask = guidedRefine(mask, px, options);
  same(out.mask, expectedMask);
  same(out.pixels.data, decontaminate(px, expectedMask, options).data);

  // And the other order really is different, so the assertion above has teeth.
  const wrongOrder = decontaminate(px, mask, options);
  assert.notDeepEqual([...out.pixels.data], [...wrongOrder.data],
    'refine-then-decontaminate is indistinguishable from decontaminate-then-refine');
});

test('refine: false skips the filter but still hands back a FRESH mask', () => {
  const { px, mask } = spillScene();
  const out = refineCutout(mask, px, { refine: false, radius: 3 });
  assert.notEqual(out.mask, mask, 'the caller\'s mask was handed straight back');
  assert.notEqual(out.mask.buffer, mask.buffer);
  same(out.mask, mask);
});

test('decontaminate: false still hands back FRESH pixels, never the caller\'s', () => {
  // Was an ALIASING FINDING, now fixed. Every other exit from this module
  // allocates; this one returned the object it was given, so a caller that
  // believed the module's own docstring ("Returns NEW pixel data; the layer's
  // original buffer is never mutated") and wrote into the result destroyed
  // `layer.pixels` permanently. This repo has already been bitten by exactly
  // this shape via `resample()`'s identity return.
  const { px, mask } = spillScene();
  const out = refineCutout(mask, px, { decontaminate: false, radius: 3 });
  assert.notEqual(out.pixels, px, 'a distinct object');
  assert.notEqual(out.pixels.data, px.data, 'backed by a distinct buffer');
  assert.deepEqual(Array.from(out.pixels.data), Array.from(px.data), 'with identical contents');
  assert.equal(out.pixels.width, px.width);
  assert.equal(out.pixels.height, px.height);
  // The point of the copy: writing to the result must not reach the source.
  const before = px.data[0];
  out.pixels.data[0] = before ^ 0xff;
  assert.equal(px.data[0], before, 'the source is untouched');
});

test('both flags off is the cheapest path and changes nothing', () => {
  const { px, mask } = spillScene();
  const out = refineCutout(mask, px, { refine: false, decontaminate: false });
  same(out.mask, mask);
  same(out.pixels.data, px.data);
});

test('the SAME `radius` drives both passes, whose own defaults differ (4 and 6)', () => {
  // `options` is forwarded whole. A caller that sets `radius` to tune the edge
  // filter silently retunes the background-estimate window as well, and a
  // `radius: 0` turns BOTH passes off at once rather than just the filter.
  const { px, mask } = spillScene();
  const zeroed = refineCutout(mask, px, { radius: 0 });
  same(zeroed.mask, mask);
  same(zeroed.pixels.data, px.data);

  const tuned = refineCutout(mask, px, { radius: 2 });
  same(tuned.mask, guidedRefine(mask, px, { radius: 2 }));
  same(tuned.pixels.data, decontaminate(px, tuned.mask, { radius: 2 }).data);
});

test('refineCutout mutates neither the mask nor the source pixels', () => {
  const { px, mask } = spillScene();
  const maskBefore = copyOf(mask);
  const pixelsBefore = Uint8ClampedArray.from(px.data);
  refineCutout(mask, px, { radius: 3 });
  refineCutout(mask, px, { radius: 3, refine: false });
  refineCutout(mask, px, { radius: 3, decontaminate: false });
  same(mask, maskBefore);
  same(px.data, pixelsBefore);
});

test('refineCutout is idempotent in shape: rerunning it produces the same buffers', () => {
  // A drag re-runs the whole pass every frame off the SAME source. If anything
  // upstream were aliased, the second run would differ from the first.
  const { px, mask } = spillScene();
  const first = refineCutout(mask, px, { radius: 3 });
  const second = refineCutout(mask, px, { radius: 3 });
  same(first.mask, second.mask);
  same(first.pixels.data, second.pixels.data);
});

test('an empty mask through the full pass leaves the image untouched', () => {
  // Nothing is foreground, so every pixel is outside the threshold band and
  // there is nothing to un-premultiply.
  const { px, w, h } = spillScene();
  const out = refineCutout(emptyMask(w, h), px, { radius: 3 });
  same(out.mask, emptyMask(w, h));
  same(out.pixels.data, px.data);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
