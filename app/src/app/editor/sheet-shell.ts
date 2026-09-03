import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from './icon';

/**
 * The `✕ / TITLE / ✓` header every tool sheet wears.
 *
 * Consistency here is the point: once one sheet's tick means something
 * different from another's, none of them mean anything. So the shell owns the
 * header and the sheet owns only its content.
 *
 * `✓` closes. `✕` asks the page to roll the sheet's whole session back through
 * `discardTo` — nothing bakes in this editor, so there is no apply step for the
 * tick to perform.
 *
 * The border and the lift shadow are the whole of the separation between a
 * sheet and the artwork behind it. Most sheets no longer sit on a dimmed
 * canvas — a tool that repaints the picture cannot be judged through a 50%
 * black wash — so the boundary the Law of Common Region asks for has to be
 * drawn at this edge rather than paid for by tinting everything else.
 */
@Component({
  selector: 'app-sheet-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section
      class="flex w-full flex-col rounded-t-2xl border-t border-white/20 bg-neutral-900 shadow-[0_-18px_48px_rgba(0,0,0,0.7)]"
      [style.max-height]="maxHeight()"
      role="dialog"
      [attr.aria-label]="title()"
    >
      <header class="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-1">
        <button
          type="button"
          class="flex h-12 w-12 items-center justify-center rounded-xl text-neutral-300 active:bg-white/10"
          [attr.aria-label]="cancelLabel()"
          (click)="cancel.emit()"
        >
          <app-icon name="close" />
        </button>

        <h2 class="text-[13px] font-semibold uppercase tracking-[0.18em] text-neutral-200">
          {{ title() }}
        </h2>

        @if (showConfirm()) {
          <button
            type="button"
            class="flex h-12 w-12 items-center justify-center rounded-xl text-sky-400 active:bg-white/10"
            aria-label="Done"
            (click)="confirm.emit()"
          >
            <app-icon name="check" />
          </button>
        } @else {
          <span class="h-12 w-12"></span>
        }
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ng-content />
      </div>
    </section>
  `,
})
export class SheetShell {
  readonly title = input.required<string>();
  /**
   * The layers sheet has no tick. Every change it makes is already committed
   * and undoable, and a confirm that does nothing would teach the user that
   * confirm means nothing on the sheets where it does.
   */
  readonly showConfirm = input(true);
  readonly cancelLabel = input('Close');

  /**
   * How tall the sheet may grow.
   *
   * A CSS length rather than a boolean, because the caller that shrinks it —
   * select mode, which needs canvas left to tap on — is the only thing that
   * knows how much canvas it needs. 72vh is the height every sheet has always
   * had, so the default changes nothing.
   */
  readonly maxHeight = input('72vh');

  readonly cancel = output<void>();
  readonly confirm = output<void>();
}
