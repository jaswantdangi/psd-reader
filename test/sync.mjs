/**
 * Photoshop -> app sync: layer identity and the message protocol.
 *
 * Pure logic. No sockets, no Photoshop, no document. Every fixture here is a
 * pair of DESCRIPTOR LISTS -- what the UXP plugin would enumerate on one side,
 * what `flatten()` produced on the other -- because that is the only thing the
 * matcher is allowed to see.
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'node:module';
import { readDocument } from '../src/index.js';
import { createProject } from '../src/edit.js';
import {
  matchLayers, MATCH_TIERS, UNMATCHED_REASONS, boundsOf, groupPathOf, appIdFor,
} from '../src/sync/identity.js';
import {
  MESSAGE_TYPES, PROTOCOL_ERRORS, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH,
  validateMessage, parseMessage, classifyChange, UNMAPPABLE_CHANGES,
  translateEvent, translateEvents,
} from '../src/sync/protocol.js';
import {
  normaliseKind, flattenLayerTree, treeFrameFor, changeForNotification, coalesceEvents,
  layerTargetsFrom, PHOTOSHOP_EVENTS,
} from '../src/sync/photoshop.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

/** A Photoshop descriptor as the plugin would report it: bounds, group array. */
const ps = (layerID, name, kind, [left, top, right, bottom], groupPath = []) =>
  ({ layerID, name, kind, bounds: { left, top, right, bottom }, groupPath });

/** An app descriptor, shaped exactly like a `toLayer` layer: x/y/w/h, joined path. */
const app = (id, sourceIndex, name, kind, [x, y, w, h], groupPath = '') =>
  ({ id, sourceIndex, name, kind, x, y, w, h, groupPath });

const reasonsFor = (result, side) =>
  result.unmatched.filter((u) => u.side === side).map((u) => u.reason).sort();

console.log('\nidentity: normalising the two descriptor shapes\n');

test('bounds read from either Photoshop bounds or app x/y/w/h', () => {
  assert.deepEqual(boundsOf({ bounds: { left: 4, top: 5, right: 14, bottom: 25 } }),
    { left: 4, top: 5, right: 14, bottom: 25 });
  assert.deepEqual(boundsOf({ x: 4, y: 5, w: 10, h: 20 }),
    { left: 4, top: 5, right: 14, bottom: 25 });
});

test('a group path is one string whichever side wrote it', () => {
  assert.equal(groupPathOf({ groupPath: ['Hero', 'Text'] }), 'Hero / Text');
  assert.equal(groupPathOf({ groupPath: 'Hero / Text' }), 'Hero / Text');
  assert.equal(groupPathOf({}), '');
});

console.log('\nidentity: the cases that actually occur in a PSD\n');

test('a plain document matches every layer on the full signature', () => {
  const result = matchLayers(
    [ps(7, 'Background', 'pixel', [0, 0, 100, 100]), ps(9, 'Headline', 'text', [10, 10, 90, 40])],
    [app(1, 0, 'Background', 'raster', [0, 0, 100, 100]), app(2, 1, 'Headline', 'text', [10, 10, 80, 30])],
  );
  assert.equal(result.matched.length, 2);
  assert.equal(result.unmatched.length, 0);
  assert.ok(result.matched.every((m) => m.tier === 'exact'));
  assert.equal(result.byLayerID.get(7).appId, 1);
  assert.equal(result.byLayerID.get(9).appId, 2);
  assert.equal(result.byAppId.get(2), 9);
});

test('duplicate names are matched apart by their bounds', () => {
  const result = matchLayers(
    [ps(1, 'Layer 1 copy', 'pixel', [0, 0, 10, 10]), ps(2, 'Layer 1 copy', 'pixel', [50, 50, 60, 60])],
    [app(11, 0, 'Layer 1 copy', 'raster', [0, 0, 10, 10]), app(12, 1, 'Layer 1 copy', 'raster', [50, 50, 10, 10])],
  );
  assert.equal(result.unmatched.length, 0, 'duplicate names are the norm; bounds still separate them');
  assert.equal(result.byLayerID.get(1).appId, 11);
  assert.equal(result.byLayerID.get(2).appId, 12);
});

test('identical name AND bounds in DIFFERENT groups are matched by group path', () => {
  const result = matchLayers(
    [ps(1, 'shadow', 'pixel', [0, 0, 10, 10], ['Card A']), ps(2, 'shadow', 'pixel', [0, 0, 10, 10], ['Card B'])],
    [app(11, 0, 'shadow', 'raster', [0, 0, 10, 10], 'Card A'), app(12, 1, 'shadow', 'raster', [0, 0, 10, 10], 'Card B')],
  );
  assert.equal(result.unmatched.length, 0);
  assert.equal(result.byLayerID.get(1).appId, 11);
  assert.equal(result.byLayerID.get(2).appId, 12);
});

test('identical name AND bounds in the SAME group match NOTHING, and say why', () => {
  const result = matchLayers(
    [ps(1, 'shadow', 'pixel', [0, 0, 10, 10], ['Card']), ps(2, 'shadow', 'pixel', [0, 0, 10, 10], ['Card'])],
    [app(11, 0, 'shadow', 'raster', [0, 0, 10, 10], 'Card'), app(12, 1, 'shadow', 'raster', [0, 0, 10, 10], 'Card')],
  );
  assert.equal(result.matched.length, 0, 'a coin flip here corrupts the user document');
  assert.deepEqual(reasonsFor(result, 'photoshop'), ['ambiguous', 'ambiguous']);
  assert.deepEqual(reasonsFor(result, 'app'), ['ambiguous', 'ambiguous']);
  const one = result.unmatched.find((u) => u.side === 'photoshop' && u.layerID === 1);
  assert.deepEqual(one.candidates, [11, 12], 'the report has to name what it could not choose between');
});

test('an ambiguous pair does not poison a unique layer beside it', () => {
  const result = matchLayers(
    [ps(1, 'dup', 'pixel', [0, 0, 10, 10]), ps(2, 'dup', 'pixel', [0, 0, 10, 10]), ps(3, 'Logo', 'pixel', [4, 4, 8, 8])],
    [app(11, 0, 'dup', 'raster', [0, 0, 10, 10]), app(12, 1, 'dup', 'raster', [0, 0, 10, 10]), app(13, 2, 'Logo', 'raster', [4, 4, 4, 4])],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.byLayerID.get(3).appId, 13);
  assert.equal(result.unmatched.length, 4);
});

