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
      .map((w) => (/Adjustment/.test(w) ? 'adjustments' : /effects/.test(w) ? 'effects'
        : /dissolve/.test(w) ? 'dissolve' : /pass-through/.test(w) ? 'pass-through' : '?'))
      .join(', ');

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
