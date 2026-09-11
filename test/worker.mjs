/**
 * The relay as a Durable Object.
 *
 * # What this file can and cannot prove
 *
 * `test/relay.mjs` drives a REAL Node server over REAL loopback TCP, because
 * the two properties it exists to establish -- that a paused reader stops the
 * relay reading, and that a vanished tab fails a send rather than leaking a
 * session -- are only observable against a real socket.
 *
 * This file cannot do that. There is no workerd here, so the sockets and the
 * storage are fakes, and what is proven is the POLICY: who may send what,
 * when, to whom, and what is refused. That is worth having on its own -- it is
 * the same policy the Node relay enforces, and a divergence between the two
 * transports would be invisible until someone paired against the wrong one.
 *
 * What it proves NOTHING about: whether Cloudflare accepts the WebSocketPair,
 * whether attachments survive a real hibernation, whether the alarm fires.
 * `npx wrangler dev` is the only thing that answers those.
 */
import assert from 'node:assert/strict';
import { RelayHub, timingSafeEqualStrings } from '../worker/hub.js';
import { resolveWorkerConfig } from '../worker/config.js';
import { originAllowed } from '../server/net.js';
import { PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from '../src/sync/protocol.js';

let passed = 0;
import { chunkFont } from '../src/sync/font-file.js';
import { makeFont } from './make-font.mjs';

const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// --------------------------------------------------------------- harness

/**
 * A socket that behaves the way workerd's does in the ways that matter:
 * an opaque attachment that round-trips through structured clone, and a
 * `send` that throws once closed.
 */
function fakeSocket(name = 'ws') {
  let attachment = null;
  const sent = [];
  return {
    name,
    sent,
    closed: null,
    send(text) {
      if (this.closed) throw new Error('socket is closed');
      sent.push(JSON.parse(text));
    },
    close(code, reason) { this.closed = { code, reason }; },
    serializeAttachment(v) { attachment = JSON.parse(JSON.stringify(v)); },
    deserializeAttachment() { return attachment; },
    /** Frames sent since the last drain. */
    drained() { return sent.splice(0); },
    last() { return sent[sent.length - 1]; },
  };
}

/** `ctx` with the three things the hub touches: storage, sockets, alarms. */
function fakeCtx() {
  const store = new Map();
  const sockets = [];
  return {
    sockets,
    alarmAt: null,
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k) => { store.delete(k); },
      setAlarm: async function (at) { this.alarmAt = at; }.bind(null),
    },
    getWebSockets: () => sockets.filter((s) => !s.closed),
    acceptWebSocket: (ws) => { sockets.push(ws); },
    /** Drop every in-memory field the way an eviction would. */
    raw: store,
  };
}

const ENV = { RELAY_ALLOWED_ORIGINS: 'https://app.test' };

function makeHub(env = {}) {
  const ctx = fakeCtx();
  ctx.storage.setAlarm = async (at) => { ctx.alarmAt = at; };
  const hub = new RelayHub(ctx, { ...ENV, ...env });
  return { hub, ctx };
}

/** Open a socket on the hub the way `fetch` would, without a WebSocketPair. */
function open(hub, ctx, name, key = '203.0.113.1') {
  const ws = fakeSocket(name);
  ctx.acceptWebSocket(ws);
  RelayHub.setState(ws, {
    id: `s${ctx.sockets.length}`, key, role: null, version: null,
    sessionId: null, bytes: 0, budget: 0, budgetAt: Date.now(), openedAt: Date.now(),
  });
  return ws;
}

/** hello as an app; return the socket and the code it was issued. */
async function appWithCode(hub, ctx, key) {
  const app = open(hub, ctx, 'app', key);
  await hub.webSocketMessage(app, JSON.stringify({ type: 'hello', role: 'app', version: '1.0.0' }));
  const frame = app.last();
  assert.equal(frame.type, 'pair', 'an app hello is answered with a code');
  return { app, code: frame.code };
}

/** A fully paired pair, both `paired` frames consumed. */
async function pairedPair(hub, ctx) {
  const { app, code } = await appWithCode(hub, ctx);
  const plugin = open(hub, ctx, 'plugin');
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code }));
  assert.equal(app.last().type, 'paired');
  assert.equal(plugin.last().type, 'paired');
  app.drained();
  plugin.drained();
  return { app, plugin, code };
}

