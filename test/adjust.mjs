import assert from 'node:assert/strict';
import fs from 'fs';
import {
  CLASS_A_ORDER, OPS, NEUTRAL_ADJUST, createAdjust,
  buildLut, lutDigest, lutFor, isNeutralAdjust, adjustCostOf,
  createScratch, acquireScratch, releaseScratch,
  applyAdjustments,
  HSL_BANDS, NEUTRAL_HSL, normaliseHsl, isNeutralHsl, bandWeights, applyHsl,
  SUPPORTED_BLEND_MODES, normaliseOverlay, isNeutralOverlay,
  PRESETS, PRESET_IDS, presetAdjust,
  createProject, setAdjust, undo, nextGestureKey, discardTo,
  toProjectJson, applyProjectJson,
  resample, renderProject, createRenderStats, createSandwichCache, renderSandwiched,
  loadProjectProxy, exportFullRes, createJsExportTarget, createMemorySpill,
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

console.log('\nthe op table\n');

test('every class-A op\'s declared neutral IS the identity, on every channel, for all 256 values', () => {
  // The whole LUT design rests on this. buildLut runs EVERY op at EVERY entry,
  // including the ones sitting at neutral -- so if one op's neutral is not
  // exactly the identity, a document with no adjustments at all would render
  // through a LUT that is not the identity table, and every image in the app
  // would shift by a greylevel with nothing to blame it on.
  for (const id of CLASS_A_ORDER) {
    const op = OPS[id];
    for (let c = 0; c < 3; c++)
      for (let v = 0; v < 256; v++)
        assert.equal(op.evaluate(v, c, op.neutral), v, `${id} at neutral, channel ${c}, value ${v}`);
  }
});

test('every evaluator stays finite at both extremes of its range', () => {
  // A NaN here would be stored as 0 by Uint8Array without a word of complaint,
  // so it has to be caught at the evaluator rather than at the table.
  for (const id of CLASS_A_ORDER) {
    const op = OPS[id];
    for (const value of op.range)
      for (let c = 0; c < 3; c++)
        for (let v = 0; v < 256; v++) {
          const out = op.evaluate(v, c, value);
          assert.ok(Number.isFinite(out), `${id} at ${value}, channel ${c}, value ${v} -> ${out}`);
        }
  }
});

test('CLASS_A_ORDER lists exactly the class-A ops, and nothing else does', () => {
  const declared = Object.keys(OPS).filter((id) => OPS[id].class === 'A');
  assert.deepEqual([...CLASS_A_ORDER].sort(), declared.sort());
  for (const id of CLASS_A_ORDER) assert.equal(OPS[id].lut, true, `${id} must be LUT-carried`);
});

test('createAdjust clamps an out-of-range parameter into its declared range', () => {
  const a = createAdjust({ brightness: 5000, contrast: -5000, exposure: 'nonsense' });
  assert.equal(a.brightness, 100);
  assert.equal(a.contrast, -100);
  assert.equal(a.exposure, 0, 'an unparseable value falls back to neutral, never to NaN');
});

test('createAdjust returns a DEEPLY frozen object', () => {
  // setLayer captures object-valued `from` BY REFERENCE. A caller that mutates
  // the object it passes has destroyed the undo entry before it was written --
  // and the failure is invisible until someone presses undo. Freezing turns
  // that into a throw at the point of the mistake.
  const a = createAdjust({ brightness: 10, hsl: { saturation: -20, bands: [] } });
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.hsl));
  assert.throws(() => { 'use strict'; a.brightness = 0; }, TypeError);
});

test('createAdjust fills every missing parameter and drops unknown keys', () => {
  const a = createAdjust({ brightness: 4, nonsense: 12 });
  for (const id of CLASS_A_ORDER) assert.equal(typeof a[id], 'number', `${id} missing`);
  assert.equal(a.nonsense, undefined);
  assert.equal(a.preset, 'none');
  assert.deepEqual(createAdjust(), { ...NEUTRAL_ADJUST });
});

console.log('\nthe LUT collapse\n');

test('a neutral adjust yields the IDENTITY table, byte for byte', () => {
  const lut = buildLut(null);
  assert.equal(lut.length, 768);
  for (let c = 0; c < 3; c++)
    for (let v = 0; v < 256; v++)
      assert.equal(lut[c * 256 + v], v, `channel ${c}, value ${v}`);
  assert.deepEqual([...buildLut(createAdjust())], [...lut], 'an all-neutral object must match null');
});

test('the composed table equals applying the ops IN SEQUENCE, at all 768 entries', () => {
  // THE assertion the whole cost design stands on. If this ever disagrees, the
  // LUT is not "four adjustments for the price of one" -- it is four
  // adjustments producing a fifth, different result, and the user is tuning
  // sliders against a preview that does not show what they do.
  const adjust = createAdjust({
    exposure: 37, temperature: -44, tint: 19, brightness: -23, contrast: 61,
  });
  const lut = buildLut(adjust);

  for (let c = 0; c < 3; c++)
    for (let v = 0; v < 256; v++) {
      let x = v;
      for (const id of CLASS_A_ORDER) x = OPS[id].evaluate(x, c, adjust[id]);
      const expected = x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x);
      assert.equal(lut[c * 256 + v], expected, `channel ${c}, value ${v}`);
    }
});

test('the collapse is order-sensitive, and the declared order is the one used', () => {
  // Pointwise ops do not commute. This pins CLASS_A_ORDER: reversing it changes
  // the table, so a silent reorder cannot slip through as a refactor.
  const forward = buildLut(createAdjust({ brightness: 60, contrast: 60 }));
  let differs = 0;
  for (let v = 0; v < 256; v++) {
    let x = v;
    for (const id of [...CLASS_A_ORDER].reverse()) x = OPS[id].evaluate(x, 0, 60);
    const reversed = x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x);
    if (reversed !== forward[v]) differs++;
  }
  assert.ok(differs > 0, 'brightness-then-contrast must differ from contrast-then-brightness');
});