test('groups are reported and excluded - the app has no layer for one', () => {
  const result = matchLayers(
    [ps(5, 'Card', 'group', [0, 0, 100, 100]), ps(6, 'fill', 'pixel', [0, 0, 100, 100], ['Card'])],
    [app(11, 0, 'fill', 'raster', [0, 0, 100, 100], 'Card')],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.byLayerID.get(6).appId, 11);
  const group = result.unmatched.find((u) => u.layerID === 5);
  assert.equal(group.reason, 'group');
  assert.equal(result.byLayerID.has(5), false, 'a group must never resolve to a layer');
});

test('a Photoshop layer that flatten() dropped is reported, not guessed at', () => {
  const result = matchLayers(
    [ps(1, 'Background', 'pixel', [0, 0, 10, 10]), ps(2, 'Layer 4', 'pixel', [0, 0, 0, 0]), ps(3, 'Top', 'pixel', [2, 2, 6, 6])],
    // flatten() dropped the empty leaf, so sourceIndex 1 does NOT exist app-side.
    [app(11, 0, 'Background', 'raster', [0, 0, 10, 10]), app(13, 2, 'Top', 'raster', [2, 2, 4, 4])],
  );
  assert.equal(result.matched.length, 2, 'the skipped leaf must not shift anything after it');
  assert.equal(result.byLayerID.get(3).appId, 13, 'positional matching would map layer 3 onto the wrong app layer');
  const dropped = result.unmatched.find((u) => u.layerID === 2);
  assert.equal(dropped.reason, 'no-candidate');
});

test('an adjustment layer has no app counterpart and is named as such', () => {
  const result = matchLayers(
    [ps(1, 'Curves 1', 'adjustment', [0, 0, 10, 10]), ps(2, 'Base', 'pixel', [0, 0, 10, 10])],
    [app(11, 0, 'Base', 'raster', [0, 0, 10, 10])],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.unmatched.find((u) => u.layerID === 1).reason, 'adjustment');
});

test('a layer renamed on ONE side still matches, at the renamed tier', () => {
  const result = matchLayers(
    [ps(1, 'Hero image', 'pixel', [0, 0, 40, 30], ['Hero'])],
    [app(11, 0, 'Layer 2', 'raster', [0, 0, 40, 30], 'Hero')],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].tier, 'renamed');
  assert.equal(result.byLayerID.get(1).appId, 11);
});

test('a layer moved between groups still matches, at the regrouped tier', () => {
  const result = matchLayers(
    [ps(1, 'Hero image', 'pixel', [0, 0, 40, 30], ['Header'])],
    [app(11, 0, 'Hero image', 'raster', [0, 0, 40, 30], 'Hero')],
  );
  assert.equal(result.matched[0].tier, 'regrouped');
});

test('renamed AND regrouped at once fails closed', () => {
  const result = matchLayers(
    [ps(1, 'Hero image', 'pixel', [0, 0, 40, 30], ['Header'])],
    [app(11, 0, 'Layer 2', 'raster', [0, 0, 40, 30], 'Hero')],
  );
  assert.equal(result.matched.length, 0, 'two relaxations at once is a guess, and a guess damages the document');
  assert.equal(result.unmatched.length, 2);
});

test('kind is never relaxed - a text layer never matches a raster one', () => {
  const result = matchLayers(
    [ps(1, 'Title', 'text', [0, 0, 40, 30])],
    [app(11, 0, 'Title', 'raster', [0, 0, 40, 30])],
  );
  assert.equal(result.matched.length, 0);
});

test('an empty document produces an empty mapping and no error', () => {
  const result = matchLayers([], []);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.unmatched, []);
  assert.equal(result.byLayerID.size, 0);
});

test('a document where nothing matches reports BOTH sides in full', () => {
  const result = matchLayers(
    [ps(1, 'A', 'pixel', [0, 0, 10, 10]), ps(2, 'B', 'pixel', [1, 1, 9, 9])],
    [app(11, 0, 'C', 'raster', [40, 40, 10, 10]), app(12, 1, 'D', 'raster', [70, 70, 5, 5])],
  );
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched.length, 4);
  assert.deepEqual(reasonsFor(result, 'photoshop'), ['no-candidate', 'no-candidate']);
  assert.deepEqual(reasonsFor(result, 'app'), ['no-candidate', 'no-candidate']);
});

test('list order is never consulted - the same document shuffled matches identically', () => {
  const psList = [ps(1, 'A', 'pixel', [0, 0, 10, 10]), ps(2, 'B', 'pixel', [5, 5, 15, 15]), ps(3, 'C', 'text', [1, 1, 9, 9])];
  const appList = [app(11, 0, 'A', 'raster', [0, 0, 10, 10]), app(12, 4, 'B', 'raster', [5, 5, 10, 10]), app(13, 9, 'C', 'text', [1, 1, 8, 8])];
  const straight = matchLayers(psList, appList);
  const shuffled = matchLayers([...psList].reverse(), [appList[2], appList[0], appList[1]]);
  const pairs = (r) => r.matched.map((m) => `${m.layerID}->${m.appId}`).sort();
  assert.deepEqual(pairs(shuffled), pairs(straight));
  assert.equal(straight.matched.length, 3);
});

test('a malformed descriptor is excluded and reported, never thrown over', () => {
  const result = matchLayers(
    [{ layerID: 1, name: 'A', kind: 'pixel' }, ps(2, 'B', 'pixel', [0, 0, 10, 10])],
    [{ id: 11 }, app(12, 1, 'B', 'raster', [0, 0, 10, 10])],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.unmatched.find((u) => u.layerID === 1).reason, 'invalid');
  assert.equal(result.unmatched.find((u) => u.appId === 11).reason, 'invalid');
});

test('a null or non-array input is refused rather than half-matched', () => {
  assert.throws(() => matchLayers(null, []), /descriptor list/i);
  assert.throws(() => matchLayers([], 'nope'), /descriptor list/i);
});

test('signature fields cannot bleed into each other across the separator', () => {
  // Group "A" holding "B C" and group "A B" holding "C" are DIFFERENT layers.
  // Joining the signature on a space would make them one key and lose both.
  const result = matchLayers(
    [ps(1, 'B C', 'pixel', [0, 0, 10, 10], ['A']), ps(2, 'C', 'pixel', [0, 0, 10, 10], ['A', 'B'])],
    [app(11, 0, 'B C', 'raster', [0, 0, 10, 10], 'A'), app(12, 1, 'C', 'raster', [0, 0, 10, 10], 'A / B')],
  );
  assert.equal(result.matched.length, 2);
  assert.equal(result.byLayerID.get(1).appId, 11);
  assert.equal(result.byLayerID.get(2).appId, 12);
});

