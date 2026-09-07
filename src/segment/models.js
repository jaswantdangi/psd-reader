/**
 * The model registry, and the rule for picking one that fits the device.
 *
 * Everything here is DATA plus two decision functions. No fetching, no
 * inference, no browser API -- so the choice is testable in Node and the app
 * cannot invent a second, differently-behaved copy of it.
 *
 * ## Every device gets an automatic cut
 *
 * An earlier version gated the feature off below 150 MB, because the best model
 * (BiRefNet_lite at fp16) is 115 MB and does not fit the 81.9 MB budget that
 * `memoryBudgetBytes()` hands unknown or <= 1.8 GB devices. That was the wrong
 * trade: it removed the headline feature from a large share of Android for a
 * quality difference most users would never see.
 *
 * There are smaller models with usable licences, so the rule is now "pick the
 * best one that fits" rather than "refuse below a line". `autoModel()` is that
 * rule and it always returns something -- the smallest entry here is 6.63 MB.
 *
 * ## Why licence sits in the table
 *
 * The two best-known browser options are unusable in a product that ships:
 * RMBG-1.4/2.0 is CC BY-NC (no commercial use) and @imgly/background-removal is
 * AGPL. Both score well and both would be picked by anyone comparing on quality
 * alone. Recording the licence next to the id is what stops that swap happening
 * in a hurry six months from now.
 *
 * ## Why sizes sit in the table
 *
 * `bytes` is not documentation, it is the number the consent prompt renders. A
 * user on mobile data is entitled to see the download before it starts.
 */

const MB = 1024 * 1024;

/** Best general cut. High-memory devices only. */
export const BASE = 'base';
/** General cut that fits a low-memory device. */
export const LITE = 'lite';
/** People, at full quality. */
export const PORTRAIT = 'portrait';
/** People, on anything at all. */
export const FEATHER = 'feather';
/** Point-prompted refinement -- a different question: "this object, not that one". */
export const CLICK = 'click';

/**
 * @typedef {object} SegmentModel
 * @property {string} id        Hugging Face repo.
 * @property {string} role      Key in MODELS.
 * @property {string} dtype     transformers.js dtype; selects the ONNX file.
 * @property {number} bytes     Transfer size of THAT file, not the repo.
 * @property {string} license
 * @property {'segment'|'point'} task
 * @property {'general'|'people'} subject
 * @property {number} rank      Higher is better output. Ties broken by size.
 * @property {string} label     Shown in the picker.
 * @property {string} purpose   Shown under the picker.
 */

/** @type {Record<string, SegmentModel>} */
export const MODELS = {
  [BASE]: {
    id: 'onnx-community/BiRefNet_lite-ONNX',
    role: BASE,
    dtype: 'fp16',
    bytes: 115 * MB,
    license: 'MIT',
    task: 'segment',
    subject: 'general',
    rank: 10,
    label: 'Sharp',
    purpose: 'Sharper edges, but only 16-bit weights exist — unverified on the CPU path. Try it; fall back to Standard if it errors.',
  },
  [PORTRAIT]: {
    id: 'onnx-community/BiRefNet-portrait-ONNX',
    role: PORTRAIT,
    dtype: 'fp16',
    bytes: 115 * MB,
    license: 'MIT',
    task: 'segment',
    subject: 'people',
    rank: 10,
    label: 'People',
    purpose: 'People, at 16-bit — same CPU-path caveat as Sharp.',
  },
  [LITE]: {
    /*
     * ormbg -- the Open Remove Background Model. Apache-2.0 on the weights,
     * with open training data, and explicitly built as the commercially-usable
     * answer to RMBG-1.4. Quantised to 8-bit it is 44.3 MB against fp16's 88.1,
     * which is what brings it inside the 81.9 MB budget once headroom is taken.
     *
     * Its card says it is optimised for images with humans. It still cuts
     * general subjects, less well than BiRefNet -- so it is the LOW-TIER
     * general model, not the preferred one, and `autoModel` only reaches it
     * when BiRefNet does not fit.
     */
    id: 'onnx-community/ormbg-ONNX',
    role: LITE,
    dtype: 'q8',
    bytes: 45 * MB,
    license: 'Apache-2.0',
    task: 'segment',
    subject: 'general',
    rank: 40,
    label: 'Standard',
    purpose: 'The default. 8-bit weights, so it runs everywhere.',
  },
  [FEATHER]: {
    /*
     * MODNet, quantised: 6.63 MB. Small enough that no realistic budget
     * excludes it, which is what makes it the floor -- `autoModel` can always
     * return SOMETHING, so no device is told the feature does not exist.
     *
     * Portrait matting only. On a non-human subject it will produce a confident
     * wrong answer rather than fail, so `subject` is checked before it is
     * offered as a general fallback.
     */
    id: 'Xenova/modnet',
    role: FEATHER,
    dtype: 'q8',
    bytes: 7 * MB,
    license: 'Apache-2.0',
    task: 'segment',
    subject: 'people',
    rank: 20,
    label: 'Light',
    purpose: 'Tiny and quick. People only — it will guess wrong on objects.',
  },
  [CLICK]: {
    /*
     * SlimSAM rather than SAM 3: SAM 3 ships under Meta's own licence, not
     * Apache-2.0, and adopting it would put a licence review on the critical
     * path of a feature that does not need one.
     */
    id: 'Xenova/slimsam-77-uniform',
    role: CLICK,
    /*
     * q8 (-> the `_quantized` files, 8.88 + 4.9 MB) rather than fp16 (12.2 +
     * 8.55). Two reasons, and the second is the load-bearing one:
     *
     *   1. SAM returns a BINARY mask. There is no soft edge for the extra
     *      precision to land in, so quantising costs approximately nothing.
     *   2. fp16 support on onnxruntime-web's WASM backend is patchy, and this
     *      model has to survive the CPU fallback -- a dtype that only works on
     *      the GPU would make the fallback fail for a second, unrelated reason.
     */
    dtype: 'q8',
    bytes: 14 * MB,
    license: 'Apache-2.0',
    task: 'point',
    subject: 'general',
    rank: 0,
    label: 'Tap',
    purpose: 'Tap an object to add it to or subtract it from the cut.',
  },
};