const treeFrame = {
  type: 'tree',
  document: { name: 'poster.psd', width: 100, height: 80 },
  layers: [{ layerID: 7, name: 'Sky', kind: 'pixel', bounds: { left: 0, top: 0, right: 10, bottom: 10 }, groupPath: [] }],
};

// ---------------------------------------------------------------- config

test('a Worker refuses to start with no origin allowlist, unconditionally', () => {
  // On Node this refusal is conditional on the bind being reachable. A Worker
  // has no unreachable bind to be the exception.
  assert.throws(() => resolveWorkerConfig({}), /RELAY_ALLOWED_ORIGINS is unset/);
  assert.throws(() => resolveWorkerConfig({ RELAY_ALLOWED_ORIGINS: '' }), /RELAY_ALLOWED_ORIGINS is unset/);
  assert.ok(resolveWorkerConfig(ENV).allowedOrigins.length === 1);
});

test('the byte-refill rate is derived from the cap here too', () => {
  const config = resolveWorkerConfig({
    ...ENV,
    // The message cap has to come down with it, or the pair is refused —
    // a session that caps on its first frame is not a configuration.
    RELAY_MAX_MESSAGE_BYTES: String(64 * 1024),
    RELAY_MAX_SESSION_BYTES: String(120 * 1024),
  });
  assert.equal(config.sessionByteRefillBytesPerSec, Math.floor((120 * 1024) / 256));
});

test('a message cap above the session cap is refused, not silently accepted', () => {
  assert.throws(
    () => resolveWorkerConfig({ ...ENV, RELAY_MAX_MESSAGE_BYTES: '100', RELAY_MAX_SESSION_BYTES: '10' }),
    /maxMessageBytes must not exceed maxSessionBytes/,
  );
});

// --------------------------------------------------------------- pairing

test('an app hello is answered with a code from the pairing alphabet', async () => {
  const { hub, ctx } = makeHub();
  const { code } = await appWithCode(hub, ctx);
  assert.equal(code.length, PAIR_CODE_LENGTH);
  for (const ch of code) assert.ok(PAIR_CODE_ALPHABET.includes(ch), `"${ch}" is not in the alphabet`);
});

test('a plugin hello is answered with nothing -- only an app is issued a code', async () => {
  const { hub, ctx } = makeHub();
  const plugin = open(hub, ctx, 'plugin');
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  assert.equal(plugin.sent.length, 0);
});

test('a plugin redeeming a live code pairs both sides on the same session', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  assert.equal(RelayHub.state(app).sessionId, RelayHub.state(plugin).sessionId);
  assert.ok(RelayHub.state(app).sessionId, 'a session id was actually assigned');
});

test('a wrong code is refused and creates no session', async () => {
  const { hub, ctx } = makeHub();
  await appWithCode(hub, ctx);
  const plugin = open(hub, ctx, 'plugin');
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code: 'ZZZZZZ' }));
  assert.equal(plugin.last().code, 'no-such-code');
  assert.equal(RelayHub.state(plugin).sessionId, null);
});

test('a code is single use -- the second plugin to present it is refused', async () => {
  const { hub, ctx } = makeHub();
  const { code } = await appWithCode(hub, ctx);
  for (const name of ['first', 'second']) {
    const plugin = open(hub, ctx, name);
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code }));
    if (name === 'second') assert.equal(plugin.last().code, 'no-such-code');
  }
});

test('pair before hello is refused and the socket is closed -- the role must be known first', async () => {
  const { hub, ctx } = makeHub();
  const { code } = await appWithCode(hub, ctx);
  const plugin = open(hub, ctx, 'plugin');
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code }));
  assert.equal(plugin.last().code, 'expected-hello');
  assert.ok(plugin.closed, 'and the socket does not get a second try');
});

test('an app that leaves before its code is redeemed takes the code with it', async () => {
  const { hub, ctx } = makeHub();
  const { app, code } = await appWithCode(hub, ctx);
  app.close();
  await hub.webSocketClose(app);

  const plugin = open(hub, ctx, 'plugin');
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code }));
  assert.equal(plugin.last().code, 'no-such-code', 'a code outliving its app is a code pointing at nothing');
});

test('pairing attempts are rate limited per key', async () => {
  const { hub, ctx } = makeHub({ RELAY_RATE_LIMIT_MAX: '2' });
  await appWithCode(hub, ctx);
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const plugin = open(hub, ctx, `p${i}`, '198.51.100.7');
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code: 'ZZZZZZ' }));
    codes.push(plugin.last().code);
  }
  assert.deepEqual(codes, ['no-such-code', 'no-such-code', 'rate-limited', 'rate-limited']);
});

