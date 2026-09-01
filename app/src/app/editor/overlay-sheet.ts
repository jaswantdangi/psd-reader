import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  OVERLAY_FITS, OVERLAY_IMAGE_EDGE, OVERLAY_KINDS, overlayNeedsImage,
} from '@engine/adjust/ops.js';
import { proxyScaleFor } from '@engine/proxy.js';
import { SUPPORTED_BLEND_MODES } from '@engine/composite.js';
import { ProjectService } from '../services/project.service';
import { BLEND_GROUPS } from './layer-sheet';
import { Slider } from './slider';

const KINDS = OVERLAY_KINDS as string[];
const FITS = OVERLAY_FITS as string[];
const SUPPORTED: string[] = SUPPORTED_BLEND_MODES;
const needsImage = overlayNeedsImage as (overlay: any) => boolean;

/**
 * The grouping the Layer sheet uses, narrowed to the list `normaliseOverlay`
 * will actually accept. The two lists are asserted equal by a test in the
 * engine; if they ever diverge, this offers the smaller one rather than a
 * button that silently resolves to Normal.
 */
const GROUPS = BLEND_GROUPS
  .map((group) => ({ label: group.label, modes: group.modes.filter((m) => SUPPORTED.includes(m)) }))
  .filter((group) => group.modes.length > 0);

/** A starter that is visible immediately: black at the top, fading down. */
const STARTER = {
  kind: 'linear',
  angle: 90,
  cx: 0.5,
  cy: 0.5,
  radius: 0.7071,
  stops: [
    { t: 0, r: 0, g: 0, b: 0, a: 0.6 },
    { t: 1, r: 0, g: 0, b: 0, a: 0 },
  ],
  mode: 'normal',
  opacity: 1,
};

/** What the OS picker offers. Anything `createImageBitmap` can decode. */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

const hex2 = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');

const FIT_NOTES: Record<string, string> = {
  cover: 'Fills the layer, keeping the picture\'s proportions and cropping what overflows.',
  stretch: 'Uses the whole picture, squeezed to the layer\'s proportions.',
};

/**
 * A gradient OR the user's own picture, painted into the selected layer and
 * clipped to its own alpha.
 *
 * Everything here is in NORMALISED layer coordinates — the centre and radius
 * are fractions of the layer rect, never pixels, and a texture's fit is decided
 * from ASPECT RATIOS alone — which is what makes the overlay scale-invariant,
 * so the proxy and the full-resolution export agree with no `proxyScale` term
 * anywhere on this screen.
 *
 * Like the Adjust and HSL sheets, a write is one `setAdjust` carrying the WHOLE
 * overlay object under one gesture key. The stored object is deeply frozen and
 * `setLayer` captures the previous VALUE for undo, which for an object field is
 * the same reference — so it is rebuilt from clones every time rather than
 * edited in place. The image's PIXELS are the one thing carried by reference
 * through that rebuild: they are never edited, and copying them per keystroke
 * would be megabytes a frame.
 *
 * ## The picture is decoded straight into the capped size
 *
 * A phone camera JPEG is 24 megapixels; read back whole that is 96 MB of heap,
 * inside a pipeline whose entire purpose is bounding exactly that. So the
 * decoded bitmap is drawn into a canvas ALREADY sized by the engine's own
 * `proxyScaleFor(w, h, OVERLAY_IMAGE_EDGE)` rule, and only that canvas is read
 * back — at most 1024 on the long edge, 4 MB, one proxy layer's worth. The
 * bitmap is closed on the way out, success or failure.
 *
 * ## Why nothing extra is needed for export
 *
 * The pixels live inside `layer.adjust`, and `ExportService.payloadFor` strips
 * only `layer.pixels` — so they cross to the export worker with the project, by
 * structured clone, which preserves shared references and therefore sends ONE
 * buffer however many layers point at it. That is the font problem's lesson
 * applied by construction rather than by a second channel: there is no path
 * where the screen has the texture and the PNG does not.
 */
