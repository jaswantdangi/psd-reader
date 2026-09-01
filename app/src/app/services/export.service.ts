import { Injectable, computed, inject, signal } from '@angular/core';
import { FontsService } from './fonts.service';

/**
 * Human sentences for the engine's phase names.
 *
 * Display metadata only — the names, their order and their weights all come
 * from `EXPORT_PHASES`, so a phase the engine adds shows its own id here rather
 * than disappearing from the readout.
 */
const PHASE_LABELS: Record<string, string> = {
  read: 'Reading the original file',
  parse: 'Parsing the document',
  layers: 'Decoding layers at full resolution',
  drain: 'Blending parked layers',
  readback: 'Reading back the composite',
  encode: 'Encoding the PNG',
  write: 'Saving',
};

/**
 * Runs `exportFullRes` in a worker and publishes what it is doing.
 *
 * Nothing about export is decided here. The walk, the ordering, the spill
 * arithmetic, the phase weights and the PNG are all the engine's; this owns the
 * worker's lifetime, the progress signals, and handing the finished Blob to the
 * browser.
 */
@Injectable({ providedIn: 'root' })
export class ExportService {
  readonly running = signal(false);
  readonly phase = signal('');
  readonly percent = signal(0);
  /** False during `parse` and `encode`, which have no interior yield point. */
  readonly determinate = signal(true);
  /** `12 of 48 layers`, when the phase has honest interior granularity. */
  readonly detail = signal('');
  /** The last outcome — a saved filename and size, or a failure message. */
  readonly note = signal('');
  readonly failed = signal(false);
  /** True when the spill had to fall back to the heap. Shown, not hidden. */
  readonly spilledToMemory = signal(false);

  readonly phaseLabel = computed(() => PHASE_LABELS[this.phase()] ?? this.phase());

  private fonts = inject(FontsService);

  private worker: Worker | null = null;

  /**
   * @param project the live project. Only its geometry crosses to the worker.
   * @param file    the original file, still a Blob handle on disk.
   */
  start(project: any, file: File): void {
    if (this.running()) return;

    this.running.set(true);
    this.failed.set(false);
    this.note.set('');
    this.spilledToMemory.set(false);
    this.phase.set('read');
    this.percent.set(0);
    this.determinate.set(true);
    this.detail.set('');

    const worker = new Worker(new URL('../workers/psd-export.worker', import.meta.url));
    this.worker = worker;

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        this.phase.set(data.phase);
        this.determinate.set(!!data.determinate);
        this.percent.set(Math.round((data.fraction ?? 0) * 100));
        this.detail.set(
          data.determinate && data.total > 1 ? `${data.done} of ${data.total}` : '',
        );
        return;
      }

      this.stop();
      if (data.type === 'done') {
        this.spilledToMemory.set(data.spill === 'memory');
        this.save(data.blob as Blob, this.pngNameFor(project), data.width, data.height);
      } else {
        this.fail(data.message || 'Export failed.');
      }
    };

    worker.onerror = (event) => {
      this.stop();
      this.fail(event.message || 'The export worker failed to start.');
    };

    // A worker killed mid-export — the memory failure this pipeline exists to
    // avoid — often raises no `error` event. Without this the sheet would sit
    // on a frozen bar forever, which reads exactly like a slow export.
    worker.onmessageerror = () => {
      this.stop();
      this.fail('Export failed: the worker stopped responding.');
    };

    // The worker has its OWN FontFaceSet — a face added to document.fonts is
    // invisible to it, and it is the worker that rasterises re-drawn text at
    // full resolution. Without these the PNG comes back in the substitute while
    // the screen shows the real typeface. Files cross by reference, so this
    // costs a handle, not the font bytes.
    worker.postMessage({ project: this.payloadFor(project), file, fonts: this.fonts.fontFiles() });
  }

  /**
   * Terminate, immediately.
   *
   * The engine's own `{cancelled}` signal cannot be delivered on the fast path
   * — see the worker's header — so this is the only cancellation that is real.
   * It drops the worker's whole heap; the spill directory it may leave behind
   * is wiped by the next export's setup.
   */
  cancel(): void {
    if (!this.running()) return;
    this.stop();
    this.note.set('Export cancelled. Nothing was written.');
    this.failed.set(false);
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.running.set(false);
  }

  private fail(message: string): void {
    this.failed.set(true);
    this.note.set(message);
  }

  /**
   * What crosses to the worker.
   *
   * `layer.pixels` is dropped, for two reasons and not one.
   *
   * MEMORY: structured clone COPIES every typed array it carries, so shipping
   * the proxy pixels would duplicate the editor's entire resident bitmap set at
   * the exact moment the worker is about to allocate a document-sized buffer.
   * Geometry, masks and text are kilobytes; the pixels are the whole document.
   *
   * CORRECTNESS: export must never draw a proxy pixel. `target.blend` calls
   * `drawLayerInto` with `pixels` explicitly present in its options, and
   * `drawLayerInto` reads it with `in` — so `layer.pixels` is never consulted on
   * the export path. Sending it anyway would leave the door open to the one
   * failure `stream.js` names as the worst available: a full-size image quietly
   * upscaled from the proxy, which looks like it worked. Dropping it turns that
   * into a layer that is visibly absent.
   */
  private payloadFor(project: any): any {
    return {
      ...project,
      layers: project.layers.map((layer: any) => ({ ...layer, pixels: null })),
    };
  }

  private pngNameFor(project: any): string {
    return String(project.fileName ?? 'export').replace(/\.psd$|\.psb$/i, '') + '.png';
  }

  private save(blob: Blob, name: string, width: number, height: number): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();

    // NOT revoked on the next line. A full-resolution PNG is tens of megabytes
    // and the browser has only been asked to start the download — revoking
    // synchronously can cancel it before a byte is written. The delay is the
    // price of the save actually happening.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    this.note.set(`Saved ${name} · ${width} × ${height} · ${megabytes(blob.size)}`);
  }
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
