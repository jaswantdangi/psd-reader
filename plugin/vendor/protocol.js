// GENERATED — do not edit.
// Converted from src/sync/protocol.js to CommonJS by scripts/vendor-plugin.mjs,
// because UXP has no ES module support. Edit the original; test/sync.mjs
// fails if these drift apart.

/**
 * The Photoshop -> app sync wire protocol: message shapes, validation, and the
 * translation of a Photoshop change into an EXISTING editor command.
 *
 * # Two rules this file exists to enforce
 *
 * **Validate every inbound message.** A relay that trusts its input crashes on
 * the first malformed frame, and the frames here arrive from a plugin process
 * this code does not control. Nothing reads a field before the frame has been
 * checked, unknown types are refused by name rather than ignored, and undeclared
 * fields are stripped rather than carried through.
 *
 * **Nothing is silently dropped.** Per the design, move, reorder, opacity,
 * blend mode, visibility, rename, retype and crop are all representable. A
 * brush stroke, a filter and an adjustment layer are NOT -- they need the
 * layer's pixels through a separate mechanism. A sync that quietly discards
 * half a user's work is worse than one that refuses it, so every event that
 * does not become a command comes back with a reason attached.
 *
 * # No parallel mutation model
 *
 * Translation targets `set`, `reorder`, `insert`, `remove` and `frame` from
 * `src/edit.js` and nothing else. Those five already have inverses and a single
 * undo stack; a second set of "sync operations" beside them would be a second
 * implementation of the editor, which is the failure mode this project has hit
 * repeatedly. What comes out of here is the command's ARGUMENTS -- the caller
 * still goes through `setLayer` / `reorderLayer` / `setFrame` / `commit`, which
 * is what captures `from` and keeps undo working.
 */
const { appIdFor } = require('./identity.js');

/** The frame types. Anything else is refused by name. */
const MESSAGE_TYPES = ['hello', 'pair', 'paired', 'tree', 'event', 'error', 'font-request', 'font-chunk', 'font-missing'];

const PROTOCOL_ERRORS = {
  BAD_JSON: 'bad-json',
  NOT_AN_OBJECT: 'not-an-object',
  MISSING_TYPE: 'missing-type',
  UNKNOWN_TYPE: 'unknown-type',
  BAD_FIELD: 'bad-field',
};

/**
 * Pairing alphabet: no `0`/`O`, no `1`/`I`. A code is read off one screen and
 * typed into another, so the characters people confuse are simply absent
 * rather than corrected after the fact.
 */
const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIR_CODE_LENGTH = 6;

/** The largest font file sync sends. A large CJK face is 10–20 MB. */
const FONT_MAX_BYTES = 32 * 1024 * 1024;

/** Raw bytes per `font-chunk` -- about 0.7 MB once base64'd, far under every frame cap on the way. */
const FONT_CHUNK_BYTES = 512 * 1024;

const ROLES = ['plugin', 'app'];

const fail = (code, message) => ({ ok: false, error: { code, message } });
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/**
 * Every Photoshop change this protocol knows, and what it becomes.
 *
 * `command` names the `src/edit.js` command it maps onto. Its ABSENCE is the
 * statement that no command represents this change -- see `requiresPixels`.
 */
const CHANGE_MAP = {
  move: { command: 'set', fields: ['x', 'y'] },
  transform: { command: 'set', fields: ['x', 'y', 'w', 'h'] },
  reorder: { command: 'reorder' },
  opacity: { command: 'set', fields: ['opacity'] },
  blendMode: { command: 'set', fields: ['blendMode'] },
  visibility: { command: 'set', fields: ['visible'] },
  rename: { command: 'set', fields: ['name'] },
  retype: { command: 'set', fields: ['text'] },
  crop: { command: 'frame', scope: 'document' },
  canvasSize: { command: 'frame', scope: 'document' },
  delete: { command: 'remove' },
  /**
   * An added layer maps to `insert`, but `insert` holds the LAYER OBJECT --
   * pixels included -- so the command cannot be built from an event alone. It
   * is classified as needing pixels for exactly that reason, not because
   * `insert` is missing.
   */
  add: { command: 'insert', requiresPixels: true },
  // No command represents any of these. They are the pixel path.
  brush: { requiresPixels: true },
  filter: { requiresPixels: true },
  adjustment: { requiresPixels: true },
  maskPaint: { requiresPixels: true },
  layerEffect: { requiresPixels: true },
};

const CHANGE_KINDS = Object.keys(CHANGE_MAP);