test('the tier list and the reason list are exported, so the UI can name them', () => {
  assert.deepEqual(MATCH_TIERS, ['exact', 'renamed', 'regrouped']);
  assert.ok(UNMATCHED_REASONS.includes('ambiguous'));
  assert.ok(UNMATCHED_REASONS.includes('no-candidate'));
});

console.log('\nprotocol: validating every inbound frame\n');

const helloOk = { type: 'hello', role: 'plugin', version: '1.0.0' };

test('each of the six frame types validates and normalises', () => {
  assert.deepEqual(MESSAGE_TYPES, ['hello', 'pair', 'paired', 'tree', 'event', 'error']);
  assert.deepEqual(validateMessage(helloOk).message, helloOk);
  assert.deepEqual(validateMessage({ type: 'pair', code: 'K7M2PQ' }).message, { type: 'pair', code: 'K7M2PQ' });
  assert.deepEqual(
    validateMessage({ type: 'paired', sessionId: 's1', peer: { role: 'app', version: '2' } }).message,
    { type: 'paired', sessionId: 's1', peer: { role: 'app', version: '2' } },
  );
  assert.deepEqual(
    validateMessage({ type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } }).message,
    { type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } },
  );
  assert.deepEqual(validateMessage({ type: 'error', code: 'nope', message: 'why' }).message,
    { type: 'error', code: 'nope', message: 'why' });
});

test('anything that is not a plain object is refused before any field is read', () => {
  for (const bad of [null, undefined, 42, 'hello', [], [{ type: 'hello' }], true]) {
    const r = validateMessage(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(r.error.code, PROTOCOL_ERRORS.NOT_AN_OBJECT);
  }
});

test('an unknown type is refused EXPLICITLY, never ignored', () => {
  const r = validateMessage({ type: 'doc-chunk', bytes: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, PROTOCOL_ERRORS.UNKNOWN_TYPE);
  assert.match(r.error.message, /doc-chunk/);
  assert.equal(validateMessage({ role: 'app' }).error.code, PROTOCOL_ERRORS.MISSING_TYPE);
});

test('every field of every type is type-checked', () => {
  const bad = [
    { type: 'hello', role: 'relay', version: '1' },
    { type: 'hello', role: 'plugin' },
    { type: 'hello', role: 'plugin', version: 3 },
    { type: 'pair' },
    { type: 'paired', sessionId: '', peer: { role: 'app', version: '1' } },
    { type: 'paired', sessionId: 's', peer: { role: 'nope', version: '1' } },
    { type: 'paired', sessionId: 's' },
    { type: 'event', change: 'move', layerID: 7 },
    { type: 'event', change: 'move', layerID: 7, props: 'x=40' },
    { type: 'event', layerID: 7, props: {} },
    { type: 'error', code: 'x' },
    { type: 'error', message: 'x' },
  ];
  for (const m of bad) {
    const r = validateMessage(m);
    assert.equal(r.ok, false, `${JSON.stringify(m)} must be refused`);
    assert.equal(r.error.code, PROTOCOL_ERRORS.BAD_FIELD, JSON.stringify(m));
  }
});

test('fields nobody declared are stripped, not carried through', () => {
  const r = validateMessage({ type: 'hello', role: 'app', version: '1', token: 'secret', __proto__x: 1 });
  assert.deepEqual(Object.keys(r.message).sort(), ['role', 'type', 'version']);
});

test('a pair code is checked against the unambiguous alphabet and upper-cased', () => {
  assert.equal(PAIR_CODE_LENGTH, 6);
  assert.equal(PAIR_CODE_ALPHABET.includes('0'), false, '0/O and 1/I are why the alphabet exists');
  assert.equal(PAIR_CODE_ALPHABET.includes('O'), false);
  assert.equal(PAIR_CODE_ALPHABET.includes('1'), false);
  assert.equal(PAIR_CODE_ALPHABET.includes('I'), false);
  assert.equal(validateMessage({ type: 'pair', code: 'k7m2pq' }).message.code, 'K7M2PQ');
  for (const code of ['K7M2P', 'K7M2PQR', 'K0M2PQ', 'K7M2P!', '', 7]) {
    assert.equal(validateMessage({ type: 'pair', code }).ok, false, `code ${code} must be refused`);
  }
});

test('a malformed JSON frame is an error return, never a throw', () => {
  const r = parseMessage('{"type":"hello"');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, PROTOCOL_ERRORS.BAD_JSON);
  assert.equal(parseMessage(JSON.stringify(helloOk)).ok, true);
  assert.equal(parseMessage('"just a string"').error.code, PROTOCOL_ERRORS.NOT_AN_OBJECT);
});

console.log('\nprotocol: Photoshop changes onto the editor command set\n');

/** Two layers matched, so translation has something to resolve against. */
const mapping = matchLayers(
  [ps(7, 'Photo', 'pixel', [0, 0, 40, 30]), ps(9, 'Title', 'text', [4, 4, 20, 12]), ps(11, 'Base', 'pixel', [0, 0, 80, 60])],
  [app(101, 0, 'Photo', 'raster', [0, 0, 40, 30]), app(102, 1, 'Title', 'text', [4, 4, 16, 8]), app(103, 2, 'Base', 'raster', [0, 0, 80, 60])],
);
const ORDER = [103, 101, 102]; // project.layers order: index 0 is the BOTTOM layer

const ev = (change, layerID, props) => ({ type: 'event', change, layerID, props });

test('the representable changes each become an EXISTING command', () => {
  const cases = [
    [ev('move', 7, { x: 40, y: 12 }), { type: 'set', id: 101, to: { x: 40, y: 12 } }],
    [ev('transform', 7, { x: 1, y: 2, w: 30, h: 20 }), { type: 'set', id: 101, to: { x: 1, y: 2, w: 30, h: 20 } }],
    [ev('opacity', 7, { opacity: 0.5 }), { type: 'set', id: 101, to: { opacity: 0.5 } }],
    [ev('blendMode', 7, { blendMode: 'multiply' }), { type: 'set', id: 101, to: { blendMode: 'multiply' } }],
    [ev('visibility', 7, { visible: false }), { type: 'set', id: 101, to: { visible: false } }],
    [ev('rename', 7, { name: 'Hero' }), { type: 'set', id: 101, to: { name: 'Hero' } }],
    [ev('retype', 9, { text: { content: 'Hi', fontSize: 30 } }), { type: 'set', id: 102, to: { text: { content: 'Hi', fontSize: 30 } } }],
    [ev('delete', 7, {}), { type: 'remove', id: 101 }],
  ];
  for (const [event, command] of cases) {
    const r = translateEvent(event, mapping, { order: ORDER });
    assert.equal(r.ok, true, `${event.change}: ${r.reason || ''}`);
    assert.deepEqual(r.command, command, event.change);
  }
});

test('a crop is a document-level frame command and carries no layer', () => {
  const r = translateEvent({ type: 'event', change: 'crop', props: { x: 2, y: 3, width: 20, height: 10 } }, mapping, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.command, { type: 'frame', to: { x: 2, y: 3, width: 20, height: 10 } });
  assert.equal(translateEvent({ type: 'event', change: 'canvasSize', props: { x: 0, y: 0, width: 90, height: 70 } }, mapping, {}).ok, true);
});

test('a reorder is resolved through the mapping, never through a Photoshop index', () => {
  // "Photo (7) now sits directly above Title (9)". In the app array -- which is
  // bottom-to-top -- that is index 2 once Photo has been spliced out.
  const r = translateEvent(ev('reorder', 7, { belowLayerID: 9 }), mapping, { order: ORDER });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.command, { type: 'reorder', from: 1, to: 2 });

  const toBottom = translateEvent(ev('reorder', 9, { belowLayerID: null }), mapping, { order: ORDER });
  assert.deepEqual(toBottom.command, { type: 'reorder', from: 2, to: 0 });
});