test('the global ceiling stops a key that has spent nothing of its own', async () => {
  const { hub, ctx } = makeHub({ RELAY_RATE_LIMIT_MAX: '2', RELAY_GLOBAL_RATE_LIMIT_MAX: '2' });
  await appWithCode(hub, ctx);
  const guess = async (key) => {
    const plugin = open(hub, ctx, key, key);
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code: 'ZZZZZZ' }));
    return plugin.last().code;
  };
  assert.equal(await guess('198.51.100.1'), 'no-such-code');
  assert.equal(await guess('198.51.100.2'), 'no-such-code');
  assert.equal(await guess('198.51.100.3'), 'rate-limited', 'the shared budget is what stops the third key');
});

// ---------------------------------------------------- surviving eviction

test('codes and rate limits survive the object being evicted', async () => {
  // The reason the desk is in storage rather than in a closure. An eviction
  // that reset the buckets would hand an attacker a fresh budget.
  const { hub, ctx } = makeHub({ RELAY_RATE_LIMIT_MAX: '2' });
  const { code } = await appWithCode(hub, ctx);

  const plugin0 = open(hub, ctx, 'p0', '198.51.100.9');
  await hub.webSocketMessage(plugin0, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await hub.webSocketMessage(plugin0, JSON.stringify({ type: 'pair', code: 'ZZZZZZ' }));
  assert.equal(plugin0.last().code, 'no-such-code', 'one attempt spent');

  // Evict: everything in memory goes, storage and the sockets remain.
  const revived = new RelayHub(ctx, ENV);
  revived.config = hub.config;

  const plugin1 = open(revived, ctx, 'p1', '198.51.100.9');
  await revived.webSocketMessage(plugin1, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await revived.webSocketMessage(plugin1, JSON.stringify({ type: 'pair', code: 'ZZZZZZ' }));
  assert.equal(plugin1.last().code, 'no-such-code', 'second attempt, still inside the budget');

  const plugin2 = open(revived, ctx, 'p2', '198.51.100.9');
  await revived.webSocketMessage(plugin2, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await revived.webSocketMessage(plugin2, JSON.stringify({ type: 'pair', code: 'ZZZZZZ' }));
  assert.equal(plugin2.last().code, 'rate-limited', 'the budget did NOT reset across the eviction');

  // And the issued code is still redeemable by the right plugin.
  const good = open(revived, ctx, 'good', '203.0.113.50');
  await revived.webSocketMessage(good, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await revived.webSocketMessage(good, JSON.stringify({ type: 'pair', code }));
  assert.equal(good.last().type, 'paired', 'a code issued before the eviction still pairs after it');
});

test('session membership rebuilds from the sockets, not from a map that went away', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);

  const revived = new RelayHub(ctx, ENV);
  await revived.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'opacity', layerID: 3, props: { opacity: 0.25 } }));

  assert.deepEqual(app.last(), { type: 'event', change: 'opacity', layerID: 3, props: { opacity: 0.25 } },
    'the fresh object found the peer with no in-memory session table at all');
});

// --------------------------------------------------------------- routing

test('a valid event crosses the wire byte for byte', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } }));
  assert.deepEqual(app.last(), { type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } });
});

test('undeclared fields are stripped, not relayed', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(plugin, JSON.stringify({
    type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 }, smuggled: 'nope',
  }));
  assert.equal('smuggled' in app.last(), false, 'the frame forwarded is the one validateMessage rebuilt');
});

test('the layer tree crosses, and travels Photoshop -> app only', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);

  await hub.webSocketMessage(plugin, JSON.stringify(treeFrame));
  assert.deepEqual(app.last(), treeFrame);

  await hub.webSocketMessage(app, JSON.stringify(treeFrame));
  assert.equal(app.last().code, 'wrong-direction');
  assert.equal(plugin.sent.length, 0, 'and nothing reached the plugin');
});

test('events travel Photoshop -> app only', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(app, JSON.stringify({ type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 } }));
  assert.equal(app.last().code, 'wrong-direction');
  assert.equal(plugin.sent.length, 0);
});