test('every parameter at both extremes yields a table of bytes in 0..255', () => {
  for (const id of CLASS_A_ORDER)
    for (const value of OPS[id].range) {
      const lut = buildLut(createAdjust({ [id]: value }));
      assert.equal(lut.length, 768);
      for (let i = 0; i < 768; i++)
        assert.ok(Number.isInteger(lut[i]) && lut[i] >= 0 && lut[i] <= 255,
          `${id} at ${value}, entry ${i} -> ${lut[i]}`);
    }
});

test('lutDigest changes if and only if a class-A parameter changes', () => {
  const base = createAdjust({ brightness: 10 });
  assert.equal(lutDigest(base), lutDigest(createAdjust({ brightness: 10 })));
  assert.notEqual(lutDigest(base), lutDigest(createAdjust({ brightness: 11 })));
  assert.notEqual(lutDigest(base), lutDigest(null));
});

test('lutDigest IGNORES hsl and overlay, because the table does not depend on them', () => {
  // Rebuilding 768 entries because a hue band moved is pure waste, once per
  // frame, for the whole of an HSL drag. It also makes the lut/lutKey pair safe
  // by construction: the key is derived from exactly the inputs the value
  // depends on, so it can never go stale the way rendered/renderedKey can.
  const plain = createAdjust({ contrast: 20 });
  const withHsl = createAdjust({ contrast: 20, hsl: { saturation: -50, bands: [] } });
  assert.equal(lutDigest(plain), lutDigest(withHsl));
  assert.deepEqual([...buildLut(plain)], [...buildLut(withHsl)]);
});

test('lutFor caches on the layer and rebuilds only when the digest moves', () => {
  const layer = { adjust: createAdjust({ brightness: 12 }) };
  const first = lutFor(layer);
  assert.equal(lutFor(layer), first, 'an unchanged digest must not reallocate');
  layer.adjust = createAdjust({ brightness: 13 });
  const second = lutFor(layer);
  assert.notEqual(second, first);
  assert.notDeepEqual([...second], [...first]);
});

test('isNeutralAdjust is true for null and for an all-neutral object', () => {
  assert.equal(isNeutralAdjust(null), true);
  assert.equal(isNeutralAdjust(createAdjust()), true);
  assert.equal(isNeutralAdjust(createAdjust({ brightness: 1 })), false);
});

test('adjustCostOf reports the three cost terms separately', () => {
  // The debug readout shows `lut: N / hsl: M`, and it can only do that if the
  // terms are separable here. A cost the user cannot see is a bug.
  assert.deepEqual(adjustCostOf(null), { lut: false, hsl: false, overlay: false });
  assert.deepEqual(adjustCostOf(createAdjust({ contrast: 5 })),
    { lut: true, hsl: false, overlay: false });
});

console.log('\nthe shared scratch\n');

test('acquireScratch returns a view of exactly the requested size', () => {
  const s = createScratch();
  const view = acquireScratch(s, 3, 2);
  assert.equal(view.width, 3);
  assert.equal(view.height, 2);
  assert.equal(view.data.length, 3 * 2 * 4);
  assert.ok(view.data instanceof Uint8ClampedArray);
});

test('a smaller request reuses the buffer without allocating', () => {
  const s = createScratch();
  acquireScratch(s, 64, 64);
  const after = s.allocations;
  acquireScratch(s, 8, 8);
  acquireScratch(s, 1, 1);
  assert.equal(s.allocations, after, 'a shrink must never allocate');
});

test('a larger request grows the buffer exactly once', () => {
  const s = createScratch();
  acquireScratch(s, 8, 8);
  assert.equal(s.allocations, 1);
  acquireScratch(s, 64, 64);
  assert.equal(s.allocations, 2);
  acquireScratch(s, 64, 64);
  assert.equal(s.allocations, 2);
});

test('the view is rect-sized, so a previous larger layer\'s bytes are unreachable', () => {
  // Not "unread" -- unreachable. A big adjusted layer followed by a small one
  // must not be able to leak a single pixel of the first into the second, and
  // a length is a stronger guarantee than a loop bound someone can edit.
  const s = createScratch();
  acquireScratch(s, 4, 4).data.fill(255);
  const small = acquireScratch(s, 2, 2);
  assert.equal(small.data.length, 16);
});

test('releaseScratch drops the buffer so it can be collected before an encode peak', () => {
  const s = createScratch();
  acquireScratch(s, 32, 32);
  releaseScratch(s);
  assert.equal(s.data, null);
  assert.equal(s.bytes, 0);
  assert.equal(acquireScratch(s, 4, 4).data.length, 64, 'it must still work afterwards');
});

console.log('\nthe per-pixel pass\n');

/** A buffer sweeping all four channels, so alpha assertions have every band. */
const sweep = (w = 16, h = 16) => {
  const data = new Uint8ClampedArray(w * h * 4);
  const bands = [0, 1, 64, 127, 128, 200, 254, 255];
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = i & 255;
    data[i * 4 + 1] = (i * 7 + 33) & 255;
    data[i * 4 + 2] = (i * 13 + 91) & 255;
    data[i * 4 + 3] = bands[i & 7];
  }
  return { width: w, height: h, data };
};

const blank = (src) => ({ width: src.width, height: src.height,
  data: new Uint8ClampedArray(src.data.length) });

test('a neutral adjust produces a buffer bit-identical to its input', () => {
  const src = sweep();
  const out = applyAdjustments(src, null, blank(src));
  assert.deepEqual([...out.data], [...src.data]);
});

test('applying into the input buffer THROWS', () => {
  // Finding 1. On the default preview path resample() identity-returns, so the
  // buffer drawLayerInto is holding IS layer.pixels -- and an in-place
  // adjustment would overwrite the layer's originals permanently and compound
  // every frame of a drag. This is a defect that survives review by looking
  // correct; a runtime assertion in the one function that can commit it is
  // cheaper than remembering.
  const src = sweep(4, 4);
  assert.throws(
    () => applyAdjustments(src, createAdjust({ brightness: 20 }), src),
    /write into its own input/,
  );
});

