/**
 * The two things a PSD text layer carries that never reached the model:
 * the transform's SCALE, and the real typeface name.
 *
 * ## Why this suite exists separately from test/edit.mjs
 *
 * test/edit.mjs asserts what the editable model ends up holding. This asserts
 * the same facts against the FILE'S OWN BYTES, by walking the layer records and
 * parsing the text-engine block directly. That independence is the point: the
 * font name we show a user comes out of ag-psd's `decodeEngineData`, and the
 * only way to know it is right is to read the same bytes a second way and
 * demand the two answers agree.
 *
 * It is also how the original spike was caught being wrong -- see
 * `src/engine-data.js` for the three claims it made that the file does not
 * support.
 */
import fs from 'fs';
import assert from 'node:assert/strict';

import { readDocument } from '../src/reader.js';
import { createProject } from '../src/edit.js';
import {
  readTextEngineLayers, parseEngineData, textEngineFacts,
  textTransformOf, sourceFontName, fontStackFor, effectiveFontSize,
  PLACEHOLDER_FONT, FONT_STACKS,
} from '../src/engine-data.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const read = (name) => new Uint8Array(fs.readFileSync('fixtures/' + name));
const close = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

console.log('\ntext engine — the transform\n');

/**
 * The measurement the whole of Bug 1 rests on.
 *
 * `style.fontSize` is the PRE-transform size. Photoshop draws
 * `fontSize x scale`, and this layer's matrix scales by 0.249 -- so the file
 * says 66.67 and the screen shows 16.6. Reading `fontSize` alone drew it 4x
 * too large. Both of the other text fixtures carry an identity transform,
 * which is exactly why nothing caught it.
 */
test("a text layer's transform carries a scale, and it is not 1", () => {
  const doc = { transform: [0.24891101431238333, 0, 0, 0.2490135905304691, 203.42217452911237, 362.9860906579289] };
  const t = textTransformOf(doc.transform);
  close(t.scaleX, 0.24891101431238333, 1e-12, 'scaleX = hypot(a, b)');
  close(t.scaleY, 0.2490135905304691, 1e-12, 'scaleY = hypot(c, d)');
  assert.equal(t.rotation, 0, 'b and c are both zero, so nothing is rotated');
  assert.equal(t.uniform, true, 'the two axes agree to 0.05%');
  assert.equal(t.identity, false);
});

test('fontSize x scale is what Photoshop draws — 16.6, not 66.7', () => {
  const size = effectiveFontSize(
    { fontSize: 66.66666 },
    [0.24891101431238333, 0, 0, 0.2490135905304691, 203.42217452911237, 362.9860906579289],
  );
  close(size, 16.6, 0.01, 'the size Photoshop puts on screen');
});

test('an identity transform changes nothing', () => {
  assert.equal(effectiveFontSize({ fontSize: 30 }, [1, 0, 0, 1, 36, 66]), 30);
  const t = textTransformOf([1, 0, 0, 1, 36, 66]);
  assert.equal(t.identity, true);
  assert.equal(t.uniform, true);
  assert.equal(t.rotation, 0);
});

test('a missing or malformed transform is treated as identity, never as zero', () => {
  // A scale of 0 would compute a font size of 0 and draw nothing at all. Every
  // rejection path here has to land on 1.
  for (const bad of [undefined, null, [], [1, 0, 0], ['a', 0, 0, 1, 0, 0], [NaN, 0, 0, 1, 0, 0]]) {
    const t = textTransformOf(bad);
    assert.equal(t.scaleX, 1, `${JSON.stringify(bad)} must fall back to scale 1`);
    assert.equal(t.scaleY, 1);
    assert.equal(t.identity, true);
  }
});

test('rotation is detected rather than silently flattened', () => {
  // 30 degrees, scale 2. hypot() recovers the 2 and throws the angle away, so
  // the angle has to be reported or the layer renders upright and "correct".
  const c = Math.cos(Math.PI / 6) * 2, s = Math.sin(Math.PI / 6) * 2;
  const t = textTransformOf([c, s, -s, c, 0, 0]);
  close(t.scaleX, 2, 1e-12, 'scale survives the rotation');
  close(t.scaleY, 2, 1e-12);
  close(t.rotation, 30, 1e-9, 'degrees, positive clockwise in PSD space');
  assert.equal(t.rotated, true);
});

test('a non-uniform scale is reported, never averaged away', () => {
  const t = textTransformOf([2, 0, 0, 1, 0, 0]);
  assert.equal(t.scaleX, 2);
  assert.equal(t.scaleY, 1);
  assert.equal(t.uniform, false);
  // The font size follows the VERTICAL axis, because that is the axis a font
  // size measures. Averaging would invent a size neither axis has.
  assert.equal(effectiveFontSize({ fontSize: 40 }, [2, 0, 0, 1, 0, 0]), 40);
});