test('a font request travels app -> Photoshop only', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(app, JSON.stringify({ type: 'font-request', names: ['MyriadPro-Regular'] }));
  assert.deepEqual(plugin.last(), { type: 'font-request', names: ['MyriadPro-Regular'] });
  plugin.drained();
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'font-request', names: ['X'] }));
  assert.equal(plugin.last().code, 'wrong-direction');
  assert.equal(app.sent.length, 0, 'nothing reached the app');
});

test('font files and font reports travel Photoshop -> app only', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  const [chunk] = chunkFont(makeFont('MyriadPro-Regular'), { name: 'MyriadPro-Regular', fileName: 'MyriadPro-Regular.otf' });
  await hub.webSocketMessage(plugin, JSON.stringify(chunk));
  assert.deepEqual(app.last(), chunk);
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'font-missing', name: 'X', reason: 'not-found' }));
  assert.deepEqual(app.last(), { type: 'font-missing', name: 'X', reason: 'not-found', detail: '' });
  app.drained();
  await hub.webSocketMessage(app, JSON.stringify(chunk));
  assert.equal(app.last().code, 'wrong-direction');
  assert.equal(plugin.sent.length, 0);
});

test('a font request before pairing is refused', async () => {
  const { hub, ctx } = makeHub();
  const { app } = await appWithCode(hub, ctx);
  await hub.webSocketMessage(app, JSON.stringify({ type: 'font-request', names: ['A'] }));
  assert.equal(app.last().code, 'not-paired');
});

test('an error frame is relayed both ways, so a peer can report what it could not apply', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(app, JSON.stringify({ type: 'error', code: 'needs-pixels', message: 'brush was not applied' }));
  assert.deepEqual(plugin.last(), { type: 'error', code: 'needs-pixels', message: 'brush was not applied' });
});

test('an event before pairing has nowhere to go and is refused', async () => {
  const { hub, ctx } = makeHub();
  const plugin = open(hub, ctx, 'plugin');
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.1.0' }));
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 } }));
  assert.equal(plugin.last().code, 'not-paired');
});

test('an unknown frame type is refused and reaches no peer', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'summon', anything: 1 }));
  assert.equal(plugin.last().code, 'unknown-type');
  assert.equal(app.sent.length, 0);
});

test('a malformed frame is refused with the parse failure, not a crash', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(plugin, '{not json');
  assert.equal(plugin.last().code, 'bad-json');
  assert.equal(app.sent.length, 0);
});

test('a binary frame is refused -- under the rescope the wire is JSON only', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(plugin, new ArrayBuffer(8));
  assert.equal(plugin.last().code, 'binary-refused');
  assert.equal(app.sent.length, 0);
});

test('a message over the per-message cap is refused without being parsed', async () => {
  const { hub, ctx } = makeHub({ RELAY_MAX_MESSAGE_BYTES: '256', RELAY_MAX_SESSION_BYTES: '4096' });
  const { app, plugin } = await pairedPair(hub, ctx);
  const blob = 'x'.repeat(1024);
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'brush', layerID: 7, props: { blob } }));
  assert.equal(plugin.last().code, 'message-too-large');
  assert.equal(app.sent.length, 0, 'nothing of an oversize frame crosses');
});

// ---------------------------------------------------------- the budget

test('a session that outruns its byte budget is closed, both sides told why', async () => {
  const { hub, ctx } = makeHub({ RELAY_MAX_MESSAGE_BYTES: '2048', RELAY_MAX_SESSION_BYTES: '4096' });
  const { app, plugin } = await pairedPair(hub, ctx);
  const blob = 'y'.repeat(1024);
  for (let i = 0; i < 8; i++) {
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'brush', layerID: 7, props: { blob, i } }));
  }
  assert.equal(plugin.last().code, 'session-cap');
  assert.ok(plugin.closed, 'the sender is closed');
  assert.ok(app.closed, 'and so is the peer, rather than being left waiting');
});

