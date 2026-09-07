import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { FontsService } from '../services/fonts.service';

/**
 * The one control that turns a font NAME into a font FILE.
 *
 * A `<label>` wrapping a hidden input rather than a button that clicks one:
 * it is the pattern the rest of this app already uses for picking a PSD, it
 * needs no `ViewChild`, and it keeps the whole 48px box as the tap target
 * instead of just the text inside it.
 *
 * `multiple` on purpose. A family is several files — regular, bold, italic —
 * and a user who has them has them in one folder. Picking them one at a time
 * would mean four trips through the system picker for one typeface.
 *
 * The input's value is cleared after every pick, or choosing the SAME file
 * again — which is exactly what a user does after fixing a corrupt download —
 * fires no `change` event at all.
 */
@Component({
  selector: 'app-font-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label
      class="flex min-h-[48px] w-full cursor-pointer items-center justify-center rounded-xl px-4 text-center text-sm font-medium"
      [class]="tone()"
      [class.pointer-events-none]="fonts.busy()"
      [class.opacity-60]="fonts.busy()"
    >
      {{ fonts.busy() ? 'Reading…' : label() }}
      <input
        type="file"
        class="hidden"
        [accept]="fonts.accept"
        [disabled]="fonts.busy()"
        multiple
        (change)="pick($event)"
      />
    </label>
  `,
})
export class FontPicker {
  protected fonts = inject(FontsService);

  readonly label = input('Load a font file…');
  /** `primary` for the call to action, `quiet` where it sits beside other text. */
  readonly variant = input<'primary' | 'quiet'>('primary');

  protected tone(): string {
    return this.variant() === 'primary'
      ? 'bg-accent-500 text-white'
      : 'border border-white/15 text-neutral-200';
  }

  protected async pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    input.value = '';
    await this.fonts.load(files);
  }
}
