/**
 * Matching a PSD's font NAMES to the font FILES a user supplies.
 *
 * A PSD stores `MyriadPro-Regular`; it never stores Myriad Pro. The only way
 * the file's own typeface can ever reach the screen is for someone to hand us
 * the file, and the only thing standing between "here is a .otf" and "the
 * headline is now in Myriad Pro" is the question this suite is about: does THIS
 * file answer THAT name?
 *
 * ## Why the matcher is deliberately dumb
 *
 * The tempting version scores candidates and picks the best. It is the wrong
 * shape: a wrong font applied silently looks like a working feature, so the
 * user never goes and finds the right file. A disclosed substitute is worse to
 * look at and better to act on. So there are exactly two tiers — the whole
 * normalised name, then the family stem — and no third. `Robotica` does not
 * answer `Roboto`, however close the edit distance.
 *
 * The corpus names asserted here are real: `AachenBTBold` is what
 * `fixtures/float-color.src.psd` asks for, and `MyriadPro-Regular` /
 * `Roboto-Regular` are the two names that appear in the other fixtures'
 * FontSets (see src/engine-data.js for why only one of them belongs to a live
 * text layer).
 */
import assert from 'node:assert/strict';

import {
  FONT_FILE_EXTENSIONS, isFontFileName, splitFontName, planFont,
  createFontRegistry, registerFont, recordFontFailure, loadedFonts, fontFailures,
  resolveFont, cssFontFamilyFor, loadedFontFamilyFor, fontDemand,
} from '../src/fonts.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const SANS = 'Arial, Helvetica, sans-serif';

console.log('\nfont files — reading a name\n');

test('a PostScript name splits into a family stem and a style', () => {
  assert.deepEqual(splitFontName('MyriadPro-Regular'),
    { normalised: 'myriadproregular', stem: 'myriadpro', weight: 'regular', italic: false, styleKey: 'regular' });
  assert.deepEqual(splitFontName('Roboto-Regular'),
    { normalised: 'robotoregular', stem: 'roboto', weight: 'regular', italic: false, styleKey: 'regular' });
});

test('a run-together name splits the same way — AachenBTBold is Aachen BT, bold', () => {
  const split = splitFontName('AachenBTBold');
  assert.equal(split.stem, 'aachenbt');
  assert.equal(split.weight, 'bold');
  assert.equal(split.italic, false);
});

test('spaces, underscores and case are all the same name', () => {
  const stems = ['MyriadPro-Regular', 'Myriad Pro Regular', 'myriad_pro_regular', 'MYRIADPRO REGULAR']
    .map((n) => splitFontName(n).stem);
  assert.deepEqual(stems, ['myriadpro', 'myriadpro', 'myriadpro', 'myriadpro']);
});

test('BoldItalic is ONE style, not a family called Bold', () => {
  const split = splitFontName('Roboto-BoldItalic');
  assert.equal(split.stem, 'roboto');
  assert.equal(split.weight, 'bold');
  assert.equal(split.italic, true);
  assert.equal(split.styleKey, 'bold-italic');
});

test('style words strip repeatedly, in any order the file wrote them', () => {
  assert.equal(splitFontName('Roboto-Italic-Bold').stem, 'roboto');
  assert.equal(splitFontName('Roboto Bold Italic').styleKey, 'bold-italic');
});

test('a name that is ONLY a style word keeps it — stripping to nothing is not a stem', () => {
  // A foundry really can call a face "Black". Eating the whole name would make
  // it match every family at once, which is the one failure this matcher exists
  // to avoid.
  const split = splitFontName('Black');
  assert.equal(split.stem, 'black');
  assert.equal(split.weight, 'regular');
});

console.log('\nfont files — what we will accept\n');

test('the four web font formats, and nothing else', () => {
  assert.deepEqual(FONT_FILE_EXTENSIONS, ['.ttf', '.otf', '.woff', '.woff2']);
  assert.equal(isFontFileName('Roboto-Regular.ttf'), true);
  assert.equal(isFontFileName('Roboto-Regular.WOFF2'), true);
  assert.equal(isFontFileName('Roboto-Regular.psd'), false);
  assert.equal(isFontFileName('Roboto-Regular'), false);
});

test('planning a font file names the family the browser will be given', () => {
  const plan = planFont('MyriadPro-Regular.otf');
  assert.equal(plan.family, 'MyriadPro-Regular');
  assert.equal(plan.stem, 'myriadpro');
  assert.equal(plan.styleKey, 'regular');
  assert.equal(plan.fileName, 'MyriadPro-Regular.otf');
});

