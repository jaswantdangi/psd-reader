/**
 * The Photoshop half of sync.
 *
 * This file is the ONLY part of the feature that cannot be tested without
 * Photoshop running, so it is kept as small as that constraint allows. Every
 * decision it makes -- what a notification means, what the layer tree looks
 * like on the wire, what to do with a burst of them -- lives in
 * `src/sync/photoshop.js` and is tested in `test/sync.mjs`. What is left here
 * is: open a socket, read the document, subscribe, and paint four states.
 *
 * # Read this before changing anything below
 *
 * NONE of this has been run against Photoshop. It is written against the UXP
 * and Photoshop DOM documentation, and the seams most likely to be wrong are
 * marked `VERIFY:`. Treat every one as a claim to check on a real install, not
 * as working code that happens to be new.
 */

import { PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from '../src/sync/protocol.js';
import { treeFrameFor, changeForNotification, coalesceEvents } from '../src/sync/photoshop.js';

// VERIFY: UXP exposes host modules through `require` even inside an ES module
// script. Mixed `import`/`require` is what Adobe's own samples do, but it is
// the first thing to check if the panel fails to load at all.
// No `core.executeAsModal` anywhere in this file, deliberately: it exists to
// hold the document still while it is MODIFIED, and nothing here modifies one.
// Sync is Photoshop -> app only, so the plugin never writes.
const { app, action } = require('photoshop');

const PLUGIN_VERSION = '0.1.0';

/**
 * How long a burst is allowed to accumulate before it is flushed.
 *
 * Photoshop fires notifications continuously during a single gesture -- one
 * drag is dozens of `move`s. Sending each would spend the session's byte
 * budget on frames that the next one supersedes. 80 ms is below the point a
 * person reads as lag and well above one notification's spacing.
 */
const FLUSH_MS = 80;

/** The notifications subscribed to. Each is translated by `changeForNotification`. */
const WATCHED = [
  'set', 'move', 'transform', 'free', 'reorder', 'delete', 'make', 'duplicate',
  'crop', 'canvasSize', 'paint', 'brushTool', 'eraserTool', 'gaussianBlur',
  'applyImage', 'hueSaturation', 'levels', 'curves', 'brightnessContrast',
  'setLayerEffects', 'disableLayerStyle',
];

const el = (id) => document.getElementById(id);
const ui = {
  status: el('status'), setup: el('setup'), live: el('live'),
  relay: el('relay'), code: el('code'),
  connect: el('connect'), disconnect: el('disconnect'),
  sent: el('sent'), unsynced: el('unsynced'),
};

let socket = null;
let paired = false;
let pending = [];
let flushTimer = null;
let listeners = null;
let sentCount = 0;
/** change kind -> how many were skipped. Counted, not listed: one stroke is dozens. */
const skipped = new Map();

// ------------------------------------------------------------------ view

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = kind;
}

function showConnected(isConnected) {
  ui.setup.style.display = isConnected ? 'none' : 'block';
  ui.live.style.display = isConnected ? 'flex' : 'none';
}

function renderSkipped() {
  if (!skipped.size) {
    ui.unsynced.innerHTML = '<li class="empty">Nothing skipped yet.</li>';
    return;
  }
  ui.unsynced.innerHTML = '';
  for (const [change, count] of skipped) {
    const li = document.createElement('li');
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = change;
    li.appendChild(what);
    li.appendChild(document.createTextNode(` — ${count} change${count === 1 ? '' : 's'} not sent`));
    ui.unsynced.appendChild(li);
  }
}

const noteSkipped = (change) => {
  skipped.set(change, (skipped.get(change) ?? 0) + 1);
  renderSkipped();
};

// ----------------------------------------------------------- the document

/**
 * Photoshop's layer tree as plain objects.
 *
 * Reversed, because `doc.layers` is top-down -- index 0 is the TOPMOST layer
 * -- and everything in this repo reads `children[0]` as the bottom.
 * `flattenLayerTree` documents that it expects bottom-to-top and that the
 * caller is the one that knows which it got. This is that caller.
 *
 * VERIFY: `layer.bounds` on a group, and on a layer with effects. The DOM
 * reports effect-inclusive bounds in some versions, which would not match the
 * app's bounds and would drop those layers to the `renamed` tier or below.
 */
function hostLayers(layers) {
  return [...layers].reverse().map((layer) => ({
    id: layer.id,
    name: layer.name,
    kind: String(layer.kind ?? ''),
    bounds: layer.bounds,
    layers: layer.layers && layer.layers.length ? hostLayers(layer.layers) : undefined,
  }));
}

function currentTreeFrame() {
  const doc = app.activeDocument;
  if (!doc) return null;
  return treeFrameFor({ name: doc.name, width: doc.width, height: doc.height }, hostLayers(doc.layers));
}

// -------------------------------------------------------------- the wire

const send = (frame) => {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame));
};

function flush() {
  flushTimer = null;
  const batch = coalesceEvents(pending);
  pending = [];
  for (const e of batch) {
    send({ type: 'event', change: e.change, ...(e.layerID === undefined ? {} : { layerID: e.layerID }), props: e.props });
    sentCount += 1;
  }
  if (batch.length) ui.sent.textContent = `${sentCount} change${sentCount === 1 ? '' : 's'} sent`;
}

const scheduleFlush = () => {
  if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
};

/**
 * One notification from Photoshop.
 *
 * The translation is `changeForNotification`'s, not this function's. All that
 * happens here is routing the three answers it can give: send it, count it as
 * undeliverable, or ignore it as something this protocol has no opinion on.
 */
