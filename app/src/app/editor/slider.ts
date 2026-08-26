import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IonRange } from '@ionic/angular';

/**
 * One labelled slider with a numeric readout.
 *
 * `ion-range` carries the knob-move lifecycle the engine's coalescing wants:
 * `ionKnobMoveStart` mints a gesture key, `ionInput` fires per frame, and
 * `ionKnobMoveEnd` closes the key — so a whole drag is one undo entry and
 * `project.revision` never moves during it, which is what keeps the sandwich
 * cache alive across the gesture.
 */
@Component({
  selector: 'app-slider',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonRange],
  styles: [
    `
      ion-range {
        --bar-background: #3f3f46;
        --bar-background-active: #38bdf8;
        --bar-height: 3px;
        --knob-background: #f8fafc;
        --knob-size: 22px;
        --height: 44px;
        padding: 0;
        flex: 1 1 auto;
      }
    `,
  ],
  template: `
    <div class="flex min-h-[44px] items-center gap-3">
      <span class="w-20 shrink-0 truncate text-[11px] font-medium uppercase tracking-wider text-neutral-400">
        {{ label() }}
      </span>

      <ion-range
        [min]="min()"
        [max]="max()"
        [step]="step()"
        [value]="value()"
        [attr.aria-label]="label()"
        (ionKnobMoveStart)="knobStart.emit()"
        (ionInput)="onInput($event)"
        (ionKnobMoveEnd)="knobEnd.emit()"
      ></ion-range>

      <span class="w-12 shrink-0 text-right text-sm font-medium tabular-nums text-neutral-100">
        {{ readout() }}
      </span>

      <!-- Reset is ABSENT at the neutral value, not disabled: a control that
           cannot do anything teaches the user that controls can mean nothing. -->
      @if (resettable()) {
        <button
          type="button"
          class="h-11 shrink-0 rounded-lg px-2 text-[11px] font-medium uppercase tracking-wider text-sky-400 active:bg-white/10"
          (click)="reset.emit()"
        >
          Reset
        </button>
      }
    </div>
  `,
})
export class Slider {
  readonly label = input.required<string>();
  readonly value = input.required<number>();
  readonly min = input(0);
  readonly max = input(100);
  readonly step = input(1);
  readonly readout = input.required<string>();
  readonly resettable = input(false);

  readonly knobStart = output<void>();
  readonly knobEnd = output<void>();
  readonly valueChange = output<number>();
  readonly reset = output<void>();

  /**
   * `ionInput` carries a `RangeValue`, which is a number for a single-knob
   * range and `{lower, upper}` for a dual one. Narrowing rather than casting
   * means a future `dualKnobs` on this component fails loudly instead of
   * emitting an object where a number is expected.
   */
  protected onInput(event: any): void {
    const value = event?.detail?.value;
    if (typeof value !== 'number') return;
    this.valueChange.emit(value);
  }
}
