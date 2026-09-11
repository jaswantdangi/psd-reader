/**
 * plugin/main.js, RUN -- inside a fake UXP.
 *
 *   node test/plugin.mjs
 *
 * Everything else about the plugin is checked by reading its source. That is
 * how "connects, but edits never sync" got through: every static check
 * passed, and the function that reads a layer id out of a Photoshop
 * notification rejected the shape Photoshop actually sends.
 *
 * So this runs the real file, unmodified, in a `vm` context whose `document`,
 * `WebSocket`, timers and `require('photoshop')` are stand-ins. Notifications
 * go in the way Photoshop delivers them; what comes out is the frames the
 * plugin puts on the wire. The descriptors below are the documented shapes --
 * above all `_enum: 'ordinal', _value: 'targetEnum'`, which is how Photoshop
 * names "the layer the user is editing" almost every time.
 *
 * What this cannot prove is that a given Photoshop build sends these shapes.
 * The plugin still logs the first raw descriptor of each event for that.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { matchLayers } from '../src/sync/identity.js';
import { translateEvent } from '../src/sync/protocol.js';
import { assembleFont } from '../src/sync/font-file.js';
import { makeFont, makeCollection } from './make-font.mjs';

const requireFromPlugin = createRequire(path.resolve('plugin/main.js'));
const SOURCE = fs.readFileSync('plugin/main.js', 'utf8');

let passed = 0;
/** Queued and run in order at the end, so a test can await the plugin's async work. */
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ------------------------------------------------------------ the fake host

function fakeElement() {
  return {
    textContent: '', className: '', value: '', style: {}, scrollTop: 0, scrollHeight: 0,
    childNodes: [], listeners: {},
    get firstChild() { return this.childNodes[0] ?? null; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    click() { for (const fn of this.listeners.click ?? []) fn(); },
  };
}

/**
 * A layer as UXP reports it. `bounds` is deliberately 5px WIDER than
 * `boundsNoEffects` on every side -- a drop shadow -- so a plugin that reads
 * the wrong one sends a position the app would never match.
 */
const layer = (id, name, [left, top, right, bottom], extra = {}) => ({
  id, name, kind: 'pixel',
  bounds: { left: left - 5, top: top - 5, right: right + 5, bottom: bottom + 5 },
  boundsNoEffects: { left, top, right, bottom },
  ...extra,
});

const ORDINAL = { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' };

/**
 * Boot the plugin against a document. Returns handles to drive it.
 *
 * `store` is localStorage and `tokens` the persistent-token table; pass the
 * same two to a second `boot` to simulate Photoshop restarting. `picks` are
 * the folders the folder picker hands back, in order.
 */
function boot({ store = new Map(), tokens = new Map(), picks = [] } = {}) {
  const top = layer(1, 'Top', [10, 10, 30, 30]);
  const nested = layer(4, 'Nested', [50, 50, 70, 80]);
  const group = { id: 3, name: 'Group', kind: 'group', layers: [nested], bounds: nested.bounds, boundsNoEffects: nested.boundsNoEffects };
  const bottom = layer(2, 'Bottom', [0, 0, 100, 100]);
  // Top-down, as UXP reports it: index 0 is the topmost layer.
  const doc = { name: 'a.psd', width: 100, height: 100, layers: [top, group, bottom], activeLayers: [top] };

  let notify = null;
  const photoshop = {
    app: { activeDocument: doc, version: 'test' },
    action: {
      addNotificationListener(events, cb) { notify = cb; return { remove() { notify = null; } }; },
    },
  };

  const storage = {
    formats: { binary: 'binary' },
    localFileSystem: {
      getFolder: async () => picks.shift() ?? null,
      createPersistentToken: async (folder) => { const t = `token-${tokens.size + 1}`; tokens.set(t, folder); return t; },
      getEntryForPersistentToken: async (t) => { if (!tokens.has(t)) throw new Error('token no longer valid'); return tokens.get(t); },
    },
  };

  const timers = new Map();
  let nextTimer = 1;
  const sockets = [];

  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.({}); }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }

  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, fakeElement()); return els.get(id); };

  const context = vm.createContext({
    document: {
      getElementById: el,
      createElement: () => fakeElement(),
      createTextNode: (t) => ({ textContent: t }),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    console: { log() {} },
    navigator: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    WebSocket: FakeSocket,
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    require: (spec) => {
      if (spec === 'photoshop') return photoshop;
      if (spec === 'uxp') return { versions: { uxp: 'test' }, storage };
      return requireFromPlugin(spec);
    },
  });
  vm.runInContext(SOURCE, context, { filename: 'plugin/main.js' });

  const env = {
    doc, top, nested, bottom, el, sockets,
    click: (id) => el(id).click(),
    /** Every piece of text in the fonts-folders list, nested spans included. */
    folders: () => {
      const text = (n) => [n.textContent || '', ...(n.childNodes || []).map(text)].join(' ');
      return el('fontfolders').childNodes.map(text).join('\n');
    },
    log: () => el('logbox').childNodes.map((n) => n.textContent).join('\n'),
    /** Deliver one notification the way Photoshop does, then let the burst flush. */
    notify(event, descriptor) {
      assert.ok(notify, 'the plugin never subscribed to notifications');
      notify(event, descriptor);
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    },
    connect() {
      el('relay').value = 'wss://relay.test';
      el('code').value = 'ABCDEF';
      el('connect').click();
      const ws = sockets.at(-1);
      ws.open();
      return ws;
    },
    pair() {
      const ws = env.connect();
      ws.receive({ type: 'paired', sessionId: 's1', peer: { role: 'app', version: '1.0.0' } });
      return ws;
    },
  };
  return env;
}