console.log('\ntext engine — the block in the file\n');

test('every fixture parses, or says why it cannot', () => {
  // Fails LOUDLY: a walk that silently returned [] on a file it could not read
  // would look exactly like a file with no text in it.
  const files = fs.readdirSync('fixtures').filter((f) => /\.(psd|psb)$/.test(f));
  assert.equal(files.length, 30, "every PSD and PSB in the corpus");
  let withText = 0;
  for (const f of files) {
    const found = readTextEngineLayers(read(f));   // throws on a structure it cannot follow
    withText += found.length;
  }
  assert.equal(withText, 4, 'four layers across the corpus carry a live text engine');
});

test('the layers the walk finds are the layers ag-psd calls text', async () => {
  for (const f of ['float-color.src.psd', 'text.src.psd', 'text-box.src.psd', 'text.expected.psd', 'werps.src.psd']) {
    const doc = await readDocument(read(f), { pixels: 'none', metadata: false, patterns: false });
    const fromLibrary = doc.layers.filter((l) => l.text).map((l) => l.name).sort();
    const fromBytes = readTextEngineLayers(read(f)).map((l) => l.name).sort();
    assert.deepEqual(fromBytes, fromLibrary, `${f}: two readings of the same file must agree`);
  }
});

/**
 * The spike's third wrong claim, and the reason the walk is structural.
 *
 * A regex over the whole file finds `/FontSet` and `/StyleRun` inside
 * werps.src.psd and reports ["Roboto-Regular", "MyriadPro-Regular"]. Walking
 * the layer records finds no TySh block on any of its seven layers: that engine
 * data belongs to something that is not a live text layer, and ag-psd agrees --
 * it exposes no `text` on any of them.
 */
test('werps.src.psd has engine data in it and no live text layer', () => {
  const raw = Buffer.from(read('werps.src.psd')).toString('latin1');
  assert.ok(raw.includes('/EngineDict'), 'the bytes a whole-file regex would find');
  assert.deepEqual(readTextEngineLayers(read('werps.src.psd')), [], 'and not one of them is on a text layer');
});

test('the font a run names is resolved against the FontSet the run indexes', () => {
  const [glow] = readTextEngineLayers(read('float-color.src.psd'));
  const facts = textEngineFacts(glow.engineData);
  assert.deepEqual(facts.fontSet, ['AachenBTBold', 'AdobeInvisFont', 'MyriadPro-Regular']);
  assert.deepEqual(facts.runs, [{ length: 11, fontIndex: 0, fontName: 'AachenBTBold', fontSize: 66.66666 }]);
  assert.equal(facts.font, 'AachenBTBold');
});

/**
 * The spike's second wrong claim. It reported MyriadPro-Regular for these two
 * files; the run does not name a font at all. Its `/StyleRun`-to-`/ParagraphRun`
 * window is a heuristic and `/ParagraphRun` comes BEFORE `/StyleRun` in every
 * one of these files, so the window ran 8000 characters past the layer's runs
 * and swept up the `/Font 1` from ResourceDict's document-level StyleSheetSet.
 * FontSet[1] there is MyriadPro-Regular, which is why the answer looked right.
 */
test('a run that names no font resolves to the placeholder, not to a guess', () => {
  for (const f of ['text.src.psd', 'text-box.src.psd']) {
    const facts = textEngineFacts(readTextEngineLayers(read(f))[0].engineData);
    assert.deepEqual(facts.fontSet, ['AdobeInvisFont', 'MyriadPro-Regular'], f);
    assert.ok(facts.runs.every((r) => r.fontIndex === null), `${f}: no /Font key in any run`);
    assert.equal(facts.font, PLACEHOLDER_FONT, `${f}: index 0 is what Photoshop falls back to`);
  }
});

test('per-character style runs are present in the corpus and are recorded', () => {
  // One character then four. We render one style per layer, which is a
  // deliberate limit rather than a reading failure -- so it has to be visible
  // here, or the next person will assume the files never needed it.
  const facts = textEngineFacts(readTextEngineLayers(read('text-box.src.psd'))[0].engineData);
  assert.deepEqual(facts.runs.map((r) => r.length), [1, 4]);
  assert.equal(facts.runCount, 2);
  assert.deepEqual(facts.runs.map((r) => r.fontSize), [30, 30], 'both runs are the same size');
});

test('a flattened file keeps its engine block and has nothing real in it', () => {
  const facts = textEngineFacts(readTextEngineLayers(read('text.expected.psd'))[0].engineData);
  assert.deepEqual(facts.fontSet, ['AdobeInvisFont'], 'ag-psd rewrote this file and kept only the placeholder');
  assert.equal(facts.font, PLACEHOLDER_FONT);
});

