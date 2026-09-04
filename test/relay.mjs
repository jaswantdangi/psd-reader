/**
 * The Photoshop -> app relay: transport and session layer.
 *
 * Every test here runs a REAL server on a REAL ephemeral port and drives it
 * with REAL `ws` clients over loopback TCP. Nothing is mocked. A mocked socket
 * proves the right frame was built; it never proves a peer accepted it, and the
 * two properties this file exists to establish -- that a paused reader actually
 * stops the relay reading, and that a vanished tab fails the send instead of
 * leaking the session -- are only observable against a real socket.
 *
 * The relay owns pairing, routing and lifecycle. It owns NO understanding of a
 * PSD: it never parses, renders or edits a document, and the assertions at the
 * bottom of this file pin that by reading `server/` back off disk.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from '../src/sync/protocol.js';
import { createRelay } from '../server/relay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, '..', 'server');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// --------------------------------------------------------------- harness

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy, or throw with the reason it never became so. */
async function until(fn, why, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${why}`);
    await sleep(5);
  }
}

/**
 * A test client. Frames land in a queue rather than a handler, so a test can
 * ask for "the next frame" without racing the socket.
 */
function client(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  const closes = [];
  let closed = null;
  const push = (v) => (waiters.length ? waiters.shift()(v) : queue.push(v));

  ws.on('message', (data, isBinary) => push(isBinary ? { binary: data } : JSON.parse(data.toString())));
  ws.on('close', (code, reason) => {
    closed = { code, reason: reason.toString() };
    closes.forEach((r) => r(closed));
    closes.length = 0;
    waiters.forEach((r) => r({ closed: true }));
    waiters.length = 0;
  });
  ws.on('error', () => {});

  return {
    ws,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    next: (timeoutMs = 5000) => new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      const t = setTimeout(() => rej(new Error('no frame arrived within ' + timeoutMs + 'ms')), timeoutMs);
      waiters.push((v) => { clearTimeout(t); res(v); });
    }),
    seen: () => queue.length,
    drained: () => queue.splice(0),
    send: (obj) => ws.send(JSON.stringify(obj)),
    closedInfo: () => closed,
    waitClose: (timeoutMs = 5000) => new Promise((res, rej) => {
      if (closed) return res(closed);
      const t = setTimeout(() => rej(new Error('socket did not close within ' + timeoutMs + 'ms')), timeoutMs);
      closes.push((v) => { clearTimeout(t); res(v); });
    }),
    close: () => ws.close(),
    terminate: () => ws.terminate(),
  };
}

/** Start a relay, run the body, always shut the relay down. */
async function withRelay(options, body) {
  const logged = [];
  const relay = createRelay({ port: 0, host: '127.0.0.1', log: (line) => logged.push(line), ...options });
  const url = await relay.listen();
  const clients = [];
  const spawnClient = (u = url) => { const c = client(u); clients.push(c); return c; };
  try {
    return await body({ relay, url, client: spawnClient, logged });
  } finally {
    for (const c of clients) { try { c.terminate(); } catch { /* already gone */ } }
    await relay.close();
  }
}

/** hello as an app, come back with the issued pairing code. */
async function appWithCode(ctx) {
  const app = ctx.client();
  await app.open();
  app.send({ type: 'hello', role: 'app', version: '1.0.0' });
  const frame = await app.next();
  assert.equal(frame.type, 'pair', 'the relay answers an app hello with the pairing code');
  return { app, code: frame.code };
}

/** A fully paired plugin/app pair, both `paired` frames consumed. */
async function pairedPair(ctx) {
  const { app, code } = await appWithCode(ctx);
  const plugin = ctx.client();
  await plugin.open();
  plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
  plugin.send({ type: 'pair', code });
  const a = await app.next();
  const p = await plugin.next();
  assert.equal(a.type, 'paired');
  assert.equal(p.type, 'paired');
  assert.equal(a.sessionId, p.sessionId, 'both sides are told the same session');
  return { app, plugin, code, sessionId: a.sessionId };
}

// --------------------------------------------------------------- pairing

test('an app hello is answered with a code from the pairing alphabet', () => withRelay({}, async (ctx) => {
  const { code } = await appWithCode(ctx);
  assert.equal(code.length, PAIR_CODE_LENGTH);
  for (const ch of code) assert.ok(PAIR_CODE_ALPHABET.includes(ch), `"${ch}" is not in the pairing alphabet`);
}));

test('two codes issued back to back differ', () => withRelay({}, async (ctx) => {
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add((await appWithCode(ctx)).code);
  assert.equal(seen.size, 12, 'codes must not repeat within a run');
}));

test('a plugin redeeming a live code pairs both sides', () => withRelay({}, async (ctx) => {
  const { app, plugin, sessionId } = await pairedPair(ctx);
  assert.ok(sessionId.length > 0);
  const stats = ctx.relay.stats();
  assert.equal(stats.sessions.length, 1, 'exactly one session exists');
  assert.equal(stats.pendingCodes, 0, 'the redeemed code is gone from the pending set');
  assert.ok(app && plugin);
}));

test('a wrong code is refused and creates no session', () => withRelay({}, async (ctx) => {
  await appWithCode(ctx);
  const plugin = ctx.client();
  await plugin.open();
  plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
  plugin.send({ type: 'pair', code: 'ZZZZZZ' });
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'no-such-code');
  assert.equal(ctx.relay.stats().sessions.length, 0);
}));

test('a code past its five-minute life is refused', () => withRelay({ pairTtlMs: 40 }, async (ctx) => {
  const { code } = await appWithCode(ctx);
  await sleep(120);
  const plugin = ctx.client();
  await plugin.open();
  plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
  plugin.send({ type: 'pair', code });
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'code-expired');
  assert.equal(ctx.relay.stats().sessions.length, 0);
}));

test('the default code lifetime is the five minutes the design specifies', () => withRelay({}, async (ctx) => {
  assert.equal(ctx.relay.config.pairTtlMs, 5 * 60 * 1000);
}));

test('a code is single use -- the second plugin to present it is refused', () => withRelay({}, async (ctx) => {
  const { code } = await pairedPair(ctx);
  const second = ctx.client();
  await second.open();
  second.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
  second.send({ type: 'pair', code });
  const frame = await second.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'no-such-code', 'a consumed code is indistinguishable from one that never existed');
  assert.equal(ctx.relay.stats().sessions.length, 1, 'the established session is untouched');
}));

test('pairing attempts are rate limited per IP', () => withRelay({ rateLimitMax: 4, rateLimitWindowMs: 60_000 }, async (ctx) => {
  await appWithCode(ctx);
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const plugin = ctx.client();
    await plugin.open();
    plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
    plugin.send({ type: 'pair', code: 'ZZZZZZ' });
    codes.push((await plugin.next()).code);
  }
  assert.deepEqual(codes.slice(0, 4), ['no-such-code', 'no-such-code', 'no-such-code', 'no-such-code']);
  assert.deepEqual(codes.slice(4), ['rate-limited', 'rate-limited'],
    'past the budget the relay stops answering guesses at all');
}));

test('the rate limiter blocks a CORRECT code once the budget is spent', () => withRelay({ rateLimitMax: 2 }, async (ctx) => {
  const { code } = await appWithCode(ctx);
  for (let i = 0; i < 2; i++) {
    const guess = ctx.client();
    await guess.open();
    guess.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
    guess.send({ type: 'pair', code: 'ZZZZZZ' });
    await guess.next();
  }
  const plugin = ctx.client();
  await plugin.open();
  plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
  plugin.send({ type: 'pair', code });
  const frame = await plugin.next();
  assert.equal(frame.code, 'rate-limited', 'brute force is throttled even when the guesser gets lucky');
  assert.equal(ctx.relay.stats().sessions.length, 0);
}));

test('pair before hello is refused -- the role must be known first', () => withRelay({}, async (ctx) => {
  const plugin = ctx.client();
  await plugin.open();
  plugin.send({ type: 'pair', code: 'ABCDEF' });
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'expected-hello');
  await plugin.waitClose();
}));

// --------------------------------------------------------------- routing

test('a valid event crosses the wire byte for byte', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  plugin.send({ type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } });
  const frame = await app.next();
  assert.deepEqual(frame, { type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } });
}));

test('undeclared fields are stripped, not relayed', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  plugin.send({ type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 }, evil: 'passthrough' });
  const frame = await app.next();
  assert.equal(frame.evil, undefined, 'the relay forwards the VALIDATED frame, never the raw one');
}));

test('an unknown frame type is refused and reaches no peer', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  plugin.send({ type: 'doc-chunk', bytes: 10 });
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'unknown-type');
  await sleep(50);
  assert.equal(app.seen(), 0, 'nothing unvalidated is ever forwarded');
}));

test('a malformed frame is refused with the parse failure, not a crash', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  plugin.ws.send('{ not json');
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'bad-json');
  await sleep(50);
  assert.equal(app.seen(), 0);
  plugin.send({ type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 } });
  assert.equal((await app.next()).change, 'move', 'the session survives a bad frame');
}));

test('a frame that fails field validation is refused', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  plugin.send({ type: 'event', change: 'move', layerID: { nope: true }, props: {} });
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'bad-field');
  await sleep(50);
  assert.equal(app.seen(), 0);
}));

test('a binary frame is refused -- under the rescope the wire is JSON only', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  plugin.ws.send(Buffer.from([1, 2, 3, 4]));
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'binary-refused');
  await sleep(50);
  assert.equal(app.seen(), 0);
}));

test('events travel Photoshop -> app only', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  app.send({ type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 } });
  const frame = await app.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'wrong-direction', 'Photoshop is authoritative; the app does not push events back');
  await sleep(50);
  assert.equal(plugin.seen(), 0);
}));

test('an error frame is relayed both ways so a peer can report what it could not apply', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  app.send({ type: 'error', code: 'unmappable', message: 'adjustment layers do not sync' });
  const atPlugin = await plugin.next();
  assert.deepEqual(atPlugin, { type: 'error', code: 'unmappable', message: 'adjustment layers do not sync' });
  plugin.send({ type: 'error', code: 'needs-pixels', message: 'brush stroke' });
  assert.equal((await app.next()).code, 'needs-pixels');
}));

test('an event before pairing has nowhere to go and is refused', () => withRelay({}, async (ctx) => {
  const plugin = ctx.client();
  await plugin.open();
  plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
  plugin.send({ type: 'event', change: 'move', layerID: 7, props: { x: 1, y: 2 } });
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'not-paired');
}));

// ---------------------------------------------------------------- caps

test('a message over the per-message cap is refused without being buffered', () => withRelay({ maxMessageBytes: 4096 }, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  plugin.send({ type: 'event', change: 'brush', layerID: 7, props: { blob: 'x'.repeat(16 * 1024) } });
  const closed = await plugin.waitClose();
  assert.equal(closed.code, 1009, 'ws refuses an oversize frame at the protocol level (1009 = message too big)');
  assert.equal(app.seen(), 0);
  await until(() => ctx.relay.stats().sessions.length === 0, 'the session tears down after the oversize close');
}));

test('a session that exceeds its byte cap is closed, both sides told why', () => withRelay(
  { maxMessageBytes: 64 * 1024, maxSessionBytes: 120 * 1024 },
  async (ctx) => {
    const { app, plugin } = await pairedPair(ctx);
    const blob = 'y'.repeat(32 * 1024);
    for (let i = 0; i < 12; i++) plugin.send({ type: 'event', change: 'brush', layerID: 7, props: { blob, i } });
    const frames = [];
    for (;;) {
      const f = await plugin.next();
      if (f.closed) break;
      frames.push(f);
      if (f.type === 'error') break;
    }
    assert.equal(frames.at(-1).type, 'error');
    assert.equal(frames.at(-1).code, 'session-cap');
    await plugin.waitClose();
    await app.waitClose();
    await until(() => ctx.relay.stats().sessions.length === 0, 'a capped session is removed, not leaked');
  },
));

test('the default caps are stated, and bound one pixel frame rather than one document', () => withRelay({}, async (ctx) => {
  assert.equal(ctx.relay.config.maxMessageBytes, 8 * 1024 * 1024);
  assert.equal(ctx.relay.config.maxSessionBytes, 256 * 1024 * 1024);
  assert.ok(ctx.relay.config.highWaterBytes < ctx.relay.config.maxMessageBytes);
}));

// ----------------------------------------------------------- backpressure

/**
 * The one property a mocked socket cannot establish.
 *
 * The app client stops reading its socket. TCP backpressure walks back through
 * the kernel to the relay's write buffer, `bufferedAmount` climbs past the high
 * water mark, and the relay must then STOP READING the plugin -- otherwise it
 * accepts 30 MB of frames into RAM to serve a peer taking none of them.
 *
 * Proof, not assertion: the relay reports how many frames it has read off the
 * plugin socket. If backpressure works that count STALLS far below what was
 * sent, and the relay's peak buffered bytes stay near one chunk. If it does
 * not, the count reaches the full send and peak buffering reaches 30 MB.
 */
test('a peer that stops reading stops the relay reading', () => withRelay(
  { maxMessageBytes: 1024 * 1024, maxSessionBytes: 128 * 1024 * 1024, highWaterBytes: 128 * 1024 },
  async (ctx) => {
    const { app, plugin } = await pairedPair(ctx);
    const N = 120;
    const blob = 'z'.repeat(256 * 1024);
    const totalBytes = N * blob.length;

    app.ws.pause(); // the browser tab stops draining its socket

    for (let i = 0; i < N; i++) plugin.send({ type: 'event', change: 'brush', layerID: 7, props: { blob, i } });

    const session = () => ctx.relay.stats().sessions[0];
    await until(() => session()?.senderPaused, 'the relay to pause its reader');

    const stalled = session();
    assert.ok(stalled.framesRead < N,
      `the relay read all ${N} frames despite the peer taking none -- there is no backpressure`);
    assert.ok(stalled.peakBufferedBytes <= ctx.relay.config.highWaterBytes + ctx.relay.config.maxMessageBytes,
      `peak buffered ${stalled.peakBufferedBytes} exceeds one high-water plus one message`);
    assert.ok(stalled.peakBufferedBytes < totalBytes / 8,
      `peak buffered ${stalled.peakBufferedBytes} of ${totalBytes} sent -- the relay is holding the stream, not a chunk`);

    // Hold it stalled: a paused relay must STAY paused, not drift forward.
    const readAtStall = stalled.framesRead;
    await sleep(250);
    assert.equal(session().framesRead, readAtStall, 'the relay kept reading while its peer was still stalled');

    app.ws.resume(); // the tab comes back

    const seen = [];
    await until(() => { seen.push(...app.drained()); return seen.length >= N; },
      `all ${N} frames to arrive once the reader resumed (saw ${seen.length})`, 30_000);

    assert.equal(seen.length, N, 'nothing was dropped while paused -- backpressure delays, it does not discard');
    assert.deepEqual(seen.map((f) => f.props.i), Array.from({ length: N }, (_, i) => i), 'and order is preserved');
    assert.equal(seen[0].props.blob.length, blob.length, 'payloads are intact');
    assert.ok(session().pauses >= 1, 'the pause was recorded');
    assert.equal(session().framesRead, N);
    assert.equal(session().senderPaused, false, 'the reader is resumed once the buffer drains');
  },
));

// ------------------------------------------------------------- lifecycle

test('a vanished peer fails the send cleanly and takes the session with it', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  app.terminate(); // the browser tab is closed, hard
  const frame = await plugin.next();
  assert.equal(frame.type, 'error');
  assert.equal(frame.code, 'peer-gone');
  const closed = await plugin.waitClose();
  assert.equal(closed.code, 1001, 'the surviving side is closed with going-away, not left hanging');
  await until(() => ctx.relay.stats().sessions.length === 0, 'the session to be reaped');
  assert.equal(ctx.relay.stats().connections, 0, 'no socket is left behind');
}));

test('an app that leaves before its code is redeemed takes the code with it', () => withRelay({}, async (ctx) => {
  const { app, code } = await appWithCode(ctx);
  assert.equal(ctx.relay.stats().pendingCodes, 1);
  app.terminate();
  await until(() => ctx.relay.stats().pendingCodes === 0, 'the orphaned code to be dropped');
  const plugin = ctx.client();
  await plugin.open();
  plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
  plugin.send({ type: 'pair', code });
  assert.equal((await plugin.next()).code, 'no-such-code');
}));

test('expired codes are swept rather than accumulating', () => withRelay({ pairTtlMs: 40, sweepMs: 20 }, async (ctx) => {
  for (let i = 0; i < 5; i++) await appWithCode(ctx);
  assert.equal(ctx.relay.stats().pendingCodes, 5);
  await until(() => ctx.relay.stats().pendingCodes === 0, 'the sweeper to drop five expired codes');
}));

test('an idle session past its life is closed', () => withRelay({ sessionTtlMs: 80, sweepMs: 20 }, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  const a = await app.next();
  assert.equal(a.code, 'session-expired');
  assert.equal((await plugin.next()).code, 'session-expired');
  await until(() => ctx.relay.stats().sessions.length === 0, 'the expired session to be removed');
}));

test('closing the relay drops every socket', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  await ctx.relay.close();
  await app.waitClose();
  await plugin.waitClose();
  assert.equal(ctx.relay.stats().sessions.length, 0);
}));

// --------------------------------------------- nothing at rest, nothing logged

test('no message payload ever reaches the log', () => withRelay({}, async (ctx) => {
  const { app, plugin } = await pairedPair(ctx);
  const secret = 'CANARY-a7f3c9-DO-NOT-LOG';
  plugin.send({ type: 'event', change: 'rename', layerID: 7, props: { name: secret } });
  assert.equal((await app.next()).props.name, secret);
  plugin.ws.send('{ bad json ' + secret);
  await plugin.next();
  app.terminate();
  await until(() => ctx.relay.stats().sessions.length === 0, 'the session to close');
  const all = ctx.logged.join('\n');
  assert.ok(all.length > 0, 'the relay does log lifecycle, so this is a real test of what it omits');
  assert.ok(!all.includes(secret), `a payload leaked into the log:\n${all}`);
  assert.ok(!all.includes('CANARY'), 'not even partially');
}));

test('the relay writes nothing to disk', () => {
  const sources = fs.readdirSync(serverDir).filter((f) => f.endsWith('.js'));
  assert.ok(sources.length > 0, 'there is server source to check');
  const banned = [/from ['"]node:fs['"]/, /from ['"]fs['"]/, /require\(['"]fs['"]\)/,
    /writeFile/, /createWriteStream/, /appendFile/, /mkdir/];
  for (const file of sources) {
    const text = fs.readFileSync(path.join(serverDir, file), 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} touches the filesystem (${pattern}) -- the relay stores nothing`);
    }
  }
});