test('OVERLAPPING views of one ArrayBuffer also throw', () => {
  // acquireScratch hands out subarrays, so `out.data !== pixels.data` is not
  // enough on its own -- two views of the same buffer would corrupt half the
  // image and pass a reference check.
  const buf = new Uint8ClampedArray(16);
  const a = { width: 2, height: 1, data: buf.subarray(0, 8) };
  const b = { width: 2, height: 1, data: buf.subarray(4, 12) };
  assert.throws(() => applyAdjustments(a, createAdjust({ brightness: 5 }), b),
    /write into its own input/);
});

test('NON-overlapping views of one ArrayBuffer are allowed', () => {
  // The guard must not be so blunt that the shared scratch becomes unusable.
  const buf = new Uint8ClampedArray(16);
  const a = { width: 2, height: 1, data: buf.subarray(0, 8) };
  const c = { width: 2, height: 1, data: buf.subarray(8, 16) };
  applyAdjustments(a, createAdjust({ brightness: 5 }), c);
  assert.ok(c.data[0] > 0);
});

test('mismatched dimensions throw rather than writing a sheared image', () => {
  const src = sweep(4, 4);
  assert.throws(
    () => applyAdjustments(src, null, { width: 3, height: 4, data: new Uint8ClampedArray(48) }),
    /4x4/,
  );
});

test('alpha is UNCHANGED for every class-A op at both extremes (invariant A)', () => {
  // blendInto reads alpha for `as`, rect.mask multiplies it, hitTest thresholds
  // it, and composite.js's alphaMap builds clipping from it. One invariant
  // keeps four consumers correct, and it is SILENT in three of them.
  const src = sweep();
  for (const id of CLASS_A_ORDER)
    for (const value of OPS[id].range) {
      const out = applyAdjustments(src, createAdjust({ [id]: value }), blank(src));
      for (let i = 0; i < src.width * src.height; i++)
        assert.equal(out.data[i * 4 + 3], src.data[i * 4 + 3], `${id} at ${value}, pixel ${i}`);
    }
});

test('the pass uses the table it is handed rather than rebuilding one', () => {
  // The whole point of caching a LUT on the layer is that the per-frame cost is
  // three indexes, not 768 evaluations plus three indexes.
  const src = sweep(4, 4);
  const identity = buildLut(null);
  const out = applyAdjustments(src, createAdjust({ brightness: 100 }), blank(src), identity);
  assert.deepEqual([...out.data], [...src.data], 'the passed table won, not the parameters');
});

console.log('\nHSL\n');

const NEUTRAL_BANDS = () => Array.from({ length: 8 }, () => ({ h: 0, s: 0, l: 0 }));

test('band weights are a partition of unity for every integer hue', () => {
  // A weighting that did not sum to 1 would shift a pixel's colour at a
  // NEUTRAL setting, at exactly the hues that fall between two bands -- which
  // is most of them.
  const w = new Float64Array(8);
  for (let hue = 0; hue < 360; hue++) {
    bandWeights(hue, w);
    let sum = 0, nonZero = 0;
    for (const v of w) { sum += v; if (v !== 0) nonZero++; }
    assert.ok(Math.abs(sum - 1) < 1e-12, `hue ${hue} sums to ${sum}`);
    assert.ok(nonZero <= 2, `hue ${hue} touches ${nonZero} bands`);
  }
});

test('a hue exactly on a band centre gives that band all of the weight', () => {
  const w = new Float64Array(8);
  HSL_BANDS.forEach((band, i) => {
    bandWeights(band.centre, w);
    assert.equal(w[i], 1, `${band.id} at ${band.centre}`);
  });
});

test('rgb -> hsl -> rgb round-trips within 1 LSB across the sweep', () => {
  // Measured, not assumed. This is the FLOOR on how exact any HSL edit can be,
  // and it is why the neutral case is handled by SKIPPING the pass rather than
  // by trusting the round trip. Report the worst delta you actually observe.
  const src = sweep(32, 32);
  const hsl = normaliseHsl({ bands: NEUTRAL_BANDS(), saturation: 0 });
  const out = blank(src);
  out.data.set(src.data);
  applyHsl(out.data, out.width * out.height, hsl);   // forced: applyAdjustments would skip it
  for (let i = 0; i < src.data.length; i++)
    if (i % 4 !== 3 && src.data[(i >> 2) * 4 + 3] !== 0)
      assert.ok(Math.abs(out.data[i] - src.data[i]) <= 1,
        `byte ${i}: ${src.data[i]} -> ${out.data[i]}`);
});

test('a neutral hsl block is SKIPPED, so the output is bit-identical to class A alone', () => {
  const src = sweep();
  const plain = applyAdjustments(src, createAdjust({ contrast: 30 }), blank(src));
  const withHsl = applyAdjustments(
    src, createAdjust({ contrast: 30, hsl: { bands: NEUTRAL_BANDS(), saturation: 0 } }), blank(src));
  assert.deepEqual([...withHsl.data], [...plain.data]);
});

test('a global saturation of -100 produces a grey everywhere', () => {
  const src = sweep();
  const out = applyAdjustments(
    src, createAdjust({ hsl: { bands: NEUTRAL_BANDS(), saturation: -100 } }), blank(src));
  for (let i = 0; i < src.width * src.height; i++) {
    if (src.data[i * 4 + 3] === 0) continue;      // transparent pixels are skipped
    const o = i * 4;
    assert.equal(out.data[o], out.data[o + 1], `pixel ${i} r/g`);
    assert.equal(out.data[o + 1], out.data[o + 2], `pixel ${i} g/b`);
  }
});

test('a band saturation moves pixels near that band and leaves the opposite band alone', () => {
  // Two pure hues, 180 degrees apart. Killing the reds must not touch the aqua.
  const src = { width: 2, height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 255, 255]) };
  const bands = NEUTRAL_BANDS();
  bands[0].s = -100;                              // the red band
  const out = applyAdjustments(src, createAdjust({ hsl: { bands, saturation: 0 } }), blank(src));
  assert.equal(out.data[0], out.data[1], 'the red pixel is now grey');
  assert.deepEqual([...out.data.slice(4, 8)], [0, 255, 255, 255], 'the aqua pixel is untouched');
});

