import fs from 'fs';
import { readDocument } from '../src/index.js';

const files = fs.readdirSync('fixtures').filter(f => /\.src\.(psd|psb)$/.test(f)).sort();
let icc = 0, exif = 0, iptc = 0, xmp = 0, warned = 0, failed = 0;

console.log('fixture'.padEnd(18) + 'size'.padEnd(12) + 'lyr'.padStart(4) + '  ICC              EXIF  IPTC  XMP');
console.log('-'.repeat(84));

for (const f of files) {
  const name = f.replace(/\.src\.(psd|psb)$/, '');
  const bytes = new Uint8Array(fs.readFileSync('fixtures/' + f));
  try {
    const doc = await readDocument(bytes);
    const m = doc.metadata;
    if (m.icc) icc++;
    if (m.exif) exif++;
    if (m.iptc) iptc++;
    if (m.xmp) xmp++;
    if (doc.warnings.length) warned++;
    console.log(
      name.padEnd(18) +
      `${doc.width}x${doc.height}/${doc.bitsPerChannel}b`.padEnd(12) +
      String(doc.layers.length).padStart(4) + '  ' +
      (m.icc ? m.icc.description.slice(0, 16) : '-').padEnd(17) +
      (m.exif ? String(Object.keys(m.exif).length) : '-').padStart(4) +
      (m.iptc ? String(Object.keys(m.iptc).length) : '-').padStart(6) +
      (m.xmp ? (m.xmp.length / 1024).toFixed(0) + 'K' : '-').padStart(6)
    );
  } catch (e) {
    failed++;
    console.log(name.padEnd(18) + 'FAILED: ' + e.message.slice(0, 50));
  }
}

console.log('-'.repeat(84));
console.log(`${files.length} files | parsed ${files.length - failed} | failed ${failed}`);
console.log(`recovered: ICC ${icc}/${files.length}  EXIF ${exif}/${files.length}  IPTC ${iptc}/${files.length}  XMP ${xmp}/${files.length}`);
console.log(`expected : ICC 16/21  EXIF 21/21  IPTC 2/21   (8 further files carry an empty IPTC envelope)`);
console.log(`files with warnings: ${warned}/${files.length}`);

const doc = await readDocument(new Uint8Array(fs.readFileSync('fixtures/blend-if.src.psd')));
console.log('\nsample warnings (blend-if):');
doc.warnings.forEach(w => console.log('  - ' + w.slice(0, 110)));