test('the relay contains no second implementation of anything in src/', () => {
  const sources = fs.readdirSync(serverDir).filter((f) => f.endsWith('.js'));
  const banned = [/ag-psd/, /readDocument/, /renderProject/, /applyCommand/, /loadProjectProxy/, /matchLayers/];
  for (const file of sources) {
    const text = fs.readFileSync(path.join(serverDir, file), 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${file} reaches into document logic (${pattern}) -- the relay must not understand a PSD`);
    }
  }
  const relay = fs.readFileSync(path.join(serverDir, 'relay.js'), 'utf8');
  assert.ok(/from '\.\.\/src\/sync\/protocol\.js'/.test(relay),
    'the relay uses the ONE protocol implementation rather than restating it');
});

// -------------------------------------------------------------- entrypoint

test('the shipped entrypoint binds a real port from the environment and routes', async () => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(serverDir, 'index.js')], {
    env: { ...process.env, RELAY_PORT: String(port), RELAY_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  try {
    await until(() => out.includes('listening'), `the child to announce it is listening (saw: ${out})`, 10_000);
    assert.ok(out.includes('127.0.0.1'), 'it binds loopback, never a public interface');
    const url = `ws://127.0.0.1:${port}`;
    const app = client(url);
    const plugin = client(url);
    await app.open();
    app.send({ type: 'hello', role: 'app', version: '1.0.0' });
    const { code } = await app.next();
    await plugin.open();
    plugin.send({ type: 'hello', role: 'plugin', version: '1.0.0' });
    plugin.send({ type: 'pair', code });
    await app.next();
    await plugin.next();
    plugin.send({ type: 'event', change: 'opacity', layerID: 3, props: { opacity: 0.5 } });
    assert.deepEqual(await app.next(), { type: 'event', change: 'opacity', layerID: 3, props: { opacity: 0.5 } });
    app.terminate();
    plugin.terminate();
  } finally {
    child.kill();
  }
});

// -------------------------------------------------------------------- run

console.log('\nrelay: pairing, routing, caps, backpressure, lifecycle\n');
for (const [name, fn] of pending) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
