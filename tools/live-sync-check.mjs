/**
 * End-to-end sync check against the DEPLOYED relay, with a stand-in for Photoshop.
 *
 *   node tools/live-sync-check.mjs
 *
 * Everything here is real except the host application: a real fixture PSD, a
 * real `createProject`, the real matcher, the real translator, the real editor
 * commands, and the real Cloudflare Worker over `wss://`. The only thing
 * replaced is `plugin/main.js` -- by a script that sends the frames it would
 * send, built from a real document.
 *
 * WHAT THIS PROVES: the protocol, the relay, the identity matching, the event
 * translation and the editor commands work together, over the internet, on the
 * deployed infrastructure.
 *
 * WHAT IT DOES NOT PROVE: that Photoshop's UXP API behaves the way
 * `plugin/main.js` assumes. That is the one thing only a real Photoshop can
 * answer, and it is deliberately the only thing left unproven.
 *
 * Lives in `tools/` rather than `test/` because it needs the network and a
 * deployed relay, so it must not run inside `npm test`.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const { readDocument } = await import('../src/index.js');
const { createProject, setLayer, reorderLayer, setFrame, findLayer } = await import('../src/edit.js');
const { removeLayer } = await import('../src/creative/index.js');
const { matchLayers } = await import('../src/sync/identity.js');
const { translateEvent } = await import('../src/sync/protocol.js');
const { treeFrameFor } = await import('../src/sync/photoshop.js');

const RELAY = process.env.RELAY_URL ?? 'wss://psd-sync-relay.jaswantdangi00.workers.dev';
const ORIGIN = process.env.RELAY_ORIGIN ?? 'https://psd-editor.pages.dev';
const FIXTURE = process.env.FIXTURE ?? 'group-blend.src.psd';

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '   ' + extra : ''}`);
  if (!cond) failed++;
};

function client(name) {
  const ws = new WebSocket(RELAY, { headers: { Origin: ORIGIN } });
  const queue = [], waiters = [];
  ws.on('message', (d) => {
    const frame = JSON.parse(d.toString());
    waiters.length ? waiters.shift()(frame) : queue.push(frame);
  });
  ws.on('error', () => { /* surfaced by the open/next timeouts */ });
  return {
    ws,
    open: (ms = 10000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${name}: socket did not open within ${ms}ms`)), ms);
      ws.on('open', () => { clearTimeout(t); res(); });
      ws.on('error', (e) => { clearTimeout(t); rej(e); });
    }),
    next: (ms = 10000) => new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      const t = setTimeout(() => rej(new Error(`${name}: no frame within ${ms}ms`)), ms);
      waiters.push((f) => { clearTimeout(t); res(f); });
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
  };
}

// -------------------------------------------- the same document, both sides

const bytes = new Uint8Array(fs.readFileSync(`fixtures/${FIXTURE}`));
const doc = await readDocument(bytes, { pixels: 'eager', metadata: false });
const project = createProject(doc, FIXTURE);

/**
 * What the plugin would enumerate from Photoshop: groups kept, adjustment
 * layers kept, ids minted per session. Built from the same file the app has
 * open, which is exactly the situation sync is designed for.
 */
let nextId = 1000;
const asHost = (children, path = []) => (children ?? []).map((n) => ({
  id: nextId++,
  name: n.name || (n.children ? 'unnamed' : '(unnamed)'),
  kind: n.children ? 'group' : n.adjustment ? 'curves' : n.text ? 'text' : 'pixel',
  bounds: { left: n.left ?? 0, top: n.top ?? 0, right: n.right ?? 0, bottom: n.bottom ?? 0 },
  layers: n.children ? asHost(n.children, [...path, n.name || 'unnamed']) : undefined,
}));

// `treeFrameFor` reverses, because the Photoshop DOM reports top-down and the
// rest of this repo reads children[0] as the bottom. Hand it top-down.
const tree = treeFrameFor(
  { name: FIXTURE, width: doc.width, height: doc.height },
  asHost(doc.children).reverse(),
);

console.log(`\nlive end-to-end  ·  ${RELAY}`);
console.log(`${FIXTURE}  ${doc.width}x${doc.height}  ·  app layers ${project.layers.length}  ·  photoshop entries ${tree.layers.length}\n`);

// --------------------------------------------------------------- handshake

const app = client('app');
await app.open();
app.send({ type: 'hello', role: 'app', version: '1.0.0' });
const pair = await app.next();
ok('the live relay issues a pairing code', pair.type === 'pair' && pair.code.length === 6, pair.code);

const plugin = client('plugin');
await plugin.open();
plugin.send({ type: 'hello', role: 'plugin', version: '0.1.0' });
plugin.send({ type: 'pair', code: pair.code });
const paired = await app.next();
const pairedPlugin = await plugin.next();
ok('both sides paired onto one session',
  paired.type === 'paired' && paired.sessionId === pairedPlugin.sessionId, paired.sessionId);

// ------------------------------------------------- the tree, and the match

plugin.send(tree);
const arrived = await app.next();
ok('the layer tree crossed intact', JSON.stringify(arrived) === JSON.stringify(tree));

const mapping = matchLayers(arrived.layers, project.layers);
ok('every app layer found its Photoshop layer',
  mapping.matched.length === project.layers.length,
  `matched ${mapping.matched.length}/${project.layers.length}, reported ${mapping.unmatched.length}`);

const psId = (name) => arrived.layers.find((l) => l.name === name)?.layerID;
const order = () => project.layers.map((l) => l.id);
const snapshot = () => JSON.stringify(project.layers.map((l) => [l.id, l.x, l.y, l.name]));

/** Exactly what SyncService.apply does, against the real engine. */
function applyCommand(command) {
  switch (command.type) {
    case 'set': setLayer(project, command.id, command.to); return true;
    case 'reorder': reorderLayer(project, command.from, command.to); return true;
    case 'remove': return !!removeLayer(project, command.id);
    case 'frame': setFrame(project, command.to); return true;
    default: return false;
  }
}

/** Send from the plugin, receive on the app, translate, apply, then assert. */
async function roundTrip(label, frame, check) {
  plugin.send(frame);
  const got = await app.next();
  const result = translateEvent(got, mapping, { order: order() });
  if (!result.ok) return ok(label, false, `refused: ${result.reason}`);
  applyCommand(result.command);
  check(label);
}

// The ids are captured ONCE, before any edit. `project.layers` entries are
// live objects the commands mutate in place, so looking a layer up by
// `target.name` after a rename searches Photoshop's tree for a name only the
// app has -- which the matcher correctly refuses as `unknown-layer`. That is
// the safety property working; it was this script that was wrong.
const target = project.layers[project.layers.length - 1];
const targetPsId = psId(target.name);
const targetAppId = target.id;
console.log(`\n  editing "${target.name}"  ·  photoshop id ${targetPsId} -> app id ${targetAppId}\n`);

await roundTrip('move       the layer moved on the app document',
  { type: 'event', change: 'move', layerID: targetPsId, props: { x: 42, y: 17 } },
  (l) => { const t = findLayer(project, targetAppId); ok(l, t.x === 42 && t.y === 17, `x=${t.x} y=${t.y}`); });

await roundTrip('rename     the name changed',
  { type: 'event', change: 'rename', layerID: targetPsId, props: { name: 'Renamed by Photoshop' } },
  (l) => ok(l, findLayer(project, targetAppId).name === 'Renamed by Photoshop'));

await roundTrip('opacity    applied on the 0..1 scale',
  { type: 'event', change: 'opacity', layerID: targetPsId, props: { opacity: 0.25 } },
  (l) => ok(l, findLayer(project, targetAppId).opacity === 0.25, String(findLayer(project, targetAppId).opacity)));

await roundTrip('visibility hidden',
  { type: 'event', change: 'visibility', layerID: targetPsId, props: { visible: false } },
  (l) => ok(l, findLayer(project, targetAppId).visible === false));

await roundTrip('blendMode  multiply',
  { type: 'event', change: 'blendMode', layerID: targetPsId, props: { blendMode: 'multiply' } },
  (l) => ok(l, findLayer(project, targetAppId).blendMode === 'multiply'));

await roundTrip('crop       the document frame changed',
  { type: 'event', change: 'crop', props: { x: 5, y: 5, width: 100, height: 90 } },
  (l) => ok(l, JSON.stringify(project.frame) === JSON.stringify({ x: 5, y: 5, width: 100, height: 90 }),
    JSON.stringify(project.frame)));

// ------------------------------------------- what must NOT cross as an edit

plugin.send({ type: "event", change: "brush", layerID: targetPsId, props: {} });
const brush = translateEvent(await app.next(), mapping, { order: order() });
ok('a brush stroke is refused as needing pixels', !brush.ok && brush.reason === 'needs-pixels', brush.reason);

app.send({ type: 'error', code: 'needs-pixels', message: 'brush was not applied' });
const backwards = await plugin.next();
ok('and the refusal reached Photoshop', backwards.type === 'error' && backwards.code === 'needs-pixels');

const before = snapshot();
plugin.send({ type: 'event', change: 'move', layerID: 999999, props: { x: 1, y: 1 } });
const ghost = translateEvent(await app.next(), mapping, { order: order() });
ok('an unknown layer is refused, never guessed at', !ghost.ok && ghost.reason === 'unknown-layer', ghost.reason);
ok('and nothing on the document moved', snapshot() === before);

// --------------------------------------------------------------- deletion

const doomed = project.layers[0];
await roundTrip('delete     the layer is gone',
  { type: 'event', change: 'delete', layerID: psId(doomed.name), props: {} },
  (l) => ok(l, !findLayer(project, doomed.id), `${project.layers.length} layers remain`));

app.close();
plugin.close();
console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASSED'}  —  through the deployed Cloudflare relay\n`);
setTimeout(() => process.exit(failed ? 1 : 0), 400);