/**
 * Slack reserved for the decoded document while a model is resident.
 *
 * A cut runs against a proxy layer already on the heap, so the model is never
 * the only thing in memory. This is why the fit test is not `budget >= bytes`.
 */
export const DOCUMENT_HEADROOM_BYTES = 24 * MB;

export const fitsBudget = (model, budgetBytes) =>
  budgetBytes >= model.bytes + DOCUMENT_HEADROOM_BYTES;

/** Every model this device can run, best first. */
export function availableModels(budgetBytes, task = 'segment') {
  return Object.values(MODELS)
    .filter((m) => m.task === task && fitsBudget(m, budgetBytes))
    .sort((a, b) => b.rank - a.rank || a.bytes - b.bytes);
}

/**
 * The best model this device can run for a subject.
 *
 * Never returns null for `general`: the ranking ends at a 7 MB model, so the
 * only way to get nothing back is a budget under ~31 MB, which no device
 * reporting through `memoryBudgetBytes()` produces. Callers still handle null,
 * because "cannot happen" is not the same as "does not happen".
 *
 * A subject match does NOT automatically win. On a low-memory device the only
 * portrait model that fits is the 7 MB one, and the 45 MB general model is both
 * higher-ranked AND itself tuned on human data -- picking the portrait model
 * there purely because the labels matched would hand the user a worse cut for
 * the sake of a tidier rule. So the subject only breaks a tie between models of
 * equal rank; below that, rank wins.
 */
export function autoModel(budgetBytes, subject = 'general') {
  const usable = availableModels(budgetBytes);
  if (usable.length === 0) return null;
  const best = usable[0].rank;
  return (
    usable.find((m) => m.subject === subject && m.rank >= best)
    ?? usable[0]
  );
}

/**
 * Can this device cut out a background automatically?
 *
 * Effectively always true, and kept as a function rather than removed because
 * the answer is a property of the device rather than of this codebase -- a
 * future budget change should be able to make it false again without every
 * caller having to grow a check back.
 */
export const canSegment = (budgetBytes) => autoModel(budgetBytes) !== null;

/**
 * The sentence shown where the button would have been, or null.
 *
 * Returned rather than logged: a caveat that lives only in a console message is
 * one the user never reads.
 */
export function unavailableReason(budgetBytes) {
  if (canSegment(budgetBytes)) return null;
  return (
    `This device reports only ${Math.floor(budgetBytes / MB)} MB of working memory, ` +
    `which is below what the smallest cut-out model needs. You can still cut by hand ` +
    `with the brush.`
  );
}

/**
 * What this device gives up by not being able to run the best model.
 *
 * Null when it IS running the best one. Exists so the panel can be honest about
 * a quality difference the user cannot otherwise see -- without it, a soft edge
 * on a cheap phone reads as the feature being broken rather than as the model
 * that fitted.
 */
export function tierNote(budgetBytes) {
  const chosen = autoModel(budgetBytes);
  if (!chosen) return null;
  // Against the best-ranked model in the REGISTRY, not against a named one:
  // ranks have already been reordered once (when the CPU-only path made the
  // 8-bit model the default), and a hardcoded comparison silently stops
  // meaning anything the next time that happens.
  const best = Math.max(...Object.values(MODELS).filter((m) => m.task === 'segment').map((m) => m.rank));
  if (chosen.rank >= best) return null;
  return `Using the ${chosen.label} model (${Math.round(chosen.bytes / MB)} MB) — this device does not have room for a larger one.`;
}

export const totalDownloadBytes = () =>
  Object.values(MODELS).reduce((n, m) => n + m.bytes, 0);
