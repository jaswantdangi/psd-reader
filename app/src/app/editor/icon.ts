import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Inline 24x24 stroke paths.
 *
 * Ionicons ships with Ionic, but its `<ion-icon>` needs each glyph registered
 * through `addIcons` and pulls the sprite over the network unless it is. These
 * are a dozen paths in the bundle, work offline in a WebView, and inherit
 * `currentColor` — which is what a tool rail with an active state needs.
 */
const PATHS: Record<string, string> = {
  back: 'M15 5 L8 12 L15 19',
  undo: 'M9 8 L4 12 L9 16 M4 12 H14 a5 5 0 0 1 0 10 H10',
  redo: 'M15 8 L20 12 L15 16 M20 12 H10 a5 5 0 0 0 0 10 H14',
  export: 'M12 3 V15 M8 11 L12 15 L16 11 M4 17 V20 H20 V17',
  warn: 'M12 3 L22 20 H2 Z M12 10 V14 M12 17 V17.5',
  layers: 'M12 3 L3 8 L12 13 L21 8 Z M3 13 L12 18 L21 13 M3 17 L12 22 L21 17',
  layer: 'M4 6 H20 V18 H4 Z M4 12 H20',
  adjust: 'M5 4 V20 M12 4 V20 M19 4 V20 M5 9 h0.01 M12 15 h0.01 M19 7 h0.01',
  filter: 'M12 3 a9 9 0 1 0 0 18 a9 9 0 0 0 0 -18 M12 3 V21 M4 9 H20 M4 15 H20',
  hsl: 'M12 3 a9 9 0 1 0 0 18 a9 9 0 0 0 0 -18 M12 12 V3 M12 12 L19.8 16.5 M12 12 L4.2 16.5',
  overlay: 'M4 5 H14 V15 H4 Z M10 9 H20 V19 H10 Z',
  text: 'M5 7 V5 H19 V7 M12 5 V19 M9 19 H15',
  eye: 'M2 12 s4 -7 10 -7 s10 7 10 7 s-4 7 -10 7 s-10 -7 -10 -7 Z M12 9 a3 3 0 1 0 0 6 a3 3 0 0 0 0 -6',
  'eye-off': 'M4 4 L20 20 M9.5 9.6 a3 3 0 0 0 4.2 4.2 M6.3 6.4 C3.8 8.1 2 12 2 12 s4 7 10 7 c1.8 0 3.4 -0.5 4.7 -1.2 M9.8 5.2 A9.6 9.6 0 0 1 12 5 c6 0 10 7 10 7 a20 20 0 0 1 -3 3.7',
  grip: 'M8 7 h0.01 M8 12 h0.01 M8 17 h0.01 M16 7 h0.01 M16 12 h0.01 M16 17 h0.01',
  close: 'M6 6 L18 18 M18 6 L6 18',
  check: 'M5 13 L9 17 L19 6',
  search: 'M11 4 a7 7 0 1 0 0 14 a7 7 0 0 0 0 -14 M16 16 L21 21',
  fit: 'M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15',
  file: 'M6 3 H14 L19 8 V21 H6 Z M14 3 V8 H19',
  select: 'M4 3 L11 20 L13.5 12.6 L21 10.1 Z',
};

@Component({
  selector: 'app-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      [style.width.px]="size()"
      [style.height.px]="size()"
    >
      <path [attr.d]="d()" />
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<string>();
  readonly size = input(22);
  protected readonly d = computed(() => PATHS[this.name()] ?? '');
}
