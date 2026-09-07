import { Injectable, computed, inject, signal } from '@angular/core';
import { ProjectService } from './project.service';
import {
  MODELS, CLICK, autoModel, availableModels, canSegment, unavailableReason, tierNote,
  buildCutout, applyCutout, paintMask, clearCutout, exportSoftnessNote,
  setMaskEdge, normaliseEdge, NEUTRAL_EDGE,
} from '@engine/segment/index.js';
import { memoryBudgetBytes } from '@engine/budget.js';

/**
 * Owns the segmentation worker, the model downloads, and the consent for them.
 *
 * Nothing about mask arithmetic is decided here. Resampling, refinement,
 * decontamination and the undo command are all the engine's; this owns the
 * worker's lifetime, the progress signals, and the one thing the engine cannot
 * do -- asking before spending 115 MB of someone's mobile data.
 */

/** Roles the user can pick a model for. Mirrors the engine registry. */
export type CutModel = 'base' | 'portrait' | 'lite' | 'feather';

@Injectable({ providedIn: 'root' })
export class SegmentService {
  /** True while an inference or a download is in flight. */
  readonly running = signal(false);
  readonly note = signal('');
  readonly failed = signal(false);

  /** 0..100 for the model download; -1 when nothing is downloading. */
  readonly downloadPercent = signal(-1);
  /** Which model ids this session has already fetched, so consent is asked once. */
  readonly fetched = signal<string[]>([]);
  /** 'webgpu' | 'wasm' | '' — shown, because the wasm path is much slower. */
  readonly device = signal('');
  /**
   * True when WebGPU was available but could not run the model.
   *
   * Distinct from `device() === 'wasm'` on a machine with no WebGPU at all:
   * that is a property of the device, this is a property of the MODEL, and the
   * user's options differ. A different model may well run on the GPU.
   */
  readonly gpuRefused = signal(false);

  /**
   * The armed canvas tool, or '' for none.
   *
   * This is the whole arbitration rule, and it lives here rather than in the
   * canvas because two things need it: the panel, which sets it, and the stage,
   * which reads it on every pointer-down. While it is set the stage hands
   * single-pointer events to this service INSTEAD of the move/resize gestures;
   * while it is '' the stage behaves exactly as it did before this feature
   * existed. Two-finger pinch and zoom are never intercepted — losing the
   * ability to zoom while pointing at something you want to cut would make the
   * tool unusable on the small edges it exists for.
   *
   *   'keep'    tap an object to ADD it to the cut       (needs the SAM model)
   *   'remove'  tap an object to SUBTRACT it             (needs the SAM model)
   *   'erase'   brush the mask away                      (no model)
   *   'restore' brush the mask back                      (no model)
   */
  readonly tool = signal<'' | 'keep' | 'remove' | 'erase' | 'restore'>('');
  /** Brush geometry, owned here so the stage does not have to be told twice. */
  readonly brushRadius = signal(24);
  readonly brushHardness = signal(0.5);

  /** True when the armed tool paints rather than prompts a model. */
  readonly isBrush = computed(() => this.tool() === 'erase' || this.tool() === 'restore');

  /**
   * The memory budget this device reports, read ONCE.
   *
   * `memoryBudgetBytes()` is two-valued and derived from `deviceMemory`, which
   * does not change while the tab is open. Reading it per call would invite a
   * caller to believe it might.
   */
  private readonly budget = memoryBudgetBytes();

  /** Null when automatic cut-out is available; a sentence when it is not. */
  readonly unavailable = computed(() => unavailableReason(this.budget));
  readonly canCut = computed(() => canSegment(this.budget));

  /** Which models this device can actually run, best first — the picker's source. */
  readonly choices = computed(() => availableModels(this.budget));

  /**
   * Said out loud when this device cannot run the sharpest model.
   *
   * Without it a softer edge on a cheap phone reads as the feature being
   * broken, rather than as the model that fitted the memory available.
   */
  readonly tier = computed(() => tierNote(this.budget));

  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  private readonly projects = inject(ProjectService);

  /**
   * Tell the UI the document changed.
   *
   * The engine mutates the project object IN PLACE, so the `project` signal's
   * reference is identical before and after a cut and nothing derived from it
   * re-runs on its own. Every mutating method in ProjectService ends with this
   * same bump; a cut that skips it applies correctly and appears to do nothing,
   * which is the worst way for this to fail.
   */
  private touch(): void {
    this.projects.version.update((v) => v + 1);
  }