@Component({
  selector: 'app-overlay-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Slider],
  template: `
    @if (svc.selected(); as layer) {
      @if (overlay(); as value) {
        <div class="space-y-5 px-4 py-4">
          <div class="flex gap-2">
            @for (kind of kinds; track kind) {
              @if (kind === 'image' && !image()) {
                <label
                  class="flex h-11 flex-1 cursor-pointer items-center justify-center rounded-xl border text-sm capitalize"
                  [class]="
                    value.kind === 'image'
                      ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                      : 'border-white/15 text-neutral-300'
                  "
                  [class.pointer-events-none]="busy()"
                  [class.opacity-60]="busy()"
                >
                  {{ busy() ? 'Reading…' : 'image' }}
                  <input type="file" class="hidden" [accept]="accept"
                         [disabled]="busy()" (change)="pick($event)" />
                </label>
              } @else {
                <button
                  type="button"
                  class="h-11 flex-1 rounded-xl border text-sm capitalize"
                  [class]="
                    value.kind === kind
                      ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                      : 'border-white/15 text-neutral-300'
                  "
                  (click)="setKind(kind)"
                >
                  {{ kind }}
                </button>
              }
            }
          </div>

          @if (value.kind === 'image') {
            @if (missing()) {
              <div class="space-y-3 rounded-xl bg-amber-400/10 px-3 py-3">
                <p class="text-[11px] leading-relaxed text-amber-300">
                  This overlay wants
                  <b>{{ value.source || 'a picture' }}</b>, which was not stored in the
                  project file — only its name was. Nothing is painted until you supply
                  it again, so the layer is showing the truth rather than a stand-in.
                </p>
                <label
                  class="flex min-h-[44px] w-full cursor-pointer items-center justify-center rounded-xl bg-sky-500 text-sm font-medium text-white"
                  [class.pointer-events-none]="busy()"
                  [class.opacity-60]="busy()"
                >
                  {{ busy() ? 'Reading…' : 'Choose the picture…' }}
                  <input type="file" class="hidden" [accept]="accept"
                         [disabled]="busy()" (change)="pick($event)" />
                </label>
              </div>
            } @else if (image()) {
              <div class="rounded-xl border border-white/10 px-3 py-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="truncate text-sm text-neutral-200">
                      {{ value.source || 'Picture' }}
                    </p>
                    <p class="text-[11px] text-neutral-500">
                      {{ image().width }} × {{ image().height }} · {{ megabytes() }} MB held
                      in this tab
                    </p>
                  </div>
                  <label
                    class="flex h-11 shrink-0 cursor-pointer items-center rounded-xl border border-white/15 px-3 text-sm text-neutral-300"
                    [class.pointer-events-none]="busy()"
                    [class.opacity-60]="busy()"
                  >
                    {{ busy() ? 'Reading…' : 'Replace' }}
                    <input type="file" class="hidden" [accept]="accept"
                           [disabled]="busy()" (change)="pick($event)" />
                  </label>
                </div>
              </div>

              <div>
                <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                  Fit
                </p>
                <div class="flex gap-2">
                  @for (fit of fits; track fit) {
                    <button
                      type="button"
                      class="h-11 flex-1 rounded-xl border text-sm capitalize"
                      [class]="
                        value.fit === fit
                          ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                          : 'border-white/15 text-neutral-300'
                      "
                      (click)="patch({ fit: fit })"
                    >
                      {{ fit }}
                    </button>
                  }
                </div>
                <p class="mt-2 text-[11px] leading-relaxed text-neutral-500">
                  {{ fitNote(value.fit) }} Either way the rule is read from the layer's
                  proportions, not its pixel size, so the export is framed exactly as this
                  preview is.
                </p>
              </div>
            }
          } @else if (value.kind === 'radial') {
            <app-slider
              label="Centre X"
              [value]="percent(value.cx)"
              [readout]="percent(value.cx) + '%'"
              (knobStart)="startDrag()"
              (valueChange)="patch({ cx: $event / 100 }, dragKey())"
              (knobEnd)="endDrag()"
            />
            <app-slider
              label="Centre Y"
              [value]="percent(value.cy)"
              [readout]="percent(value.cy) + '%'"
              (knobStart)="startDrag()"
              (valueChange)="patch({ cy: $event / 100 }, dragKey())"
              (knobEnd)="endDrag()"
            />
            <app-slider
              label="Radius"
              [value]="percent(value.radius)"
              [min]="5"
              [max]="200"
              [readout]="percent(value.radius) + '%'"
              (knobStart)="startDrag()"
              (valueChange)="patch({ radius: $event / 100 }, dragKey())"
              (knobEnd)="endDrag()"
            />
          } @else {
            <app-slider
              label="Angle"
              [value]="Math.round(value.angle)"
              [min]="0"
              [max]="360"
              [readout]="Math.round(value.angle) + '°'"
              (knobStart)="startDrag()"
              (valueChange)="patch({ angle: $event }, dragKey())"
              (knobEnd)="endDrag()"
            />
          }

          @if (note()) {
            <p class="rounded-lg bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
              {{ note() }}
            </p>
          }

          @if (value.kind !== 'image') {
            <div class="space-y-3">
              <p class="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                Colours
              </p>

              @if (extraStops()) {
                <!-- Never silently discard what the file carried. -->
                <p class="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300">
                  This gradient has {{ value.stops.length }} stops. Only the first and the
                  last are editable here; the {{ extraStops() }} between them are kept as
                  they are.
                </p>
              }

              @for (end of ends(); track end.index) {
                <div class="rounded-xl border border-white/10 px-3 py-2">
                  <div class="flex min-h-[44px] items-center justify-between gap-3">
                    <span class="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
                      {{ end.label }}
                    </span>
                    <input
                      type="color"
                      class="h-11 w-16 shrink-0 cursor-pointer rounded-lg border border-white/15 bg-transparent p-1"
                      [attr.aria-label]="end.label + ' colour'"
                      [value]="colourOf(end.index)"
                      (change)="setColour(end.index, $event)"
                    />
                  </div>
                  <app-slider
                    label="Opacity"
                    [value]="alphaOf(end.index)"
                    [readout]="alphaOf(end.index) + '%'"
                    (knobStart)="startDrag()"
                    (valueChange)="setAlpha(end.index, $event)"
                    (knobEnd)="endDrag()"
                  />
                </div>
              }
            </div>
          }

          <app-slider
            label="Strength"
            [value]="percent(value.opacity)"
            [readout]="percent(value.opacity) + '%'"
            (knobStart)="startDrag()"
            (valueChange)="patch({ opacity: $event / 100 }, dragKey())"
            (knobEnd)="endDrag()"
          />

          <div>
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Overlay blend mode
            </p>
            <div class="space-y-3">
              @for (group of groups; track group.label) {
                <div>
                  <p class="mb-1 text-[10px] uppercase tracking-[0.18em] text-neutral-600">
                    {{ group.label }}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    @for (mode of group.modes; track mode) {
                      <button
                        type="button"
                        class="h-11 rounded-xl border px-3 text-sm capitalize"
                        [class]="
                          value.mode === mode
                            ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                            : 'border-white/15 text-neutral-300'
                        "
                        (click)="patch({ mode: mode })"
                      >
                        {{ mode }}
                      </button>
                    }
                  </div>
                </div>
              }
            </div>
          </div>

          <div class="flex items-start justify-between gap-3 border-t border-white/10 pt-4">
            <p class="text-[11px] leading-relaxed text-neutral-500">
              Painted inside <b class="text-neutral-300">{{ layer.name }}</b> and clipped to
              its own transparency, so a cut-out stays a cut-out. A layer carrying an
              overlay is composited on the CPU — the GPU path cannot express an
              overlay's blend mode alongside the layer's.
              @if (value.kind === 'image') {
                A picture is reduced to {{ edge }} px on its long edge when you pick it, so
                one costs at most 4 MB here and is copied once more into the export worker.
                Saving the project stores its NAME, not its pixels — you will be asked for
                the file again when you reopen.
              }
            </p>
            <button
              type="button"
              class="h-11 shrink-0 rounded-xl border border-white/15 px-3 text-sm text-neutral-300"
              (click)="remove(layer)"
            >
              Remove
            </button>
          </div>
        </div>
      } @else {
        <div class="space-y-4 px-4 py-6 text-center">
          <p class="text-sm text-neutral-300">No overlay on {{ layer.name }}.</p>
          <p class="text-[11px] leading-relaxed text-neutral-500">
            An overlay is painted into this layer only, clipped to its own transparency. A
            gradient is stored as two colours and a direction, so it costs nothing to
            change. A picture — a light leak, a texture, bokeh — is stored as pixels,
            reduced to {{ edge }} px on its long edge. Both are resampled to the layer at
            draw time, so both export at full resolution.
          </p>
          @if (note()) {
            <p class="rounded-lg bg-rose-500/10 px-3 py-2 text-left text-[11px] text-rose-300">
              {{ note() }}
            </p>
          }
          <button
            type="button"
            class="h-12 w-full rounded-xl bg-sky-500 text-sm font-medium text-white"
            (click)="add(layer)"
          >
            Add gradient overlay
          </button>
          <label
            class="flex h-12 w-full cursor-pointer items-center justify-center rounded-xl border border-white/15 text-sm font-medium text-neutral-200"
            [class.pointer-events-none]="busy()"
            [class.opacity-60]="busy()"
          >
            {{ busy() ? 'Reading…' : 'Add image overlay…' }}
            <input type="file" class="hidden" [accept]="accept"
                   [disabled]="busy()" (change)="pick($event)" />
          </label>
        </div>
      }
    }
  `,
})
export class OverlaySheet {
  protected svc = inject(ProjectService);
  protected readonly kinds = KINDS;
  protected readonly fits = FITS;
  protected readonly groups = GROUPS;
  protected readonly accept = IMAGE_ACCEPT;
  protected readonly edge = OVERLAY_IMAGE_EDGE;
  /** Templates cannot reach globals; rounding an angle needs one. */
  protected readonly Math = Math;

