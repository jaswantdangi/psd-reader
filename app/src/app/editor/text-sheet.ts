import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FONT_STACKS } from '@engine/edit.js';
import { ProjectService } from '../services/project.service';
import { Slider } from './slider';

const STACKS: string[] = FONT_STACKS;

/** The three the engine's rasteriser understands — `ctx.textAlign` takes these verbatim. */
const ALIGNMENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Centre' },
  { id: 'right', label: 'Right' },
];

/** Smallest size the slider offers. `fontSpec` clamps at 1px, which is not a size. */
const MIN_SIZE = 8;
const BASE_MAX_SIZE = 200;

/**
 * The string, and how it is drawn.
 *
 * Every write goes through `retypeText`, which is ONE `setLayer` carrying the
 * text fields AND the new box together — so the glyphs and their bounds can
 * never be undone apart. Nothing about measurement, anchoring or the box scale
 * is decided here; `src/creative/text.js` owns all of it.
 *
 * ## Two things this screen has to say out loud
 *
 * 1. **Editing re-draws the layer.** Photoshop's text arrives as a baked
 *    bitmap. `setLayer` flips `rerendered` the moment `text`, `w` or `h`
 *    changes, and from then on `render.js` rasterises the glyphs itself. That
 *    is a visible change to the image, so it is stated before it happens and
 *    badged after.
 *
 * 2. **The file's typography is not fully carried.** `toLayer` sets
 *    `fontFamily` to `FONT_STACKS[0]` and `bold`/`italic` to false for EVERY
 *    text layer it reads — the PSD's own typeface never reaches the model. The
 *    controls below are therefore what the app will draw with, not a readout of
 *    what Photoshop used, and a picker that did not say so would be lying about
 *    the file.
 *
 * The "edited" state is read from `layer.rerendered`, never from
 * `content !== originalContent`: a layer created here has `originalContent:''`
 * by design, so the string comparison badges every created layer forever.
 */
@Component({
  selector: 'app-text-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Slider],
  template: `
    @if (svc.selected(); as layer) {
      @if (layer.kind === 'text' && layer.text) {
        <div class="space-y-5 px-4 pb-6 pt-4">
          <!-- Stated BEFORE the first keystroke, and only while it is still
               true. Once the layer is re-drawn the badge below replaces it. -->
          @if (!layer.rerendered) {
            <p class="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
              This layer is still Photoshop's own pixels. Changing anything here re-draws
              the glyphs with the settings below, and the file's own typeface is not
              carried into this editor — so the result can look different from the
              original. Undo puts the original pixels back.
            </p>
          } @else {
            <p class="flex items-start gap-2 text-[11px] leading-relaxed text-neutral-500">
              <span
                class="mt-px shrink-0 rounded bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-300"
              >
                Re-drawn
              </span>
              <span>
                This app is drawing these glyphs, not Photoshop. It stays that way on
                screen and at export, at any size.
              </span>
            </p>
          }

          <!-- First in the sheet on purpose: it is the one control that has to
               stay visible when the on-screen keyboard takes the bottom half. -->
          <div>
            <label
              class="mb-2 block text-[11px] font-medium uppercase tracking-wider text-neutral-400"
              for="text-content"
            >
              Text
            </label>
            <textarea
              id="text-content"
              rows="4"
              class="min-h-[96px] w-full resize-y rounded-xl bg-white/5 px-3 py-3 text-sm leading-relaxed text-neutral-100 outline-none ring-1 ring-white/10 focus:ring-sky-400"
              [value]="layer.text.content"
              (focus)="startTyping($event)"
              (input)="onType($event)"
              (blur)="endTyping()"
            ></textarea>
            <p class="mt-1 text-[11px] tabular-nums text-neutral-500">
              {{ layer.w }} × {{ layer.h }} px · {{ lineCount(layer.text.content) }} line(s)
            </p>
          </div>

          @if (error(); as message) {
            <p class="rounded-lg bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-400">
              {{ message }}
            </p>
          }

          <app-slider
            label="Size"
            [value]="layer.text.fontSize"
            [min]="minSize"
            [max]="maxSize()"
            [step]="1"
            [readout]="layer.text.fontSize + ' px'"
            (knobStart)="startSize()"
            (valueChange)="setSize($event)"
            (knobEnd)="endSize()"
          />

          <div class="flex flex-wrap items-center gap-2">
            <span class="w-20 shrink-0 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Style
            </span>
            <button
              type="button"
              class="h-11 min-w-[52px] rounded-xl border px-3 text-sm font-bold"
              [class]="pill(layer.text.bold)"
              [attr.aria-pressed]="layer.text.bold"
              (click)="apply({ bold: !layer.text.bold })"
            >
              B
            </button>
            <button
              type="button"
              class="h-11 min-w-[52px] rounded-xl border px-3 text-sm italic"
              [class]="pill(layer.text.italic)"
              [attr.aria-pressed]="layer.text.italic"
              (click)="apply({ italic: !layer.text.italic })"
            >
              I
            </button>
            <input
              type="color"
              class="h-11 w-16 shrink-0 cursor-pointer rounded-xl border border-white/15 bg-transparent p-1"
              aria-label="Text colour"
              [value]="layer.text.color"
              (change)="setColour($event)"
            />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <span class="w-20 shrink-0 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Align
            </span>
            <!-- Alignment is also the ANCHOR the box grows from, which is why
                 changing it can move the layer as well as re-flow it. -->
            @for (option of alignments; track option.id) {
              <button
                type="button"
                class="h-11 flex-1 rounded-xl border px-3 text-sm"
                [class]="pill(layer.text.align === option.id)"
                [attr.aria-pressed]="layer.text.align === option.id"
                (click)="apply({ align: option.id })"
              >
                {{ option.label }}
              </button>
            }
          </div>

          <div>
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Typeface
            </p>
            <div class="flex flex-wrap gap-2">
              @for (stack of stacks; track stack) {
                <button
                  type="button"
                  class="h-11 rounded-xl border px-3 text-sm"
                  [class]="pill(layer.text.fontFamily === stack)"
                  [style.fontFamily]="stack"
                  (click)="apply({ fontFamily: stack })"
                >
                  {{ nameOf(stack) }}
                </button>
              }
            </div>
            <p class="mt-2 text-[11px] leading-relaxed text-neutral-500">
              These are the stacks the renderer can guarantee on a phone. The PSD's own
              font is never read, so this is a choice rather than a match.
            </p>
          </div>
        </div>
      } @else {
        <!-- The case a user hits first. A dead sheet full of disabled controls
             would teach nothing; naming the layer and offering the one useful
             action does. -->
        <div class="space-y-4 px-4 py-6">
          <div>
            <p class="text-sm text-neutral-200">
              <b class="text-neutral-100">{{ layer.name }}</b> is not a text layer.
            </p>
            <p class="mt-1 text-xs leading-relaxed text-neutral-500">
              Text tools work on one text layer at a time. Pick one from Layers — they
              carry a <span class="rounded bg-white/10 px-1 text-neutral-300">T</span>
              badge — or add a new one.
            </p>
          </div>

          @if (error(); as message) {
            <p class="rounded-lg bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-400">
              {{ message }}
            </p>
          }

          <button
            type="button"
            class="h-12 w-full rounded-xl bg-sky-500 text-sm font-medium text-white"
            (click)="addLayer()"
          >
            Add a text layer
          </button>
          <p class="text-[11px] leading-relaxed text-neutral-500">
            Goes on top of the stack, centred in the document, and is drawn by this app
            rather than read from the file. It is one undo step, and it reaches your PSD
            only through Export.
          </p>
        </div>
      }
    }
  `,
})
export class TextSheet {
  protected svc = inject(ProjectService);

