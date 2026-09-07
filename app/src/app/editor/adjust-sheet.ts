import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CLASS_A_ORDER, NEUTRAL_ADJUST, OPS } from '@engine/adjust/ops.js';
import { ProjectService } from '../services/project.service';
import { ValueDial } from './value-dial';
import { Slider } from './slider';

/** `OPS` is a plain object literal in untyped JS; index it through one alias. */
const OPERATIONS = OPS as Record<string, any>;
const NEUTRAL = NEUTRAL_ADJUST as Record<string, any>;
const PARAMETERS: string[] = CLASS_A_ORDER;

/**
 * The five class-A parameters, one slider at a time.
 *
 * Order is not an implementation detail — `CLASS_A_ORDER` is the engine's
 * declared evaluation order and the picker follows it, so the strip reads in
 * the order the numbers are actually applied.
 *
 * Nothing here knows what a parameter DOES. The label, the range and the
 * neutral value all come from `OPS`, so a new operation in the engine appears
 * here with no change to this file.
 */
@Component({
  selector: 'app-adjust-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ValueDial, Slider],
  template: `
    @if (svc.selected(); as layer) {
      <div class="space-y-4 px-4 py-4">
        <!-- Scrolls, because five dials at 64px overflow a narrow phone once
             the sheet has its padding. justify-between would centre four and
             hide the fifth; a scroller keeps the order honest. -->
        <div
          class="-mx-1 flex gap-1 overflow-x-auto px-1"
          role="tablist"
          aria-label="Adjustment"
        >
          @for (id of parameters; track id) {
            <app-value-dial
              [label]="labelOf(id)"
              [value]="valueOf(id)"
              [min]="rangeOf(id)[0]"
              [max]="rangeOf(id)[1]"
              [neutralValue]="neutralOf(id)"
              [active]="active() === id"
              (pick)="active.set(id)"
            />
          }
        </div>

        <app-slider
          [label]="labelOf(active())"
          [value]="valueOf(active())"
          [min]="rangeOf(active())[0]"
          [max]="rangeOf(active())[1]"
          [step]="1"
          [readout]="readoutOf(active())"
          [resettable]="valueOf(active()) !== neutralOf(active())"
          (knobStart)="startDrag()"
          (valueChange)="setValue($event)"
          (knobEnd)="endDrag()"
          (reset)="resetActive()"
        />

        <div class="flex items-center justify-between gap-3 pt-1">
          <p class="text-[11px] text-neutral-500">
            @if (layer.adjust) {
              Applied to <b class="text-neutral-300">{{ layer.name }}</b> — non-destructive,
              evaluated on its own pixels at export resolution.
            } @else {
              No adjustment on <b class="text-neutral-300">{{ layer.name }}</b>.
            }
          </p>

          @if (layer.adjust) {
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
export class AdjustSheet {
  protected svc = inject(ProjectService);
  protected readonly parameters = PARAMETERS;
  protected readonly active = signal(PARAMETERS[0]);

  private dragKey = signal<string | undefined>(undefined);

  private readonly adjust = computed(() => {
    this.svc.version();
    const layer = this.svc.selected();
    // A neutral adjustment is stored as `null`, so a reset layer costs what an
    // untouched one costs. Reading through the neutral object keeps every
    // display path identical either way.
    return (layer?.adjust ?? NEUTRAL) as Record<string, any>;
  });

  protected labelOf(id: string): string {
    return OPERATIONS[id]?.label ?? id;
  }

  protected rangeOf(id: string): number[] {
    return OPERATIONS[id]?.range ?? [-100, 100];
  }

  protected neutralOf(id: string): number {
    return OPERATIONS[id]?.neutral ?? 0;
  }

  protected valueOf(id: string): number {
    const raw = this.adjust()[id];
    return typeof raw === 'number' ? Math.round(raw) : this.neutralOf(id);
  }

  protected readoutOf(id: string): string {
    const value = this.valueOf(id);
    return value > 0 ? `+${value}` : `${value}`;
  }

  protected startDrag(): void {
    this.dragKey.set(this.svc.gestureKey('adjust'));
  }

  protected endDrag(): void {
    this.dragKey.set(undefined);
  }

  protected setValue(value: number): void {
    const layer = this.svc.selected();
    if (!layer) return;
    // One gesture key for the whole drag: `setLayer` then coalesces the frames
    // into ONE history entry and leaves `project.revision` alone, which is what
    // lets the sandwich cache survive the drag.
    this.svc.setAdjust(layer.id, { [this.active()]: value }, this.dragKey());
  }

  protected resetActive(): void {
    const layer = this.svc.selected();
    if (!layer) return;
    this.svc.setAdjust(layer.id, { [this.active()]: this.neutralOf(this.active()) });
  }

  protected resetAll(layer: any): void {
    this.svc.setAdjust(layer.id, { ...NEUTRAL });
  }
}