  protected readonly dragKey = signal<string | undefined>(undefined);
  /** A pick is awaited; the controls disable themselves rather than queueing. */
  protected readonly busy = signal(false);
  /** Why the last pick failed. Cleared when a new one starts. */
  protected readonly note = signal('');

  protected readonly overlay = computed<any>(() => {
    this.svc.version();
    return this.svc.selected()?.adjust?.overlay ?? null;
  });

  protected readonly image = computed<any>(() => this.overlay()?.image ?? null);

  /** Reopened from a saved project: the kind is `image` and the pixels are gone. */
  protected readonly missing = computed(() => needsImage(this.overlay()));

  /** The first and last stop — the two ends a two-colour editor can address. */
  protected readonly ends = computed(() => {
    const stops = this.overlay()?.stops ?? [];
    return [
      { index: 0, label: 'From' },
      { index: Math.max(1, stops.length - 1), label: 'To' },
    ];
  });

  protected readonly extraStops = computed(() => Math.max(0, (this.overlay()?.stops?.length ?? 0) - 2));

  protected megabytes(): string {
    const picture = this.image();
    return picture ? (picture.data.length / (1024 * 1024)).toFixed(1) : '0';
  }

  protected fitNote(fit: string): string {
    return FIT_NOTES[fit] ?? '';
  }