function onNotification(event, descriptor) {
  if (!paired) return;
  const { change, known, mappable } = changeForNotification(event, descriptor);

  // Unknown is not the same as unmappable. An event we have never heard of is
  // not evidence that the user's work was dropped, so it is not reported as if
  // it were -- it is simply not ours.
  if (!known) return;

  if (!mappable) {
    noteSkipped(change);
    return;
  }

  // VERIFY: which layer a notification is about. `descriptor._target` carries
  // a reference chain, and reading the id out of it is the single most likely
  // thing in this file to be wrong. A WRONG id here is the failure the whole
  // identity model exists to prevent -- it applies a real change to the wrong
  // layer -- so it is better to send nothing than to send a guess.
  const layerID = layerIdFrom(descriptor);
  const documentScoped = change === 'crop' || change === 'canvasSize';
  if (layerID === null && !documentScoped) return;

  pending.push({ change, ...(documentScoped ? {} : { layerID }), props: propsFor(change, descriptor) });
  scheduleFlush();
}

/** The layer a descriptor refers to, or null when it cannot be read confidently. */
function layerIdFrom(descriptor) {
  const target = descriptor?._target;
  if (Array.isArray(target)) {
    for (const ref of target) {
      if (ref?._ref === 'layer' && typeof ref._id === 'number') return ref._id;
    }
  }
  if (typeof descriptor?.layerID === 'number') return descriptor.layerID;
  return null;
}

/**
 * The payload for one change.
 *
 * Deliberately narrow: only the fields `CHANGE_MAP` names for that change
 * reach the wire. `validateEvent` does not police the inside of `props`, so
 * this is the last place a stray descriptor field can be stopped.
 *
 * VERIFY: every branch. These are the descriptor shapes documented for each
 * event, and none has been observed.
 */
function propsFor(change, descriptor) {
  const to = descriptor?.to ?? {};
  switch (change) {
    case 'move':
    case 'transform': {
      const b = app.activeDocument?.activeLayers?.[0]?.bounds;
      return b ? { x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top } : {};
    }
    case 'opacity': return { opacity: (to.opacity ?? to.fillOpacity ?? 100) / 100 };
    case 'blendMode': return { blendMode: String(to.mode?._value ?? to.mode ?? to.blendMode ?? 'normal') };
    case 'visibility': return { visible: !!(to.visible ?? descriptor?.visible) };
    case 'rename': return { name: String(to.name ?? '') };
    case 'retype': return { text: String(to.textKey ?? '') };
    case 'reorder': return { to: descriptor?.to?._index ?? descriptor?.index ?? 0 };
    case 'crop':
    case 'canvasSize': {
      const doc = app.activeDocument;
      return { x: 0, y: 0, width: doc?.width ?? 0, height: doc?.height ?? 0 };
    }
    default: return {};
  }
}

// ------------------------------------------------------------- lifecycle

async function subscribe() {
  // VERIFY: `addNotificationListener` takes the array and one handler in
  // Photoshop 24+. Older builds took one event per call.
  listeners = await action.addNotificationListener(
    WATCHED.map((event) => ({ event })),
    (event, descriptor) => onNotification(event, descriptor),
  );
}

async function onPaired() {
  paired = true;
  const frame = currentTreeFrame();
  if (!frame) {
    setStatus('Paired, but no document is open. Open the same file as the app.', 'failed');
    return;
  }
  send(frame);
  await subscribe();
  const count = frame.layers.length;
  setStatus(`Live — ${frame.document.name}, ${count} layer${count === 1 ? '' : 's'} sent.`, 'live');
}

function teardown(message, kind) {
  paired = false;
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  pending = [];
  if (listeners && typeof listeners.remove === 'function') listeners.remove();
  listeners = null;
  if (socket) { const s = socket; socket = null; try { s.close(); } catch { /* already gone */ } }
  showConnected(false);
  setStatus(message, kind);
}

function onFrame(frame) {
  if (frame.type === 'paired') { onPaired(); return; }
  if (frame.type === 'error') {
    // The relay's refusals are the ones worth showing verbatim: `rate-limited`
    // and `no-such-code` are both things the person at the keyboard can act on.
    teardown(`Relay refused: ${frame.message} (${frame.code})`, 'failed');
  }
}

function connect() {
  const url = ui.relay.value.trim();
  const code = ui.code.value.trim().toUpperCase();

  // Checked here as well as at the relay, because a typo should cost a glance
  // rather than one of ten attempts against the rate limit.
  if (code.length !== PAIR_CODE_LENGTH || [...code].some((c) => !PAIR_CODE_ALPHABET.includes(c))) {
    setStatus(`That is not a pairing code — ${PAIR_CODE_LENGTH} characters from ${PAIR_CODE_ALPHABET}.`, 'failed');
    return;
  }

  setStatus('Connecting…', 'working');
  socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    setStatus('Pairing…', 'working');
    send({ type: 'hello', role: 'plugin', version: PLUGIN_VERSION });
    send({ type: 'pair', code });
    showConnected(true);
  });
  socket.addEventListener('message', (e) => {
    try { onFrame(JSON.parse(e.data)); }
    catch { /* the relay only ever sends JSON; a frame that is not is not ours */ }
  });
  socket.addEventListener('close', () => { if (socket) teardown('Disconnected.', ''); });
  socket.addEventListener('error', () => {
    // A failed handshake reaches here with no detail -- the browser security
    // model gives none. Naming the two things it is almost always is worth
    // more than repeating "error".
    teardown('Could not reach the relay. Check it is running, and that its address is in manifest.json.', 'failed');
  });
}

ui.connect.addEventListener('click', connect);
ui.disconnect.addEventListener('click', () => teardown('Disconnected.', ''));
renderSkipped();
