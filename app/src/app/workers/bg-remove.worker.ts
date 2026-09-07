/// <reference lib="webworker" />
/**
 * Segmentation inference, off the main thread.
 *
 * Follows psd-decode.worker.ts: one `message` listener, progress posted as it
 * goes. The reason it is a worker at all is the same reason decode is -- a
 * model download and a one-to-three second inference would otherwise freeze the
 * canvas mid-gesture.
 *
 * ## Why the pipeline and not AutoModel
 *
 * An earlier version drove `AutoModel` directly and had to GUESS the input and
 * output tensor names, because they differ between the BiRefNet, ormbg and
 * MODNet exports and nothing in the repo could settle them without running.
 * transformers.js 3.8 ships a `background-removal` pipeline that owns exactly
 * that mapping, per model, upstream. Using it deletes the guess rather than
 * hiding it, and is the reason four different architectures can share one code
 * path here.
 *
 * ## What this file does NOT do
 *
 * No mask arithmetic, no refinement, no compositing. It returns a coverage
 * plane and its dimensions; src/segment/cutout.js turns that into a layer mask.
 * Keeping the split there is what lets every pixel decision be tested in Node
 * without a GPU, a network, or a model download.
 */
import {
  pipeline, SamModel, AutoProcessor, RawImage, env,
} from '@huggingface/transformers';

/*
 * Models come from the Hugging Face CDN and are cached by the browser. Nothing
 * is bundled: adding even the 7 MB model to the app bundle would make every
 * user pay for a feature most never open.
 */
env.allowLocalModels = false;

const segmenters = new Map<string, Promise<any>>();
const samModels = new Map<string, Promise<{ model: any; processor: any }>>();

/**
 * WebGPU where it exists, WASM everywhere else.
 *
 * A runtime decision on the device, never a build-time one: WebGPU
 * availability varies by browser, OS and driver.
 *
 * The WASM path is SINGLE-THREADED here, and that follows from a decision made
 * elsewhere -- multi-threaded onnxruntime-web needs SharedArrayBuffer, which
 * needs COOP/COEP, which app/public/_headers deliberately does not set. So the
 * fallback is correct but slow, and the UI says so rather than looking hung.
 */
async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  /*
   * WebGPU is DISABLED, deliberately, and this is not a stub.
   *
   * onnxruntime-web's WebGPU execution provider does not implement every ONNX
   * operator its WASM one does. The one that stops us is
   *
   *   "using ceil() in shape computation is not yet supported for MaxPool"
   *
   * which every U^2-Net / ISNet-family decoder uses -- ormbg and MODNet both
   * carry `MaxPool` with `ceil_mode=1`. Two attempts to catch that and fall
   * back to the CPU both failed in the browser, and the reason they failed is
   * the honest problem here: nothing in this repo can execute WebGPU, so every
   * fix aimed at it was written blind and shipped unverified.
   *
   * The WASM backend has the full kernel set and is the path that has actually
   * been observed to produce correct masks. Choosing it unconditionally trades
   * speed for a feature that works, which is the right way round.
   *
   * To re-enable: confirm ONE model runs on WebGPU on a real device, then gate
   * it per-model in `src/segment/models.js` rather than restoring a blanket
   * `requestAdapter()` check -- the capability is per-operator, not per-device,
   * so asking the adapter whether it exists never answered the right question.
   */
  return 'wasm';
}

/**
 * Build a model on the best device, dropping to WASM when WebGPU refuses it.
 *
 * onnxruntime-web's WebGPU execution provider does not implement every ONNX
 * operator its WASM one does. The one that bites here is
 *
 *   "using ceil() in shape computation is not yet supported for MaxPool"
 *
 * which every U^2-Net / ISNet-family decoder trips — ormbg and MODNet both use
 * `MaxPool` with `ceil_mode=1`. It surfaces when the session is created, not
 * when it runs, so it kills the load rather than the inference.
 *
 * There is no capability query for this: the only way to learn that a given
 * model cannot run on this device's WebGPU is to try. So try, and on ANY
 * failure rebuild on WASM, which has the full kernel set. WASM is slower and
 * single-threaded here, which is why the fallback is REPORTED rather than
 * silent — a 20-second cut with no explanation reads as a hang.
 *
 * Deliberately catches everything, not just this message. The failure modes of
 * a GPU backend across drivers are not enumerable, and every one of them has
 * the same correct answer.
 */
async function buildOn<T>(make: (device: string) => Promise<T>, id: string): Promise<{ value: T; device: string }> {
  const preferred = forcedWasm.has(id) ? 'wasm' : await pickDevice();
  return { value: await make(preferred), device: preferred };
}

/**
 * Models this session has proved cannot run on WebGPU.
 *
 * Keyed by model id, not by session: once a model has failed on the GPU it will
 * fail again for the same reason, and retrying the GPU on every tap would make
 * each one pay the failure twice.
 */
const forcedWasm = new Set<string>();

/**
 * Run an operation, and if WebGPU cannot do it, rebuild on WASM and run again.
 *
 * This wraps the whole LOAD-AND-RUN, not just the load, and that is the point.
 * onnxruntime-web compiles WebGPU kernels lazily, so an unsupported operator
 * does not necessarily fail when the session is created -- it can fail on the
 * first inference, which is where
 *
 *   "using ceil() in shape computation is not yet supported for MaxPool"
 *
 * actually surfaced. An earlier version of this guarded only construction and
 * therefore caught nothing.
 *
 * The cached model is evicted before the retry, because the cached one is bound
 * to the GPU session that just failed; reusing it would fail identically.
 */