test('a reorder naming an unmatched neighbour is refused, not approximated', () => {
  const r = translateEvent(ev('reorder', 7, { belowLayerID: 999 }), mapping, { order: ORDER });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-layer');
});

test('an event for a layer that never matched is refused', () => {
  const r = translateEvent(ev('move', 999, { x: 1, y: 2 }), mapping, { order: ORDER });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-layer');
  assert.equal(r.layerID, 999);
});

test('props are validated per change, so a command is never half-built', () => {
  const bad = [
    ev('move', 7, { x: 'left' }),
    ev('move', 7, { y: 2 }),
    ev('opacity', 7, { opacity: 4 }),
    ev('visibility', 7, { visible: 'no' }),
    ev('rename', 7, { name: 12 }),
    ev('retype', 9, { text: 'Hi' }),
    { type: 'event', change: 'crop', props: { x: 0, y: 0, width: -4, height: 10 } },
  ];
  for (const event of bad) {
    const r = translateEvent(event, mapping, { order: ORDER });
    assert.equal(r.ok, false, JSON.stringify(event));
    assert.equal(r.reason, 'bad-props', JSON.stringify(event));
  }
});

test('pixel changes have no command, and say so instead of vanishing', () => {
  assert.deepEqual(UNMAPPABLE_CHANGES.sort(), ['adjustment', 'brush', 'filter', 'layerEffect', 'maskPaint']);
  for (const change of UNMAPPABLE_CHANGES) {
    const r = translateEvent(ev(change, 7, {}), mapping, { order: ORDER });
    assert.equal(r.ok, false, change);
    assert.equal(r.reason, 'needs-pixels', change);
    assert.equal(r.requiresPixels, true, change);
    assert.equal(classifyChange(change).known, true, `${change} is a change we KNOW we cannot map`);
  }
});

test('a layer added in Photoshop needs pixels before any insert can be built', () => {
  const r = translateEvent(ev('add', 7, {}), mapping, { order: ORDER });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'needs-pixels');
  assert.equal(classifyChange('add').command, 'insert');
});

test('an unrecognised change is refused explicitly, not ignored', () => {
  const r = translateEvent(ev('smartFilterEdited', 7, {}), mapping, { order: ORDER });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-change');
  assert.equal(classifyChange('smartFilterEdited').known, false);
});

test('a batch reports every refusal beside the commands it did produce', () => {
  const result = translateEvents([
    ev('move', 7, { x: 40, y: 12 }),
    ev('brush', 7, {}),
    ev('opacity', 999, { opacity: 0.2 }),
    ev('somethingElse', 9, {}),
    ev('rename', 9, { name: 'Heading' }),
  ], mapping, { order: ORDER });

  assert.equal(result.commands.length, 2);
  assert.deepEqual(result.commands[0], { type: 'set', id: 101, to: { x: 40, y: 12 } });
  assert.equal(result.refused.length, 3, 'three events could not be applied and all three must be reported');
  assert.deepEqual(result.refused.map((r) => r.reason), ['needs-pixels', 'unknown-layer', 'unknown-change']);
  assert.equal(result.refused[0].change, 'brush');
  assert.equal(result.needsPixels.length, 1, 'the pixel path needs its own list to debounce against');
});

test('a batch validates its frames, so one bad message does not take the batch down', () => {
  const result = translateEvents([{ type: 'event', change: 'move', layerID: 7 }, ev('move', 7, { x: 1, y: 1 })], mapping, { order: ORDER });
  assert.equal(result.commands.length, 1);
  assert.equal(result.refused[0].reason, 'invalid-message');
});

console.log('\nidentity: the matcher against all 21 real fixture documents\n');

/**
 * Everything above is a hand-built descriptor pair, which proves the algorithm
 * and nothing about real files. This runs it over every fixture in the repo:
 * the app side is a genuine `createProject`, and the Photoshop side is
 * synthesised from the same ag-psd tree the way the UXP plugin would enumerate
 * it -- groups as layers, adjustment layers included, empty leaves included.
 * Names, bounds, kinds and group paths all come from the actual file. Only the
 * layerID counter is synthetic, and Photoshop mints those per session anyway.
 *
 * Costs about 150ms and 86MB RSS for 21 eager decodes.
 */
let nextSyntheticID = 1000;
const enumerateLikePhotoshop = (children, out = [], path = []) => {
  for (const node of children || []) {
    const kind = node.children ? 'group'
      : node.adjustment ? 'adjustment'
        : node.text ? 'text' : 'pixel';
    out.push({
      layerID: nextSyntheticID++,
      // Mirrors flatten()/toLayer()'s own fallbacks, so an unnamed layer is not
      // scored as a mismatch when the only difference is which placeholder ran.
      name: node.name || (node.children ? 'unnamed' : '(unnamed)'),
      kind,
      bounds: { left: node.left ?? 0, top: node.top ?? 0, right: node.right ?? 0, bottom: node.bottom ?? 0 },
      groupPath: [...path],
    });
    if (node.children) enumerateLikePhotoshop(node.children, out, [...path, node.name || 'unnamed']);
  }
  return out;
};