test('the budget drains, so a slow sender is never capped', async () => {
  // The property the decay exists for: without it the cap is a lifetime quota
  // and every long session dies eventually for doing nothing wrong.
  // The refill rate is stated rather than derived here. Derived it would be
  // 4096/256 = 16 bytes a second, and a test that waits out a 4 KiB budget at
  // 16 B/s is a test about arithmetic rather than about draining.
  const { hub, ctx } = makeHub({
    RELAY_MAX_MESSAGE_BYTES: '2048', RELAY_MAX_SESSION_BYTES: '4096', RELAY_SESSION_BYTE_REFILL: '4096',
  });
  const { app, plugin } = await pairedPair(hub, ctx);
  const blob = 'y'.repeat(1024);

  for (let i = 0; i < 3; i++) {
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'brush', layerID: 7, props: { blob, i } }));
  }
  // Wind the clock back on the socket's own record, which is what the drain
  // reads. Two seconds at 4096 B/s refunds more than the whole budget.
  const state = RelayHub.state(plugin);
  RelayHub.setState(plugin, { ...state, budgetAt: state.budgetAt - 2_000 });

  for (let i = 0; i < 3; i++) {
    await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'brush', layerID: 7, props: { blob, i } }));
  }
  assert.equal(plugin.closed, null, 'a minute of silence refunded the whole budget');
  assert.ok(RelayHub.state(plugin).bytes > hub.config.maxSessionBytes,
    'and lifetime bytes passed the cap without the cap firing');
});

// ------------------------------------------------------------ lifecycle

test('peer-gone names which side left and how, not one fixed sentence', async () => {
  // "Connects, then stops with a peer error" was undiagnosable because every
  // departure produced the same words. The survivor has to learn which side
  // went and the close code -- that is what separates a person closing a tab
  // from the relay pairing the wrong two sockets.
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  app.close();
  await hub.webSocketClose(app, 1001, 'going away', true);

  const frame = plugin.last();
  assert.equal(frame.code, 'peer-gone', 'the code stays peer-gone — both clients switch on it');
  assert.match(frame.message, /\bthe app\b/, 'names the app as the side that left');
  assert.match(frame.message, /1001/, 'carries the close code');
  assert.match(frame.message, /going away/, 'and what that code means');
});

test('an errored socket reaches the survivor as an error, not a clean close', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  app.close();
  await hub.webSocketError(app, new Error('connection reset'));

  assert.equal(plugin.last().code, 'peer-gone');
  assert.match(plugin.last().message, /connection reset/, 'the error text reaches the survivor');
});

test('a close with no code is described honestly rather than as an error', async () => {
  // The fake calls webSocketClose(ws) bare. Absence of a code is not evidence
  // of a failure, and saying "it errored" would send the search the wrong way.
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  app.close();
  await hub.webSocketClose(app);
  assert.match(plugin.last().message, /no close code was given/);
});

test('a vanished peer takes the session with it', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  app.close();
  await hub.webSocketClose(app);
  assert.equal(plugin.last().code, 'peer-gone');
  assert.ok(plugin.closed);
});

test('routing to a peer that is already gone refuses rather than throwing', async () => {
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  app.close(); // gone, but webSocketClose has not run yet
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 } }));
  assert.equal(plugin.last().code, 'peer-gone');
});