test('alpha is unchanged by HSL at every alpha band (invariant A)', () => {
  const src = sweep();
  const bands = NEUTRAL_BANDS();
  bands[3].h = 100; bands[3].s = -80; bands[3].l = 60;
  const out = applyAdjustments(src, createAdjust({ hsl: { bands, saturation: 90 } }), blank(src));
  for (let i = 0; i < src.width * src.height; i++)
    assert.equal(out.data[i * 4 + 3], src.data[i * 4 + 3], `pixel ${i}`);
});

test('normaliseHsl always returns eight clamped bands, and isNeutralHsl agrees', () => {
  const n = normaliseHsl({ bands: [{ h: 5000 }], saturation: -5000 });
  assert.equal(n.bands.length, 8);
  assert.equal(n.bands[0].h, 100);
  assert.equal(n.bands[0].s, 0);
  assert.equal(n.saturation, -100);
  assert.equal(isNeutralHsl(NEUTRAL_HSL), true);
  assert.equal(isNeutralHsl(n), false);
  // A present-but-neutral block must not make the whole object non-neutral, or
  // opening the HSL sheet and touching nothing would cost the expensive pass.
  const opened = createAdjust({ hsl: { bands: NEUTRAL_BANDS(), saturation: 0 } });
  assert.equal(isNeutralAdjust(opened), true);
  assert.equal(adjustCostOf(opened).hsl, false);
});

console.log('\nthe gradient overlay\n');

const RAMP = [{ t: 0, r: 0, g: 0, b: 0, a: 1 }, { t: 1, r: 255, g: 255, b: 255, a: 1 }];

/** An opaque black row, `w` wide. */
const blackRow = (w) => {
  const data = new Uint8ClampedArray(w * 4);
  for (let i = 0; i < w; i++) data[i * 4 + 3] = 255;
  return { width: w, height: 1, data };
};

test('a linear gradient samples at NORMALISED positions, identically at two resolutions', () => {
  // The scale-invariance claim, made checkable. Every Phase 3 operation is
  // pointwise and carries no length parameter, so preview and export apply the
  // same function -- there is no proxyScale term to get wrong and nowhere for a
  // preview/export mismatch to hide. That is what the radius exclusion buys.
  const overlay = createAdjust({
    overlay: { kind: 'linear', angle: 0, stops: RAMP, mode: 'normal', opacity: 1 },
  });
  for (const width of [4, 8, 64]) {
    const src = blackRow(width);
    const out = applyAdjustments(src, overlay, blank(src));
    for (let x = 0; x < width; x++)
      assert.equal(out.data[x * 4], Math.round(255 * ((x + 0.5) / width)),
        `width ${width}, x ${x}`);
  }
});

test('a radial gradient is centred and rises away from the centre', () => {
  const overlay = createAdjust({
    overlay: { kind: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: RAMP,
               mode: 'normal', opacity: 1 },
  });
  const src = blackRow(4);
  const out = applyAdjustments(src, overlay, blank(src));
  assert.equal(out.data[0], out.data[12], 'symmetric about the centre');
  assert.ok(out.data[4] < out.data[0], 'the centre is nearer the near stop');
});

test('a transparent pixel is untouched in all four channels', () => {
  // Without the alpha clip a gradient paints into the transparent region and
  // turns a cut-out into a rectangle.
  const src = { width: 2, height: 1, data: new Uint8ClampedArray([9, 9, 9, 0, 9, 9, 9, 255]) };
  const overlay = createAdjust({
    overlay: { kind: 'linear', angle: 0, mode: 'normal', opacity: 1,
               stops: [{ t: 0, r: 255, g: 0, b: 0, a: 1 }, { t: 1, r: 255, g: 0, b: 0, a: 1 }] },
  });
  const out = applyAdjustments(src, overlay, blank(src));
  assert.deepEqual([...out.data.slice(0, 4)], [9, 9, 9, 0], 'the transparent pixel is untouched');
  assert.equal(out.data[4], 255, 'the opaque pixel took the overlay');
});

test('alpha is byte-identical before and after, at every alpha band (invariant A)', () => {
  // blendInto raises alpha (ao = as + ab(1 - as)) on every partially transparent
  // pixel. An overlay TINTS; it does not add coverage. Restoring the column is
  // what keeps this true rather than nearly true -- and hitTest, rect.mask and
  // composite.js's alphaMap all depend on it.
  const src = sweep();
  const overlay = createAdjust({
    overlay: { kind: 'radial', mode: 'overlay', opacity: 0.8,
               stops: [{ t: 0, r: 200, g: 40, b: 90, a: 1 },
                       { t: 1, r: 10, g: 220, b: 30, a: 0.6 }] },
  });
  const out = applyAdjustments(src, overlay, blank(src));
  for (let i = 0; i < src.width * src.height; i++)
    assert.equal(out.data[i * 4 + 3], src.data[i * 4 + 3], `pixel ${i}`);
});

test('a zero-opacity or fully transparent overlay is neutral and is skipped', () => {
  const src = sweep();
  const plain = applyAdjustments(src, createAdjust({ contrast: 12 }), blank(src));
  for (const overlay of [
    { kind: 'linear', stops: RAMP, mode: 'normal', opacity: 0 },
    { kind: 'linear', mode: 'normal', opacity: 1,
      stops: [{ t: 0, r: 255, g: 0, b: 0, a: 0 }, { t: 1, r: 0, g: 0, b: 255, a: 0 }] },
  ]) {
    const a = createAdjust({ contrast: 12, overlay });
    assert.equal(isNeutralOverlay(a.overlay), true);
    assert.equal(adjustCostOf(a).overlay, false);
    assert.deepEqual([...applyAdjustments(src, a, blank(src)).data], [...plain.data]);
  }
});

test('the overlay goes through blendInto, so all 26 modes are available to it', () => {
  // Reuse, not reimplementation: a second copy of 26 blend modes inside the
  // overlay is a second thing that can drift from the pixel-validated oracle.
  const src = blackRow(4);
  const seen = new Set();
  for (const mode of SUPPORTED_BLEND_MODES) {
    const a = createAdjust({
      overlay: { kind: 'linear', angle: 0, stops: RAMP, mode, opacity: 1 },
    });
    assert.equal(a.overlay.mode, mode, `${mode} survived normalisation`);
    seen.add(applyAdjustments(src, a, blank(src)).data.join(','));
  }
  assert.ok(seen.size > 1, 'different modes must produce different results');
});