/**
 * The changes with no command at all. `add` is not here: it HAS a command, it
 * just cannot be built without pixels. The UI needs both lists -- this one is
 * "what will never sync as an operation", which is the disclosure the design
 * asks for.
 */
const UNMAPPABLE_CHANGES = CHANGE_KINDS.filter((k) => !CHANGE_MAP[k].command);

/** What kind of change this is, without needing an event or a mapping. */
function classifyChange(change) {
  const spec = CHANGE_MAP[change];
  if (!spec) return { known: false, mappable: false, requiresPixels: false, command: null };
  return {
    known: true,
    mappable: !!spec.command && !spec.requiresPixels,
    requiresPixels: !!spec.requiresPixels,
    command: spec.command ?? null,
    scope: spec.scope ?? 'layer',
  };
}

// ------------------------------------------------------------- validation

function validateHello(m) {
  if (!ROLES.includes(m.role)) return fail(PROTOCOL_ERRORS.BAD_FIELD, `hello.role must be one of ${ROLES.join(', ')}`);
  if (!isNonEmptyString(m.version)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'hello.version must be a non-empty string');
  return { ok: true, message: { type: 'hello', role: m.role, version: m.version } };
}

function validatePair(m) {
  if (!isNonEmptyString(m.code)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'pair.code must be a string');
  const code = m.code.toUpperCase();
  if (code.length !== PAIR_CODE_LENGTH) {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, `pair.code must be ${PAIR_CODE_LENGTH} characters`);
  }
  for (const ch of code) {
    if (!PAIR_CODE_ALPHABET.includes(ch)) {
      return fail(PROTOCOL_ERRORS.BAD_FIELD, `pair.code contains "${ch}", which is not in the pairing alphabet`);
    }
  }
  return { ok: true, message: { type: 'pair', code } };
}

function validatePaired(m) {
  if (!isNonEmptyString(m.sessionId)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'paired.sessionId must be a non-empty string');
  if (!isPlainObject(m.peer)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'paired.peer must be an object');
  if (!ROLES.includes(m.peer.role)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'paired.peer.role must be a known role');
  if (!isNonEmptyString(m.peer.version)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'paired.peer.version must be a non-empty string');
  return { ok: true, message: { type: 'paired', sessionId: m.sessionId, peer: { role: m.peer.role, version: m.peer.version } } };
}

/**
 * One layer in a `tree` frame, checked against exactly what `matchLayers`
 * needs to normalise it. A descriptor it would reject is refused here instead,
 * where the reason can still name the index it came from.
 */
function treeLayerFault(l, i) {
  if (!isPlainObject(l)) return `tree.layers[${i}] must be an object`;
  const id = l.layerID;
  if (typeof id !== 'number' && typeof id !== 'string') return `tree.layers[${i}].layerID must be a number or string`;
  if (typeof id === 'number' && !Number.isFinite(id)) return `tree.layers[${i}].layerID must be finite`;
  if (typeof l.name !== 'string') return `tree.layers[${i}].name must be a string`;
  if (!isNonEmptyString(l.kind)) return `tree.layers[${i}].kind must be a non-empty string`;
  const b = l.bounds;
  if (!isPlainObject(b) || ![b.left, b.top, b.right, b.bottom].every(Number.isFinite)) {
    return `tree.layers[${i}].bounds must be {left,top,right,bottom} finite numbers`;
  }
  if (l.groupPath !== undefined
    && !(Array.isArray(l.groupPath) && l.groupPath.every((s) => typeof s === 'string'))) {
    return `tree.layers[${i}].groupPath must be an array of strings`;
  }
  return null;
}

/**
 * The layer tree, sent once by the plugin at pairing.
 *
 * This is the frame the whole identity model rests on: `matchLayers` cannot
 * run until the app has Photoshop's side of the comparison, and an event that
 * arrives before a mapping exists has nowhere to land. It is a type of its own
 * rather than an `event` because it is not a change -- classifying it as one
 * would put it through `CHANGE_MAP`, which has nothing to say about it.
 *
 * `document` is REQUIRED, and is not decoration. Both sides open the same file
 * independently, and nothing so far checks that they did. Pair against the
 * wrong open document and every signature misses: the user sees "matched 0 of
 * 12" with no way to tell a broken matcher from a wrong file. Carrying the
 * name and size lets the app say which it is.
 */
