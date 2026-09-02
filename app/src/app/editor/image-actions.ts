import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ProjectService } from '../services/project.service';

/**
 * What the OS picker offers. MIME types AND extensions: an Android picker
 * handed only MIME types hides files whose type the content provider failed to
 * report, and a user whose photo is greyed out has no way to know why.
 */
const IMPORT_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

/**
 * Longest edge, in pixels, an imported picture is decoded to.
 *
 * THIS NUMBER IS THE EXPORT RESOLUTION, not a preview cap, and that is why it
 * needs justifying rather than copying from `DEFAULT_PROXY_EDGE`.
 *
 * Every layer read from the PSD is held at 1024 on the long edge and re-read
 * from the file at full size when the document is exported. An imported
 * picture has no file to re-read: `insertImageLayer` stamps `selfSupplied`,
 * and `src/export/target-js.js` blends exactly this buffer at scale 1. So
 * whatever is decoded here is what ships.
 *
 * Both ends of the range are wrong:
 *
 *   1024 (the proxy edge) — costs 4 MB and matches the resident layers
 *         exactly, but a picture placed across a 6000 px poster exports at 17%
 *         of document scale. Visibly soft, permanently, with no way back.
 *
 *   full resolution — a 6000x4000 phone photo is 96 MB of RGBA, held for the
 *         whole session, inside a pipeline whose file budget on a device that
 *         reports no `deviceMemory` is 82 MB (`memoryBudgetBytes`, src/budget.js).
 *         One picture would exceed the budget for the entire document. On a
 *         phone that is the out-of-memory kill this app exists to avoid.
 *
 * 2048 costs 16.8 MB at the very worst (a square picture) and 11.2 MB for a
 * 3:2 photo — about four proxy layers, once, for something the user explicitly
 * asked for — and doubles the linear export resolution against the proxy edge.
 * It is capped again by the document's own long edge below, so a document
 * smaller than 2048 px imports at full document scale and nothing is lost.
 *
 * The cost is stated on screen before the picker opens, in pixels and MB, and
 * again after the import with this document's actual numbers.
 */
const IMPORT_EDGE = 2048;

/** Decoded size, placement box, and what the pair costs. */
interface ImportPlan {
  decodeW: number;
  decodeH: number;
  placeW: number;
  placeH: number;
  bytes: number;
  /** Decoded pixels as a percentage of the placement box. 100 = pixel-exact at export. */
  exportPercent: number;
}

interface DecodedImage {
  pixels: { width: number; height: number; data: Uint8ClampedArray };
  plan: ImportPlan;
  naturalW: number;
  naturalH: number;
}

/**
 * Add a picture to the document as A LAYER OF ITS OWN, and replace the picture
 * on a raster layer that already exists.
 *
 * ## Not Overlay, and the difference is the whole point
 *
 * `layer.adjust.overlay` with `kind: 'image'` paints a texture ONTO an existing
 * layer, clipped to that layer's alpha, as a non-destructive effect on it. It
 * has no row in the Layers panel, no opacity of its own, no blend mode of its
 * own, no position in the stack, and it cannot be removed without editing the
 * layer it is welded to. A user who wanted a second picture in the document and
 * found only Overlay gets exactly that — which is what happened, and is why
 * this exists beside it rather than instead of it.
 *
 * What this produces goes through `insertImageLayer`, so it is
 * indistinguishable from a layer read out of the PSD to `panelRows`, the
 * sandwich cache, `hitTest`, the canvas drag handles and the export walk.
 * `test/creative.mjs` pins the field set.
 *
 * ## Where it lives, and why not the rail
 *
 * The rail already carries eight tools at 80 px each, which scrolls off the
 * right edge of every phone; a ninth would make an existing findability
 * problem worse for a tool used once or twice per document. This is a STACK
 * operation — it creates a layer — and the Layers sheet is where the stack is
 * owned: select, reorder, hide. It is also the one sheet with no confirm tick,
 * because everything it does is already committed and undoable, which is
 * exactly the shape of an insert command.
 *
 * ## Decoding
 *
 * `createImageBitmap(file, { resizeWidth, resizeHeight })` decodes STRAIGHT
 * into the target size, so a 24-megapixel photo never becomes a 96 MB buffer
 * on the way to an 11 MB one. The natural size is read first from an
 * `HTMLImageElement` load event, which parses the header without forcing a
 * full decode into the JS heap. If a WebView ignores the resize options, the
 * canvas draw still lands at the planned size, so the cap holds either way.
 * The bitmap is closed in a `finally` — it is a native allocation the
 * collector is in no hurry over.
 */