test('a file we cannot use is refused by name, before any bytes are read', () => {
  assert.throws(() => planFont('portrait.psd'), /not a font file/i);
  // Nothing left after the punctuation is stripped: there is no family here to
  // register under, and inventing one would put an unreachable face in the DB.
  assert.throws(() => planFont('---.ttf'), /no family name/i);
});

console.log('\nthe registry — one file, one family\n');

test('a registered file answers the PSD name it was named for', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('MyriadPro-Regular.otf'));

  const hit = resolveFont(registry, 'MyriadPro-Regular');
  assert.ok(hit, 'the file names exactly what the PSD asks for');
  assert.equal(hit.family, 'MyriadPro-Regular');
  assert.equal(hit.how, 'name');
  assert.equal(hit.styleMatched, true);
});

test('the file a user actually has is not named the way Photoshop writes it', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('Myriad Pro Regular.otf'));

  const hit = resolveFont(registry, 'MyriadPro-Regular');
  assert.ok(hit, 'hyphens, spaces and case are not part of the name');
  assert.equal(hit.family, 'Myriad Pro Regular');
  assert.equal(hit.styleMatched, true);
});

test('a family match with the wrong weight is a match that SAYS it is the wrong weight', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('Roboto-Bold.ttf'));

  const hit = resolveFont(registry, 'Roboto-Regular');
  assert.ok(hit, 'the family is right, and Roboto Bold beats Arial');
  assert.equal(hit.how, 'stem');
  assert.equal(hit.styleMatched, false, 'and the caller has to be able to say so');
});

test('the right weight wins over another weight of the same family', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('Roboto-Bold.ttf'));
  registerFont(registry, planFont('Roboto-Regular.ttf'));

  const hit = resolveFont(registry, 'Roboto-Regular');
  assert.equal(hit.family, 'Roboto-Regular');
  assert.equal(hit.styleMatched, true);
  assert.equal(loadedFonts(registry).length, 2, 'both faces stay loaded — they are different faces');
});

test('a near miss is a MISS — there is no fuzzy tier', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('Robotica-Regular.ttf'));
  registerFont(registry, planFont('RobotoSlab-Regular.ttf'));

  assert.equal(resolveFont(registry, 'Roboto-Regular'), null,
    'a wrong font applied in silence is worse than a substitute that is disclosed');
  assert.equal(resolveFont(registry, 'AachenBTBold'), null);
});

test('a PSD that names no font resolves to nothing rather than to the first file loaded', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('Roboto-Regular.ttf'));
  assert.equal(resolveFont(registry, null), null);
  assert.equal(resolveFont(registry, ''), null);
});

console.log('\nthe registry — the two things that go wrong\n');

test('two files claiming the same family AND style: the later one replaces, and says so', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('Roboto-Regular.ttf'));
  const second = registerFont(registry, planFont('roboto regular.woff2'));

  assert.ok(second.replaced, 'the user is not left wondering which of their two files is drawing');
  assert.equal(second.replaced.family, 'Roboto-Regular');
  assert.equal(loadedFonts(registry).length, 1, 'one face per family and style, never two');
  assert.equal(resolveFont(registry, 'Roboto-Regular').family, 'roboto regular',
    'the file they just picked is the one that draws');
});

test('a file that fails to parse leaves NOTHING resolvable, and is listed', () => {
  const registry = createFontRegistry();
  const plan = planFont('Roboto-Regular.ttf');
  // The app plans, then asks the browser to parse it. This is the browser
  // saying no — a corrupt file, or a .ttf that is really a zip.
  recordFontFailure(registry, plan.fileName, 'Could not parse the font file.');

  assert.equal(resolveFont(registry, 'Roboto-Regular'), null,
    'a face that never loaded must not be handed to the renderer');
  assert.deepEqual(fontFailures(registry),
    [{ fileName: 'Roboto-Regular.ttf', message: 'Could not parse the font file.' }]);
});

test('re-picking a file that failed clears its failure once it loads', () => {
  const registry = createFontRegistry();
  recordFontFailure(registry, 'Roboto-Regular.ttf', 'Could not parse the font file.');
  registerFont(registry, planFont('Roboto-Regular.ttf'));

  assert.deepEqual(fontFailures(registry), [], 'a stale complaint is a lie about the current state');
  assert.ok(resolveFont(registry, 'Roboto-Regular'));
});

test('the same file failing twice is listed once', () => {
  const registry = createFontRegistry();
  recordFontFailure(registry, 'Roboto-Regular.ttf', 'Could not parse the font file.');
  recordFontFailure(registry, 'Roboto-Regular.ttf', 'Could not parse the font file.');
  assert.equal(fontFailures(registry).length, 1);
});

console.log('\nthe value the renderer is given\n');

