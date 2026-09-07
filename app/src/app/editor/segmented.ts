import { ChangeDetectionStrategy, Component, TemplateRef, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

/**
 * One option in a segmented control.
 *
 * Deliberately thin. Anything richer than a label, a readout and a "this one
 * carries an edit" dot is drawn by the caller's own `media` template, so this
 * type never grows a field for one sheet's special case.
 */
export type SegmentedOption = {
  id: string;
  label: string;
  /** A second line under the label — a value readout, never a description. */
  note?: string;
  /** A corner dot: this option carries an edit worth finding again. */
  marked?: boolean;
  disabled?: boolean;
};

/**
 * Every segment, in both variants, is this string plus a width rule plus a
 * selection state. That is the whole point of the component: the height, the
 * radius, the border, the padding, the gap and the focus ring cannot drift
 * between sheets, because there is one copy of them.
 *
 * min-h-[48px] rather than the h-11 (44px) these controls used to be: 44 is the
 * floor, not a target, and a segment carrying a swatch or a readout needs the
 * headroom anyway.
 */
const BASE =
  'relative flex min-h-[48px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl ' +
  'border px-3 py-1.5 text-[12px] leading-none transition-colors disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/70';

const SELECTED = 'border-accent-400 bg-accent-400/15 text-accent-300';
const UNSELECTED = 'border-white/15 text-neutral-300';

/**
 * Pick one of N.
 *
 * Four sheets had four different answers to that question — 60px tiles with a
 * dot, 68px thumbnails with a transparent border, full-width 44px segments, and
 * 44px chips with two different paddings in one file. Same function, four
 * appearances, and every new sheet was going to invent a fifth. It already had:
 * the Adjust sheet was the fifth and the Text sheet's alignment row the sixth.
 *
 * ## Two variants, one control
 *
 * - `fill` — equal-width segments sharing the row. For a handful of options
 *   whose labels are short: overlay kinds, image fits, text alignment, on/off.
 * - `scroll` — a row of fixed-minimum tiles that scrolls sideways, optionally
 *   wrapping instead. For many options, or options that carry a thumbnail:
 *   filter presets, HSL bands, adjust parameters, blend modes.
 *
 * They differ ONLY in how the track lays its children out. Selection state,
 * height, radius, padding, gap, label size, the edited-dot and the focus ring
 * are the same string in both, so a user who learns what a chosen segment looks
 * like in one sheet has learnt it everywhere.
 *
 * ## What it does not do
 *
 * Single select. A multi-select chip strip (the Layers sheet's filters) and an
 * independent toggle (the Text sheet's B and I) are different interactions and
 * must not be made to look like this one.
 */
@Component({
  selector: 'app-segmented',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  // The host is a flex item in the fill variant and a plain block elsewhere.
  // Left inline it would be an inline box wrapping a block one.
  styles: [':host { display: block; }'],
  template: `
    <div [class]="trackClass()" role="group" [attr.aria-label]="ariaLabel() || null">
      @for (option of options(); track option.id) {
        <button
          type="button"
          [class]="segmentClass(option)"
          [attr.aria-pressed]="option.id === selected()"
          [disabled]="!!option.disabled"
          (click)="pick.emit(option.id)"
        >
          @if (media(); as tpl) {
            <ng-container
              [ngTemplateOutlet]="tpl"
              [ngTemplateOutletContext]="{ $implicit: option }"
            ></ng-container>
          }

          <span class="max-w-full truncate capitalize">{{ option.label }}</span>

          @if (option.note) {
            <span class="max-w-full truncate text-[11px] tabular-nums opacity-70">
              {{ option.note }}
            </span>
          }

          @if (option.marked) {
            <span
              class="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent-400"
              aria-hidden="true"
            ></span>
          }
        </button>
      }
    </div>
  `,
})
export class Segmented {
  readonly options = input.required<readonly SegmentedOption[]>();

  /** `null` is a real state: the parameters have drifted off every option. */
  readonly selected = input<string | null>(null);

  readonly variant = input<'fill' | 'scroll'>('fill');

  /**
   * Scroll variant only: wrap onto more lines instead of scrolling sideways.
   *
   * Used by the blend-mode groups, which had every mode visible at once before
   * this component existed. Trading that for a scroll row would have been a
   * findability regression paid for with consistency, so it is not traded.
   */
  readonly wrap = input(false);

  readonly ariaLabel = input('');

  /**
   * Drawn above the label, once per option, with the option as `$implicit`.
   * The filter sheet's per-preset thumbnail and the HSL sheet's band swatch go
   * through here rather than being fields on the option.
   */
  readonly media = input<TemplateRef<any> | null>(null);

  readonly pick = output<string>();

  protected trackClass(): string {
    if (this.variant() === 'fill') return 'flex gap-2';
    if (this.wrap()) return 'flex flex-wrap gap-2';
    // Bleeds to the sheet's edge so the last tile is cut by the screen rather
    // than by a margin — which is the only cue that the row scrolls at all.
    return '-mx-4 flex gap-2 overflow-x-auto px-4 pb-1';
  }

  protected segmentClass(option: SegmentedOption): string {
    const width = this.variant() === 'fill' ? 'min-w-0 flex-1 basis-0' : 'min-w-[76px]';
    const state = option.id === this.selected() ? SELECTED : UNSELECTED;
    return `${BASE} ${width} ${state}`;
  }
}