  /**
   * Bytes a role would cost if used now.
   *
   * Zero once fetched: the browser has it cached, so the consent prompt must
   * stop asking. Quoting the download a second time trains people to dismiss it.
   */
  costOf(role: string): number {
    const model = (MODELS as any)[role];
    if (!model) return 0;
    return this.fetched().includes(model.id) ? 0 : model.bytes;
  }

  /** Cut the background from one layer. */
  async cut(
    project: any,
    layerId: number,
    options: { role?: CutModel; mode?: string; subject?: string } = {},
  ) {
    const layer = project.layers.find((l: any) => l.id === layerId);
    if (!layer?.pixels) return;

    /*
     * No role given means "the best one that fits this device" — the normal
     * path, and the reason a low-memory phone gets a cut at all instead of the
     * feature being hidden. An explicit role is the user overriding that from
     * the picker.
     */
    const model = options.role
      ? (MODELS as any)[options.role]
      : autoModel(this.budget, options.subject ?? 'general');
    if (!model) {
      this.failed.set(true);
      this.note.set(this.unavailable() ?? 'No cut-out model fits this device.');
      return;
    }

    this.running.set(true);
    this.failed.set(false);
    this.note.set('');
    try {
      const out = await this.ask({
        kind: 'segment',
        pixels: this.copyPixels(layer.pixels),
        modelId: model.id,
        dtype: model.dtype,
      });

      /*
       * The engine does every pixel decision from here: resample onto the
       * layer's grid, guided-filter the edge onto the real one, then solve for
       * the foreground colour so the old background stops bleeding through.
       */
      const cut = buildCutout(out.data, out.width, out.height, layer.pixels);
      if (cut.empty) {
        this.note.set('Nothing found to cut out. Try the brush, or tap the subject to point at it.');
        return;
      }
      applyCutout(project, layerId, cut, { mode: options.mode ?? 'replace' });
      this.touch();
      this.note.set(`Cut out ${Math.round(cut.coverage * 100)}% of the layer.`);
    } catch (error: any) {
      this.failed.set(true);
      this.note.set(error?.message ?? String(error));
    } finally {
      this.running.set(false);
      this.downloadPercent.set(-1);
    }
  }

  /**
   * Add or subtract the object under a tap.
   *
   * `add` composes with the existing mask rather than replacing it, which is
   * the entire point: the base model got most of it and this is the correction.
   */
  async pointAt(project: any, layerId: number, x: number, y: number, add = true) {
    const layer = project.layers.find((l: any) => l.id === layerId);
    if (!layer?.pixels) return;
    const model = (MODELS as any)[CLICK];

    this.running.set(true);
    this.failed.set(false);
    try {
      const out = await this.ask({
        kind: 'point',
        pixels: this.copyPixels(layer.pixels),
        modelId: model.id,
        dtype: model.dtype,
        points: [{ x, y }],
        labels: [1],
      });
      const cut = buildCutout(out.data, out.width, out.height, layer.pixels, {
        // SAM returns a hard binary mask, so there is no soft edge for the
        // guided filter to pull onto anything -- but decontamination still has
        // nothing to do either, since no pixel is partly transparent. Refine
        // only, at a small radius, to take the staircase off the boundary.
        decontaminate: false,
        radius: 2,
      });
      applyCutout(project, layerId, cut, { mode: add ? 'add' : 'subtract' });
      this.touch();
    } catch (error: any) {
      this.failed.set(true);
      this.note.set(error?.message ?? String(error));
    } finally {
      this.running.set(false);
      this.downloadPercent.set(-1);
    }
  }

  /**
   * Canvas coordinates -> the layer's own pixel grid.
   *
   * `layer.x/y/w/h` are the layer's CURRENT placement, which a resize can have
   * moved away from its source dimensions — so the mapping has to go through
   * the ratio rather than assume they agree. Returns null when the point is
   * outside the layer, so a tap on empty canvas does not paint at a clamped
   * edge pixel and look like a bug.
   */
  private toLayerPixel(layer: any, x: number, y: number) {
    if (!layer?.pixels || !layer.w || !layer.h) return null;
    const px = ((x - layer.x) / layer.w) * layer.pixels.width;
    const py = ((y - layer.y) / layer.h) * layer.pixels.height;
    if (px < 0 || py < 0 || px >= layer.pixels.width || py >= layer.pixels.height) return null;
    return { x: px, y: py };
  }

