/**
 * Photoshop -> app sync: layer identity and the message protocol.
 *
 * Pure logic. No sockets, no Photoshop, no document. Every fixture here is a
 * pair of DESCRIPTOR LISTS -- what the UXP plugin would enumerate on one side,
 * what `flatten()` produced on the other -- because that is the only thing the
 * matcher is allowed to see.
 */
import assert from 'node:assert/strict';
import {
  matchLayers, MATCH_TIERS, UNMATCHED_REASONS, boundsOf, groupPathOf,
} from '../src/sync/identity.js';
import {
  MESSAGE_TYPES, PROTOCOL_ERRORS, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH,
  validateMessage, parseMessage, classifyChange, UNMAPPABLE_CHANGES,
  translateEvent, translateEvents,
} from '../src/sync/protocol.js';

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

test('each of the five frame types validates and normalises', () => {
  assert.deepEqual(MESSAGE_TYPES, ['hello', 'pair', 'paired', 'event', 'error']);
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
