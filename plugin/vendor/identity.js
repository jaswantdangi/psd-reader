// GENERATED — do not edit.
// Copied from src/sync/identity.js by scripts/vendor-plugin.mjs.
// Edit the original; test/sync.mjs fails if these two ever drift apart.

/**
 * Layer identity between Photoshop and this app.
 *
 * # Why this file exists
 *
 * A Photoshop event says *"layer 7 moved to x=40"*. Applying it needs both
 * sides to agree which layer 7 is, and they do not:
 *
 * - The app keys on `id` (an app-local counter) and `sourceIndex` -- position
 *   among the file's LEAF nodes, with the pixel-less and text-less ones dropped
 *   by `flatten()` in `src/edit.js`.
 * - Photoshop has a stable per-session `layerID`, and enumerates GROUPS as
 *   layers too.
 *
 * `docs/BACKLOG.md` already records the consequence: positional matching
 * "would silently misalign every layer after the first skipped one". Groups
 * widen the same gap from both ends.
 *
 * # Why it fails closed
 *
 * A misaligned event does not throw. It applies the right change to the WRONG
 * layer -- which the user reads as this app corrupting their document. That is
 * the worst outcome available here, strictly worse than syncing nothing. So:
 *
 * - Index is never an input. Not as a tiebreak, not as a hint.
 * - Every tier is 1:1 or it does not match. Two candidates at a tier means NO
 *   match for either, never a coin flip.
 * - Everything unmatched is REPORTED with a reason. An unmatched layer simply
 *   does not sync; a wrongly matched one damages the document.
 *
 * # The tiers, and why there are exactly three
 *
 * The signature is group path + kind + name + bounds. Each tier drops at most
 * ONE of those, so every tier still carries three independent constraints:
 *
 * | tier        | drops      | the edit it survives                        |
 * |-------------|------------|---------------------------------------------|
 * | `exact`     | nothing    | -- the common case                          |
 * | `renamed`   | name       | the layer was renamed on one side only      |
 * | `regrouped` | group path | the layer was dragged into another group    |
 *
 * `bounds` and `kind` are never dropped. Bounds carry nearly all the entropy
 * (four independent integers), and kind is a hard type constraint -- matching a
 * text layer onto a raster one would send `set { text }` to a layer with no
 * `text` object at all.
 *
 * Tiers run in order over the RESIDUE of the previous one, so a pair resolved
 * at `exact` is gone before `renamed` is considered and cannot be stolen by a
 * looser rule. `renamed` runs before `regrouped` because a rename is a
 * one-click Photoshop operation and far more frequent than dragging a layer
 * between groups; resolving the common edit first leaves fewer collisions for
 * the looser tier. Both are 1:1-gated either way, so the order changes which
 * cases resolve early, never whether a wrong pair can be produced.
 *
 * Dropping TWO attributes at once (renamed *and* regrouped) is deliberately not
 * a tier. Name plus kind, or group plus kind, is not enough to be sure, and
 * "not sure" here means damaging a document.
 *
 * Bounds are compared EXACTLY, with no tolerance. Both sides read the same
 * file, so they agree to the integer; a tolerance would only widen buckets and
 * manufacture the ambiguity this module exists to refuse.
 */

/** Tiers, loosest last. Every tier drops at most one signature attribute. */
export const MATCH_TIERS = ['exact', 'renamed', 'regrouped'];

/**
 * Every reason a descriptor can end up in `unmatched`. Exported so the UI can
 * write copy per reason -- "3 layers could not be identified" is not useful;
 * "2 layers share a name and position, so neither will sync" is.
 */
export const UNMATCHED_REASONS = [
  /** Photoshop lists groups as layers; `flatten()` dissolves them. Expected, not a failure. */
  'group',
  /** An adjustment layer carries no pixels, so `flatten()` drops it. Its effect is not in our model either. */
  'adjustment',
  /** More than one candidate survived at some tier. Refused on both sides. */
  'ambiguous',
  /** Nothing on the other side shares even the loosest signature. */
  'no-candidate',
  /** The descriptor itself was missing fields or carried non-finite numbers. */
  'invalid',
];

/**
 * Signature field separator: NUL, which no layer name can contain.
 *
 * A space would not do. `groupPath + " " + name` cannot distinguish group
 * "A" holding "B C" from group "A B" holding "C", and a signature that
 * collides is exactly the ambiguity this module refuses everywhere else.
 */
