/**
 * The model registry, and the rule for which models a device may load.
 *
 * Everything here is DATA plus one decision function. No fetching, no
 * inference, no browser API -- so the gating rule is testable in Node and the
 * app cannot invent a second, differently-behaved copy of it.
 *
 * ## Why a registry rather than a constant
 *
 * There are four models and they are not interchangeable: one is the default
 * cut, two are subject presets, one is a click-refiner that answers a different
 * question entirely. Each carries a download the user pays for on a phone. The
 * registry exists so that `bytes` sits next to `id` and nothing can quote a
 * size that drifted from the file it names.
 *
 * ## Why sizes are stated at all
 *
 * Loading every model in this table costs ~385 MB. That is a number a user on
 * mobile data is entitled to see BEFORE the download starts, not after -- so
 * `bytes` is not documentation, it is the value the consent prompt renders.
 * Nothing here downloads anything as a side effect of being read.
 */

/**
 * Roughly what the network transfer costs, in bytes.
 *
 * Measured from the published ONNX files, not estimated: the fp16 BiRefNet_lite
 * export is 115 MB and the fp32 is 224 MB, so `dtype` and `bytes` have to move
 * together. If either is edited alone the prompt lies about the download.
 */
const MB = 1024 * 1024;

/**
 * The one model every cut starts from.
 *
 * BiRefNet is MIT on the CODE AND THE WEIGHTS, which is the reason it is here
 * rather than RMBG-2.0 (CC BY-NC, no commercial use) or anything routed through
 * @imgly/background-removal (AGPL). Those two are the better-known options and
 * both are unusable in a product that ships; recording that here is what stops
 * the next person swapping one in because it scored better in a blog post.
 */
export const BASE = 'base';
/** Point-prompted refinement -- a different question: "this object, not that one". */
export const CLICK = 'click';
/** Subject presets. Same architecture, retrained heads. */
export const PORTRAIT = 'portrait';
export const FAST = 'fast';

/** @typedef {{id: string, role: string, dtype: string, bytes: number, license: string, purpose: string, task: string}} SegmentModel */

/** @type {Record<string, SegmentModel>} */
export const MODELS = {
  [BASE]: {
    id: 'onnx-community/BiRefNet_lite-ONNX',
    role: BASE,
    dtype: 'fp16',
    bytes: 115 * MB,
    license: 'MIT',
    task: 'segment',
    purpose: 'General cut-out. The default for every subject.',
  },
  [PORTRAIT]: {
    id: 'onnx-community/BiRefNet-portrait-ONNX',
    role: PORTRAIT,
    dtype: 'fp16',
    bytes: 115 * MB,
    license: 'MIT',
    task: 'segment',
    purpose: 'People. Better on hair and shoulders than the general model.',
  },
  [FAST]: {
    id: 'onnx-community/BiRefNet_512x512-ONNX',
    role: FAST,
    dtype: 'fp16',
    bytes: 115 * MB,
    license: 'MIT',
    task: 'segment',
    purpose: 'Half-resolution pass. Coarser edges, quicker answer.',
  },
  [CLICK]: {
    /*
     * SlimSAM rather than SAM 3. SAM 3 ships under Meta's own "SAM License",
     * not Apache-2.0, and adopting it would put a licence review on the
     * critical path of a feature that does not need one -- SlimSAM is a pruned
     * SAM 1, Apache-2.0, and roughly a third of the download. If SAM 3 is ever
     * wanted, that is a licence decision first and a code change second.
     */
    id: 'Xenova/slimsam-77-uniform',
    role: CLICK,
    dtype: 'fp16',
    bytes: 40 * MB,
    license: 'Apache-2.0',
    task: 'point',
    purpose: 'Tap an object to add it to or subtract it from the cut.',
  },
};

/**
 * Headroom the app needs for the document itself while a model is resident.
 *
 * A cut runs against a proxy layer that is already decoded and on the heap, so
 * the model is not the only thing in memory when it loads. This is the slack
 * reserved for that, and it is why the gate below is not simply
 * `budget >= model.bytes`.
 */
export const DOCUMENT_HEADROOM_BYTES = 24 * MB;

/**
 * May this device load this model?
 *
 * The budget passed in is `memoryBudgetBytes()` from budget.js, which is
 * two-valued in practice: 81.9 MB when device memory is unknown or <= 1.8 GB,
 * 150 MB otherwise. The 115 MB base model therefore does NOT fit the low tier,
 * and this returns false there -- deliberately, and visibly.
 *
 * The alternative was shipping an int8 export so the feature exists everywhere.
 * That was considered and declined: a quantised model would have to be built
 * and hosted by us, and its edges are worse in exactly the cases people cut out
 * (hair, fur, glass). A feature that is honestly absent beats one that is
 * quietly worse.
 */
export function fitsBudget(model, budgetBytes) {
  return budgetBytes >= model.bytes + DOCUMENT_HEADROOM_BYTES;
}

/**
 * Which models this device can run, keyed by role.
 *
 * @returns {SegmentModel[]}
 */
export function availableModels(budgetBytes) {
  return Object.values(MODELS).filter((m) => fitsBudget(m, budgetBytes));
}

/**
 * Can this device cut out a background at all?
 *
 * False means the base model does not fit. The brush still works -- it needs no
 * model -- so this gates the AUTOMATIC cut, not the whole feature. Callers that
 * conflate the two will hide the one part that runs everywhere.
 */
export const canSegment = (budgetBytes) => fitsBudget(MODELS[BASE], budgetBytes);

/**
 * The sentence shown where the button would have been.
 *
 * Returned rather than logged: a caveat that lives only in a console message is
 * a caveat the user never reads. Null when the feature is available, so the
 * caller can render `reason ?? nothing`.
 */
export function unavailableReason(budgetBytes) {
  if (canSegment(budgetBytes)) return null;
  const need = Math.ceil((MODELS[BASE].bytes + DOCUMENT_HEADROOM_BYTES) / MB);
  const have = Math.floor(budgetBytes / MB);
  return (
    `Automatic cut-out needs about ${need} MB of working memory and this device ` +
    `allows ${have} MB. You can still cut by hand with the brush.`
  );
}

/**
 * Total bytes a user would download by using everything here.
 *
 * Exists so the number can be asserted rather than quoted from memory in a
 * design document that then goes stale.
 */
export const totalDownloadBytes = () =>
  Object.values(MODELS).reduce((n, m) => n + m.bytes, 0);