@Component({
  selector: 'app-image-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (svc.project()) {
      <div class="space-y-3 border-b border-white/10 px-3 py-4">
        <label
          class="flex h-12 w-full cursor-pointer items-center justify-center rounded-xl bg-sky-500 text-sm font-medium text-white"
          [class.pointer-events-none]="busy()"
          [class.opacity-60]="busy()"
        >
          {{ busy() ? 'Reading…' : 'Add a picture as a new layer' }}
          <input
            type="file"
            class="hidden"
            [accept]="accept"
            [disabled]="busy()"
            (change)="add($event)"
          />
        </label>

        <p class="text-[11px] leading-relaxed text-neutral-500">
          PNG, JPEG or WebP. It becomes a layer of its own — {{ placement() }} — so it can be
          moved and scaled on the canvas, reordered, hidden, faded, blended and deleted like
          every other layer here. One undo step. The file is read in this browser and never
          uploaded.
        </p>

        <p class="text-[11px] leading-relaxed text-neutral-500">
          <b class="text-neutral-300">This is not Overlay.</b> Overlay paints a texture onto a
          layer you already have, clipped to its shape, as an effect belonging to that layer.
          This adds a layer.
        </p>

        @if (selectedRaster(); as target) {
          <label
            class="flex h-12 w-full cursor-pointer items-center justify-center rounded-xl border border-white/15 px-3 text-sm text-neutral-200"
            [class.pointer-events-none]="busy()"
            [class.opacity-60]="busy()"
          >
            <span class="min-w-0 truncate">Replace the picture on {{ target.name }}</span>
            <input
              type="file"
              class="hidden"
              [accept]="accept"
              [disabled]="busy()"
              (change)="replace($event)"
            />
          </label>
          <p class="text-[11px] leading-relaxed text-neutral-500">
            Keeps that layer's place in the stack, its opacity, its blend mode and its mask, and
            fits the new picture inside the box it occupies now. It stops being the file's layer
            at that moment, so an export blends the new picture rather than re-reading the old
            one. One undo step.
          </p>
        } @else {
          @if (selectedOther(); as target) {
            <p class="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
              <b class="font-semibold">{{ target.name }}</b> is a {{ target.kind }} layer, so
              there is no picture on it to replace. Select a raster layer below to replace the
              picture on that, or use the button above to add this picture as its own layer
              instead.
            </p>
          } @else {
            <p class="text-[11px] leading-relaxed text-neutral-500">
              Select a raster layer below and this offers to replace the picture on it as well.
            </p>
          }
        }

        @if (note(); as message) {
          <p class="rounded-lg bg-emerald-400/10 px-3 py-2 text-[11px] leading-relaxed text-emerald-300">
            {{ message }}
          </p>
        }

        @if (error(); as message) {
          <p class="rounded-lg bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-400">
            {{ message }}
          </p>
        }

        <p class="text-[11px] leading-relaxed text-neutral-500">{{ resolutionNote() }}</p>
      </div>
    }
  `,
})
export class ImageActions {
  protected svc = inject(ProjectService);

  protected readonly accept = IMPORT_ACCEPT;

  protected readonly busy = signal(false);
  protected readonly note = signal('');
  protected readonly error = signal('');

  /** The selected layer, when a picture can be replaced on it. */
  protected readonly selectedRaster = computed(() => {
    const layer = this.svc.selected();
    return layer && layer.kind === 'raster' ? layer : null;
  });

  /** The selected layer when it is something else — a text layer, in practice. */
  protected readonly selectedOther = computed(() => {
    const layer = this.svc.selected();
    return layer && layer.kind !== 'raster' ? layer : null;
  });

  /** Said before the picker opens, because it decides where the new row appears. */
  protected readonly placement = computed(() => {
    const layer = this.svc.selected();
    return layer
      ? 'it goes in directly above ' + layer.name + ', and becomes the selected layer'
      : 'it goes on top of the stack, centred, and becomes the selected layer';
  });

  /**
   * The resolution trade, in this document's own numbers, before anything is
   * picked. A percentage rather than a warning: at 100 there is nothing to warn
   * about, and the same sentence has to be able to say so.
   */
  protected readonly resolutionNote = computed(() => {
    this.svc.version();
    const project = this.svc.project();
    if (!project) return '';
    const docEdge = Math.max(project.width, project.height);
    const edge = Math.min(IMPORT_EDGE, docEdge);
    const percent = Math.round((edge / docEdge) * 100);
    const head =
      `Pictures are decoded at up to ${edge} px on the long edge — about `
      + `${megabytes(edge * edge * 4)} at the very worst, held for this session and copied `
      + `once more while an export runs. An added picture has no file to re-read, so that `
      + `buffer is what exports.`;
    return percent >= 100
      ? `${head} This document is ${project.width} × ${project.height}, so an added picture `
        + `exports at full document scale — nothing is lost.`
      : `${head} This document is ${project.width} × ${project.height}, so a picture placed `
        + `across the whole of it exports at about ${percent}% of document scale and looks `
        + `softer than the layers that came from the PSD. Placed smaller, it is sharper.`;
  });

  // ------------------------------------------------------------ actions

  /**
   * Decode the picked file and insert it as a layer.
   *
   * The input's value is cleared BEFORE the await, or picking the same file
   * twice — what a user does after re-exporting an asset — fires no `change`
   * event at all. Same reason the font and overlay pickers do it.
   */
  protected async add(event: Event): Promise<void> {
    const file = this.take(event);
    if (!file) return;

    const project = this.svc.project();
    if (!project) return;

    this.note.set('');
    this.error.set('');
    this.busy.set(true);
    try {
      const read = await this.decode(file, project);
      // Above the selection, or on top when there is none. `selectionIndex` is
      // an index into `project.layers`, where 0 is the BOTTOM — so one past the
      // selected layer is directly above it, which is where a user watching the
      // panel expects the new row to appear.
      const index = this.svc.selectionIndex();
      const options: any = {
        pixels: read.pixels,
        name: layerNameFor(file.name),
        w: read.plan.placeW,
        h: read.plan.placeH,
      };
      if (index >= 0) options.index = index + 1;

      const refusal = this.svc.insertImage(options);
      if (refusal) {
        this.error.set(refusal);
        return;
      }
      this.note.set(`Added ${file.name} as a layer. ${summaryOf(read)}`);
    } catch (failure: any) {
      this.error.set(`Could not read ${file.name}. (${failure?.message ?? failure})`);
    } finally {
      this.busy.set(false);
    }
  }

  /** Swap the picture on the selected raster layer, keeping everything else about it. */
  protected async replace(event: Event): Promise<void> {
    const file = this.take(event);
    if (!file) return;

    const project = this.svc.project();
    const layer = this.selectedRaster();
    if (!project || !layer) return;

    this.note.set('');
    this.error.set('');
    this.busy.set(true);
    try {
      const read = await this.decode(file, project);
      const refusal = this.svc.replaceImage(layer.id, read.pixels);
      if (refusal) {
        this.error.set(refusal);
        return;
      }
      this.note.set(`Replaced the picture on ${layer.name}. ${summaryOf(read)}`);
    } catch (failure: any) {
      this.error.set(`Could not read ${file.name}. (${failure?.message ?? failure})`);
    } finally {
      this.busy.set(false);
    }
  }

  private take(event: Event): File | null {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    return file;
  }

  // ------------------------------------------------------------ decoding

  private async decode(file: File, project: any): Promise<DecodedImage> {
    if (typeof createImageBitmap !== 'function')
      throw new Error('this browser cannot decode images off the DOM');

    const natural = await naturalSize(file);
    const plan = planFor(natural.width, natural.height, project.width, project.height);

    const bitmap = await createImageBitmap(file, {
      resizeWidth: plan.decodeW,
      resizeHeight: plan.decodeH,
      resizeQuality: 'high',
    });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = plan.decodeW;
      canvas.height = plan.decodeH;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('this browser gave no 2D context');

      // Drawn at the planned size whatever the bitmap came back as: a WebView
      // that ignores the resize options above must not be able to smuggle a
      // full-resolution buffer past the cap.
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, plan.decodeW, plan.decodeH);

      return {
        pixels: {
          width: plan.decodeW,
          height: plan.decodeH,
          data: context.getImageData(0, 0, plan.decodeW, plan.decodeH).data,
        },
        plan,
        naturalW: natural.width,
        naturalH: natural.height,
      };
    } finally {
      bitmap.close();
    }
  }
}

/**
 * The picture's own pixel size, without decoding it into the heap.
 *
 * `load` fires once the header has been parsed, which is where `naturalWidth`
 * comes from; `decode()` is deliberately NOT called, because that is the call
 * that forces the full-resolution decode this whole path exists to avoid.
 */
function naturalSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      URL.revokeObjectURL(url);
      if (probe.naturalWidth > 0 && probe.naturalHeight > 0)
        resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
      else reject(new Error('the file reports no usable dimensions'));
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the browser could not read this file as an image'));
    };
    probe.src = url;
  });
}

/**
 * Decide the decoded size and the placement box. They are NOT the same number.
 *
 * The decoded size is a memory decision, capped at `IMPORT_EDGE` and again at
 * the document's long edge — storing more pixels than the document can ever
 * show at scale 1 buys nothing at any zoom or at export.
 *
 * The placement box is a layout decision, taken from the picture's NATURAL
 * size so that the cap above cannot move where the layer lands. It is shrunk
 * to fit inside the document when the picture is larger. `insertImageLayer`
 * would otherwise place it at the size of whatever buffer we happened to
 * decode, which for a phone photo in a poster is a small stamp in the middle.
 */
function planFor(naturalW: number, naturalH: number, docW: number, docH: number): ImportPlan {
  const edge = Math.min(IMPORT_EDGE, Math.max(docW, docH));
  const decodeScale = Math.min(1, edge / Math.max(naturalW, naturalH));
  const decodeW = Math.max(1, Math.round(naturalW * decodeScale));
  const decodeH = Math.max(1, Math.round(naturalH * decodeScale));

  const placeScale = Math.min(1, docW / naturalW, docH / naturalH);
  const placeW = Math.max(1, Math.round(naturalW * placeScale));
  const placeH = Math.max(1, Math.round(naturalH * placeScale));

  return {
    decodeW,
    decodeH,
    placeW,
    placeH,
    bytes: decodeW * decodeH * 4,
    exportPercent: Math.round((decodeW / placeW) * 100),
  };
}

/** What the import actually cost and what it will export at, in units. */
function summaryOf(read: DecodedImage): string {
  const head =
    `${read.naturalW} × ${read.naturalH} decoded to ${read.plan.decodeW} × ${read.plan.decodeH} `
    + `(${megabytes(read.plan.bytes)}), placed at ${read.plan.placeW} × ${read.plan.placeH}.`;
  return read.plan.exportPercent >= 100
    ? `${head} It exports at those pixels exactly.`
    : `${head} It exports from those pixels, about ${read.plan.exportPercent}% of the box it `
      + `sits in — scale it down on the canvas for a sharper result.`;
}

/** The file's name without its extension, which is what a user would call the layer. */
function layerNameFor(fileName: string): string {
  const base = String(fileName ?? '').replace(/\.[a-z0-9]+$/i, '').trim();
  return base ? base.slice(0, 60) : 'Image';
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