const fixtures = fs.readdirSync('fixtures').filter((f) => /\.src\.(psd|psb)$/.test(f)).sort();
const tally = { psEntries: 0, appLayers: 0, matched: 0, tiers: {}, reasons: {} };
for (const file of fixtures) {
  const doc = await readDocument(new Uint8Array(fs.readFileSync('fixtures/' + file)), { pixels: 'eager' });
  const project = createProject(doc, file);
  const result = matchLayers(enumerateLikePhotoshop(doc.children), project.layers);
  tally.psEntries += result.matched.length + result.unmatched.filter((u) => u.side === 'photoshop').length;
  tally.appLayers += project.layers.length;
  tally.matched += result.matched.length;
  for (const m of result.matched) tally.tiers[m.tier] = (tally.tiers[m.tier] ?? 0) + 1;
  for (const u of result.unmatched) tally.reasons[u.reason] = (tally.reasons[u.reason] ?? 0) + 1;
}
console.log(`  ${tally.appLayers} app layers, ${tally.psEntries} Photoshop entries, ` +
  `${tally.matched} matched ${JSON.stringify(tally.tiers)}, unmatched ${JSON.stringify(tally.reasons)}`);

test('the corpus is actually being read, so an empty run cannot pass silently', () => {
  assert.ok(fixtures.length >= 21, `expected the 21 fixtures, saw ${fixtures.length}`);
  assert.ok(tally.appLayers >= 50, `expected the fixtures to yield layers, saw ${tally.appLayers}`);
});

test('every app layer in every fixture finds its Photoshop layer', () => {
  assert.equal(tally.matched, tally.appLayers);
});

test('nothing needs a relaxed tier when both sides just opened the same file', () => {
  assert.deepEqual(Object.keys(tally.tiers), ['exact'],
    'renamed/regrouped exist for a document that has since diverged, not for pairing');
});

test('no real fixture produces an ambiguous pair', () => {
  assert.equal(tally.reasons.ambiguous ?? 0, 0);
});

test('every Photoshop entry with no app layer has a STRUCTURAL reason', () => {
  // Groups and adjustment layers do not exist in the app model at all, and a
  // pixel-less leaf was dropped by flatten(). None of those is a matching
  // failure -- but each one is a layer that will not sync, and the UI has to
  // say so rather than the user finding out by moving it.
  const structural = ['group', 'adjustment', 'no-candidate'];
  for (const reason of Object.keys(tally.reasons)) {
    assert.ok(structural.includes(reason), `unexpected unmatched reason "${reason}" on real files`);
  }
  assert.ok((tally.reasons.group ?? 0) > 0, 'the fixtures include grouped documents');
  assert.ok((tally.reasons.adjustment ?? 0) > 0, 'the fixtures include adjustment layers');
});

console.log('\nprotocol: the layer tree frame\n');

const treeLayer = (over = {}) => ({
  layerID: 7, name: 'Sky', kind: 'pixel',
  bounds: { left: 0, top: 0, right: 10, bottom: 10 }, groupPath: ['Backgrounds'], ...over,
});
const treeOk = (over = {}) => ({
  type: 'tree',
  document: { name: 'poster.psd', width: 100, height: 80 },
  layers: [treeLayer()],
  ...over,
});

test('a tree frame validates and normalises', () => {
  assert.deepEqual(validateMessage(treeOk()).message, treeOk());
});

test('a tree frame is rebuilt from known fields only', () => {
  // Same discipline as every other frame: what the plugin invents does not
  // reach the app just because the plugin sent it.
  const dirty = treeOk({
    layers: [treeLayer({ opacity: 0.5, secret: 'x' })],
    document: { name: 'poster.psd', width: 100, height: 80, path: '/Users/someone/poster.psd' },
  });
  const out = validateMessage(dirty).message;
  assert.deepEqual(Object.keys(out.layers[0]).sort(), ['bounds', 'groupPath', 'kind', 'layerID', 'name']);
  assert.deepEqual(Object.keys(out.document).sort(), ['height', 'name', 'width'],
    'a local filesystem path is not part of this protocol and must not ride along');
});

test('an empty layer list is a legitimate tree, not a fault', () => {
  // An empty document is a real state, and it has to reconcile to "nothing
  // matched" rather than to a parse error the user cannot act on.
  assert.equal(validateMessage(treeOk({ layers: [] })).ok, true);
});

test('groupPath is optional and normalises to an empty array', () => {
  const l = treeLayer();
  delete l.groupPath;
  assert.deepEqual(validateMessage(treeOk({ layers: [l] })).message.layers[0].groupPath, []);
});

test('a tree frame is refused field by field, naming the layer at fault', () => {
  const bad = [
    [treeOk({ document: undefined }), 'tree.document must be an object'],
    [treeOk({ document: { name: 'x', width: 'wide', height: 80 } }), 'tree.document.width and .height must be finite numbers'],
    [treeOk({ layers: 'Sky' }), 'tree.layers must be an array'],
    [treeOk({ layers: [treeLayer(), treeLayer({ layerID: null })] }), 'tree.layers[1].layerID must be a number or string'],
    [treeOk({ layers: [treeLayer({ layerID: Number.NaN })] }), 'tree.layers[0].layerID must be finite'],
    [treeOk({ layers: [treeLayer({ name: 7 })] }), 'tree.layers[0].name must be a string'],
    [treeOk({ layers: [treeLayer({ kind: '' })] }), 'tree.layers[0].kind must be a non-empty string'],
    [treeOk({ layers: [treeLayer({ bounds: { left: 0, top: 0, right: 10 } })] }), 'tree.layers[0].bounds must be {left,top,right,bottom} finite numbers'],
    [treeOk({ layers: [treeLayer({ groupPath: [1, 2] })] }), 'tree.layers[0].groupPath must be an array of strings'],
  ];
  for (const [frame, message] of bad) {
    const r = validateMessage(frame);
    assert.equal(r.ok, false, `should have been refused: ${JSON.stringify(frame).slice(0, 70)}`);
    assert.equal(r.error.code, PROTOCOL_ERRORS.BAD_FIELD);
    assert.equal(r.error.message, message);
  }
});

test('a validated tree feeds matchLayers without further shaping', () => {
  // The point of the frame. If these two disagree about field names the
  // handshake fails at run time, on a machine with Photoshop on it, which is
  // the hardest possible place to find out.
  const frame = validateMessage(treeOk({
    layers: [treeLayer(), treeLayer({ layerID: 8, name: 'Sea', bounds: { left: 0, top: 10, right: 10, bottom: 20 } })],
  })).message;
  const appLayers = [
    { id: 'a1', sourceIndex: 0, name: 'Sky', kind: 'raster', x: 0, y: 0, w: 10, h: 10, groupPath: ['Backgrounds'] },
    { id: 'a2', sourceIndex: 1, name: 'Sea', kind: 'raster', x: 0, y: 10, w: 10, h: 10, groupPath: ['Backgrounds'] },
  ];
  const mapping = matchLayers(frame.layers, appLayers);
  assert.equal(mapping.matched.length, 2, 'both layers reconciled straight off the wire');
  assert.equal(mapping.unmatched.length, 0);
  assert.equal(appIdFor(mapping, 7), 'a1');
  assert.equal(appIdFor(mapping, 8), 'a2');
});