test('the loaded family goes FIRST, and the substitute stays behind it', () => {
  const registry = createFontRegistry();
  const { record } = registerFont(registry, planFont('Myriad Pro Regular.otf'));
  const css = cssFontFamilyFor(record, SANS);

  assert.equal(css, '"Myriad Pro Regular", Arial, Helvetica, sans-serif');
});

test('a family name that collides with a CSS keyword is still a family name', () => {
  const registry = createFontRegistry();
  const { record } = registerFont(registry, planFont('serif.ttf'));
  // Unquoted, `serif` is the generic keyword and the file would never draw.
  assert.equal(cssFontFamilyFor(record, SANS), '"serif", Arial, Helvetica, sans-serif');
});

test('a quote in the file name cannot break out of the family string', () => {
  const registry = createFontRegistry();
  const { record } = registerFont(registry, planFont('My"Face.ttf'));
  // An unescaped quote here ends the family early, canvas rejects the whole
  // `ctx.font` shorthand, and EVERY text layer silently reverts to the default.
  assert.equal(cssFontFamilyFor(record, SANS), '"MyFace", Arial, Helvetica, sans-serif');
});

test('the applied value is derived once, from the name the document asks for', () => {
  const registry = createFontRegistry();
  const { record } = registerFont(registry, planFont('AachenBT-Bold.otf'));
  assert.equal(loadedFontFamilyFor(record, 'AachenBTBold'),
    '"AachenBT-Bold", Arial, Helvetica, sans-serif');
});

console.log('\nwhat the document wants\n');

const documentLayers = () => [
  { name: 'headline', kind: 'text', text: { sourceFont: 'AachenBTBold', fontFamily: SANS } },
  { name: 'subhead', kind: 'text', text: { sourceFont: 'AachenBTBold', fontFamily: SANS } },
  { name: 'body', kind: 'text', text: { sourceFont: 'MyriadPro-Regular', fontFamily: SANS } },
  { name: 'caption', kind: 'text', text: { sourceFont: null, fontFamily: SANS } },
  { name: 'photo', kind: 'raster', text: null },
];

test('the document can say which fonts it wants, and how many layers want each', () => {
  const registry = createFontRegistry();
  const report = fontDemand(documentLayers(), registry);

  assert.deepEqual(report.fonts.map((f) => f.name), ['AachenBTBold', 'MyriadPro-Regular']);
  assert.deepEqual(report.fonts[0].layers, ['headline', 'subhead']);
  assert.equal(report.wanted, 2);
  assert.equal(report.loaded, 0);
  assert.equal(report.substituted, 2, 'nothing is loaded yet, so everything is a substitute');
  assert.equal(report.unnamed, 1, 'the caption names no typeface — that is not a missing font');
});

test('loading one of them moves it from substituted to loaded, and nothing else moves', () => {
  const registry = createFontRegistry();
  registerFont(registry, planFont('AachenBT-Bold.otf'));
  const report = fontDemand(documentLayers(), registry);

  assert.equal(report.loaded, 1);
  assert.equal(report.substituted, 1);
  assert.equal(report.fonts[0].match.family, 'AachenBT-Bold');
  assert.equal(report.fonts[1].match, null, 'MyriadPro is still missing and still says so');
});

test('a font that is loaded but not yet drawn is reported separately from one that is', () => {
  const registry = createFontRegistry();
  const { record } = registerFont(registry, planFont('AachenBT-Bold.otf'));
  const layers = documentLayers();
  layers[0].text.fontFamily = cssFontFamilyFor(record, SANS);

  const report = fontDemand(layers, registry);
  assert.equal(report.fonts[0].applied, 1, 'one of the two AachenBT layers is actually drawing it');
  assert.equal(report.fonts[0].layers.length, 2);
});

test('"drawing it" is exact — a stack that merely STARTS with the family is not', () => {
  // A user loading Georgia.ttf for a document asking for Georgia collides with
  // the substitute stack `Georgia, serif`. Comparing first families would report
  // their file as drawing while the system's Georgia is what is on screen.
  const registry = createFontRegistry();
  registerFont(registry, planFont('Georgia.ttf'));
  const layers = [{ name: 'quote', kind: 'text', text: { sourceFont: 'Georgia', fontFamily: 'Georgia, serif' } }];

  const report = fontDemand(layers, registry);
  assert.equal(report.loaded, 1, 'the file does answer the name');
  assert.equal(report.fonts[0].applied, 0, 'and it is not what this layer is drawing yet');
  assert.equal(report.fonts[0].match.applies, '"Georgia", Georgia, serif');
});

test('a document with no text at all wants nothing', () => {
  const report = fontDemand([{ name: 'photo', kind: 'raster', text: null }], createFontRegistry());
  assert.deepEqual(report.fonts, []);
  assert.equal(report.wanted, 0);
  assert.equal(report.unnamed, 0);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
