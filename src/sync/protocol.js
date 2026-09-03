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
import { appIdFor } from './identity.js';

/** The five frame types. Anything else is refused by name. */
export const MESSAGE_TYPES = ['hello', 'pair', 'paired', 'event', 'error'];

export const PROTOCOL_ERRORS = {
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
export const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAIR_CODE_LENGTH = 6;

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

export const CHANGE_KINDS = Object.keys(CHANGE_MAP);

/**
 * The changes with no command at all. `add` is not here: it HAS a command, it
 * just cannot be built without pixels. The UI needs both lists -- this one is
 * "what will never sync as an operation", which is the disclosure the design
 * asks for.
 */
export const UNMAPPABLE_CHANGES = CHANGE_KINDS.filter((k) => !CHANGE_MAP[k].command);

/** What kind of change this is, without needing an event or a mapping. */
export function classifyChange(change) {
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

function validateError(m) {
  if (!isNonEmptyString(m.code)) return fail(PROTOCOL_ERRORS.BAD_FIELD, 'error.code must be a non-empty string');
  if (typeof m.message !== 'string') return fail(PROTOCOL_ERRORS.BAD_FIELD, 'error.message must be a string');
  return { ok: true, message: { type: 'error', code: m.code, message: m.message } };
}

const VALIDATORS = {
  hello: validateHello,
  pair: validatePair,
  paired: validatePaired,
  event: validateEvent,
  error: validateError,
};

/**
 * Check one inbound frame.
 *
 * @returns {{ok:true,message:object}|{ok:false,error:{code,message}}} Never
 *   throws, and the returned `message` is REBUILT from known fields only --
 *   anything the sender added beyond the schema does not reach the rest of the
 *   app.
 */
export function validateMessage(raw) {
  if (!isPlainObject(raw)) return fail(PROTOCOL_ERRORS.NOT_AN_OBJECT, 'a frame must be a JSON object');
  if (!isNonEmptyString(raw.type)) return fail(PROTOCOL_ERRORS.MISSING_TYPE, 'a frame must carry a string `type`');
  const validate = Object.prototype.hasOwnProperty.call(VALIDATORS, raw.type) ? VALIDATORS[raw.type] : null;
  if (!validate) return fail(PROTOCOL_ERRORS.UNKNOWN_TYPE, `unknown frame type "${raw.type}"`);
  return validate(raw);
}

/** `JSON.parse` plus `validateMessage`, with the parse failure as a return value. */
export function parseMessage(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(PROTOCOL_ERRORS.BAD_JSON, `frame is not JSON: ${e.message}`);
  }
  return validateMessage(raw);
}

/** Build an `error` frame. One shape, so the peer only ever parses one. */
export const errorFrame = (code, message) => ({ type: 'error', code, message: String(message ?? '') });

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
export function translateEvent(event, mapping, options = {}) {
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
export function translateEvents(events, mapping, options = {}) {
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