console.log('\nphotoshop: the plugin\'s decisions, without Photoshop\n');

const hostLayer = (id, name, kind, [left, top, right, bottom], layers) =>
  ({ id, name, kind, bounds: { left, top, right, bottom }, ...(layers ? { layers } : {}) });

test('adjustment layers collapse to one kind, so identity can report them', () => {
  // Photoshop has no single `adjustment` kind -- it has one per adjustment
  // type. identity.js compares against `adjustment`, so the collapse has to
  // happen before the frame is built or every Curves layer looks like a raster.
  for (const k of ['curves', 'levels', 'brightnessContrast', 'colorLookup'])
    assert.equal(normaliseKind(k), 'adjustment', `${k} should read as an adjustment`);
  assert.equal(normaliseKind('group'), 'group');
  assert.equal(normaliseKind('groupEnd'), 'group');
  assert.equal(normaliseKind('pixel'), 'pixel', 'anything else is passed through for kindOf to reduce');
  assert.equal(normaliseKind(undefined), '');
});

test('an unlisted adjustment kind fails towards disclosure, not towards a wrong edit', () => {
  // The safe direction. It reads as a raster, matches no app layer, and is
  // reported unmatched -- rather than being mapped onto something.
  const result = matchLayers(
    [{ layerID: 1, name: 'Some New Adjustment 1', kind: normaliseKind('futureAdjustment'), bounds: { left: 0, top: 0, right: 10, bottom: 10 }, groupPath: [] }],
    [app(11, 0, 'Background', 'raster', [0, 0, 100, 100])],
  );
  assert.equal(result.matched.length, 0, 'it must not be mapped onto an unrelated layer');
  assert.equal(result.unmatched.some((u) => u.layerID === 1), true, 'and it must be reported');
});

test('the tree walk keeps groups and builds a group path', () => {
  const flat = flattenLayerTree([
    hostLayer(1, 'Background', 'pixel', [0, 0, 100, 100]),
    hostLayer(2, 'Card', 'group', [0, 0, 50, 50], [
      hostLayer(3, 'fill', 'pixel', [0, 0, 50, 50]),
      hostLayer(4, 'Inner', 'group', [5, 5, 20, 20], [hostLayer(5, 'dot', 'pixel', [5, 5, 20, 20])]),
    ]),
  ]);
  assert.deepEqual(flat.map((l) => l.layerID), [1, 2, 3, 4, 5]);
  assert.deepEqual(flat.map((l) => l.groupPath), [[], [], ['Card'], ['Card'], ['Card', 'Inner']]);
  assert.equal(flat.find((l) => l.layerID === 2).kind, 'group',
    'groups are kept so matchLayers can name them rather than go quiet');
});

test('a layer with unreadable bounds is dropped rather than sent unmatched-shaped', () => {
  const flat = flattenLayerTree([hostLayer(1, 'ok', 'pixel', [0, 0, 10, 10]), { id: 2, name: 'no bounds', kind: 'pixel' }]);
  assert.deepEqual(flat.map((l) => l.layerID), [1]);
});

test('UnitValue bounds are read as numbers', () => {
  // UXP returns `{_value,_unit}` in some versions and plain numbers in others.
  const flat = flattenLayerTree([{
    id: 1, name: 'Sky', kind: 'pixel',
    bounds: { left: { _value: 0, _unit: 'px' }, top: { _value: 0 }, right: { _value: 10 }, bottom: { _value: 10 } },
  }]);
  assert.deepEqual(flat[0].bounds, { left: 0, top: 0, right: 10, bottom: 10 });
});

test('the tree frame it builds is one the protocol accepts', () => {
  // The seam that cannot be checked by reading: the plugin builds it, the
  // relay validates it, and they are written in different files.
  const frame = treeFrameFor({ name: 'poster.psd', width: 100, height: 80 },
    [hostLayer(1, 'Background', 'pixel', [0, 0, 100, 100]),
     hostLayer(2, 'Card', 'group', [0, 0, 50, 50], [hostLayer(3, 'fill', 'pixel', [0, 0, 50, 50])])]);
  const checked = validateMessage(frame);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.error.message);
  assert.deepEqual(checked.message, frame, 'and survives validation unchanged');
});

test('an empty document still builds a valid frame', () => {
  assert.equal(validateMessage(treeFrameFor({ name: 'blank.psd', width: 10, height: 10 }, [])).ok, true);
});

test('Photoshop\'s vocabulary is translated into this protocol\'s', () => {
  assert.equal(changeForNotification('move').change, 'move');
  assert.equal(changeForNotification('delete').change, 'delete');
  assert.equal(changeForNotification('gaussianBlur').change, 'filter');
  assert.equal(changeForNotification('setLayerEffects').change, 'layerEffect');
});

test('a `set` is disambiguated by its descriptor, never by guessing', () => {
  // Photoshop uses one event name for opacity, blend mode, visibility and
  // rename. Which it was is only in the payload.
  assert.equal(changeForNotification('set', { to: { opacity: 40 } }).change, 'opacity');
  assert.equal(changeForNotification('set', { to: { mode: 'multiply' } }).change, 'blendMode');
  assert.equal(changeForNotification('set', { to: { visible: false } }).change, 'visibility');
  assert.equal(changeForNotification('set', { to: { name: 'Hero' } }).change, 'rename');
  assert.equal(changeForNotification('set', { to: { textKey: 'hi' } }).change, 'retype');
});

test('a change with nothing this protocol represents is unknown, not invented', () => {
  for (const [event, descriptor] of [['set', { to: { someFutureField: 1 } }], ['invertPurple', {}], ['', {}]]) {
    const r = changeForNotification(event, descriptor);
    assert.equal(r.known, false, `${event} should be unknown`);
    assert.equal(r.change, null);
  }
});

test('the pixel-path changes are marked as needing pixels, not as mappable', () => {
  // The disclosure the design asks for: these cannot cross as an operation,
  // and a sync that silently dropped them would be worse than one that says so.
  for (const event of ['paint', 'gaussianBlur', 'setLayerEffects', 'curves']) {
    const r = changeForNotification(event, {});
    assert.equal(r.known, true, `${event} is a change we know about`);
    assert.equal(r.mappable, false, `${event} must not be treated as forwardable`);
    assert.equal(r.requiresPixels, true);
  }
});

