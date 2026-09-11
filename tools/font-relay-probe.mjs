/**
 * Do font frames cross the DEPLOYED relay, each in its own direction only?
 *
 *   node tools/font-relay-probe.mjs
 *
 * Pairs an app and a plugin against the live Worker, then:
 *   1. app -> plugin: a `font-request` arrives intact;
 *   2. plugin -> app: a generated font, chunked, arrives and reassembles to
 *      the same bytes (SHA-256 checked by assembleFont);
 *   3. app -> plugin with a chunk is refused `wrong-direction`.
 *
 * A relay deployed before font sync refuses all three frames as unknown,
 * so this is also the check that the deploy actually landed.
 */
import { createRequire } from 'node:module';
import { chunkFont, assembleFont } from '../src/sync/font-file.js';
import { makeFont } from '../test/make-font.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const RELAY = process.env.RELAY_URL ?? 'wss://psd-sync-relay.jaswantdangi00.workers.dev';
const ORIGIN = 'https://psd-editor.pages.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(RELAY, { headers: { Origin: ORIGIN } });
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.on('error', () => {});
  return {
    ws, frames,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
  };
}

const results = [];
const check = (label, ok, detail) => results.push({ label, ok, detail });

console.log(`\nfont relay probe · ${RELAY}\n`);

const app = client();
await app.open();
app.send({ type: 'hello', role: 'app', version: '1.0.0' });
await sleep(1200);
const code = app.frames.find((f) => f.type === 'pair')?.code;

const plugin = client();
await plugin.open();
plugin.send({ type: 'hello', role: 'plugin', version: '0.2.0' });
plugin.send({ type: 'pair', code });
await sleep(1500);
check('paired', plugin.frames.some((f) => f.type === 'paired'), code ? `code ${code}` : 'no code issued');

app.send({ type: 'font-request', names: ['MyriadPro-Regular'] });
await sleep(1200);
const request = plugin.frames.find((f) => f.type === 'font-request');
check('font-request crosses app -> plugin', !!request && request.names[0] === 'MyriadPro-Regular',
  request ? JSON.stringify(request) : JSON.stringify(app.frames.at(-1)));

const font = makeFont('MyriadPro-Regular', { padding: 900_000 });
const frames = chunkFont(font, { name: 'MyriadPro-Regular', fileName: 'MyriadPro-Regular.otf' });
frames.forEach((f) => plugin.send(f));
await sleep(3000);
const arrived = app.frames.filter((f) => f.type === 'font-chunk');
const rebuilt = assembleFont(arrived);
check(`a ${Math.round(font.length / 1024)} KB font crosses plugin -> app in ${frames.length} chunks`,
  rebuilt.ok && rebuilt.bytes.length === font.length, rebuilt.ok ? `${arrived.length} chunks, checksum ok` : rebuilt.reason);

const before = plugin.frames.length;
app.send(frames[0]);
await sleep(1200);
const refusal = app.frames.at(-1);
check('a chunk from the app is refused', refusal?.code === 'wrong-direction' && plugin.frames.length === before,
  JSON.stringify(refusal));

for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.label}\n       ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} FAILED\n` : '\nfont frames cross the live relay, each one way only\n');
try { app.ws.close(); plugin.ws.close(); } catch { /* already closed */ }
setTimeout(() => process.exit(failed ? 1 : 0), 300);
