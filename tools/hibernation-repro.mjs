/**
 * Reproduce "connects, then disconnects with peer-gone" against the deployed relay.
 *
 *   node tools/hibernation-repro.mjs [waitSeconds]
 *
 * The hypothesis: a Durable Object is EVICTED between requests, and on wake a
 * fresh RelayHub is constructed. If anything that must be unique across the
 * object's life is minted from in-memory state, it restarts on every wake.
 *
 * A real user reads the code off one screen and types it into Photoshop, which
 * takes many seconds -- long enough for the object to hibernate between the app
 * connecting and the plugin connecting. `tools/live-sync-check.mjs` connects
 * both within milliseconds, so it never lets that happen, and would pass
 * against exactly the bug this looks for.
 *
 * Run once with 0 (the control) and once with a long wait (the real case).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const RELAY = process.env.RELAY_URL ?? 'wss://psd-sync-relay.jaswantdangi00.workers.dev';
const ORIGIN = 'https://psd-editor.pages.dev';
const WAIT = Number(process.argv[2] ?? 30);

function client(name) {
  const ws = new WebSocket(RELAY, { headers: { Origin: ORIGIN } });
  const frames = [];
  let closed = null;
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
  ws.on('error', () => {});
  return {
    ws, name, frames,
    closed: () => closed,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = (c) => c.frames.map((f) => f.type + (f.code ? `:${f.code}` : '')).join(', ') || '(none)';

console.log(`\nhibernation repro · wait ${WAIT}s between app and plugin · ${RELAY}\n`);

const app = client('app');
await app.open();
app.send({ type: 'hello', role: 'app', version: '1.0.0' });
await sleep(1500);
const pairFrame = app.frames.find((f) => f.type === 'pair');
if (!pairFrame) { console.log('  app never received a code — relay unreachable?'); process.exit(2); }
console.log(`  app got code ${pairFrame.code}`);

if (WAIT > 0) {
  console.log(`  waiting ${WAIT}s — long enough for the Durable Object to hibernate…`);
  await sleep(WAIT * 1000);
}

const plugin = client('plugin');
await plugin.open();
plugin.send({ type: 'hello', role: 'plugin', version: '0.2.0' });
plugin.send({ type: 'pair', code: pairFrame.code });
await sleep(2000);

plugin.send({
  type: 'tree',
  document: { name: 'repro.psd', width: 100, height: 100 },
  layers: [{ layerID: 1, name: 'Layer', kind: 'pixel', bounds: { left: 0, top: 0, right: 10, bottom: 10 }, groupPath: [] }],
});
await sleep(2500);

const appPaired = app.frames.some((f) => f.type === 'paired');
const pluginPaired = plugin.frames.some((f) => f.type === 'paired');
const pluginPairedCount = plugin.frames.filter((f) => f.type === 'paired').length;
const appGotTree = app.frames.some((f) => f.type === 'tree');
const peerGone = plugin.frames.some((f) => f.code === 'peer-gone');

console.log('');
console.log(`  app    frames: ${summary(app)}${app.closed() ? `  [closed ${app.closed().code}]` : ''}`);
console.log(`  plugin frames: ${summary(plugin)}${plugin.closed() ? `  [closed ${plugin.closed().code}]` : ''}`);
console.log('');
console.log(`  app received paired      : ${appPaired}`);
console.log(`  plugin received paired   : ${pluginPaired}  (${pluginPairedCount} time${pluginPairedCount === 1 ? '' : 's'})`);
console.log(`  app received the tree    : ${appGotTree}`);
console.log(`  plugin got peer-gone     : ${peerGone}`);

const reproduced = !appGotTree && (peerGone || !appPaired || pluginPairedCount > 1);
console.log(`\n  ${reproduced ? 'REPRODUCED — the pairing broke' : 'healthy — the tree reached the app'}\n`);

app.close();
plugin.close();
setTimeout(() => process.exit(reproduced ? 1 : 0), 300);