test('hide and show are visibility, not unclaimed events', () => {
  // Photoshop fires these rather than a `set` when a layer's eye is toggled.
  // Without them a hide or a show was an event nobody claimed, so toggling
  // visibility simply did nothing and said nothing.
  assert.equal(changeForNotification('hide').change, 'visibility');
  assert.equal(changeForNotification('show').change, 'visibility');
  assert.equal(changeForNotification('hide').mappable, true);
});

test('a notification aimed at "the selected layer" is read as the selection, not as nothing', () => {
  // How Photoshop almost always names the layer an edit touched: not by id,
  // but as `_enum: ordinal / targetEnum` -- "whatever is currently targeted".
  // The plugin used to accept ONLY a numeric `_id`, so a real move, rename or
  // opacity change arrived with no readable layer and was sent nowhere.
  const ordinal = { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' };
  assert.deepEqual(layerTargetsFrom({ _target: [ordinal] }), { selected: true });
  // `hide`/`show` carry the reference under `null`, not `_target`.
  assert.deepEqual(layerTargetsFrom({ null: [ordinal] }), { selected: true });
  assert.deepEqual(layerTargetsFrom({ null: ordinal }), { selected: true }, 'a single reference, not an array');
});

test('an explicit layer id in a notification wins, in every shape Photoshop sends it', () => {
  assert.deepEqual(layerTargetsFrom({ _target: [{ _ref: 'layer', _id: 12 }] }), { ids: [12] });
  // Newer builds add `layerID` as an ARRAY of every layer the command touched.
  assert.deepEqual(layerTargetsFrom({ layerID: [3, 4] }), { ids: [3, 4] });
  assert.deepEqual(layerTargetsFrom({ layerID: 5 }), { ids: [5] });
  assert.deepEqual(layerTargetsFrom({ layerID: { _id: 6 } }), { ids: [6] });
  // An id beats the ordinal: it names the layer outright.
  assert.deepEqual(
    layerTargetsFrom({ _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], layerID: [9] }),
    { ids: [9] },
  );
  // Duplicates collapse -- one layer, one event.
  assert.deepEqual(layerTargetsFrom({ _target: [{ _ref: 'layer', _id: 9 }], layerID: [9] }), { ids: [9] });
});

test('a layer named rather than numbered is reported as a name, never as the selection', () => {
  // Clicking the eye of a layer that is NOT selected targets it by name.
  // Reading that as "the selection" would hide the wrong layer.
  assert.deepEqual(layerTargetsFrom({ null: [{ _ref: 'layer', _name: 'Sky' }] }), { names: ['Sky'] });
});

test('a notification that names no layer returns null, so nothing is guessed', () => {
  assert.equal(layerTargetsFrom({}), null);
  assert.equal(layerTargetsFrom(undefined), null);
  assert.equal(layerTargetsFrom({ _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }] }), null,
    'a document reference is not a layer reference');
  assert.equal(layerTargetsFrom({ layerID: [] }), null);
  assert.equal(layerTargetsFrom({ layerID: [Number.NaN] }), null);
});

test('the plugin subscribes to every Photoshop event it knows how to forward', () => {
  // `hide` and `show` were mapped to visibility but never subscribed to, so
  // Photoshop never delivered them and toggling a layer's eye synced nothing.
  // Asserted as a rule rather than as two names, so the next event added to
  // the table cannot be forgotten the same way.
  const main = fs.readFileSync('plugin/main.js', 'utf8');
  const block = main.match(/const WATCHED = \[([\s\S]*?)\];/);
  assert.ok(block, 'WATCHED must be a literal array in plugin/main.js');
  const watched = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const forwardable = Object.keys(PHOTOSHOP_EVENTS).filter((e) => changeForNotification(e).mappable);
  const missing = forwardable.filter((e) => !watched.includes(e));
  assert.deepEqual(missing, [], `mapped but never subscribed to: ${missing.join(', ')}`);
  assert.ok(watched.includes('set'), '`set` carries opacity, blend mode and rename');
});

test('a burst collapses to the last of each layer, keeping first-seen order', () => {
  // One drag is dozens of `move` notifications, all superseded by the last.
  const collapsed = coalesceEvents([
    { change: 'move', layerID: 7, props: { x: 1 } },
    { change: 'reorder', layerID: 9, props: { to: 2 } },
    { change: 'move', layerID: 7, props: { x: 2 } },
    { change: 'move', layerID: 8, props: { x: 5 } },
    { change: 'move', layerID: 7, props: { x: 3 } },
  ]);
  assert.deepEqual(collapsed, [
    { change: 'move', layerID: 7, props: { x: 3 } },
    { change: 'reorder', layerID: 9, props: { to: 2 } },
    { change: 'move', layerID: 8, props: { x: 5 } },
  ]);
});

test('coalescing keeps different changes on one layer apart', () => {
  const collapsed = coalesceEvents([
    { change: 'move', layerID: 7, props: { x: 1 } },
    { change: 'opacity', layerID: 7, props: { opacity: 0.5 } },
  ]);
  assert.equal(collapsed.length, 2, 'a move and an opacity change are not the same edit');
});

test('document-level changes coalesce without a layerID colliding them', () => {
  const collapsed = coalesceEvents([
    { change: 'crop', props: { x: 0, y: 0, width: 10, height: 10 } },
    { change: 'canvasSize', props: { x: 0, y: 0, width: 20, height: 20 } },
    { change: 'crop', props: { x: 1, y: 1, width: 8, height: 8 } },
  ]);
  assert.deepEqual(collapsed.map((e) => e.change), ['crop', 'canvasSize']);
  assert.deepEqual(collapsed[0].props, { x: 1, y: 1, width: 8, height: 8 });
});

console.log('\nthe plugin\'s vendored copies\n');

const pluginRequire = createRequire(new URL('../plugin/vendor/', import.meta.url));