test('normaliseOverlay sorts stops, completes defaults and rejects an unknown mode', () => {
  const o = normaliseOverlay({
    kind: 'nonsense', mode: 'dissolve', opacity: 5,
    stops: [{ t: 1, r: 300, g: -5, b: 10, a: 2 }, { t: 0, r: 0, g: 0, b: 0, a: 1 }],
  });
  assert.equal(o.kind, 'linear');
  assert.equal(o.mode, 'normal', 'dissolve is the one mode the compositor does not implement');
  assert.equal(o.opacity, 1);
  assert.deepEqual(o.stops.map((s) => s.t), [0, 1], 'sorted by position');
  assert.equal(o.stops[1].r, 255);
  assert.equal(o.stops[1].g, 0);
  assert.equal(o.stops[1].a, 1);
  assert.equal(normaliseOverlay({ stops: [] }).stops.length, 2, 'a gradient needs two stops');
  assert.ok(normaliseOverlay({ radius: 0 }).radius > 0, 'a zero radius divides by zero');
});

console.log('\npresets\n');

test('every preset has a unique id and a label, and there are at least twelve', () => {
  assert.ok(PRESETS.length >= 12, `only ${PRESETS.length} presets`);
  assert.equal(new Set(PRESET_IDS).size, PRESETS.length, 'duplicate preset id');
  for (const p of PRESETS) assert.ok(p.label && p.label.length, `${p.id} has no label`);
});

test('every preset parameter is inside its op\'s declared range', () => {
  // A preset is authored by hand, so this is the only thing standing between a
  // typo and a table built from a clamped-at-the-boundary parameter that looks
  // deliberate.
  for (const p of PRESETS)
    for (const id of CLASS_A_ORDER) {
      const v = p[id] ?? 0;
      const [lo, hi] = OPS[id].range;
      assert.ok(v >= lo && v <= hi, `${p.id}.${id} = ${v}`);
    }
});

test('no preset is neutral, and every one builds a usable table', () => {
  for (const p of PRESETS) {
    const a = presetAdjust(p.id);
    assert.equal(isNeutralAdjust(a), false, `${p.id} does nothing`);
    const lut = buildLut(a);
    for (let i = 0; i < 768; i++)
      assert.ok(Number.isInteger(lut[i]) && lut[i] >= 0 && lut[i] <= 255, `${p.id} entry ${i}`);
  }
});

test('presetAdjust returns a frozen object carrying the preset id', () => {
  const a = presetAdjust('ember');
  assert.equal(a.preset, 'ember');
  assert.ok(Object.isFrozen(a));
  assert.equal(presetAdjust('no-such-preset').preset, 'none');
});

test('intensity scales every parameter toward neutral, and 0 IS neutral', () => {
  // One multiply on ten numbers, before the table is built. That is the whole
  // strength slider -- no new op, and nothing per pixel.
  const full = presetAdjust('ember', 1);
  const half = presetAdjust('ember', 0.5);
  for (const id of CLASS_A_ORDER)
    assert.ok(Math.abs(half[id] - full[id] / 2) < 1e-9, `${id}: ${half[id]} vs ${full[id] / 2}`);
  assert.equal(isNeutralAdjust(presetAdjust('ember', 0)), true);
});

test('intensity scales the hsl block too, not just the sliders', () => {
  const p = PRESETS.find((x) => x.hsl);
  const full = presetAdjust(p.id, 1);
  const half = presetAdjust(p.id, 0.5);
  assert.ok(Math.abs(half.hsl.saturation - full.hsl.saturation / 2) < 1e-9);
  full.hsl.bands.forEach((band, i) => {
    for (const k of ['h', 's', 'l'])
      assert.ok(Math.abs(half.hsl.bands[i][k] - band[k] / 2) < 1e-9, `band ${i}.${k}`);
  });
});

console.log('\nthe layer model\n');

/** Two full-canvas raster layers, built the way conformance.js builds its own. */
const twoLayerProject = () => createProject({
  width: 8, height: 8,
  children: [
    { name: 'bottom', left: 0, top: 0, right: 8, bottom: 8,
      proxyData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(160) } },
    { name: 'top', left: 0, top: 0, right: 8, bottom: 8,
      proxyData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(90) } },
  ],
}, 'two.psd');

test('a fresh layer carries adjust === null', () => {
  // null is the neutral value of the WHOLE object, and it is what makes a
  // document with no adjustments cost exactly what it costs today: one branch.
  for (const layer of twoLayerProject().layers) assert.equal(layer.adjust, null);
});

test('setAdjust replaces the object wholesale and freezes it', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 20 });
  assert.equal(p.layers[0].adjust.brightness, 20);
  assert.ok(Object.isFrozen(p.layers[0].adjust));
  const first = p.layers[0].adjust;
  setAdjust(p, id, { contrast: 10 });
  assert.notEqual(p.layers[0].adjust, first, 'a new object, never the same one mutated');
  assert.equal(p.layers[0].adjust.brightness, 20, 'the merge kept the earlier parameter');
});

test('mutating a STALE layer.adjust reference does not corrupt undo', () => {
  // setLayer does `from[key] = layer[key]`, so an object-valued field's undo
  // entry holds THE SAME OBJECT as the new value. If a caller could mutate it,
  // undo would restore the mutated version -- a no-op that looks like undo is
  // broken rather than like the mutation was wrong. Freezing makes the attempt
  // throw; this asserts the outcome that matters either way.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 20 });
  const stale = p.layers[0].adjust;
  setAdjust(p, id, { brightness: 80 });
  assert.throws(() => { 'use strict'; stale.brightness = 999; }, TypeError);
  undo(p);
  assert.equal(p.layers[0].adjust.brightness, 20, 'undo restored the real earlier value');
});