const events = (ws) => ws.sent.filter((f) => f.type === 'event');

// ------------------------------------------------------------------ tests

test('the plugin boots and pairs in the fake host', () => {
  const env = boot();
  const ws = env.pair();
  const tree = ws.sent.find((f) => f.type === 'tree');
  assert.ok(tree, `no tree frame was sent. Log:\n${env.log()}`);
  assert.equal(tree.layers.find((l) => l.layerID === 1).bounds.left, 10, 'the tree uses effect-free bounds');
});

test('a move of the selected layer is sent for THAT layer, at its effect-free position', () => {
  // The notification names the layer as "the selection", not by id. Before
  // the fix this logged "no layer id could be read" and sent nothing -- which
  // is what "connected, but changes do not sync" was.
  const env = boot();
  const ws = env.pair();
  env.notify('move', { _obj: 'move', _target: [ORDINAL], to: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: 5 } } });
  assert.deepEqual(events(ws), [
    { type: 'event', change: 'move', layerID: 1, props: { x: 10, y: 10, w: 20, h: 20 } },
  ], `Log:\n${env.log()}`);
});

test('a move with several layers selected sends one event per layer, each at its own position', () => {
  const env = boot();
  env.doc.activeLayers = [env.top, env.bottom];
  const ws = env.pair();
  env.notify('move', { _target: [ORDINAL] });
  assert.deepEqual(events(ws).map((e) => [e.layerID, e.props.x, e.props.y]), [[1, 10, 10], [2, 0, 0]]);
});

test('an explicit layer id is honoured even for a layer inside a group', () => {
  const env = boot();
  const ws = env.pair();
  env.notify('move', { _target: [{ _ref: 'layer', _id: 4 }] });
  assert.deepEqual(events(ws), [
    { type: 'event', change: 'move', layerID: 4, props: { x: 50, y: 50, w: 20, h: 30 } },
  ], `Log:\n${env.log()}`);
});

test('a rename of the selected layer is sent', () => {
  const env = boot();
  const ws = env.pair();
  env.notify('set', { _target: [ORDINAL], to: { _obj: 'layer', name: 'Renamed' } });
  assert.deepEqual(events(ws), [{ type: 'event', change: 'rename', layerID: 1, props: { name: 'Renamed' } }]);
});

test('an opacity change on the selected layer is sent as a fraction', () => {
  const env = boot();
  const ws = env.pair();
  env.notify('set', { _target: [ORDINAL], to: { _obj: 'layer', opacity: { _unit: 'percentUnit', _value: 40 } } });
  assert.deepEqual(events(ws), [{ type: 'event', change: 'opacity', layerID: 1, props: { opacity: 0.4 } }]);
});

test('hiding a layer by NAME hides that layer, not whatever is selected', () => {
  const env = boot();
  const ws = env.pair();
  env.notify('hide', { null: [{ _ref: 'layer', _name: 'Bottom' }] });
  assert.deepEqual(events(ws), [{ type: 'event', change: 'visibility', layerID: 2, props: { visible: false } }]);
});

