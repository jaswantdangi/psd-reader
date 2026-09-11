/**
 * Reading a font file's own PostScript name, and moving its bytes as JSON.
 *
 * The plugin identifies a font FILE by what the file says it is -- the sfnt
 * `name` table's nameID 6, the same string a PSD stores -- because Photoshop's
 * API never says where a font's file lives. These fixtures are built in memory
 * (test/make-font.mjs); the repo holds no licensed font files.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  fontNamesIn, candidateOrder, bytesToBase64, base64ToBytes, sha256Hex, chunkFont, assembleFont,
} from '../src/sync/font-file.js';
import { FONT_CHUNK_BYTES } from '../src/sync/protocol.js';
import { makeFont, makeCollection } from './make-font.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('\nfont files — reading a name, moving the bytes\n');

test('a TrueType file names itself by its PostScript name', () => {
  assert.deepEqual(fontNamesIn(makeFont('MyriadPro-Regular', { family: 'Myriad Pro' })),
    { postscriptName: 'MyriadPro-Regular', family: 'Myriad Pro', subfamily: 'Regular' });
});

test('CFF (OTTO) and Apple (true) signatures read the same way', () => {
  assert.equal(fontNamesIn(makeFont('A-Bold', { signature: 'OTTO' })).postscriptName, 'A-Bold');
  assert.equal(fontNamesIn(makeFont('B-Bold', { signature: 'true' })).postscriptName, 'B-Bold');
});

test('the Windows English record wins over the Mac one', () => {
  assert.equal(fontNamesIn(makeFont('Roboto-Regular', { platform: 'both' })).postscriptName, 'Roboto-Regular');
});

test('a Mac-only name table is still read', () => {
  assert.equal(fontNamesIn(makeFont('Futura-Medium', { platform: 'mac' })).postscriptName, 'Futura-Medium');
});

test('a collection lists every font inside it', () => {
  const r = fontNamesIn(makeCollection(['Cambria', 'CambriaMath']));
  assert.equal(r.collection, true);
  assert.deepEqual(r.fonts.map((f) => f.postscriptName), ['Cambria', 'CambriaMath']);
});

test('WOFF and WOFF2 are recognised and refused, not misread', () => {
  const sig = (s) => { const b = new Uint8Array(64); for (let i = 0; i < 4; i++) b[i] = s.charCodeAt(i); return b; };
  assert.deepEqual(fontNamesIn(sig('wOFF')), { unsupported: 'woff' });
  assert.deepEqual(fontNamesIn(sig('wOF2')), { unsupported: 'woff' });
});

test('anything that is not a font, or is cut short, is null', () => {
  assert.equal(fontNamesIn(new Uint8Array(0)), null);
  assert.equal(fontNamesIn(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(fontNamesIn(makeFont('X-Regular').subarray(0, 40)), null);
  assert.equal(fontNamesIn(undefined), null);
});

test('an ArrayBuffer is accepted as well as a Uint8Array', () => {
  const b = makeFont('Y-Regular');
  assert.equal(fontNamesIn(b.buffer.slice(0)).postscriptName, 'Y-Regular');
});

test('random and corrupted bytes never throw', () => {
  for (let i = 0; i < 300; i++) fontNamesIn(randomBytes(1 + (i % 200)));
  for (let i = 0; i < 100; i++) {
    const b = makeFont('Z-Regular');
    b[4 + (i % 60)] ^= 0xff;
    fontNamesIn(b);
  }
});

test('candidateOrder opens the likely file first and drops nothing', () => {
  const files = ['arial.ttf', 'MyriadPro-Regular.otf', 'times.ttf', 'MyriadPro-Bold.otf'];
  assert.deepEqual(candidateOrder(['MyriadPro-Regular'], files),
    ['MyriadPro-Regular.otf', 'MyriadPro-Bold.otf', 'arial.ttf', 'times.ttf']);
  assert.deepEqual(candidateOrder(['Nothing'], files), files, 'no resemblance keeps the listing order');
});

test('base64 agrees with Node for every tail length', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 1000]) {
    const b = new Uint8Array(randomBytes(n));
    const text = bytesToBase64(b);
    assert.equal(text, Buffer.from(b).toString('base64'), `length ${n}`);
    assert.deepEqual(base64ToBytes(text), b);
  }
});

test('malformed base64 decodes to null', () => {
  assert.equal(base64ToBytes('abc'), null);
  assert.equal(base64ToBytes('ab$='), null);
  assert.equal(base64ToBytes(42), null);
});

test('sha256 agrees with Node at every padding boundary', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 1 << 20]) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(sha256Hex(b), createHash('sha256').update(b).digest('hex'), `length ${n}`);
  }
});

test('a font splits into chunks and reassembles byte for byte, in any order', () => {
  const font = makeFont('Big-Regular', { padding: 1_200_000 });
  const frames = chunkFont(font, { name: 'Big-Regular', fileName: 'Big-Regular.otf' });
  assert.equal(frames.length, 3);
  for (const f of frames) {
    assert.equal(f.type, 'font-chunk');
    assert.ok(base64ToBytes(f.data).length <= FONT_CHUNK_BYTES);
  }
  const result = assembleFont([frames[2], frames[0], frames[1]]);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.bytes, font);
});

test('a small font is one chunk', () => {
  assert.equal(chunkFont(makeFont('S-Regular'), { name: 'S-Regular', fileName: 's.ttf' }).length, 1);
});

test('reassembly refuses a missing chunk, a damaged one, and a stranger', () => {
  const frames = chunkFont(makeFont('Big-Regular', { padding: 1_200_000 }), { name: 'Big-Regular', fileName: 'b.otf' });
  assert.match(assembleFont([frames[0], frames[2]]).reason, /chunk 2 of 3 never arrived/);

  const damaged = frames.map((f) => ({ ...f }));
  const at = 100;
  damaged[1].data = damaged[1].data.slice(0, at) + (damaged[1].data[at] === 'A' ? 'B' : 'A') + damaged[1].data.slice(at + 1);
  assert.match(assembleFont(damaged).reason, /damaged/);

  const other = chunkFont(makeFont('Other-Regular'), { name: 'Other-Regular', fileName: 'o.otf' })[0];
  assert.match(assembleFont([frames[0], { ...other, index: 1, count: 3 }]).reason, /disagree/);
  assert.equal(assembleFont([]).ok, false);
});

console.log(`\n${passed} passed`);