const SEP = '\u0000';

/**
 * Bounds in one shape, from either side's.
 *
 * Photoshop reports `bounds: { left, top, right, bottom }`. An app layer built
 * by `toLayer` carries `x`, `y`, `w`, `h` directly on itself. Both are document
 * space, so the conversion is arithmetic and nothing else.
 *
 * @returns {{left:number,top:number,right:number,bottom:number}|null} null when
 *   the descriptor carries neither shape, or carries non-finite numbers.
 */
export function boundsOf(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const b = descriptor.bounds;
  if (b && typeof b === 'object') {
    const { left, top, right, bottom } = b;
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    return { left, top, right, bottom };
  }
  const { x, y, w, h } = descriptor;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { left: x, top: y, right: x + w, bottom: y + h };
}

/**
 * The group path as one string.
 *
 * `flatten()` writes `' / '`-joined names; the plugin walks a tree and has an
 * array. Joining here means the signature builder never has to know which side
 * it is looking at.
 */
export function groupPathOf(descriptor) {
  const path = descriptor?.groupPath;
  if (Array.isArray(path)) return path.join(' / ');
  return typeof path === 'string' ? path : '';
}

/**
 * Photoshop's kind vocabulary and ours, reduced to what the matcher compares.
 *
 * Everything Photoshop calls a pixel-bearing layer -- pixel, smart object,
 * shape, video -- reaches the app as `raster`, because `toLayer` has exactly
 * two kinds. `group` and `adjustment` are kept distinct precisely so they can
 * NEVER match: neither exists app-side, and both must be reported instead.
 */
function kindOf(descriptor) {
  const raw = typeof descriptor?.kind === 'string' ? descriptor.kind : '';
  const k = raw.toLowerCase();
  if (k === 'group' || k === 'groupend' || k === 'layersection') return 'group';
  if (k === 'adjustment' || k === 'adjustmentlayer') return 'adjustment';
  if (k === 'text' || k === 'textlayer' || k === 'type') return 'text';
  if (!k) return '';
  return 'raster';
}

/** A stable, printable identity for one side's descriptor, for the report. */
const idOf = (descriptor, side) => (side === 'photoshop' ? descriptor.layerID : descriptor.id);

/**
 * Reduce a descriptor to the fields the matcher is allowed to see, or null if
 * it is not usable. Nothing downstream touches the raw descriptor again, which
 * is what keeps index and array position out of the algorithm structurally
 * rather than by discipline.
 */
function normalise(descriptor, side) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const id = idOf(descriptor, side);
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  if (typeof id === 'number' && !Number.isFinite(id)) return null;
  const name = descriptor.name;
  if (typeof name !== 'string') return null;
  const kind = kindOf(descriptor);
  if (!kind) return null;
  const bounds = boundsOf(descriptor);
  if (!bounds) return null;
  return {
    id, name, kind, bounds,
    groupPath: groupPathOf(descriptor),
    sourceIndex: Number.isFinite(descriptor.sourceIndex) ? descriptor.sourceIndex : null,
  };
}

const boundsKey = (b) => `${b.left},${b.top},${b.right},${b.bottom}`;

/** The signature at one tier. Bounds and kind are in every one of them. */
function signatureAt(entry, tier) {
  const bk = boundsKey(entry.bounds);
  if (tier === 'exact') return `${entry.groupPath}${SEP}${entry.kind}${SEP}${entry.name}${SEP}${bk}`;
  if (tier === 'renamed') return `${entry.groupPath}${SEP}${entry.kind}${SEP}${bk}`;
  return `${entry.kind}${SEP}${entry.name}${SEP}${bk}`; // regrouped
}

const bucketise = (entries, tier) => {
  const buckets = new Map();
  for (const e of entries) {
    const key = signatureAt(e, tier);
    const list = buckets.get(key);
    if (list) list.push(e); else buckets.set(key, [e]);
  }
  return buckets;
};

/**
 * Reconcile the two descriptor lists once, at pairing, and pin the result for
 * the session.
 *
 * @param {object[]} photoshopLayers  `{ layerID, name, kind, bounds, groupPath }`
 * @param {object[]} appLayers        `{ id, sourceIndex, name, kind, x, y, w, h, groupPath }`
 * @returns {{
 *   matched: Array<{layerID, appId, sourceIndex, tier, name}>,
 *   byLayerID: Map<number|string, {appId, sourceIndex, tier}>,
 *   byAppId: Map<number|string, number|string>,
 *   unmatched: Array<{side, layerID?, appId?, name, kind, reason, candidates?}>,
 * }}
 */
