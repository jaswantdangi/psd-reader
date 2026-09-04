import fs from 'fs';
import { readDocument, compositeDocument, compareBuffers, flattenOnto } from '../src/index.js';

const files = fs.readdirSync('fixtures').filter((f) => /\.src\.(psd|psb)$/.test(f)).sort();

console.log('\nOur compositor vs the composite Photoshop embedded in the file.');
console.log('A low % means our layer stacking matches what Photoshop rendered.\n');
console.log(
  'fixture'.padEnd(18) + 'canvas'.padEnd(13) + 'lyr'.padStart(4) +
  'raw %'.padStart(8) + 'real %'.padStart(9) + 'maxΔ'.padStart(6) + '  unapplied features'
);
console.log('-'.repeat(100));

let exact = 0, close = 0, off = 0, skipped = 0;
/** fixture -> {real, maxDelta} for this run, checked against CEILINGS below. */
const measured = new Map();

for (const f of files) {
  const name = f.replace(/\.src\.(psd|psb)$/, '');
  const bytes = new Uint8Array(fs.readFileSync('fixtures/' + f));

  try {
    const doc = await readDocument(bytes, { pixels: 'eager', embedded: true, metadata: false });

    if (!doc.embeddedComposite) {
      console.log(name.padEnd(18) + 'no embedded composite to compare against');
      skipped++;
      continue;
    }

    const ours = compositeDocument(doc);
    // Both flattened onto white: compare what a viewer sees, not the RGB
    // hiding under fully transparent pixels.
    const stat = compareBuffers(flattenOnto(ours), flattenOnto(doc.embeddedComposite));

    if (!stat.comparable) {
      console.log(name.padEnd(18) + 'size mismatch: ' + stat.reason);
      skipped++;
      continue;
    }

    if (stat.percentReal < 0.5) exact++;
    else if (stat.percentReal < 10) close++;
    else off++;

    const why = ours.warnings
      .map((w) => (/Adjustment/.test(w) ? 'adjustments' : /Smart filters/.test(w) ? 'smart filters'
        : /effects/.test(w) ? 'effects'
        : /dissolve/.test(w) ? 'dissolve' : /pass-through/.test(w) ? 'pass-through' : '?'))
      .join(', ');

    measured.set(name, { real: stat.percentReal, maxDelta: stat.maxDelta });

    console.log(
      name.padEnd(18) +
      `${doc.width}x${doc.height}`.padEnd(13) +
      String(doc.layers.length).padStart(4) +
      stat.percent.toFixed(1).padStart(8) +
      stat.percentReal.toFixed(2).padStart(9) +
      String(stat.maxDelta).padStart(6) +
      '  ' + why
    );
  } catch (e) {
    console.log(name.padEnd(18) + 'FAILED: ' + e.message.slice(0, 60));
    skipped++;
  }
}

console.log('-'.repeat(100));
console.log(`${files.length} files  |  <0.5% diff: ${exact}   <10%: ${close}   >=10%: ${off}   skipped: ${skipped}`);
console.log('\nA non-zero diff is expected wherever adjustments/effects appear — we do not apply those.');

/**
 * PER-FIXTURE CEILINGS. Nothing may get worse than the number beside it.
 *
 * The summary line above was treated as this project's stop condition for
 * months and ENFORCED NOTHING. It printed three bucket counts and always exited
 * 0, so a compositing regression went green and would be caught only if someone
 * happened to read the number and remember what it used to be.
 *
 * Buckets alone would still be too weak, because they are counts: one fixture
 * improving while another regresses leaves 12/6/3 completely unchanged. These
 * are per-fixture, so the two cannot cancel out.
 *
 * maxDelta is checked as well as the percentage. A change can move a few pixels
 * far further wrong while barely touching the percentage, and maxDelta is the
 * half that catches it -- `gradient` sits at 0.00% with maxDelta 1, where the
 * percentage alone would notice nothing at all if it broke.
 *
 * A fixture missing from this table is an ERROR, not a skip. Adding one to
 * fixtures/ has to be a deliberate act that records what it scores, or the
 * corpus silently grows an unguarded file.
 *
 * The non-zero entries are unimplemented features, not bugs: effects (layer
 * styles), smart-filters-2, adjustments, stroke. They are ceilings on known
 * gaps, not targets.
 *
 * `layer-comps` is the exception and does NOT belong in that list. Its 10.84%
 * is one layer's visibility, not a compositing gap: hide "Layer 3" and we match
 * Photoshop at 0.00% / maxDelta 0 over the whole canvas. The file disagrees
 * with itself -- the layer record says visible (flags 0x08, a real 1073-byte
 * alpha channel, no mask, no lsct/lfx2/FMsk, and the lastApplied comp
 * 510999610 lists it enabled:true), yet the composite Photoshop embedded omits
 * it. `layer-comps.expected.psd` was saved separately and agrees with the
 * embedded one exactly, so it reproduces across saves. Nothing in the file
 * tells a renderer to skip that layer.
 *
 * So this ceiling guards a fixture we cannot score to zero without rendering
 * something other than what its own layer records describe. Do not "fix" the
 * compositor to chase it, and do not implement layer comps expecting this
 * number to move -- applying comp 510999610 yields exactly today's output.
 *
 * `artboards` used to sit here at 9.79% with the "unapplied features" column
 * blank, because the compositor emitted no warning for it. It was not a
 * mystery and not a gap in blending: its three zero-bounds layers each carry
 * an `artb` record with the board's rect and background type, and we applied
 * neither. "Layer 2" spans x 121..1881, crossing out of its own board into
 * the one beside it, so it bled across the canvas over ground Photoshop
 * paints white. `applyArtboard` in src/composite.js now clips and fills, and
 * the fixture is bit-exact. Its ceiling is 0/0 -- keep it there.
 */