test('one gesture key is ONE history entry, and revision does not move during the drag', () => {
  // The whole reason the sandwich cache survives a slider drag. revision is
  // bumped by commit/undo/redo/applyProjectJson but NOT by setLayer's
  // coalescing early-return, and sandwich.js keys on revision. Move this bump
  // and the drag cache is worthless.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  const key = nextGestureKey('adjust');
  setAdjust(p, id, { brightness: 10 }, key);
  const afterFirst = p.revision;
  const historyAfterFirst = p.history.length;
  for (let v = 11; v <= 40; v++) setAdjust(p, id, { brightness: v }, key);
  assert.equal(p.history.length, historyAfterFirst, 'thirty frames, one undo step');
  assert.equal(p.revision, afterFirst, 'revision must NOT move on a coalesced frame');
  assert.ok(p.mutation > afterFirst, 'mutation must move on every applied frame');
  assert.equal(p.layers[0].adjust.brightness, 40);
  undo(p);
  assert.equal(p.layers[0].adjust, null, 'one undo returns to where the drag started');
});

test('two separate drags are two undo steps', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 10 }, nextGestureKey('adjust'));
  setAdjust(p, id, { brightness: 40 }, nextGestureKey('adjust'));
  assert.equal(p.history.length, 2);
  undo(p);
  assert.equal(p.layers[0].adjust.brightness, 10, 'undo restores the PREVIOUS value, not neutral');
});

test('touching a slider marks the preset custom; applying one does not', () => {
  // Silently keeping the highlight would claim a look the numbers no longer are.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, presetAdjust('ember'));
  assert.equal(p.layers[0].adjust.preset, 'ember');
  setAdjust(p, id, { contrast: 60 });
  assert.equal(p.layers[0].adjust.preset, 'custom');
});

test('an adjustment pulled back to neutral is stored as null', () => {
  // Not an empty object. isNeutralAdjust short-cuts the entire pass on null,
  // and a layer that has been reset must cost what an untouched one costs.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 30 });
  setAdjust(p, id, { brightness: 0 });
  assert.equal(p.layers[0].adjust, null);
});

test('discardTo returns the layer to its pre-sheet state in one call', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, presetAdjust('ember'));
  const mark = p.history.length;                 // the sheet opens here
  setAdjust(p, id, { brightness: 40 }, nextGestureKey('adjust'));
  setAdjust(p, id, { contrast: -30 }, nextGestureKey('adjust'));
  setAdjust(p, id, { temperature: 90 }, nextGestureKey('adjust'));
  assert.equal(discardTo(p, mark), 3);
  assert.equal(p.layers[0].adjust.preset, 'ember');
  assert.equal(p.layers[0].adjust.brightness, presetAdjust('ember').brightness);
  assert.equal(p.history.length, mark);
});

test('discardTo leaves `future` empty rather than stashing the experiment on redo', () => {
  // A discarded experiment sitting on the redo stack is something the user
  // finds again by accident and cannot explain.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  const mark = p.history.length;
  setAdjust(p, id, { brightness: 40 });
  discardTo(p, mark);
  assert.equal(p.future.length, 0);
});

test('discardTo bumps revision once, not once per pop', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  const mark = p.history.length;
  for (const v of [10, 20, 30, 40]) setAdjust(p, id, { brightness: v }, nextGestureKey('adjust'));
  const before = p.revision;
  discardTo(p, mark);
  assert.equal(p.revision, before + 1, 'one user action, one structural change');
});

test('discardTo past the current length, or below zero, is a no-op', () => {
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 12 });
  const before = p.revision;
  assert.equal(discardTo(p, 99), 0);
  assert.equal(discardTo(p, -5), 1, 'a negative target clamps to zero and empties the history');
  assert.equal(p.layers[0].adjust, null);
  assert.equal(p.revision, before + 1);
});

test('toProjectJson carries every parameter, including hsl bands and overlay stops', () => {
  const p = twoLayerProject();
  const bands = NEUTRAL_BANDS();
  bands[5] = { h: -40, s: 55, l: -12 };
  setAdjust(p, p.layers[0].id, {
    brightness: 14, contrast: -22, exposure: 9, temperature: 31, tint: -7,
    hsl: { bands, saturation: 18 },
    overlay: { kind: 'radial', cx: 0.3, cy: 0.7, radius: 0.42, mode: 'soft light', opacity: 0.65,
               stops: [{ t: 0, r: 12, g: 34, b: 56, a: 0.9 }, { t: 1, r: 200, g: 10, b: 5, a: 0.2 }] },
  });

  const json = toProjectJson(p);
  const saved = json.layers[0].adjust;
  assert.equal(saved.brightness, 14);
  assert.equal(saved.hsl.bands[5].s, 55);
  assert.equal(saved.overlay.stops[1].r, 200);
  assert.equal(json.layers[1].adjust, null, 'an unadjusted layer saves null, not an object');
});

test('applyProjectJson restores every parameter, re-frozen', () => {
  const source = twoLayerProject();
  setAdjust(source, source.layers[0].id, {
    brightness: 14, hsl: { bands: NEUTRAL_BANDS(), saturation: 18 },
    overlay: { kind: 'radial', mode: 'soft light', opacity: 0.65,
               stops: [{ t: 0, r: 12, g: 34, b: 56, a: 0.9 }, { t: 1, r: 200, g: 10, b: 5, a: 0.2 }] },
  });
  const json = JSON.parse(JSON.stringify(toProjectJson(source)));   // a real round trip through text

  const target = twoLayerProject();
  applyProjectJson(target, json);
  const a = target.layers[0].adjust;
  assert.equal(a.brightness, 14);
  assert.equal(a.hsl.saturation, 18);
  assert.equal(a.overlay.kind, 'radial');
  assert.equal(a.overlay.mode, 'soft light');
  assert.equal(a.overlay.stops[1].r, 200);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.hsl) && Object.isFrozen(a.overlay));
  assert.equal(target.layers[1].adjust, null);
});

test('applyProjectJson clamps a hand-edited out-of-range parameter', () => {
  // The save file is text on a device. It reaches an evaluator only through
  // createAdjust, so an absurd number becomes the boundary rather than a table
  // full of clipped values that looks deliberate.
  const target = twoLayerProject();
  const json = toProjectJson(twoLayerProject());
  json.layers[0].adjust = { brightness: 9e9, contrast: -9e9 };
  applyProjectJson(target, json);
  assert.equal(target.layers[0].adjust.brightness, 100);
  assert.equal(target.layers[0].adjust.contrast, -100);
});