function validateTree(m) {
  if (!isPlainObject(m.document)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'tree.document must be an object');
  const { name, width, height } = m.document;
  if (typeof name !== 'string') return fail(PROTOCOL_ERRORS.BAD_FIELD, 'tree.document.name must be a string');
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, 'tree.document.width and .height must be finite numbers');
  }
  if (!Array.isArray(m.layers)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'tree.layers must be an array');
  for (let i = 0; i < m.layers.length; i++) {
    const fault = treeLayerFault(m.layers[i], i);
    if (fault) return fail(PROTOCOL_ERRORS.BAD_FIELD, fault);
  }
  return {
    ok: true,
    message: {
      type: 'tree',
      document: { name, width, height },
      layers: m.layers.map((l) => ({
        layerID: l.layerID,
        name: l.name,
        kind: l.kind,
        bounds: { left: l.bounds.left, top: l.bounds.top, right: l.bounds.right, bottom: l.bounds.bottom },
        groupPath: Array.isArray(l.groupPath) ? [...l.groupPath] : [],
      })),
    },
  };
}

function validateEvent(m) {
  if (!isNonEmptyString(m.change)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'event.change must be a string');
  if (!isPlainObject(m.props)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'event.props must be an object');
  // A layerID is NOT required here: `crop` and `canvasSize` are document-level.
  // What it must not be is a wrong type -- that is how a mapping lookup silently
  // misses and an event gets dropped without a reason.
  const hasLayer = m.layerID !== undefined && m.layerID !== null;
  if (hasLayer && typeof m.layerID !== 'number' && typeof m.layerID !== 'string') {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, 'event.layerID must be a number or string');
  }
  if (hasLayer && typeof m.layerID === 'number' && !Number.isFinite(m.layerID)) {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, 'event.layerID must be finite');
  }
  const message = { type: 'event', change: m.change, props: m.props };
  if (hasLayer) message.layerID = m.layerID;
  return { ok: true, message };
}

/** Why the plugin could not send a font. The app writes copy per reason. */
const FONT_MISSING_REASONS = ['no-folder', 'not-found', 'collection', 'too-large', 'unreadable'];

const FONT_NAME_MAX = 128;
const FONT_REQUEST_MAX = 64;
const FONT_CHUNKS_MAX = FONT_MAX_BYTES / FONT_CHUNK_BYTES;
const FONT_CHUNK_BASE64_MAX = Math.ceil(FONT_CHUNK_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isFontName = (v) => isNonEmptyString(v) && v.length <= FONT_NAME_MAX;
const isIntIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** The app asking for the fonts it is substituting. Names are PostScript names, as the PSD stores them. */
function validateFontRequest(m) {
  if (!Array.isArray(m.names) || m.names.length < 1 || m.names.length > FONT_REQUEST_MAX) {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, `font-request.names must list 1 to ${FONT_REQUEST_MAX} font names`);
  }
  if (!m.names.every(isFontName)) {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, `every font-request name must be a string of 1 to ${FONT_NAME_MAX} characters`);
  }
  return { ok: true, message: { type: 'font-request', names: [...new Set(m.names)] } };
}

/**
 * One piece of one font file. Every field is bounded here, before a relay
 * forwards it or the app allocates for it: `bytes` is what the app will
 * allocate, so it is the one that must never be trusted unchecked.
 */
function validateFontChunk(m) {
  const bad = (what) => fail(PROTOCOL_ERRORS.BAD_FIELD, `font-chunk.${what}`);
  if (!isFontName(m.name)) return bad(`name must be a string of 1 to ${FONT_NAME_MAX} characters`);
  if (!isNonEmptyString(m.fileName) || m.fileName.length > 255) return bad('fileName must be a string of 1 to 255 characters');
  if (!isIntIn(m.count, 1, FONT_CHUNKS_MAX)) return bad(`count must be an integer from 1 to ${FONT_CHUNKS_MAX}`);
  if (!isIntIn(m.index, 0, m.count - 1)) return bad('index must be an integer from 0 to count - 1');
  if (!isIntIn(m.bytes, 1, FONT_MAX_BYTES)) return bad(`bytes must be an integer from 1 to ${FONT_MAX_BYTES}`);
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return bad('sha256 must be 64 lowercase hex characters');
  if (typeof m.data !== 'string' || m.data.length > FONT_CHUNK_BASE64_MAX || m.data.length % 4 !== 0 || !BASE64.test(m.data)) {
    return bad(`data must be base64 of at most ${FONT_CHUNK_BYTES} bytes`);
  }
  const { name, fileName, index, count, bytes, sha256, data } = m;
  return { ok: true, message: { type: 'font-chunk', name, fileName, index, count, bytes, sha256, data } };
}