test('a name two layers share sends nothing rather than picking one', () => {
  const env = boot();
  env.nested.name = 'Bottom';
  const ws = env.pair();
  env.notify('hide', { null: [{ _ref: 'layer', _name: 'Bottom' }] });
  assert.deepEqual(events(ws), []);
  assert.match(env.log(), /Bottom/);
});

test('a delete aimed at "the selection" sends NOTHING — the selection is already a different layer', () => {
  // After a delete Photoshop selects a neighbour. Reading the selection here
  // would tell the app to delete a layer the user never touched.
  const env = boot();
  const ws = env.pair();
  env.doc.layers.shift();           // Top is gone...
  env.doc.activeLayers = [env.bottom]; // ...and Photoshop selected Bottom
  env.notify('delete', { _target: [ORDINAL] });
  assert.deepEqual(events(ws), []);
  assert.match(env.log(), /DIFFERENT layer/);
});

test('a delete naming the layer id is sent, though that layer is no longer in the document', () => {
  const env = boot();
  const ws = env.pair();
  env.doc.layers.shift();
  env.doc.activeLayers = [env.bottom];
  env.notify('delete', { _target: [ORDINAL], layerID: [1] });
  assert.deepEqual(events(ws), [{ type: 'event', change: 'delete', layerID: 1, props: {} }]);
});

test('the app refusing ONE change does not drop the whole connection', () => {
  // The app sends an `error` frame for every change it cannot apply -- an
  // unmatched layer, say. The plugin used to treat any error as the relay
  // refusing it and tore the session down, so one unmatched layer ended sync.
  const env = boot();
  const ws = env.pair();
  ws.receive({ type: 'error', code: 'unknown-layer', message: 'move was not applied: unknown-layer' });
  assert.equal(ws.closed, false, `the socket was closed. Log:\n${env.log()}`);
  env.notify('move', { _target: [ORDINAL] });
  assert.equal(events(ws).length, 1, 'changes after a refusal must still be sent');
  assert.match(env.log(), /unknown-layer/);
});

test('an error before pairing still ends the attempt', () => {
  const env = boot();
  const ws = env.connect();
  ws.receive({ type: 'error', code: 'no-such-code', message: 'that pairing code is not valid' });
  assert.equal(ws.closed, true);
});

test('peer-gone after pairing still ends the session', () => {
  const env = boot();
  const ws = env.pair();
  ws.receive({ type: 'error', code: 'peer-gone', message: 'the app disconnected (close 1001)' });
  assert.equal(ws.closed, true);
});

test('what the plugin sends is what the APP accepts: its tree matches and its events translate', () => {
  // The half the frames above do not prove. The app side is the engine's own
  // matchLayers + translateEvent, run on exactly the frames the plugin put on
  // the wire, against app layers shaped like `toLayer` builds them.
  const env = boot();
  const ws = env.pair();
  env.notify('move', { _target: [ORDINAL] });
  env.notify('set', { _target: [{ _ref: 'layer', _id: 4 }], to: { _obj: 'layer', name: 'Renamed' } });

  const tree = ws.sent.find((f) => f.type === 'tree');
  const appLayers = [
    { id: 100, name: 'Bottom', kind: 'raster', x: 0, y: 0, w: 100, h: 100, groupPath: '' },
    { id: 101, name: 'Nested', kind: 'raster', x: 50, y: 50, w: 20, h: 30, groupPath: 'Group' },
    { id: 102, name: 'Top', kind: 'raster', x: 10, y: 10, w: 20, h: 20, groupPath: '' },
  ];
  const mapping = matchLayers(tree.layers, appLayers);
  assert.equal(mapping.matched.length, 3, `every app layer should match: ${JSON.stringify(mapping.unmatched)}`);

  const results = events(ws).map((e) => translateEvent(e, mapping, { order: appLayers.map((l) => l.id) }));
  assert.deepEqual(results, [
    { ok: true, command: { type: 'set', id: 102, to: { x: 10, y: 10 } } },
    { ok: true, command: { type: 'set', id: 101, to: { name: 'Renamed' } } },
  ]);
});

// ---------------------------------------------------------------- fonts