  protected readonly stacks = STACKS;
  protected readonly alignments = ALIGNMENTS;
  protected readonly minSize = MIN_SIZE;

  /** Only ever set by the engine refusing — in practice, no measurer. */
  protected readonly error = signal('');

  private typeKey = signal<string | undefined>(undefined);
  private sizeKey = signal<string | undefined>(undefined);

  /**
   * A PSD title can be 400px in a document nobody would call large. Clamping
   * the slider at 200 would silently shrink it on the first touch, so the top
   * of the range is whichever is larger.
   */
  protected readonly maxSize = computed(() => {
    const layer = this.svc.selected();
    const size = layer?.text?.fontSize ?? 0;
    return Math.max(BASE_MAX_SIZE, Math.ceil(size));
  });

  protected pill(active: boolean): string {
    return active
      ? 'border-sky-400 bg-sky-400/15 text-sky-300'
      : 'border-white/15 text-neutral-300';
  }

  protected nameOf(stack: string): string {
    return (stack.split(',')[0] ?? stack).replace(/["']/g, '');
  }

  protected lineCount(content: string): number {
    return String(content ?? '').split('\n').length;
  }

  // ------------------------------------------------------------ typing

  protected startTyping(event: Event): void {
    // One key for the whole editing session, minted at focus. `setLayer` then
    // merges every keystroke into the SAME history entry, so "Hello" is one
    // undo rather than five — and `project.revision` never moves during it,
    // which is what keeps the sandwich cache alive while the user types.
    this.typeKey.set(this.svc.gestureKey('type'));

    // The sheet is bottom-anchored and the keyboard covers the bottom of it.
    // Nothing here can resize the sheet, but pulling the field to the top of
    // its own scroller keeps it in view on every device that shrinks the
    // layout viewport for the keyboard.
    (event.target as HTMLElement).scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  protected endTyping(): void {
    this.typeKey.set(undefined);
  }

  protected onType(event: Event): void {
    this.apply({ content: (event.target as HTMLTextAreaElement).value }, this.typeKey());
  }

  // ------------------------------------------------------------ size

  protected startSize(): void {
    this.sizeKey.set(this.svc.gestureKey('fontSize'));
  }

  protected endSize(): void {
    this.sizeKey.set(undefined);
  }

  protected setSize(value: number): void {
    this.apply({ fontSize: Math.round(value) }, this.sizeKey());
  }

  // ------------------------------------------------------------ writes

  protected setColour(event: Event): void {
    this.apply({ color: (event.target as HTMLInputElement).value });
  }

  protected apply(changes: any, coalesceKey?: string): void {
    const layer = this.svc.selected();
    if (!layer) return;
    this.error.set(this.svc.retypeText(layer.id, changes, coalesceKey) ?? '');
  }

  protected addLayer(): void {
    const project = this.svc.project();
    if (!project) return;
    // The only number this screen invents. The engine's own default is 24px,
    // which is a speck in a 4000px document, so the starting size is a fraction
    // of the shorter edge — a legible default, not a measurement.
    const fontSize = Math.max(24, Math.round(Math.min(project.width, project.height) * 0.08));
    this.error.set(this.svc.insertText({ content: 'Text', fontSize }) ?? '');
  }
}
