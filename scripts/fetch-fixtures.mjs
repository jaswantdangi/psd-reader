/**
 * Downloads the test corpus: 21 Photoshop-authored PSD/PSB files from ag-psd's
 * test suite (MIT). They aren't committed here — they're ~13 MB of binaries
 * belonging to another project, so we fetch them on demand instead.
 *
 *   node scripts/fetch-fixtures.mjs
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

const dir = path.join(process.cwd(), 'fixtures');
fs.mkdirSync(dir, { recursive: true });

let fetched = 0, skipped = 0, failed = 0;

for (const [name, ext] of Object.entries(FIXTURES)) {
  const target = path.join(dir, `${name}.src.${ext}`);

  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    skipped++;
    continue;
  }

  const url = `${BASE}/${name}/src.${ext}`;
  process.stdout.write(`  ${name}.src.${ext} … `);

  try {
    const res = await fetch(url);
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

console.log(`\n${fetched} downloaded, ${skipped} already present, ${failed} failed`);
if (failed) process.exit(1);
