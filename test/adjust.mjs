import assert from 'node:assert/strict';
import {
  CLASS_A_ORDER, OPS, NEUTRAL_ADJUST, createAdjust,
  buildLut, lutDigest, lutFor, isNeutralAdjust, adjustCostOf,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