async function withCpuFallback<T>(id: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: any) {
    // Already on the CPU: this is a real failure, not a backend limitation.
    if (forcedWasm.has(id)) throw error;

    forcedWasm.add(id);
    for (const key of [...segmenters.keys()]) if (key.startsWith(id + '#')) segmenters.delete(key);
    for (const key of [...samModels.keys()]) if (key.startsWith(id + '#')) samModels.delete(key);

    postMessage({ type: 'fallback', id, message: error?.message ?? String(error) });
    return await run();
  }
}

function optionsFor(device: string, dtype: string) {
  return {
    device,
    dtype,
    // Forwarded straight through: a 45-115 MB download with no bar is
    // indistinguishable from a hang on a phone.
    progress_callback: (p: any) => {
      if (p?.status === 'progress' && p.total)
        postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
    },
  } as any;
}

/**
 * One cache entry per model, holding the PROMISE rather than the result.
 *
 * Two cuts fired before the first finishes -- normal when someone taps twice --
 * would otherwise start two downloads of the same file.
 */
function segmenterFor(id: string, dtype: string): Promise<any> {
  const key = `${id}#${dtype}`;
  const existing = segmenters.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const { value, device } = await buildOn(
      (d) => pipeline('background-removal', id, optionsFor(d, dtype)) as Promise<any>,
      id,
    );
    postMessage({ type: 'ready', id, device });
    return value;
  })();

  segmenters.set(key, promise);
  // A failed download must not poison the cache, or one dropped connection
  // breaks the feature for the rest of the session.
  promise.catch(() => segmenters.delete(key));
  return promise;
}

function samFor(id: string, dtype: string) {
  const key = `${id}#${dtype}`;
  const existing = samModels.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const { value, device } = await buildOn(async (d) => {
      const [model, processor] = await Promise.all([
        SamModel.from_pretrained(id, optionsFor(d, dtype)),
        AutoProcessor.from_pretrained(id),
      ]);
      return { model, processor };
    }, id);
    postMessage({ type: 'ready', id, device });
    return value;
  })();

  samModels.set(key, promise);
  promise.catch(() => samModels.delete(key));
  return promise;
}

const toImage = (p: ImageDataLike) =>
  new RawImage(new Uint8ClampedArray(p.data), p.width, p.height, 4);

/**
 * Run the segmentation model and hand back its coverage plane.
 *
 * The pipeline returns the image with its background removed -- so the mask we
 * want is the ALPHA channel of that result, already at the input's own size and
 * already post-processed by whatever that model needs. Reading channel 3 is the
 * whole extraction; no sigmoid, no transpose, no name guessing.
 */
async function segment(pixels: ImageDataLike, id: string, dtype: string) {
  const segmenter = await segmenterFor(id, dtype);
  const result = await segmenter(toImage(pixels));

  // The pipeline returns an array of RawImage, one per input.
  const image: any = Array.isArray(result) ? result[0] : result;
  const { width, height, channels } = image;
  const src: Uint8ClampedArray = image.data;

  const data = new Uint8Array(width * height);
  if (channels === 4) {
    for (let i = 0; i < data.length; i++) data[i] = src[i * 4 + 3];
  } else if (channels === 1) {
    // Some builds return the mask itself rather than a cut-out image. Both are
    // a coverage plane; only the stride differs.
    data.set(src.subarray(0, data.length));
  } else {
    throw new Error(`unexpected ${channels}-channel result from ${id}`);
  }
  return { data, width, height };
}

/** Point-prompted mask, for tap-to-add and tap-to-subtract. */
async function point(
  pixels: ImageDataLike, id: string, dtype: string, points: Pt[], labels: number[],
) {
  const { model, processor } = await samFor(id, dtype);
  const inputs = await processor(toImage(pixels));

  const outputs = await model({
    ...inputs,
    input_points: [[points.map((p) => [p.x, p.y])]],
    // 1 = include this object, 0 = exclude it — which is what lets one model
    // serve both add and subtract.
    input_labels: [[labels]],
  });
  const masks = await processor.post_process_masks(
    outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes,
  );

  const m: any = masks[0];
  const dims: number[] = m.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];

  // SAM returns three candidate masks with predicted IoU scores. Take the
  // best-scoring one rather than the first — they are not in score order.
  const scores: any = outputs.iou_scores?.data ?? [1];
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const plane = m.data.subarray(best * width * height, (best + 1) * width * height);

  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = plane[i] ? 255 : 0;
  return { data, width, height };
}

interface ImageDataLike { data: Uint8ClampedArray; width: number; height: number }
interface Pt { x: number; y: number }

addEventListener('message', async ({ data: msg }) => {
  const { requestId, kind, pixels, modelId, dtype, points, labels } = msg;
  try {
    // The fallback wraps load AND inference — see withCpuFallback.
    const result = await withCpuFallback(modelId, () => (kind === 'point'
      ? point(pixels, modelId, dtype, points, labels)
      : segment(pixels, modelId, dtype)));
    postMessage({ type: 'done', requestId, ...result }, [result.data.buffer]);
  } catch (error: any) {
    postMessage({ type: 'error', requestId, message: error?.message ?? String(error) });
  }
});