  /** A tap with the keep/remove tool armed. Canvas coordinates. */
  async tapAt(project: any, layerId: number, x: number, y: number) {
    const layer = project?.layers.find((l: any) => l.id === layerId);
    const point = this.toLayerPixel(layer, x, y);
    if (!point) return;
    await this.pointAt(project, layerId, point.x, point.y, this.tool() !== 'remove');
  }

  /** A brush stroke with the erase/restore tool armed. Canvas coordinates. */
  strokeAt(project: any, layerId: number, path: { x: number; y: number }[]) {
    const layer = project?.layers.find((l: any) => l.id === layerId);
    if (!layer) return;
    const points = path
      .map((p) => this.toLayerPixel(layer, p.x, p.y))
      .filter((p): p is { x: number; y: number } => p !== null);
    if (points.length === 0) return;

    // Scale the brush from canvas units into the layer's pixel grid, so the dab
    // is the size the user saw under their finger rather than the size the
    // slider happens to say.
    const scale = layer.pixels.width / layer.w;
    this.paint(project, layerId, points, {
      radius: Math.max(1, this.brushRadius() * scale),
      hardness: this.brushHardness(),
      erase: this.tool() === 'erase',
    });
  }

  /**
   * Paint the mask by hand. No model, no download, no budget gate.
   *
   * This is the path that works on every device, including the ones where
   * `canCut()` is false — so it must never be hidden behind the same check.
   */
  paint(project: any, layerId: number, points: any[], options: any) {
    paintMask(project, layerId, points, options);
    this.touch();
  }

  /**
   * Change one edge control.
   *
   * `coalesceKey` collapses a whole slider drag into one undo step, the same way
   * a layer drag is one — without it a single sweep of the feather slider would
   * bury everything before it under fifty history entries.
   */
  setEdge(project: any, layerId: number, patch: any, coalesceKey?: string) {
    setMaskEdge(project, layerId, patch, coalesceKey);
    this.touch();
  }

  /** The current recipe for a layer, or the neutral one. */
  edgeOf(project: any, layerId: number) {
    const layer = project?.layers.find((l: any) => l.id === layerId);
    return normaliseEdge(layer?.mask?.edge);
  }

  clear(project: any, layerId: number) {
    clearCutout(project, layerId);
    this.touch();
  }

  /** The export disclosure, or null. @see exportSoftnessNote */
  softnessNote(project: any, proxyScale: number): string | null {
    return exportSoftnessNote(project, proxyScale);
  }

  /**
   * A structured clone of the layer's pixels for the worker.
   *
   * Copied rather than transferred, unlike the decode worker: `layer.pixels` is
   * the ORIGINAL decoded buffer and the whole editor treats it as immutable
   * source. Transferring it would detach it here, and every subsequent render
   * of that layer would read a zero-length array.
   */
  private copyPixels(pixels: any) {
    return {
      data: new Uint8ClampedArray(pixels.data),
      width: pixels.width,
      height: pixels.height,
    };
  }

  private ask(message: any): Promise<any> {
    const worker = this.ensureWorker();
    const requestId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ ...message, requestId });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/bg-remove.worker', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = ({ data }) => {
      if (data.type === 'download') {
        this.downloadPercent.set(Math.round((data.loaded / data.total) * 100));
        return;
      }
      if (data.type === 'fallback') {
        /*
         * WebGPU refused this model and it is being rebuilt on the CPU. Shown
         * rather than logged: the visible consequence is that the cut takes
         * several times longer, and a user who is not told why will read that
         * as the app hanging. The operator name is kept in the sentence because
         * it is the one detail that makes the cause searchable.
         */
        this.gpuRefused.set(true);
        return;
      }
      if (data.type === 'ready') {
        this.device.set(data.device);
        this.downloadPercent.set(-1);
        if (!this.fetched().includes(data.id)) this.fetched.update((ids) => [...ids, data.id]);
        return;
      }
      const waiting = this.pending.get(data.requestId);
      if (!waiting) return;
      this.pending.delete(data.requestId);
      if (data.type === 'error') waiting.reject(new Error(data.message));
      else waiting.resolve(data);
    };
    /*
     * A worker that dies takes every in-flight request with it. Rejecting them
     * explicitly is what turns "the button stopped responding" into a message,
     * and it is the failure people actually hit -- an out-of-memory kill on a
     * phone terminates the worker without ever posting an error.
     */
    worker.onerror = (event) => {
      for (const [, waiting] of this.pending)
        waiting.reject(new Error(event.message || 'The cut-out worker stopped.'));
      this.pending.clear();
      this.worker = null;
      this.running.set(false);
    };
    this.worker = worker;
    return worker;
  }
}