/** The plugin saying it could not send a font, and why. Never silent. */
function validateFontMissing(m) {
  if (!isFontName(m.name)) return fail(PROTOCOL_ERRORS.BAD_FIELD, `font-missing.name must be a string of 1 to ${FONT_NAME_MAX} characters`);
  if (!FONT_MISSING_REASONS.includes(m.reason)) {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, `font-missing.reason must be one of ${FONT_MISSING_REASONS.join(', ')}`);
  }
  if (m.detail !== undefined && (typeof m.detail !== 'string' || m.detail.length > 500)) {
    return fail(PROTOCOL_ERRORS.BAD_FIELD, 'font-missing.detail must be a string of at most 500 characters');
  }
  return { ok: true, message: { type: 'font-missing', name: m.name, reason: m.reason, detail: m.detail ?? '' } };
}

/**
 * Which way each one-way frame travels, and what to say when it goes the
 * wrong way. ONE table, read by both relays, so the Node relay and the
 * Worker cannot drift into disagreeing about direction.
 */
const ONE_WAY_FRAMES = {
  tree: { from: 'plugin', notPaired: 'pair before sending the layer tree', wrongWay: 'the layer tree travels Photoshop -> app only' },
  event: { from: 'plugin', notPaired: 'pair before sending events', wrongWay: 'events travel Photoshop -> app only' },
  'font-chunk': { from: 'plugin', notPaired: 'pair before sending font files', wrongWay: 'font files travel Photoshop -> app only' },
  'font-missing': { from: 'plugin', notPaired: 'pair before reporting fonts', wrongWay: 'font reports travel Photoshop -> app only' },
  'font-request': { from: 'app', notPaired: 'pair before requesting fonts', wrongWay: 'font requests travel app -> Photoshop only' },
};

function validateError(m) {
  if (!isNonEmptyString(m.code)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'error.code must be a non-empty string');
  if (typeof m.message !== 'string') return fail(PROTOCOL_ERRORS.BAD_FIELD, 'error.message must be a string');
  return { ok: true, message: { type: 'error', code: m.code, message: m.message } };
}

const VALIDATORS = {
  hello: validateHello,
  pair: validatePair,
  paired: validatePaired,
  tree: validateTree,
  event: validateEvent,
  error: validateError,
  'font-request': validateFontRequest,
  'font-chunk': validateFontChunk,
  'font-missing': validateFontMissing,
};

/**
 * Check one inbound frame.
 *
 * @returns {{ok:true,message:object}|{ok:false,error:{code,message}}} Never
 *   throws, and the returned `message` is REBUILT from known fields only --
 *   anything the sender added beyond the schema does not reach the rest of the
 *   app.
 */
function validateMessage(raw) {
  if (!isPlainObject(raw)) return fail(PROTOCOL_ERRORS.NOT_AN_OBJECT, 'a frame must be a JSON object');
  if (!isNonEmptyString(raw.type)) return fail(PROTOCOL_ERRORS.MISSING_TYPE, 'a frame must carry a string `type`');
  const validate = Object.prototype.hasOwnProperty.call(VALIDATORS, raw.type) ? VALIDATORS[raw.type] : null;
  if (!validate) return fail(PROTOCOL_ERRORS.UNKNOWN_TYPE, `unknown frame type "${raw.type}"`);
  return validate(raw);
}

/** `JSON.parse` plus `validateMessage`, with the parse failure as a return value. */
function parseMessage(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(PROTOCOL_ERRORS.BAD_JSON, `frame is not JSON: ${e.message}`);
  }
  return validateMessage(raw);
}

/** Build an `error` frame. One shape, so the peer only ever parses one. */
const errorFrame = (code, message) => ({ type: 'error', code, message: String(message ?? '') });

// ------------------------------------------------------------ translation

const finite = (v) => Number.isFinite(v);

const refuse = (reason, extra = {}) => ({ ok: false, reason, requiresPixels: false, ...extra });

/** Per-change prop checks. A command is never half-built from partial props. */
function readProps(change, props) {
  const spec = CHANGE_MAP[change];
  if (spec.fields) {
    const to = {};
    for (const field of spec.fields) {
      const value = props[field];
      if (field === 'visible') {
        if (typeof value !== 'boolean') return null;
      } else if (field === 'name' || field === 'blendMode') {
        if (typeof value !== 'string') return null;
      } else if (field === 'opacity') {
        if (!finite(value) || value < 0 || value > 1) return null;
      } else if (field === 'text') {
        if (!isPlainObject(value)) return null;
      } else if (!finite(value)) return null;
      to[field] = value;
    }
    return to;
  }
  if (spec.scope === 'document') {
    const { x, y, width, height } = props;
    if (![x, y, width, height].every(finite)) return null;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }
  return {};
}

