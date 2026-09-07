import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * One adjustment, as a ring that shows its value.
 *
 * WHAT THIS REPLACES, ACCURATELY. The strip here was already a name plus its
 * value — it did not hide anything. What it could not do is let you SCAN:
 * five numbers have to be read one after another and compared in your head,
 * and "+4" against "+34" is a character's difference on screen. An arc is
 * pre-attentive — a long one and a short one separate before you have read
 * either number. The numbers stay for the exact value.
 *
 * So this is a legibility upgrade, not a new capability. Worth being honest
 * about: it costs the same vertical space the strip did.
 *
 * THE ARC IS THE MODIFIED FLAG. At the neutral value there is no arc at all —
 * so "untouched" is the absence of ink rather than a badge that has to be
 * read. That is also why there is no separate dot here: it would say a second
 * time what the arc already says. The rail dot exists because the rail has no
 * room for an arc.
 *
 * NO INVENTED ICONOGRAPHY. The reference designs put a glyph in the ring, but
 * theirs are established by long use. A guessable glyph for "tint" is worse
 * than the number it would replace, so the number stays.
 */
@Component({
  selector: 'app-value-dial',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="flex w-16 shrink-0 flex-col items-center gap-1.5 rounded-xl py-1 active:bg-white/5"
      [attr.aria-pressed]="active()"
      [attr.aria-label]="label() + ', ' + value()"
      (click)="pick.emit()"
    >
      <span class="relative flex h-11 w-11 items-center justify-center">
        <svg viewBox="0 0 44 44" class="absolute inset-0 h-11 w-11" aria-hidden="true">
          <circle
            cx="22" cy="22" [attr.r]="radius"
            fill="none" stroke="currentColor" stroke-width="2"
            [class]="active() ? 'text-white/25' : 'text-white/12'"
          />
          @if (!neutral()) {
            <circle
              cx="22" cy="22" [attr.r]="radius"
              fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
              class="text-accent-400"
              [attr.stroke-dasharray]="dash()"
              [attr.transform]="spin()"
            />
          }
        </svg>

        <span
          class="relative text-[13px] font-medium tabular-nums"
          [class]="active() ? 'text-white' : 'text-neutral-400'"
        >{{ value() }}</span>
      </span>

      <span
        class="max-w-full truncate text-[10px] leading-none"
        [class]="active() ? 'text-accent-400' : 'text-neutral-500'"
      >{{ label() }}</span>
    </button>
  `,
})
export class ValueDial {
  readonly label = input.required<string>();
  readonly value = input.required<number>();
  readonly min = input(-100);
  readonly max = input(100);
  readonly neutralValue = input(0);
  readonly active = input(false);

  readonly pick = output<void>();

  protected readonly radius = RADIUS;

  protected readonly neutral = computed(() => this.value() === this.neutralValue());

  /** How far from neutral, as a fraction of the furthest this control can go. */
  private readonly fraction = computed(() => {
    const span = Math.max(
      Math.abs(this.max() - this.neutralValue()),
      Math.abs(this.neutralValue() - this.min()),
    );
    if (!span) return 0;
    return Math.min(1, Math.abs(this.value() - this.neutralValue()) / span);
  });

  protected readonly dash = computed(() =>
    `${this.fraction() * CIRCUMFERENCE} ${CIRCUMFERENCE}`);

  /**
   * Where the arc starts.
   *
   * An SVG circle's stroke begins at 3 o'clock and runs clockwise, so -90
   * moves the start to the top. A NEGATIVE value should sweep the other way
   * from the top, which is the same shape as sweeping clockwise from a start
   * rolled back by the arc's own length — one number instead of a mirror
   * transform, and it cannot get the winding backwards.
   */
  protected readonly spin = computed(() => {
    const back = this.value() < this.neutralValue() ? this.fraction() * 360 : 0;
    return `rotate(${-90 - back} 22 22)`;
  });
}
