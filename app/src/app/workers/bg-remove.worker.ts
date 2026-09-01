/// <reference lib="webworker" />
/**
 * Segmentation inference, off the main thread.
 *
 * Follows psd-decode.worker.ts: one `message` listener, progress posted as it
 * goes, buffers transferred rather than copied. The reason it is a worker at
 * all is the same reason decode is -- a 115 MB model and a one-to-three second
 * inference would otherwise freeze the canvas mid-gesture.
 *
 * ## What this file does NOT do
 *
 * No mask arithmetic, no refinement, no compositing. It returns the model's
 * raw output and its dimensions; src/segment/cutout.js turns that into a mask.
 * Keeping the split there is what lets every pixel decision be tested in Node
 * without a GPU, a network, or a 115 MB download.
 */
import {
  AutoModel, AutoProcessor, SamModel, RawImage, env,
} from '@huggingface/transformers';

/*
 * Models are fetched from the Hugging Face CDN and cached by the browser. No
 * local model files are bundled: adding 115 MB to the app bundle would make
 * every user pay for a feature most never open, which is the same "expensive by
 * default" mistake as preloading a grid's whole dataset to make sorting fast.
 */
env.allowLocalModels = false;

type Loaded = { model: any; processor: any };

/**
 * One cache entry per model id, holding the PROMISE rather than the result.
 *
 * Two cuts fired before the first finishes -- entirely normal when someone taps
 * twice -- would otherwise start two 115 MB downloads. Caching the in-flight
 * promise makes the second caller await the first.
 */
const loaded = new Map<string, Promise<Loaded>>();

/**
 * WebGPU where it exists, WASM everywhere else.
 *
 * Deliberately not asserted at build time: WebGPU availability varies by
 * browser, OS and driver, and the fallback has to be a runtime decision made on
 * the device rather than a guess made here.
 *
 * The WASM path is SINGLE-THREADED in this app, and that is a consequence of a
 * decision made elsewhere: multi-threaded onnxruntime-web needs
 * SharedArrayBuffer, which needs COOP/COEP headers, which app/public/_headers
 * deliberately does not set because nothing else here uses shared memory. So
 * the fallback is correct but slow, and the UI should say "this will take a
 * moment" rather than appear hung.
 */
async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as any).gpu;
  if (!gpu) return 'wasm';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

function load(id: string, task: string, dtype: string): Promise<Loaded> {
  const key = `${id}#${dtype}`;
  const existing = loaded.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const device = await pickDevice();
    const options: any = {
      dtype,
      device,
      // Forwarded straight through: a 115 MB download with no bar is
      // indistinguishable from a hang on a phone.
      progress_callback: (p: any) => {
        if (p?.status === 'progress' && p.total)
          postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
      },
    };
    const Model = task === 'point' ? SamModel : AutoModel;
    const [model, processor] = await Promise.all([
      Model.from_pretrained(id, options),
      AutoProcessor.from_pretrained(id),
    ]);
    postMessage({ type: 'ready', id, device });
    return { model, processor };
  })();

  loaded.set(key, promise);
  // A failed download must not poison the cache -- otherwise a dropped
  // connection makes the feature permanently broken for the session.
  promise.catch(() => loaded.delete(key));
  return promise;
}

/**
 * Run the segmentation model and hand back its raw output plane.
 *
 * The input and output tensor NAMES differ between the BiRefNet exports and are
 * not something this file can settle without running against the real files --
 * so it probes rather than asserts. This is the one place in the pipeline that
 * is genuinely unverified until it executes on a device; everything downstream
 * takes a plain array and is testable in Node.
 */
async function segment(pixels: ImageDataLike, id: string, dtype: string) {
  const { model, processor } = await load(id, 'segment', dtype);
  const image = new RawImage(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height, 4);
  const inputs = await processor(image);

  const names: string[] = model?.sessions?.model?.inputNames ?? [];
  const key = names.find((n) => n.includes('image') || n.includes('pixel')) ?? 'input_image';
  let out: any;
  try {
    out = await model({ [key]: inputs.pixel_values });
  } catch {
    // Second guess, then let it throw: an error naming the real input is far
    // more useful to whoever debugs this than a third silent attempt.
    out = await model({ pixel_values: inputs.pixel_values });
  }

  // The first tensor in the output, whatever it is called. BiRefNet exports
  // publish a single output; picking it by position rather than by name is what
  // keeps this working across the four variants in the registry.
  const tensor: any = Object.values(out).find((v: any) => v?.dims && v?.data) ?? Object.values(out)[0];
  const dims: number[] = tensor.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];

  /*
   * Sigmoid here rather than in the engine. The export emits logits, and the
   * engine's resampleLogits deliberately accepts either 0..1 or 0..255 without
   * knowing which model produced them -- squashing at the boundary is what
   * keeps that contract honest instead of leaking a model detail inland.
   */
  const raw: any = tensor.data;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = 1 / (1 + Math.exp(-raw[i]));

  return { data, width, height };
}

/** Point-prompted mask, for tap-to-add and tap-to-subtract. */
async function point(pixels: ImageDataLike, id: string, dtype: string, points: Pt[], labels: number[]) {
  const { model, processor } = await load(id, 'point', dtype);
  const image = new RawImage(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height, 4);
  const inputs = await processor(image);

  const outputs = await model({
    ...inputs,
    input_points: [[points.map((p) => [p.x, p.y])]],
    // 1 = include this object, 0 = exclude it. SlimSAM takes both, which is
    // what makes a single model serve add AND subtract.
    input_labels: [[labels]],
  });
  const masks = await processor.post_process_masks(
    outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes,
  );

  const m: any = masks[0];
  const dims: number[] = m.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  // SAM returns three candidate masks ranked by predicted IoU. Take the
  // best-scoring one rather than the first -- they are not in score order.
  const scores: any = outputs.iou_scores?.data ?? [1];
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const plane = m.data.subarray(best * width * height, (best + 1) * width * height);

  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = plane[i] ? 1 : 0;
  return { data, width, height };
}

interface ImageDataLike { data: Uint8ClampedArray; width: number; height: number }
interface Pt { x: number; y: number }

addEventListener('message', async ({ data: msg }) => {
  const { requestId, kind, pixels, modelId, dtype, points, labels } = msg;
  try {
    const result = kind === 'point'
      ? await point(pixels, modelId, dtype, points, labels)
      : await segment(pixels, modelId, dtype);
    postMessage({ type: 'done', requestId, ...result }, [result.data.buffer]);
  } catch (error: any) {
    postMessage({ type: 'error', requestId, message: error?.message ?? String(error) });
  }
});