test('the vendored modules are CommonJS and actually load', () => {
  // UXP HAS NO ES MODULE SUPPORT. No `import`, no `<script type="module">`.
  // A panel script using them does not raise a useful error -- it never runs,
  // and the panel is empty or absent. That is the most common reason a UXP
  // plugin "will not load", and it is what the first version of this plugin
  // got wrong.
  //
  // So `require()` them here for real. A regex-built module that does not load
  // is worth nothing, and this is the only place that can find out cheaply.
  for (const name of ['protocol.js', 'identity.js', 'photoshop.js', 'font-file.js']) {
    const text = fs.readFileSync(`plugin/vendor/${name}`, 'utf8');
    assert.ok(text.startsWith('// GENERATED'), `plugin/vendor/${name} lost its generated banner`);
    assert.equal(/^import\s/m.test(text), false, `plugin/vendor/${name} still contains an ESM import`);
    assert.equal(/^export\s/m.test(text), false, `plugin/vendor/${name} still contains an ESM export`);
    assert.ok(/^module\.exports = \{/m.test(text), `plugin/vendor/${name} has no module.exports`);
    assert.doesNotThrow(() => pluginRequire(`./${name}`), `plugin/vendor/${name} does not load as CommonJS`);
  }
});

test('the vendored modules export exactly what src/sync exports', () => {
  // The drift guard. Byte-equality cannot be the check any more -- the files
  // are transformed, not copied -- so the check is the thing that actually
  // matters: same public surface, same behaviour.
  const pairs = [
    ['protocol.js', import('../src/sync/protocol.js')],
    ['identity.js', import('../src/sync/identity.js')],
    ['photoshop.js', import('../src/sync/photoshop.js')],
    ['font-file.js', import('../src/sync/font-file.js')],
  ];
  return Promise.all(pairs.map(async ([name, loading]) => {
    const esm = await loading;
    const cjs = pluginRequire(`./${name}`);
    const expected = Object.keys(esm).filter((k) => k !== 'default').sort();
    assert.deepEqual(Object.keys(cjs).sort(), expected,
      `plugin/vendor/${name} has drifted — run: node scripts/vendor-plugin.mjs`);
  }));
});

test('the vendored copy behaves identically to the original', () => {
  // Same input, same answer. Catches a transform that produced something which
  // loads and exports the right names while doing the wrong thing.
  const cjs = pluginRequire('./photoshop.js');
  assert.deepEqual(cjs.changeForNotification('set', { to: { opacity: 40 } }),
    changeForNotification('set', { to: { opacity: 40 } }));
  assert.deepEqual(cjs.normaliseKind('curves'), normaliseKind('curves'));
  assert.deepEqual(
    cjs.coalesceEvents([{ change: 'move', layerID: 7, props: { x: 1 } }, { change: 'move', layerID: 7, props: { x: 2 } }]),
    coalesceEvents([{ change: 'move', layerID: 7, props: { x: 1 } }, { change: 'move', layerID: 7, props: { x: 2 } }]),
  );
});

test('the plugin refuses to build a payload it would have to guess at', () => {
  // `reorder` has to name the neighbour the layer now sits above. The plugin
  // cannot read that yet, and the previous version sent `belowLayerID: null`
  // -- which translateEvent reads as "bottom of the stack", so EVERY reorder
  // moved the layer to the bottom wherever it was actually dropped. A wrong
  // edit on the right layer is no better than the right edit on the wrong one.
  const main = fs.readFileSync('plugin/main.js', 'utf8');
  // Comments stripped: the explanation of why this is wrong necessarily
  // contains the thing being banned.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('belowLayerID: null'), false,
    'plugin/main.js must not send a null belowLayerID — it means "move to the bottom"');
  assert.ok(/case 'reorder': return null;/.test(code), 'reorder must refuse rather than guess');

  // And the proof that null actually means "bottom", so nobody re-adds it
  // thinking it is a harmless placeholder.
  const mapping = matchLayers(
    [ps(1, 'a', 'pixel', [0, 0, 10, 10]), ps(2, 'b', 'pixel', [0, 0, 10, 10], ['G'])],
    [app(11, 0, 'a', 'raster', [0, 0, 10, 10]), app(12, 1, 'b', 'raster', [0, 0, 10, 10], 'G')],
  );
  const result = translateEvent(
    { type: 'event', change: 'reorder', layerID: 2, props: { belowLayerID: null } },
    mapping, { order: [11, 12] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.command.to, 0, 'null belowLayerID lands the layer at index 0 — the bottom');
});

test('plugin/main.js is a classic CommonJS script', () => {
  // The three things that stop a UXP panel loading, asserted rather than
  // remembered. An `import` is fatal; a specifier climbing out of plugin/ may
  // be, since UXP treats the manifest's folder as the plugin root.
  const main = fs.readFileSync('plugin/main.js', 'utf8');
  assert.equal(/^import\s/m.test(main), false, 'plugin/main.js uses ESM import — UXP cannot load it');
  assert.equal(/^export\s/m.test(main), false, 'plugin/main.js uses ESM export — UXP cannot load it');

  const climbing = [...main.matchAll(/require\('([^']+)'\)/g)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith('../'));
  assert.deepEqual(climbing, [], 'plugin/main.js must not require above its own folder');

  // UXP's DOM is not a browser DOM. innerHTML is not something to bet the
  // panel on, least of all the log that reports why everything else failed.
  // Matches the PROPERTY, not the word: the comment above the log explains
  // why innerHTML is avoided, and a test that cannot tell prose from code
  // fails on its own documentation.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('innerHTML'), false, 'plugin/main.js uses innerHTML, which UXP may not support');
});

test('index.html loads main.js as a classic script', () => {
  const html = fs.readFileSync('plugin/index.html', 'utf8');
  assert.ok(html.includes('<script src="main.js"></script>'), 'main.js must load as a classic script');
  // Comments are stripped first. The doc comment at the top of index.html
  // explains WHY type="module" cannot be used, and a check that cannot tell
  // prose from markup fails on its own documentation.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/<script[^>]*type\s*=\s*["']module["']/.test(markup), false, 'type="module" cannot work in UXP');
});

test('the manifest is the shape UXP validates', () => {
  // `host` as an ARRAY was the other load failure: Adobe's manifest v5 example
  // is an object, and a manifest that fails validation never reaches the code.
  const manifest = JSON.parse(fs.readFileSync('plugin/manifest.json', 'utf8'));
  assert.equal(manifest.manifestVersion, 5);
  assert.equal(typeof manifest.host, 'object');
  assert.equal(Array.isArray(manifest.host), false, 'manifest.host must be an object, not an array');
  assert.equal(manifest.host.app, 'PS');
  assert.ok(manifest.main.endsWith('.html'), 'manifest.main must point at an HTML file');
  assert.ok(Array.isArray(manifest.entrypoints) && manifest.entrypoints[0].type === 'panel');

  const domains = manifest.requiredPermissions.network.domains;
  assert.ok(domains.some((d) => d.startsWith('wss://')), 'the deployed relay must be allowlisted');
  // UXP 7.4+ rejects wildcard TLDs outright, so one here means the plugin
  // silently fails to load rather than merely failing to connect.
  assert.deepEqual(domains.filter((d) => d.includes('*')), [], 'no wildcards: UXP 7.4+ rejects them');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