export function matchLayers(photoshopLayers, appLayers) {
  if (!Array.isArray(photoshopLayers) || !Array.isArray(appLayers)) {
    throw new TypeError('matchLayers needs a descriptor list from each side');
  }

  const matched = [];
  const unmatched = [];
  const psResidue = [];
  const appResidue = [];

  // Pass 0: split off everything that cannot participate, with its own reason.
  // A group or an adjustment layer is not a matching FAILURE -- the app model
  // has no such layer at all -- and conflating the two would bury the real
  // failures under noise on every grouped document.
  for (const raw of photoshopLayers) {
    const entry = normalise(raw, 'photoshop');
    if (!entry) {
      unmatched.push({
        side: 'photoshop', layerID: raw?.layerID ?? null,
        name: typeof raw?.name === 'string' ? raw.name : '(unnamed)', kind: null, reason: 'invalid',
      });
      continue;
    }
    if (entry.kind === 'group' || entry.kind === 'adjustment') {
      unmatched.push({
        side: 'photoshop', layerID: entry.id, name: entry.name, kind: entry.kind, reason: entry.kind,
      });
      continue;
    }
    psResidue.push(entry);
  }
  for (const raw of appLayers) {
    const entry = normalise(raw, 'app');
    if (!entry) {
      unmatched.push({
        side: 'app', appId: raw?.id ?? null,
        name: typeof raw?.name === 'string' ? raw.name : '(unnamed)', kind: null, reason: 'invalid',
      });
      continue;
    }
    appResidue.push(entry);
  }

  // Tiers, loosest last, each over what the previous one left behind.
  let ps = psResidue;
  let ap = appResidue;
  for (const tier of MATCH_TIERS) {
    if (!ps.length || !ap.length) break;
    const psBuckets = bucketise(ps, tier);
    const apBuckets = bucketise(ap, tier);
    const takenPs = new Set();
    const takenAp = new Set();

    for (const [key, psGroup] of psBuckets) {
      const apGroup = apBuckets.get(key);
      // EXACTLY one on each side, or nothing. This single condition is the
      // whole fail-closed guarantee: 2-vs-1, 1-vs-2 and 2-vs-2 all fall
      // through to the next tier and, failing that, to `ambiguous`.
      if (!apGroup || psGroup.length !== 1 || apGroup.length !== 1) continue;
      const p = psGroup[0];
      const a = apGroup[0];
      matched.push({ layerID: p.id, appId: a.id, sourceIndex: a.sourceIndex, tier, name: a.name });
      takenPs.add(p);
      takenAp.add(a);
    }

    ps = ps.filter((e) => !takenPs.has(e));
    ap = ap.filter((e) => !takenAp.has(e));
  }

  // Whatever is left could not be resolved. Distinguish "I saw candidates and
  // refused to choose" from "there was nothing there" -- they need different
  // copy and they mean different things about the document.
  const explain = (entry, others, side) => {
    const candidates = new Set();
    for (const tier of MATCH_TIERS) {
      const key = signatureAt(entry, tier);
      for (const other of others) if (signatureAt(other, tier) === key) candidates.add(other.id);
    }
    if (!candidates.size) {
      return { side, name: entry.name, kind: entry.kind, reason: 'no-candidate' };
    }
    return { side, name: entry.name, kind: entry.kind, reason: 'ambiguous', candidates: [...candidates] };
  };
  for (const entry of ps) unmatched.push({ layerID: entry.id, ...explain(entry, ap, 'photoshop') });
  for (const entry of ap) unmatched.push({ appId: entry.id, ...explain(entry, ps, 'app') });

  const byLayerID = new Map();
  const byAppId = new Map();
  for (const m of matched) {
    byLayerID.set(m.layerID, { appId: m.appId, sourceIndex: m.sourceIndex, tier: m.tier });
    byAppId.set(m.appId, m.layerID);
  }
  return { matched, unmatched, byLayerID, byAppId };
}

/**
 * The app layer a Photoshop `layerID` names, or null.
 *
 * Callers must treat null as "drop this event and report it", never as "try
 * something else" -- there is nothing else to try that is not a guess.
 */
export const appIdFor = (mapping, layerID) => mapping?.byLayerID?.get(layerID)?.appId ?? null;
