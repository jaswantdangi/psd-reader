/**
 * Downloads the test corpus from ag-psd's test suite (MIT). The files aren't
 * committed here — ~13 MB of binaries belonging to another project — so they
 * are fetched on demand instead.
 *
 *   node scripts/fetch-fixtures.mjs
 *
 * TWO kinds of file, and this script used to fetch only the first:
 *
 *   <name>.src.psd       the Photoshop original. 21 of them, the accuracy corpus.
 *   <name>.expected.psd  Photoshop's own re-save of it. 9 of them.
 *
 * Missing the second kind is invisible on any machine that has ever had them,
 * and fatal on one that has not: `test/text-engine.mjs` reads
 * `text.expected.psd` directly and dies with ENOENT rather than skipping. That
 * is how it was found — CI, on a clean runner, on its second ever run.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://raw.githubusercontent.com/Agamnentzar/ag-psd/master/test/read-write';

/** name -> extension. Each is the Photoshop original, not ag-psd's output. */
const FIXTURES = {
  adjustments: 'psd', annotations: 'psd', artboards: 'psd', 'blend-if': 'psd',
  boolean: 'psd', effects: 'psd', 'float-color': 'psd', gradient: 'psd',
  'group-blend': 'psd', 'layer-comps': 'psd', masks: 'psd', psb2: 'psb',
  shapes: 'psd', smart: 'psd', 'smart-filters-2': 'psd', stroke: 'psd',
  text: 'psd', 'text-box': 'psd', 'vector-and-mask': 'psd', vectors: 'psd',
  werps: 'psd',
};

/**
 * The fixtures that ALSO have Photoshop's re-save beside the original.
 *
 * Listed explicitly rather than probing every name and shrugging at a 404. A
 * 404 is exactly what a renamed or removed upstream file looks like, so
 * tolerating it would let the corpus quietly shrink — which is the failure
 * this whole script exists downstream of.
 */
const EXPECTED = ['adjustments', 'artboards', 'blend-if', 'effects', 'layer-comps', 'masks', 'psb2', 'smart', 'text'];

const dir = path.join(process.cwd(), 'fixtures');
fs.mkdirSync(dir, { recursive: true });

let fetched = 0, skipped = 0, failed = 0;

/** One file. `kind` is `src` or `expected`; both live in the same upstream directory. */
async function grab(name, ext, kind) {
  const target = path.join(dir, `${name}.${kind}.${ext}`);

  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    skipped++;
    return;
  }

  process.stdout.write(`  ${name}.${kind}.${ext} … `);
  try {
    const res = await fetch(`${BASE}/${name}/${kind}.${ext}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, bytes);
    console.log(`${(bytes.length / 1024).toFixed(0)} KB`);
    fetched++;
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    failed++;
  }
}

for (const [name, ext] of Object.entries(FIXTURES)) {
  await grab(name, ext, 'src');
  if (EXPECTED.includes(name)) await grab(name, ext, 'expected');
}

const want = Object.keys(FIXTURES).length + EXPECTED.length;
console.log(`\n${fetched} downloaded, ${skipped} already present, ${failed} failed (${want} expected in total)`);
if (failed) process.exit(1);
