import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { OVERLAY_KINDS } from '@engine/adjust/ops.js';
import { SUPPORTED_BLEND_MODES } from '@engine/composite.js';
import { ProjectService } from '../services/project.service';
import { BLEND_GROUPS } from './layer-sheet';
import { Slider } from './slider';

const KINDS = OVERLAY_KINDS as string[];
const SUPPORTED: string[] = SUPPORTED_BLEND_MODES;

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

const hex2 = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');

/**
 * A gradient painted into the selected layer, clipped to its own alpha.
 *
 * Everything here is in NORMALISED layer coordinates — the centre and radius
 * are fractions of the layer rect, never pixels — which is what makes the
 * overlay scale-invariant, so the proxy and the full-resolution export agree
 * with no `proxyScale` term anywhere on this screen.
 *
 * Like the Adjust and HSL sheets, a write is one `setAdjust` carrying the WHOLE
 * overlay object under one gesture key. The stored object is deeply frozen and
 * `setLayer` captures the previous VALUE for undo, which for an object field is
 * the same reference — so it is rebuilt from clones every time rather than
 * edited in place.
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
          </div>

          @if (value.kind === 'radial') {
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
            An overlay is a gradient painted into this layer only, clipped to its own
            transparency. It is stored as two colours and a direction, not as pixels, so
            it costs nothing to change and exports at full resolution.
          </p>
          <button
            type="button"
            class="h-12 w-full rounded-xl bg-sky-500 text-sm font-medium text-white"
            (click)="add(layer)"
          >
            Add overlay
          </button>
        </div>
      }
    }
  `,
})
export class OverlaySheet {
  protected svc = inject(ProjectService);
  protected readonly kinds = KINDS;
  protected readonly groups = GROUPS;
  /** Templates cannot reach globals; rounding an angle needs one. */
  protected readonly Math = Math;

  protected readonly dragKey = signal<string | undefined>(undefined);

  protected readonly overlay = computed<any>(() => {
    this.svc.version();
    return this.svc.selected()?.adjust?.overlay ?? null;
  });

  /** The first and last stop — the two ends a two-colour editor can address. */
  protected readonly ends = computed(() => {
    const stops = this.overlay()?.stops ?? [];
    return [
      { index: 0, label: 'From' },
      { index: Math.max(1, stops.length - 1), label: 'To' },
    ];
  });

  protected readonly extraStops = computed(() => Math.max(0, (this.overlay()?.stops?.length ?? 0) - 2));

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

  private replaceStop(index: number, changes: Record<string, number>, coalesceKey?: string): void {
    const current = this.overlay();
    if (!current) return;
    const stops = current.stops.map((s: any) => ({ ...s }));
    if (!stops[index]) return;
    stops[index] = { ...stops[index], ...changes };
    this.patch({ stops }, coalesceKey);
  }
}