/**
 * Where a reordered layer lands in `project.layers`.
 *
 * `project.layers` runs BOTTOM to TOP -- `renderProject` draws it in array
 * order, so the last entry is the frontmost. Photoshop's own panel index runs
 * the other way AND counts groups, so it is not translatable; the event names a
 * neighbour by `layerID` instead, and both ends are resolved through the
 * mapping. `belowLayerID: null` means the layer is now bottom-most.
 *
 * `to` is an index into the array AFTER the move is spliced out, which is
 * exactly what `applyCommand`'s `reorder` expects.
 */
function reorderIndices(appId, belowLayerID, mapping, order) {
  const from = order.indexOf(appId);
  if (from < 0) return null;
  const rest = order.filter((id) => id !== appId);
  if (belowLayerID === null || belowLayerID === undefined) return { from, to: 0 };
  const belowAppId = appIdFor(mapping, belowLayerID);
  if (belowAppId === null) return null;
  const at = rest.indexOf(belowAppId);
  if (at < 0) return null;
  return { from, to: at + 1 };
}

/**
 * One Photoshop event -> one editor command, or a stated refusal.
 *
 * @param {object} event    an `event` frame, already validated or not
 * @param {object} mapping  the result of `matchLayers`, pinned at pairing
 * @param {{order?: Array}} options  `order` is the app's current layer ids,
 *   bottom to top -- required only by `reorder`.
 * @returns {{ok:true,command:object}|{ok:false,reason:string,requiresPixels:boolean}}
 *   reasons: `invalid-message`, `unknown-change`, `needs-pixels`,
 *   `unknown-layer`, `bad-props`.
 */
function translateEvent(event, mapping, options = {}) {
  const checked = validateMessage(event);
  if (!checked.ok) return refuse('invalid-message', { detail: checked.error });
  const { change, props, layerID } = checked.message;

  const spec = CHANGE_MAP[change];
  if (!spec) return refuse('unknown-change', { change, layerID: layerID ?? null });
  if (spec.requiresPixels) {
    return refuse('needs-pixels', { change, layerID: layerID ?? null, requiresPixels: true, command: spec.command ?? null });
  }

  if (spec.scope === 'document') {
    const to = readProps(change, props);
    if (!to) return refuse('bad-props', { change });
    return { ok: true, command: { type: 'frame', to } };
  }

  const appId = appIdFor(mapping, layerID);
  if (appId === null) return refuse('unknown-layer', { change, layerID: layerID ?? null });

  if (spec.command === 'remove') return { ok: true, command: { type: 'remove', id: appId } };

  if (spec.command === 'reorder') {
    const order = options.order;
    if (!Array.isArray(order)) return refuse('bad-props', { change, layerID });
    const indices = reorderIndices(appId, props.belowLayerID ?? null, mapping, order);
    // A neighbour that never matched means we do not know where this layer
    // goes. Placing it "somewhere near" is the misalignment the identity
    // handshake exists to prevent, so the event is refused instead.
    if (!indices) return refuse('unknown-layer', { change, layerID });
    return { ok: true, command: { type: 'reorder', ...indices } };
  }

  const to = readProps(change, props);
  if (!to) return refuse('bad-props', { change, layerID });
  return { ok: true, command: { type: 'set', id: appId, to } };
}

/**
 * Translate a batch, keeping every refusal beside the commands.
 *
 * `needsPixels` is split out because it is a different mechanism with a
 * different cost -- `imaging.getPixels` for one layer at proxy resolution, in
 * megabytes -- and it needs its own debounce. Photoshop's notification stream
 * fires continuously during a brush stroke; the caller has to batch that list,
 * not act on it per event.
 */
function translateEvents(events, mapping, options = {}) {
  if (!Array.isArray(events)) throw new TypeError('translateEvents needs an array of event frames');
  const commands = [];
  const refused = [];
  const needsPixels = [];
  for (const event of events) {
    const result = translateEvent(event, mapping, options);
    if (result.ok) { commands.push(result.command); continue; }
    const entry = {
      reason: result.reason,
      change: result.change ?? (typeof event?.change === 'string' ? event.change : null),
      layerID: result.layerID ?? null,
      detail: result.detail ?? null,
    };
    refused.push(entry);
    if (result.requiresPixels) needsPixels.push(entry);
  }
  return { commands, refused, needsPixels };
}

module.exports = { MESSAGE_TYPES, PROTOCOL_ERRORS, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH, FONT_MAX_BYTES, FONT_CHUNK_BYTES, CHANGE_KINDS, UNMAPPABLE_CHANGES, FONT_MISSING_REASONS, ONE_WAY_FRAMES, errorFrame, classifyChange, validateMessage, parseMessage, translateEvent, translateEvents };