test('the derived LUT is not persisted and is rebuilt from parameters', () => {
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { contrast: 44 });
  lutFor(p.layers[0]);                                   // populate the cache
  assert.equal(toProjectJson(p).layers[0].lut, undefined);
  assert.equal(toProjectJson(p).layers[0].lutKey, undefined);

  const target = twoLayerProject();
  applyProjectJson(target, JSON.parse(JSON.stringify(toProjectJson(p))));
  assert.deepEqual([...lutFor(target.layers[0])], [...lutFor(p.layers[0])]);
});

console.log('\nthe render hook\n');

test('resample() identity-returns its input when the dimensions already match', () => {
  // The PRECONDITION of the whole aliasing hazard, pinned so nobody removes the
  // early return and quietly deletes the reason applyAdjustments guards itself.
  // 1B's finding 4: this is the DEFAULT preview path, not an edge case --
  // downscaleImage produces round(w * proxyScale) and renderProject at
  // scale = proxyScale asks for the same expression.
  const src = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  assert.equal(resample(src, 8, 8), src, 'same object, not a copy');
});

test('a render NEVER writes into layer.pixels', () => {
  // THE assertion the non-destructive claim stands on. Applied in place, a
  // brightness adjustment would overwrite the layer's originals permanently --
  // and because the next frame reads the same buffer it would compound, so a
  // held slider runs away to white with nothing on screen to say so.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 90, contrast: 60 });
  const before = new Uint8ClampedArray(p.layers[0].pixels.data);
  renderProject(p, { scale: 1 });
  assert.deepEqual([...p.layers[0].pixels.data], [...before], 'the source was mutated');
});

test('rendering the same project twice produces identical frames', () => {
  // The compounding half. One frame proves the buffer was not aliased; two
  // prove it cannot accumulate, which is what a drag actually does.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 90, contrast: 60 });
  const first = renderProject(p, { scale: 1 });
  const second = renderProject(p, { scale: 1 });
  assert.deepEqual([...first.data], [...second.data]);
});

test('an adjustment changes the layer it is on and nothing else', () => {
  const p = twoLayerProject();
  p.layers[1].visible = false;                          // isolate the bottom layer
  const plain = renderProject(p, { scale: 1 });
  setAdjust(p, p.layers[1].id, { brightness: 100 });    // adjust the HIDDEN one
  assert.deepEqual([...renderProject(p, { scale: 1 }).data], [...plain.data],
    'an adjustment on a hidden layer must change nothing');
  setAdjust(p, p.layers[0].id, { brightness: 100 });
  assert.notDeepEqual([...renderProject(p, { scale: 1 }).data], [...plain.data]);
});

test('a layer with no adjustment renders byte-identically to before this phase', () => {
  // The one-branch guarantee. A document with no adjustments must cost exactly
  // what it cost yesterday, and produce exactly the same pixels.
  const p = twoLayerProject();
  const plain = renderProject(p, { scale: 1 });
  setAdjust(p, p.layers[0].id, { brightness: 0 });      // neutral -> stored as null
  assert.equal(p.layers[0].adjust, null);
  assert.deepEqual([...renderProject(p, { scale: 1 }).data], [...plain.data]);
});

test('the two cost terms are counted separately, per frame', () => {
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { contrast: 20 });
  setAdjust(p, p.layers[1].id, {
    hsl: { bands: NEUTRAL_BANDS(), saturation: -50 },
  });
  const stats = createRenderStats();
  renderProject(p, { scale: 1, stats });
  assert.equal(stats.layers, 2);
  assert.equal(stats.lut, 1, 'one layer carried a class-A table');
  assert.equal(stats.hsl, 1, 'one layer carried the expensive pass');
  assert.equal(stats.overlay, 0);
});

test('a cached sandwich frame counts only the live layer, because only it ran', () => {
  // Reporting what a frame WOULD have cost rather than what it DID cost is the
  // same lie the measured ladder exists to replace. During a drag, `below` and
  // `above` are cached composites that already contain their layers'
  // adjustments, computed once at cache build.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { contrast: 20 });
  setAdjust(p, p.layers[1].id, { contrast: 20 });
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });          // build
  const stats = createRenderStats();
  renderSandwiched(cache, p, 1, { scale: 1, stats });   // cached
  assert.equal(stats.lut, 1, 'only the live layer re-adjusted');
});

console.log('\nexport parity\n');

const bytesOf = (path) => new Uint8Array(fs.readFileSync(path));
const FIXTURE = 'fixtures/vectors.src.psd';
const FIXTURE_SIZE = fs.statSync(FIXTURE).size;

const openProxy = () => loadProjectProxy(bytesOf(FIXTURE), {
  fileName: 'vectors.src.psd',
  proxyEdge: 256,
  source: { uri: FIXTURE, name: 'vectors.src.psd', size: FIXTURE_SIZE, kind: 'blob' },
});

const runExport = (project, spill) => exportFullRes({
  project, readSource: async () => bytesOf(FIXTURE), spill, createTarget: createJsExportTarget,
});

await atest('the JS export target and renderProject produce the identical buffer', async () => {
  // Both go through drawLayerInto, so this is the assertion that the hook has
  // exactly one implementation rather than two that happen to agree today.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 40, contrast: -25 });
  setAdjust(p, p.layers[1].id, {
    overlay: { kind: 'linear', angle: 45, mode: 'multiply', opacity: 0.7,
               stops: [{ t: 0, r: 255, g: 200, b: 0, a: 1 }, { t: 1, r: 0, g: 30, b: 120, a: 1 }] },
  });

  const target = createJsExportTarget(p.width, p.height);
  for (const layer of p.layers) target.blend(layer, layer.pixels);
  const exported = await target.finish();

  assert.deepEqual([...exported.data], [...renderProject(p, { scale: 1 }).data]);
});

