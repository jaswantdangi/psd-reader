import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HSL_BANDS, HSL_HUE_DEGREES, NEUTRAL_HSL } from '@engine/adjust/ops.js';
import { ProjectService } from '../services/project.service';
import { Slider } from './slider';

type Band = { h: number; s: number; l: number };
type Hsl = { bands: Band[]; saturation: number };

/** Eight bands at Photoshop's own centres — deliberately not evenly spaced. */
const BANDS = HSL_BANDS as ReadonlyArray<{ id: string; centre: number }>;
const NEUTRAL = NEUTRAL_HSL as Hsl;

const FIELDS: ReadonlyArray<{ key: 'h' | 's' | 'l'; label: string }> = [
  { key: 'h', label: 'Hue' },
  { key: 's', label: 'Saturation' },
  { key: 'l', label: 'Luminance' },
];

/**
 * Per-band hue, saturation and luminance, plus one master saturation.
 *
 * Same shape as the Adjust sheet and for the same reason: a chip strip picks
 * the target, sliders edit it, and every write is one `setAdjust` under one
 * gesture key. Nothing here knows what a band IS — the centres, the count and
 * the +/-30 degree mapping all come from the engine, so the picker cannot drift
 * from the evaluator.
 *
 * `setAdjust` merges shallowly and `createAdjust` re-normalises, so a write has
 * to carry the WHOLE hsl object, not one band. It is rebuilt from clones each
 * time: the stored object is deeply frozen, and `setLayer` captures the
 * previous VALUE for undo — which for an object field is the same reference, so
 * an in-place edit would destroy the undo entry before it was written.
 */
@Component({
  selector: 'app-hsl-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Slider],
  template: `
    @if (svc.selected(); as layer) {
      <div class="space-y-4 px-4 py-4">
        <div class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          @for (band of bands; track band.id; let i = $index) {
            <button
              type="button"
              class="relative flex h-[60px] min-w-[72px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl border px-3"
              [class]="
                index() === i
                  ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                  : 'border-white/15 text-neutral-300'
              "
              (click)="index.set(i)"
            >
              <span
                class="h-3 w-3 rounded-full"
                [style.background]="swatch(band.centre)"
              ></span>
              <span class="text-[11px] capitalize">{{ band.id }}</span>

              <!-- Which bands carry an edit has to be visible from the strip:
                   otherwise the only way to find one is to tap all eight. -->
              @if (touched(i)) {
                <span
                  class="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-sky-400"
                  aria-label="edited"
                ></span>
              }
            </button>
          }
        </div>

        @for (field of fields; track field.key) {
          <app-slider
            [label]="field.label"
            [value]="valueOf(field.key)"
            [min]="-100"
            [max]="100"
            [step]="1"
            [readout]="readoutOf(field.key)"
            [resettable]="valueOf(field.key) !== 0"
            (knobStart)="startDrag()"
            (valueChange)="setBand(field.key, $event)"
            (knobEnd)="endDrag()"
            (reset)="setBand(field.key, 0)"
          />
        }

        <div class="border-t border-white/10 pt-3">
          <app-slider
            label="All hues"
            [value]="saturation()"
            [min]="-100"
            [max]="100"
            [step]="1"
            [readout]="signed(saturation())"
            [resettable]="saturation() !== 0"
            (knobStart)="startDrag()"
            (valueChange)="setSaturation($event)"
            (knobEnd)="endDrag()"
            (reset)="setSaturation(0)"
          />
        </div>

        <div class="flex items-start justify-between gap-3 pt-1">
          <!-- Stated where the cost is paid. Class-A adjustments fold into one
               768-byte table; this one does not and cannot. -->
          <p class="text-[11px] leading-relaxed text-neutral-500">
            Hue moves up to {{ degrees }}° at either end. HSL is the one
            adjustment evaluated per pixel rather than through the lookup table,
            so it is the expensive one on a large layer.
          </p>

          @if (active()) {
            <button
              type="button"
              class="h-11 shrink-0 rounded-xl border border-white/15 px-3 text-sm text-neutral-300"
              (click)="resetAll(layer)"
            >
              Reset all
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class HslSheet {
  protected svc = inject(ProjectService);
  protected readonly bands = BANDS;
  protected readonly fields = FIELDS;
  protected readonly degrees = HSL_HUE_DEGREES;

  protected readonly index = signal(0);
  private dragKey = signal<string | undefined>(undefined);

  /** The layer's hsl, or the engine's neutral one, so display has one path. */
  private readonly hsl = computed<Hsl>(() => {
    this.svc.version();
    const layer = this.svc.selected();
    return (layer?.adjust?.hsl ?? NEUTRAL) as Hsl;
  });

  protected readonly saturation = computed(() => Math.round(this.hsl().saturation));

  /** Whether anything at all is set, which is what `Reset all` is for. */
  protected readonly active = computed(() => {
    const hsl = this.hsl();
    return hsl.saturation !== 0 || hsl.bands.some((b) => b.h !== 0 || b.s !== 0 || b.l !== 0);
  });

  protected swatch(centre: number): string {
    return `hsl(${centre} 85% 55%)`;
  }

  protected touched(i: number): boolean {
    const band = this.hsl().bands[i];
    return !!band && (band.h !== 0 || band.s !== 0 || band.l !== 0);
  }

  protected valueOf(key: 'h' | 's' | 'l'): number {
    const band = this.hsl().bands[this.index()];
    return band ? Math.round(band[key]) : 0;
  }

  protected signed(value: number): string {
    return value > 0 ? `+${value}` : `${value}`;
  }

  protected readoutOf(key: 'h' | 's' | 'l'): string {
    const value = this.valueOf(key);
    // The hue slider is not in the same units as the other two. Showing it in
    // degrees is the only way the number on screen means anything.
    if (key !== 'h') return this.signed(value);
    const shifted = Math.round((value * HSL_HUE_DEGREES) / 100);
    return `${shifted > 0 ? '+' : ''}${shifted}°`;
  }

  protected startDrag(): void {
    this.dragKey.set(this.svc.gestureKey('hsl'));
  }

  protected endDrag(): void {
    this.dragKey.set(undefined);
  }

  protected setBand(key: 'h' | 's' | 'l', value: number): void {
    const layer = this.svc.selected();
    if (!layer) return;
    const source = this.hsl();
    const bands = source.bands.map((b) => ({ h: b.h, s: b.s, l: b.l }));
    const band = bands[this.index()];
    if (!band) return;
    band[key] = value;
    this.svc.setAdjust(layer.id, { hsl: { bands, saturation: source.saturation } }, this.dragKey());
  }

  protected setSaturation(value: number): void {
    const layer = this.svc.selected();
    if (!layer) return;
    const source = this.hsl();
    const bands = source.bands.map((b) => ({ h: b.h, s: b.s, l: b.l }));
    this.svc.setAdjust(layer.id, { hsl: { bands, saturation: value } }, this.dragKey());
  }

  protected resetAll(layer: any): void {
    // `null`, not a neutral object: the engine stores a neutral adjustment as
    // null so a reset layer costs exactly what an untouched one costs.
    this.svc.setAdjust(layer.id, { hsl: null });
  }
}