/** A folder as UXP's file system hands one back, recording which files were read. */
function fakeFolder(label, files) {
  const reads = [];
  const entries = Object.entries(files).map(([name, bytes]) => ({
    name,
    isFile: true,
    read: async () => { reads.push(name); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  }));
  return { name: label, nativePath: label, reads, getEntries: async () => entries };
}

/** Let the plugin's async font work run to completion. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const FONTS = () => fakeFolder('C:\\Windows\\Fonts', {
  'arial.ttf': makeFont('ArialMT'),
  'times.ttf': makeFont('TimesNewRomanPSMT'),
  'MyriadPro-Regular.otf': makeFont('MyriadPro-Regular', { signature: 'OTTO', padding: 700_000 }),
  'cambria.ttc': makeCollection(['Cambria', 'CambriaMath']),
});

test('a chosen fonts folder is remembered across a restart', async () => {
  const store = new Map();
  const tokens = new Map();
  const env = boot({ store, tokens, picks: [FONTS()] });
  env.click('addfolder');
  await settle();
  assert.match(env.folders(), /C:\\Windows\\Fonts/);

  const again = boot({ store, tokens });
  await settle();
  assert.match(again.folders(), /C:\\Windows\\Fonts/);
  assert.doesNotMatch(again.folders(), /no longer available/);
});

test('a requested font is found by its name table and arrives byte for byte', async () => {
  const folder = FONTS();
  const env = boot({ picks: [folder] });
  env.click('addfolder');
  await settle();
  const ws = env.pair();
  ws.receive({ type: 'font-request', names: ['MyriadPro-Regular'] });
  await settle();

  const chunks = ws.sent.filter((f) => f.type === 'font-chunk');
  assert.equal(chunks.length, 2, `a 700 KB file is two chunks. Log:\n${env.log()}`);
  const result = assembleFont(chunks);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.bytes, makeFont('MyriadPro-Regular', { signature: 'OTTO', padding: 700_000 }));
  assert.equal(folder.reads[0], 'MyriadPro-Regular.otf', 'the likely-named file is opened first');
});

test('no folder chosen answers every name with no-folder', async () => {
  const env = boot();
  const ws = env.pair();
  ws.receive({ type: 'font-request', names: ['A', 'B'] });
  await settle();
  assert.deepEqual(
    ws.sent.filter((f) => f.type === 'font-missing').map((f) => [f.name, f.reason]),
    [['A', 'no-folder'], ['B', 'no-folder']],
  );
});

test('a name in no file is not-found, and asking again reads nothing new', async () => {
  const folder = FONTS();
  const env = boot({ picks: [folder] });
  env.click('addfolder');
  await settle();
  const ws = env.pair();
  ws.receive({ type: 'font-request', names: ['AdobeClean-Regular'] });
  await settle();
  const missing = ws.sent.find((f) => f.type === 'font-missing');
  assert.equal(missing.reason, 'not-found');
  assert.match(missing.detail, /Adobe Fonts/);

  const before = folder.reads.length;
  ws.receive({ type: 'font-request', names: ['AdobeClean-Regular'] });
  await settle();
  assert.equal(folder.reads.length, before, 'every file is already indexed, so nothing is re-read');
});

test('a font inside a .ttc is reported as a collection, not as missing', async () => {
  const env = boot({ picks: [FONTS()] });
  env.click('addfolder');
  await settle();
  const ws = env.pair();
  ws.receive({ type: 'font-request', names: ['CambriaMath'] });
  await settle();
  const missing = ws.sent.find((f) => f.type === 'font-missing');
  assert.equal(missing.reason, 'collection');
  assert.match(missing.detail, /cambria\.ttc/);
});

test('a folder whose token no longer resolves is shown as such, and treated as absent', async () => {
  const store = new Map([['psdsync.fontFolders', JSON.stringify([{ token: 'gone', label: 'D:\\Fonts' }])]]);
  const env = boot({ store });
  await settle();
  assert.match(env.folders(), /no longer available/);
  const ws = env.pair();
  ws.receive({ type: 'font-request', names: ['A'] });
  await settle();
  assert.equal(ws.sent.find((f) => f.type === 'font-missing').reason, 'no-folder');
});

test('a font request before pairing is ignored', async () => {
  const env = boot({ picks: [FONTS()] });
  env.click('addfolder');
  await settle();
  const ws = env.connect();
  ws.receive({ type: 'font-request', names: ['ArialMT'] });
  await settle();
  assert.equal(ws.sent.filter((f) => f.type.startsWith('font-')).length, 0);
});

for (const [name, fn] of pending) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

console.log(`\n${passed} passed`);