test('a session nobody else holds is described as that, not as a departure', async () => {
  // Two situations that must not read the same. A peer that CLOSED arrives
  // through webSocketClose and names who went. A sender whose session no other
  // live socket shares is either a peer that dropped without its close reaching
  // the relay, or a socket paired to itself -- which is what an eviction
  // produced before ids were UUIDs.
  const { hub, ctx } = makeHub();
  const { app, plugin } = await pairedPair(hub, ctx);
  app.close(); // gone, and no webSocketClose has reached the relay
  await hub.webSocketMessage(plugin, JSON.stringify(treeFrame));

  const frame = plugin.last();
  assert.equal(frame.code, 'peer-gone', 'the code is unchanged — clients switch on it');
  assert.match(frame.message, /no other socket holds this session/);
  assert.doesNotMatch(frame.message, /disconnected \(close/,
    'must not claim a close code it never received');
});

test('the alarm sweeps expired codes and re-arms only while any remain', async () => {
  const { hub, ctx } = makeHub({ RELAY_PAIR_TTL_MS: '1' });
  await appWithCode(hub, ctx);
  assert.equal((await hub.deskNow()).size(), 1);

  await new Promise((r) => setTimeout(r, 5));
  ctx.alarmAt = null;
  await hub.alarm();

  assert.equal((await hub.deskNow()).size(), 0, 'the expired code is gone');
  assert.equal(ctx.alarmAt, null, 'and nothing re-arms an alarm with no codes left to sweep');
});

// ------------------------------------------------- eviction and socket ids

/**
 * Cloudflare's docs are explicit: "When an event arrives, the Durable Object is
 * re-initialized and its constructor runs." So ANY in-memory counter restarts on
 * every wake. Socket ids were minted from one -- `s${this.nextId++}` -- which
 * means an app connected BEFORE an eviction and a plugin connected AFTER it can
 * be handed the very same id. A person reading a code off one screen and typing
 * it into Photoshop is exactly the gap in which an eviction happens.
 *
 * Whether the collision then breaks anything depends on something else nobody
 * controls. `onPair` resolves the code's owner with `find(id === owner)`, and
 * which of two same-id sockets it finds first depends on the order
 * `ctx.getWebSockets()` yields them -- which Cloudflare does not specify. App
 * first: pairing happens to work. Plugin first: the plugin pairs WITH ITSELF,
 * the app is never told, and the first frame the plugin sends finds no peer and
 * comes back `peer-gone`. That is the reported symptom, and it is why it is
 * intermittent.
 *
 * So this runs in BOTH orders. Correctness must not depend on either.
 */
for (const order of ['insertion', 'reversed']) {
  test(`pairing survives an eviction between app and plugin (${order} socket order)`, async () => {
    const ctx = fakeCtx();
    ctx.storage.setAlarm = async (at) => { ctx.alarmAt = at; };
    if (order === 'reversed') {
      const listed = ctx.getWebSockets;
      ctx.getWebSockets = () => listed().slice().reverse();
    }

    // Before the eviction: the app connects and is issued a code.
    const before = new RelayHub(ctx, ENV);
    const app = open(before, ctx, 'app');
    RelayHub.setState(app, { ...RelayHub.state(app), id: before.mintSocketId() });
    await before.webSocketMessage(app, JSON.stringify({ type: 'hello', role: 'app', version: '1.0.0' }));
    const { code } = app.last();

    // The eviction: a brand-new instance, exactly as a wake constructs one.
    const after = new RelayHub(ctx, ENV);
    const plugin = open(after, ctx, 'plugin');
    RelayHub.setState(plugin, { ...RelayHub.state(plugin), id: after.mintSocketId() });

    await after.webSocketMessage(plugin, JSON.stringify({ type: 'hello', role: 'plugin', version: '0.2.0' }));
    await after.webSocketMessage(plugin, JSON.stringify({ type: 'pair', code }));

    // The user-visible symptom first, so a failure names what a person saw.
    assert.ok(app.sent.some((f) => f.type === 'paired'),
      'the app was never told it was paired — the plugin paired with itself');
    assert.equal(plugin.sent.filter((f) => f.type === 'paired').length, 1,
      'the plugin was paired twice — once as each side of its own session');

    await after.webSocketMessage(plugin, JSON.stringify(treeFrame));
    assert.equal(plugin.sent.some((f) => f.code === 'peer-gone'), false,
      'the plugin was told peer-gone — the reported bug');
    assert.ok(app.sent.some((f) => f.type === 'tree'), 'the tree never reached the app');

    // Then the root cause, which is what fails even when the order is lucky.
    assert.notEqual(RelayHub.state(plugin).id, RelayHub.state(app).id,
      'a socket minted after an eviction reused the id of one minted before it');
  });
}

test('socket ids never repeat across many evictions', () => {
  // The general property, not just the two-socket case: every wake is a fresh
  // instance, and none of them may hand out an id another already has.
  const ctx = fakeCtx();
  const seen = new Set();
  for (let wake = 0; wake < 50; wake++) {
    const hub = new RelayHub(ctx, ENV);
    for (let n = 0; n < 4; n++) {
      const id = hub.mintSocketId();
      assert.equal(seen.has(id), false, `id ${id} was minted twice (wake ${wake})`);
      seen.add(id);
    }
  }
});

// --------------------------------------------------------------- origin

test('a non-web origin is admitted — the allowlist only ever constrained browsers', () => {
  // The UXP plugin could not connect at all because of this. It is not a web
  // page, so whatever it presents is not a page origin, and applying a control
  // designed to stop "any tab" to a native client excludes no browser and
  // locks out the one client that is supposed to be there.
  //
  // Asserted on the policy rather than through `fetch`: a successful upgrade
  // returns HTTP 101, which only workerd can construct — Node's Response
  // refuses the status outright. The 403 path below IS driven through fetch,
  // because that one returns an ordinary response.
  const allowlist = ['https://app.test'];
  for (const origin of ['plugin://com.psdreader.sync', 'app:photoshop', 'uxp', '']) {
    assert.equal(originAllowed(origin, allowlist), true, `origin ${JSON.stringify(origin)} was refused`);
  }
  assert.equal(originAllowed(undefined, allowlist), true, 'no header at all is admitted');
  assert.equal(originAllowed('https://app.test', allowlist), true, 'the allowlisted page still works');
});

test('the origin rule does not become a way around the allowlist', () => {
  // The control still has to do its job for the case it exists for: a page in
  // a tab. `null` is included because that is what a sandboxed or file://
  // document sends — it IS a browser, and must not be waved through.
  const allowlist = ['https://app.test'];
  for (const origin of ['https://evil.test', 'http://evil.test', 'HTTPS://EVIL.TEST', 'null']) {
    assert.equal(originAllowed(origin, allowlist), false, `browser origin ${origin} should be refused`);
  }
});

test('a browser origin outside the allowlist is still refused', async () => {
  // The control has to keep doing its job for the case it exists for.
  const { hub } = makeHub();
  for (const origin of ['https://evil.test', 'http://evil.test', 'null']) {
    const res = await hub.fetch(new Request('https://relay.test/', {
      headers: { Upgrade: 'websocket', Origin: origin },
    }));
    assert.equal(res.status, 403, `browser origin ${origin} should be refused`);
  }
});

test('/whoami reports the origin it saw, and whether it would be admitted', async () => {
  // A refused upgrade tells the client nothing at all -- no status, no body,
  // no reason. This is the only way a plugin can tell "wrong address" from
  // "refused origin", which is the exact ambiguity that stalled it.
  const { hub } = makeHub();

  const seen = await (await hub.fetch(new Request('https://relay.test/whoami', {
    headers: { Origin: 'https://app.test' },
  }))).json();
  assert.equal(seen.origin, 'https://app.test');
  assert.equal(seen.allowed, true);
  assert.equal(seen.sentOriginHeader, true);

  const refused = await (await hub.fetch(new Request('https://relay.test/whoami', {
    headers: { Origin: 'https://evil.test' },
  }))).json();
  assert.equal(refused.allowed, false, 'and it says no when the answer is no');

  const bare = await (await hub.fetch(new Request('https://relay.test/whoami'))).json();
  assert.equal(bare.sentOriginHeader, false);
  assert.equal(bare.allowed, true, 'no Origin header is always admitted');
});

// ---------------------------------------------------------------- stats

test('stats are unreachable without a token, and say nothing that identifies the route', async () => {
  const { hub, ctx } = makeHub();
  await pairedPair(hub, ctx);
  const res = await hub.statsResponse(new Request('https://relay.test/stats'));
  const other = hub.notWebSocket();
  assert.equal(res.status, 426);
  assert.equal(await res.text(), await other.text(), 'byte for byte what any other path returns');
});

test('a wrong token of the right length is refused', async () => {
  const { hub, ctx } = makeHub({ RELAY_STATS_TOKEN: 'a-long-enough-token' });
  await pairedPair(hub, ctx);
  const res = await hub.statsResponse(new Request('https://relay.test/stats', {
    headers: { authorization: 'Bearer a-long-enough-toker' },
  }));
  assert.equal(res.status, 426);
});

test('the right token reads counts, and no payload', async () => {
  const { hub, ctx } = makeHub({ RELAY_STATS_TOKEN: 'a-long-enough-token' });
  const { plugin } = await pairedPair(hub, ctx);
  await hub.webSocketMessage(plugin, JSON.stringify({ type: 'event', change: 'rename', layerID: 3, props: { name: 'SECRETMARKER' } }));

  const res = await hub.statsResponse(new Request('https://relay.test/stats', {
    headers: { authorization: 'Bearer a-long-enough-token' },
  }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('SECRETMARKER'), 'stats is counts only, and that is load-bearing');

  const body = JSON.parse(text);
  assert.equal(body.runtime, 'workers');
  assert.equal(body.connections, 2);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].peers, 2);
  assert.equal('peakBufferedBytes' in body.sessions[0], false,
    'this runtime cannot measure backpressure, so it must not report a zero for it');
});

test('the constant-time compare is actually comparing', () => {
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStrings('', ''), true);
});

// ------------------------------------------------------------------ run

console.log('\nworker: the relay as a Durable Object (fake sockets, fake storage)\n');
for (const [name, fn] of pending) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