const CEILINGS = new Map(Object.entries({
  'adjustments':     { real: 4.60,  maxDelta: 71 },
  'annotations':     { real: 0,     maxDelta: 0 },
  'artboards':       { real: 0,     maxDelta: 0 },
  'blend-if':        { real: 1.26,  maxDelta: 3 },
  'boolean':         { real: 0.18,  maxDelta: 57 },
  'effects':         { real: 23.03, maxDelta: 186 },
  'float-color':     { real: 7.96,  maxDelta: 89 },
  'gradient':        { real: 0,     maxDelta: 1 },
  'group-blend':     { real: 0,     maxDelta: 1 },
  // Not a compositing gap -- see the note above. Bit-exact once "Layer 3" is hidden.
  'layer-comps':     { real: 10.84, maxDelta: 255 },
  'masks':           { real: 4.57,  maxDelta: 58 },
  'psb2':            { real: 0,     maxDelta: 0 },
  'shapes':          { real: 0,     maxDelta: 0 },
  'smart':           { real: 0,     maxDelta: 0 },
  'smart-filters-2': { real: 46.38, maxDelta: 255 },
  'stroke':          { real: 6.18,  maxDelta: 172 },
  'text':            { real: 0,     maxDelta: 0 },
  'text-box':        { real: 0,     maxDelta: 0 },
  'vector-and-mask': { real: 0,     maxDelta: 0 },
  'vectors':         { real: 0,     maxDelta: 0 },
  'werps':           { real: 0,     maxDelta: 0 },
}));

// Compared at 2 decimal places, the precision the table above prints. Anything
// finer is noise from the last bit of a float, not a change in what we render.
const round2 = (v) => Math.round(v * 100) / 100;

const regressions = [];
const improvements = [];

for (const [name, got] of measured) {
  const ceiling = CEILINGS.get(name);
  if (!ceiling) {
    regressions.push(`${name}: not in CEILINGS -- add it, recording real ${round2(got.real)} / maxDelta ${got.maxDelta}`);
    continue;
  }
  if (round2(got.real) > ceiling.real)
    regressions.push(`${name}: real ${round2(got.real)}% is worse than its ceiling ${ceiling.real}%`);
  if (got.maxDelta > ceiling.maxDelta)
    regressions.push(`${name}: maxDelta ${got.maxDelta} is worse than its ceiling ${ceiling.maxDelta}`);
  if (round2(got.real) < ceiling.real || got.maxDelta < ceiling.maxDelta)
    improvements.push(`${name}: ${ceiling.real}% / ${ceiling.maxDelta} -> ${round2(got.real)}% / ${got.maxDelta}`);
}

for (const name of CEILINGS.keys())
  if (!measured.has(name))
    regressions.push(`${name}: has a ceiling but did not run -- it failed to parse, or left fixtures/`);

if (improvements.length) {
  console.log('\nIMPROVED. Tighten these ceilings in test/composite.mjs, or they stop guarding the ground just won:');
  for (const line of improvements) console.log('  ' + line);
}

if (regressions.length) {
  console.log('\nACCURACY REGRESSION -- our composite moved away from Photoshop:');
  for (const line of regressions) console.log('  ' + line);
  console.log('\nThese are per-fixture ceilings, not bucket counts, so this cannot be');
  console.log('a rounding artefact of one file improving while another got worse.');
  process.exitCode = 1;
} else {
  console.log(`\nAll ${measured.size} fixtures within their accuracy ceilings.`);
}