await atest('a full-resolution streamed export carries the adjustment', async () => {
  // End to end, through the real walk on a real fixture -- the file is re-read
  // and re-decoded, so these are the FULL-RESOLUTION pixels, not the proxy the
  // editor is holding.
  const plainProject = await openProxy();
  const plain = await runExport(plainProject, createMemorySpill());

  const adjusted = await openProxy();
  // DARKEN, not brighten. Layer 0 of this fixture is "Background", which is
  // pure white (255,255,255) across all 65536 pixels -- verified, not assumed.
  // `brightness: +60` clamps to 255 and changes nothing, so the original form
  // of this test failed while the export was working perfectly: it had picked
  // an input that cannot discriminate. A negative delta moves white and makes
  // the assertion mean what its name says.
  setAdjust(adjusted, adjusted.layers[0].id, { brightness: -60 });
  const out = await runExport(adjusted, createMemorySpill());

  assert.equal(out.width, plain.width);
  assert.notDeepEqual([...out.data], [...plain.data], 'the adjustment never reached the export');
});

await atest('for a single opaque layer the export equals the LUT applied to the plain export', async () => {
  // The exact parity claim, not an approximation of it. With one visible layer
  // blending `normal` onto a transparent backdrop, blendInto reduces to
  // dest = src, so the exported byte IS the adjusted source byte -- and the
  // adjusted source byte is, by construction, lut[plain byte].
  const plainProject = await openProxy();
  for (let i = 1; i < plainProject.layers.length; i++) plainProject.layers[i].visible = false;
  const plain = await runExport(plainProject, createMemorySpill());

  const adjustedProject = await openProxy();
  for (let i = 1; i < adjustedProject.layers.length; i++) adjustedProject.layers[i].visible = false;
  setAdjust(adjustedProject, adjustedProject.layers[0].id, { contrast: 45, temperature: -20 });
  const out = await runExport(adjustedProject, createMemorySpill());

  const lut = buildLut(adjustedProject.layers[0].adjust);
  let checked = 0;
  for (let i = 0; i < plain.data.length; i += 4) {
    if (plain.data[i + 3] === 0) continue;               // blendInto skipped it in both
    assert.equal(out.data[i], lut[plain.data[i]], `pixel ${i / 4} red`);
    assert.equal(out.data[i + 1], lut[256 + plain.data[i + 1]], `pixel ${i / 4} green`);
    assert.equal(out.data[i + 2], lut[512 + plain.data[i + 2]], `pixel ${i / 4} blue`);
    checked++;
  }
  assert.ok(checked > 1000, `only ${checked} opaque pixels checked`);
});

await atest('the export target owns its scratch and releases it before the encode peak', async () => {
  // At scale 1 the scratch has grown to the largest layer in the document --
  // +66.4 MB for the measured poster. It must not still be resident while the
  // PNG encoder allocates, which is the same place 1C already drops the file
  // bytes.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 40 });
  const target = createJsExportTarget(p.width, p.height);
  for (const layer of p.layers) target.blend(layer, layer.pixels);
  assert.ok(target.scratch.data, 'the scratch was never acquired');
  await target.finish();
  assert.equal(target.scratch.data, null, 'finish() must drop it');

  const second = createJsExportTarget(p.width, p.height);
  second.blend(p.layers[0], p.layers[0].pixels);
  second.dispose();
  assert.equal(second.scratch.data, null, 'dispose() must drop it too');
});

console.log('\ncache invalidation\n');

/** Three full-canvas layers, so there is something above AND below a selection. */
const threeLayerProject = () => createProject({
  width: 8, height: 8,
  children: [0, 1, 2].map((i) => ({
    name: `L${i}`, left: 0, top: 0, right: 8, bottom: 8,
    proxyData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(60 + i * 60) },
  })),
}, 'three.psd');

test('a coalesced adjustment drag reuses ONE cache build while the frame keeps changing', () => {
  // The whole reason src/sandwich.js exists. If revision moved on a coalesced
  // frame, every drag frame would rebuild TWO full composites of the rest of
  // the stack -- and it would fail silently, by being slow.
  const p = threeLayerProject();
  const cache = createSandwichCache();
  const id = p.layers[1].id;
  const key = nextGestureKey('adjust');

  setAdjust(p, id, { brightness: 5 }, key);          // first frame: commit, revision moves
  const firstFrame = renderSandwiched(cache, p, 1, { scale: 1 });
  const builds = cache.builds;
  assert.equal(builds, 1);

  let lastFrame = firstFrame;
  for (let v = 10; v <= 90; v += 10) {
    setAdjust(p, id, { brightness: v }, key);
    lastFrame = renderSandwiched(cache, p, 1, { scale: 1 });
    assert.equal(cache.builds, builds, `frame at brightness ${v} rebuilt the cache`);
  }
  assert.notDeepEqual([...lastFrame.data], [...firstFrame.data],
    'the cache held but the frame never changed -- the live layer is not re-adjusting');
});

test('the first frame of a drag rebuilds exactly once', () => {
  const p = threeLayerProject();
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });
  assert.equal(cache.builds, 1);
  setAdjust(p, p.layers[1].id, { brightness: 20 }, nextGestureKey('adjust'));
  renderSandwiched(cache, p, 1, { scale: 1 });
  assert.equal(cache.builds, 2, 'a commit must invalidate; `below` and `above` are stale');
});

test('an adjustment on a layer BELOW the selection rebuilds the cache', () => {
  // `below` is a real composite of those layers, so it has to be redone. Same
  // for above. Getting this wrong in the other direction is the failure that
  // shows a stale backdrop for the rest of a gesture.
  const p = threeLayerProject();
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });
  const builds = cache.builds;
  setAdjust(p, p.layers[0].id, { brightness: 70 });
  const after = renderSandwiched(cache, p, 1, { scale: 1 });
  assert.equal(cache.builds, builds + 1);
  assert.ok(after.data.some((v, i) => v !== 0 || i % 4 === 3));
});

test('a discarded sheet session invalidates the cache once', () => {
  const p = threeLayerProject();
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });
  const mark = p.history.length;
  const builds = cache.builds;
  for (const v of [20, 40, 60]) setAdjust(p, p.layers[1].id, { brightness: v }, nextGestureKey('adjust'));
  discardTo(p, mark);
  renderSandwiched(cache, p, 1, { scale: 1 });
  assert.ok(cache.builds > builds, 'the cache must not survive a rollback');
  assert.equal(p.layers[1].adjust, null);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