  protected percent(value: number): number {
    return Math.round((value ?? 0) * 100);
  }

  protected colourOf(index: number): string {
    const stop = this.overlay()?.stops?.[index];
    return stop ? `#${hex2(stop.r)}${hex2(stop.g)}${hex2(stop.b)}` : '#000000';
  }

  protected alphaOf(index: number): number {
    return this.percent(this.overlay()?.stops?.[index]?.a ?? 0);
  }

  protected startDrag(): void {
    this.dragKey.set(this.svc.gestureKey('overlay'));
  }

  protected endDrag(): void {
    this.dragKey.set(undefined);
  }

  protected add(layer: any): void {
    // Spread, so the object handed to setAdjust is never the module constant —
    // `createAdjust` freezes what it stores and the constant would be shared.
    this.svc.setAdjust(layer.id, { overlay: { ...STARTER, stops: STARTER.stops.map((s) => ({ ...s })) } });
  }

  protected remove(layer: any): void {
    this.svc.setAdjust(layer.id, { overlay: null });
  }

  /**
   * Switching kinds. `image` is NEVER reached this way while there are no
   * pixels — the kind button becomes a file picker instead.
   *
   * The reason is not cosmetic. An image overlay with no picture is neutral by
   * definition, `setAdjust` stores a wholly neutral adjustment as `null`, and
   * the overlay the user was building would simply vanish under their finger.
   */
  protected setKind(kind: string): void {
    this.patch({ kind });
  }

