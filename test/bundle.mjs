/**
 * Opening a folder instead of hunting for files.
 *
 * A PSD names its typefaces and carries none of them (`src/engine-data.js`), so
 * `src/fonts.js` exists to match a name the document asks for against a file the
 * user supplies. The gap that leaves is human: the user has to KNOW which files
 * to go and find. A designer never hands over a bare PSD — they hand over a
 * folder, PSD and fonts together — so accepting that folder as a zip removes the
 * hunting step entirely, and this suite is about the decision that makes it safe.
 *
 * ## Why classification is pure and lives here
 *
 * Nothing in `src/bundle.js` decompresses anything. It is handed the manifest a
 * zip's central directory already carries — `{ path, size }` per entry, where
 * `size` is the UNCOMPRESSED size — and answers which entry is the document,
 * which are fonts, what is ignored and what is refused. That split is what lets
 * a zip bomb be refused BEFORE a byte is inflated, and it is what lets the whole
 * decision be tested in Node with no browser, no fflate and no fixture archive.
 *
 * ## Why the messy paths are asserted rather than assumed
 *
 * Every zip a macOS user makes carries `__MACOSX/` shadows and `.DS_Store`. A
 * classifier that does not know that reports two PSDs in an archive with one,
 * and then asks the user which of `art.psd` and `__MACOSX/._art.psd` they meant
 * — which is a worse experience than the hunting it replaced. Windows zippers
 * write `\` separators. Extensions arrive in any case. These are not edge cases,
 * they are the common case, so they are the tests.
 */
import assert from 'node:assert/strict';

import {
  classifyBundle, bundleFontOutcome, isBundleFileName, bundleByteCap,
  BUNDLE_ENTRY_CAP, BUNDLE_FONT_HEADROOM_BYTES, BUNDLE_FILE_ACCEPT,
} from '../src/bundle.js';
import {
  createFontRegistry, registerFont, planFont, fontDemand, cssFontFamilyFor,
} from '../src/fonts.js';
import { memoryBudgetBytes } from '../src/budget.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const MB = 1024 * 1024;
/** A roomy budget, so a size test that means to pass is not fighting the guard. */
const BIG = 150 * MB;
const entry = (path, size = 1024) => ({ path, size });

console.log('\nzip handover — what is in the folder\n');