test('the parser reads strings, not bytes between brackets', () => {
  // Names are UTF-16BE behind a BOM, and Photoshop escapes a literal
  // parenthesis with a backslash. `/Name \(([^)]*)\)/` mis-reads both.
  // Exactly how Photoshop writes one: BOM, UTF-16BE, and a backslash before any
  // byte that is '(', ')' or '\' — inside a code unit as readily as between two.
  const psString = (s) => {
    const out = [0xfe, 0xff];
    for (const ch of s) {
      for (const byte of [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]) {
        if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out.push(0x5c);
        out.push(byte);
      }
    }
    return out;
  };
  const block = Uint8Array.from([
    ...Buffer.from('\n\n<<\n/A\n<<\n/Name ('), ...psString('Fun)Fa(ce'),
    ...Buffer.from(')\n/N 3\n/B true\n/Empty ()\n>>\n/Arr [ 1 2 ]\n>>'),
  ]);
  const parsed = parseEngineData(block);
  assert.equal(parsed.A.Name, 'Fun)Fa(ce', 'both escaped brackets are part of the name');
  assert.equal(parsed.A.N, 3);
  assert.equal(parsed.A.B, true);
  assert.equal(parsed.A.Empty, '', 'an empty string carries no BOM and is still a string');
  assert.deepEqual(parsed.Arr, [1, 2]);
});

test('a block that is not engine data throws instead of returning something plausible', () => {
  assert.throws(() => parseEngineData(Uint8Array.from(Buffer.from('not engine data at all'))), /engine data/i);
  assert.throws(() => textEngineFacts(Uint8Array.from(Buffer.from('\n\n<<\n/EngineDict\n<<\n>>\n>>'))), /ResourceDict|FontSet/);
});

console.log('\ntext engine — what we substitute\n');

test('the placeholder is not a typeface and is never reported as one', () => {
  assert.equal(sourceFontName({ font: { name: PLACEHOLDER_FONT } }), null);
  assert.equal(sourceFontName({ font: { name: 'AachenBTBold' } }), 'AachenBTBold');
  assert.equal(sourceFontName({}), null);
  assert.equal(sourceFontName(undefined), null);
});

test('a serif name does not become Arial', () => {
  assert.equal(fontStackFor('TimesNewRomanPSMT'), '"Times New Roman", Times, serif');
  assert.equal(fontStackFor('Georgia-Bold'), 'Georgia, serif');
  assert.equal(fontStackFor('AGaramondPro-Regular'), 'Georgia, serif');
  assert.equal(fontStackFor('CourierNewPS-BoldMT'), '"Courier New", Courier, monospace');
  assert.equal(fontStackFor('Consolas'), '"Courier New", Courier, monospace');
  assert.equal(fontStackFor('Verdana'), 'Verdana, Geneva, sans-serif');
  assert.equal(fontStackFor('MyriadPro-Regular'), FONT_STACKS[0], 'a sans is a sans');
  assert.equal(fontStackFor('Roboto-Regular'), FONT_STACKS[0]);
  assert.equal(fontStackFor('Impact'), 'Impact, sans-serif');
});

test('"sans-serif" in a name is not a serif', () => {
  assert.equal(fontStackFor('OpenSans-Regular'), FONT_STACKS[0]);
  assert.equal(fontStackFor('PT Sans Narrow'), FONT_STACKS[0]);
});

test('an unknown name falls back to the default stack rather than throwing', () => {
  // AachenBT is a slab serif and nothing in its NAME says so. A name-based
  // heuristic cannot know that, and inventing an entry for it would be
  // fitting the rule to the fixture.
  assert.equal(fontStackFor('AachenBTBold'), FONT_STACKS[0]);
  assert.equal(fontStackFor(null), FONT_STACKS[0]);
  assert.equal(fontStackFor(''), FONT_STACKS[0]);
});

console.log('\ntext engine — end to end, on the file\n');

const glowDoc = await readDocument(read('float-color.src.psd'), { pixels: 'eager', metadata: false });

test('the model draws the size Photoshop draws', () => {
  const project = createProject(glowDoc, 'float-color.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  assert.equal(layer.name, 'outer glow');
  assert.equal(layer.text.sourceFontSize, 66.66666, "the file's own pre-transform size, kept for disclosure");
  close(layer.text.sourceScale, 0.2490135905304691, 1e-12, 'the scale the matrix carries');
  assert.equal(layer.text.fontSize, 17, '66.66666 x 0.249 = 16.6, rounded like every other size in the model');
});

test('the real typeface reaches the model and the substitution is named', () => {
  const project = createProject(glowDoc, 'float-color.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  assert.equal(layer.text.sourceFont, 'AachenBTBold');
  assert.equal(layer.text.fontFamily, fontStackFor('AachenBTBold'));
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