  /** Rebuild the whole overlay from clones — see the class comment. */
  protected patch(changes: Record<string, any>, coalesceKey?: string): void {
    const layer = this.svc.selected();
    const current = this.overlay();
    if (!layer || !current) return;
    this.svc.setAdjust(
      layer.id,
      { overlay: { ...current, stops: current.stops.map((s: any) => ({ ...s })), ...changes } },
      coalesceKey,
    );
  }

  /**
   * `change`, not `input`. The OS colour picker fires `input` continuously
   * while it is open, and each one would be its own undo entry.
   */
  protected setColour(index: number, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    const rgb = Number.parseInt(text.slice(1), 16);
    if (!Number.isFinite(rgb)) return;
    this.replaceStop(index, { r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255 });
  }

  protected setAlpha(index: number, percent: number): void {
    this.replaceStop(index, { a: percent / 100 }, this.dragKey());
  }

  /**
   * Take a picked file and make it this layer's overlay.
   *
   * The input's value is cleared before the await, or picking the SAME file
   * again — which is what a user does after re-exporting a texture — fires no
   * `change` event at all. Same reason the font picker does it.
   */
  protected async pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;

    const layer = this.svc.selected();
    if (!layer) return;

    this.note.set('');
    this.busy.set(true);
    try {
      const picture = await this.decode(file);
      const current = this.overlay();
      const next = current
        ? { ...current, stops: current.stops.map((s: any) => ({ ...s })) }
        : { ...STARTER, stops: STARTER.stops.map((s) => ({ ...s })), opacity: 1 };
      this.svc.setAdjust(layer.id, {
        overlay: { ...next, kind: 'image', image: picture, source: file.name },
      });
    } catch (error: any) {
      this.note.set(`Could not read ${file.name}. (${error?.message ?? error})`);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Decode straight into the capped size.
   *
   * `drawImage` into an already-small canvas, never a full-resolution
   * `getImageData`: a 24-megapixel phone photo read back whole is 96 MB of
   * heap, which is the out-of-memory this whole pipeline exists to avoid. The
   * target size is the engine's `proxyScaleFor(w, h, OVERLAY_IMAGE_EDGE)`, so
   * the cap is one rule in one place rather than a number repeated here.
   *
   * `imageSmoothingQuality: 'high'` because the browser's own reduction is what
   * does the band-limiting for this feature — the sampler in `applyOverlay` is
   * bilinear and spends no anti-alias budget of its own.
   *
   * The bitmap is closed in a `finally`: it is a native allocation the garbage
   * collector will not hurry over, and on a phone a leaked 24-megapixel decode
   * is the difference between a slow tab and a killed one.
   */
  private async decode(file: File): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
    if (typeof createImageBitmap !== 'function')
      throw new Error('this browser cannot decode images off the DOM');

    const bitmap = await createImageBitmap(file);
    try {
      const scale = proxyScaleFor(bitmap.width, bitmap.height, OVERLAY_IMAGE_EDGE);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('this browser gave no 2D context');

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      return { width, height, data: context.getImageData(0, 0, width, height).data };
    } finally {
      bitmap.close();
    }
  }

  private replaceStop(index: number, changes: Record<string, number>, coalesceKey?: string): void {
    const current = this.overlay();
    if (!current) return;
    const stops = current.stops.map((s: any) => ({ ...s }));
    if (!stops[index]) return;
    stops[index] = { ...stops[index], ...changes };
    this.patch({ stops }, coalesceKey);
  }
}