test('a plain handover: one PSD, one font, and nothing else to decide', () => {
  const report = classifyBundle([
    entry('poster.psd', 12 * MB),
    entry('fonts/AachenBT-Bold.otf', 90_000),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, true);
  assert.equal(report.reason, null);
  assert.equal(report.psd.path, 'poster.psd');
  assert.equal(report.psd.name, 'poster.psd');
  assert.equal(report.fonts.length, 1);
  assert.equal(report.fonts[0].name, 'AachenBT-Bold.otf', 'the NAME is what planFont reads, not the path');
  assert.equal(report.fonts[0].path, 'fonts/AachenBT-Bold.otf');
});

test('a .psb is the document too — the reader takes both', () => {
  const report = classifyBundle([entry('huge.psb', 40 * MB)], { budgetBytes: BIG });
  assert.equal(report.ok, true);
  assert.equal(report.psd.path, 'huge.psb');
});

test('extensions match in any case — .PSD and .Otf are the same files', () => {
  const report = classifyBundle([
    entry('ART.PSD', 1 * MB),
    entry('Fonts/Foo-Bold.Otf'),
    entry('Fonts/Foo-Italic.WOFF2'),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, true);
  assert.equal(report.psd.name, 'ART.PSD');
  assert.deepEqual(report.fonts.map((f) => f.name), ['Foo-Bold.Otf', 'Foo-Italic.WOFF2']);
});

test('nested directories and Windows backslashes reach the same font', () => {
  const report = classifyBundle([
    entry('Handover\\art.psd', 2 * MB),
    entry('fonts\\Sub Dir\\Foo-Bold.OTF'),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, true, report.message);
  assert.equal(report.psd.name, 'art.psd');
  assert.equal(report.fonts.length, 1);
  assert.equal(report.fonts[0].name, 'Foo-Bold.OTF');
  assert.equal(report.fonts[0].path, 'fonts/Sub Dir/Foo-Bold.OTF', 'the path is normalised, so re-reading it finds the entry');
});

test('directory entries are not files and are never classified', () => {
  const report = classifyBundle([
    entry('handover/', 0),
    entry('handover/fonts/', 0),
    entry('handover/art.psd', MB),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, true);
  assert.equal(report.fonts.length, 0);
  assert.equal(report.ignored.filter((i) => i.why === 'directory').length, 2);
});

console.log('\nzip handover — the mess every real archive carries\n');

test('__MACOSX shadows are ignored, and do NOT read as a second PSD', () => {
  const report = classifyBundle([
    entry('art.psd', 3 * MB),
    entry('__MACOSX/._art.psd', 220),
    entry('__MACOSX/fonts/._Foo-Bold.otf', 220),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, true, report.message);
  assert.equal(report.psd.path, 'art.psd', 'the real file, and no question asked about which');
  assert.equal(report.fonts.length, 0, 'an AppleDouble shadow is not a font file');
  assert.equal(report.ignored.filter((i) => i.why === 'macos').length, 2);
});

test('.DS_Store and bare AppleDouble files are ignored wherever they sit', () => {
  const report = classifyBundle([
    entry('art.psd', MB),
    entry('.DS_Store', 6148),
    entry('fonts/.DS_Store', 6148),
    entry('fonts/._Foo-Bold.otf', 220),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, true);
  assert.equal(report.fonts.length, 0);
  assert.equal(report.ignored.filter((i) => i.why === 'macos').length, 3);
});

test('anything we would not read is ignored by name, never executed or written', () => {
  const report = classifyBundle([
    entry('art.psd', MB),
    entry('notes/readme.txt'),
    entry('install.sh'),
    entry('preview.png'),
    entry('nested.zip'),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.ignored.filter((i) => i.why === 'unsupported').map((i) => i.path),
    ['notes/readme.txt', 'install.sh', 'preview.png', 'nested.zip'],
  );
});

test('absolute and traversing paths are ignored rather than reasoned about', () => {
  const report = classifyBundle([
    entry('..\\evil.psd', MB),
    entry('../../evil2.psd', MB),
    entry('/etc/passwd.psd', MB),
    entry('C:\\Windows\\Fonts\\evil.ttf'),
    entry('fonts/../../escape.otf'),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'no-psd', 'every candidate was refused on its path, so nothing is left to open');
  assert.equal(report.ignored.filter((i) => i.why === 'unsafe-path').length, 5);
});

test('a name that merely STARTS with dots is a filename, not a traversal', () => {
  const report = classifyBundle([entry('..hidden.psd', MB)], { budgetBytes: BIG });
  assert.equal(report.ok, true, report.message);
  assert.equal(report.psd.name, '..hidden.psd');
});

console.log('\nzip handover — refusals\n');

test('a zip with no PSD in it is refused by name, not by crashing', () => {
  const report = classifyBundle([
    entry('fonts/Foo-Bold.otf'),
    entry('readme.txt'),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'no-psd');
  assert.match(report.message, /\.psd/);
  assert.equal(report.psd, null);
});

test('an empty archive is the same refusal, with nothing invented', () => {
  const report = classifyBundle([], { budgetBytes: BIG });
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'no-psd');
  assert.deepEqual(report.psds, []);
});

test('two PSDs are REPORTED, never silently picked', () => {
  const report = classifyBundle([
    entry('final/art.psd', 3 * MB),
    entry('old/art-v1.psd', 2 * MB),
    entry('fonts/Foo-Bold.otf'),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'many-psds');
  assert.equal(report.psd, null, 'no guess — the first one alphabetically is not an answer');
  assert.deepEqual(report.psds.map((p) => p.path), ['final/art.psd', 'old/art-v1.psd']);
  assert.equal(report.fonts.length, 1, 'the fonts are still known, so answering the question costs no second read');
});

test('naming one of them resolves it, and the rest of the classification is unchanged', () => {
  const entries = [
    entry('final/art.psd', 3 * MB),
    entry('old/art-v1.psd', 2 * MB),
    entry('fonts/Foo-Bold.otf'),
  ];
  const report = classifyBundle(entries, { budgetBytes: BIG, pick: 'old/art-v1.psd' });

  assert.equal(report.ok, true, report.message);
  assert.equal(report.psd.path, 'old/art-v1.psd');
  assert.equal(report.fonts.length, 1);
});

test('a pick that names nothing in the archive is refused, not silently ignored', () => {
  const report = classifyBundle([
    entry('final/art.psd', 3 * MB),
    entry('old/art-v1.psd', 2 * MB),
  ], { budgetBytes: BIG, pick: 'somewhere/else.psd' });

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'many-psds');
});

test('a zip bomb is refused on its DECLARED size, before anything is inflated', () => {
  // 10 GB uncompressed, in a file that fits in a text message. The central
  // directory says so, and that is checked first — the alternative is finding
  // out by being killed.
  const report = classifyBundle([
    entry('art.psd', 4 * MB),
    entry('bomb.psd', 10 * 1024 * MB),
  ], { budgetBytes: BIG });

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'too-large');
  assert.match(report.message, /10244 MB/, 'the size is stated in units, not called "too big"');
  assert.match(report.message, /214 MB/, 'and so is the limit it broke');
});

test('the unpack limit follows the device budget, so it cannot contradict it', () => {
  assert.equal(bundleByteCap(BIG), BIG + BUNDLE_FONT_HEADROOM_BYTES);
  // A 1 GB phone budgets ~82 MB for a PSD; the zip cap has to be above it, or a
  // PSD this device CAN open would be refused for being inside a zip.
  const phone = memoryBudgetBytes(1);
  assert.ok(bundleByteCap(phone) > phone);
});

test('an archive with implausibly many entries is refused before any of them is read', () => {
  const entries = [];
  for (let i = 0; i <= BUNDLE_ENTRY_CAP; i++) entries.push(entry(`f${i}.txt`, 16));
  const report = classifyBundle(entries, { budgetBytes: BIG });

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'too-many-entries');
  assert.match(report.message, new RegExp(String(BUNDLE_ENTRY_CAP)));
  assert.deepEqual(report.ignored, [], 'refused before per-entry work, so there is nothing to report about them');
});

test('a PSD too large for the device faces the EXISTING guard, and the message says PSD', () => {
  const budget = memoryBudgetBytes(1);          // ~82 MB
  const report = classifyBundle([
    entry('poster.psd', 120 * MB),
    entry('fonts/Foo-Bold.otf'),
  ], { budgetBytes: budget });

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'psd-too-large');
  assert.match(report.message, /poster\.psd/, 'names the PSD, so it cannot be read as the zip being too big');
  assert.match(report.message, /This device can open PSDs up to/, 'and it is guardFileSize\'s own sentence, not a second wording of it');
  assert.match(report.message, /120 MB/);
});

test('the PSD guard is the last word, so a zip within budget still refuses an over-budget PSD', () => {
  // 100 MB of PSD is under the ~146 MB unpack cap for this device and over the
  // ~82 MB the device can actually decode. Both checks exist; both must fire.
  const budget = memoryBudgetBytes(1);
  const report = classifyBundle([entry('art.psd', 100 * MB)], { budgetBytes: budget });
  assert.ok(100 * MB < bundleByteCap(budget), 'the zip cap does not catch this one');
  assert.equal(report.reason, 'psd-too-large');
});

console.log('\nzip handover — what the user is told afterwards\n');

const documentLayers = () => [
  { name: 'headline', kind: 'text', text: { sourceFont: 'AachenBTBold', fontFamily: 'Georgia, serif' } },
  { name: 'body', kind: 'text', text: { sourceFont: 'MyriadPro-Regular', fontFamily: 'Arial, sans-serif' } },
];

test('the three numbers: what answered a name, what nothing asked for, what is still substituted', () => {
  const registry = createFontRegistry();
  const aachen = registerFont(registry, planFont('AachenBT-Bold.otf')).record;
  registerFont(registry, planFont('Decorative-Swash.ttf'));

  const outcome = bundleFontOutcome(
    fontDemand(documentLayers(), registry),
    [aachen.family, 'Decorative-Swash'],
  );

  assert.deepEqual(outcome.used, ['AachenBT-Bold'], 'this one answered a name the document asked for');
  assert.deepEqual(outcome.unused, ['Decorative-Swash'], 'this one was in the zip and no layer wants it');
  assert.deepEqual(outcome.substituted, ['MyriadPro-Regular'], 'and this name is still not answered by anything');
});

test('a zip that answers everything reports nothing left substituted', () => {
  const registry = createFontRegistry();
  const a = registerFont(registry, planFont('AachenBT-Bold.otf')).record;
  const m = registerFont(registry, planFont('MyriadPro-Regular.otf')).record;
  const layers = documentLayers();
  layers[0].text.fontFamily = cssFontFamilyFor(a, 'serif');
  layers[1].text.fontFamily = cssFontFamilyFor(m, 'sans-serif');

  const outcome = bundleFontOutcome(fontDemand(layers, registry), [a.family, m.family]);
  assert.deepEqual(outcome.substituted, []);
  assert.deepEqual(outcome.unused, []);
  assert.equal(outcome.used.length, 2);
});

test('a font the zip did not carry is still counted as substituted, not hidden by the ones it did', () => {
  const registry = createFontRegistry();
  const a = registerFont(registry, planFont('AachenBT-Bold.otf')).record;
  const outcome = bundleFontOutcome(fontDemand(documentLayers(), registry), [a.family]);
  assert.deepEqual(outcome.substituted, ['MyriadPro-Regular']);
});

console.log('\nzip handover — the picker\n');

test('the file input accepts zips alongside the documents it already took', () => {
  assert.equal(isBundleFileName('handover.zip'), true);
  assert.equal(isBundleFileName('HANDOVER.ZIP'), true);
  assert.equal(isBundleFileName('art.psd'), false);
  assert.equal(isBundleFileName(''), false);
  assert.equal(isBundleFileName(null), false);
  assert.match(BUNDLE_FILE_ACCEPT, /\.zip/);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
