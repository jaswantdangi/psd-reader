import assert from 'node:assert/strict';
import {
  CLASS_A_ORDER, OPS, NEUTRAL_ADJUST, createAdjust,
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
