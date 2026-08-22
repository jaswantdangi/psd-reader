import fs from 'fs';
import { readDocument } from '../src/index.js';
const mode = process.argv[2];
const bytes = new Uint8Array(fs.readFileSync('fixtures/mem.psd'));
let handed = 0, held = 0;
const t = Date.now();
const doc = await readDocument(bytes, {
  pixels: mode,
  onLayer: mode === 'stream' ? (l, px) => { if (px) handed += px.data.length; } : undefined,
  metadata: false,
});
if (mode === 'eager') for (const l of doc.layers) if (l.imageData) held += l.imageData.data.length;
console.log(JSON.stringify({
  mode, fileMB: +(bytes.length/1048576).toFixed(0), layers: doc.layers.length,
  handedOffMB: +(handed/1048576).toFixed(0), stillHeldMB: +(held/1048576).toFixed(0),
  peakMB: +(process.resourceUsage().maxRSS/1024).toFixed(0), ms: Date.now()-t,
}));
