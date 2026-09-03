import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NEUTRAL_ADJUST, isNeutralHsl, isNeutralOverlay } from '@engine/adjust/ops.js';
import { PRESETS, presetAdjust } from '@engine/adjust/presets.js';
import { ProjectService } from '../services/project.service';
import { LayerThumb } from './layer-thumb';
import { Segmented, SegmentedOption } from './segmented';
import { Slider } from './slider';

const NEUTRAL = NEUTRAL_ADJUST as Record<string, any>;

/**
 * A preset is a named bundle of the same parameters the Adjust sheet exposes —
 * not a separate mechanism — so every chip is editable afterwards and every
 * chip costs exactly what a manual adjustment costs.
 *
 * Each chip previews the preset on THE USER'S OWN LAYER, through the same
 * `drawLayerInto` the canvas uses. A stock sample image would show a look the
 * user cannot map onto their picture. The previews are built at full strength;
 * intensity moves the applied value, not the swatches, so a drag does not
 * repaint fourteen thumbnails per frame.
 */
@Component({
  selector: 'app-filter-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LayerThumb, Segmented, Slider],
  template: `
    @if (svc.selected(); as layer) {
      <div class="space-y-4 py-4">
        <!-- presetAdjust returns a COMPLETE adjustment: createAdjust fills hsl
             and overlay with null when the preset does not define them, so
             applying one replaces whatever the HSL and Overlay sheets put
             there. That was invisible while those sheets did not exist. It is
             not a silent loss if it is said before the tap. -->
        @if (replaces()) {
          <p class="mx-4 rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
            Choosing a filter here — or None — replaces this layer's
            {{ replaces() }} settings. Undo restores them.
          </p>
        }

        <!-- Every tile previews the preset on THE USER'S OWN LAYER, through the
             same drawLayerInto the canvas uses. -->
        <ng-template #preview let-option>
          <app-layer-thumb [layer]="layer" [size]="56" [previewAdjust]="adjustFor(option.id)" />
        </ng-template>

        <!-- Hick's law: fifteen tiles in one undifferentiated row is a scan, not
             a choice. The split is not invented for the sake of splitting — it
             is the one the engine already draws, and it is the one that costs
             the user something: nine of these fold into the same lookup table
             the Adjust sheet builds, and five carry an HSL block that is
             evaluated per pixel. Naming that here is the only place a user can
             learn it before their phone tells them on a 40-megapixel layer. -->
        <div class="space-y-4 px-4">
          <div>
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Looks
            </p>
            <app-segmented
              variant="scroll"
              ariaLabel="Filter"
              [options]="plain"
              [selected]="highlight()"
              [media]="preview"
              (pick)="choose(layer, $event)"
            />
          </div>

          <div>
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Colour shift
              <span class="ml-1 font-normal normal-case tracking-normal text-neutral-500">
                — slower on a large layer
              </span>
            </p>
            <app-segmented
              variant="scroll"
              ariaLabel="Colour-shift filter"
              [options]="shifting"
              [selected]="highlight()"
              [media]="preview"
              (pick)="choose(layer, $event)"
            />
          </div>
        </div>

        <div class="px-4">
          @if (highlight() === null) {
            <!-- Silently keeping a chip highlighted after the numbers moved
                 would claim a look they are no longer. -->
            <p class="text-[11px] text-amber-300">
              Custom — the parameters were changed after this filter was applied.
            </p>
          } @else if (highlight() !== 'none') {
            <app-slider
              label="Strength"
              [value]="intensityPercent()"
              [min]="0"
              [max]="100"
              [step]="1"
              [readout]="intensityPercent() + '%'"
              (knobStart)="startDrag()"
              (valueChange)="setIntensity(layer, $event)"
              (knobEnd)="endDrag()"
            />
          } @else {
            <p class="text-[11px] text-neutral-500">
              Filters apply to the selected layer only, and stay editable in Adjust.
            </p>
          }
        </div>
      </div>
    }
  `,
})
export class FilterSheet {
  protected svc = inject(ProjectService);

  /**
   * Built once: `presetAdjust` at full strength is what each swatch shows.
   *
   * The adjustments are held in a Map and read back by id rather than carried
   * on the option, so a tile's `previewAdjust` is the SAME object on every
   * change detection pass and fourteen thumbnails do not redraw when an
   * unrelated signal moves.
   */
  private readonly adjusts = ((): Map<string, any> => {
    const map = new Map<string, any>([['none', NEUTRAL]]);
    for (const preset of PRESETS as any[]) map.set(preset.id, presetAdjust(preset.id, 1));
    return map;
  })();

  /** The nine that fold into the lookup table — a table lookup per pixel. */
  protected readonly plain: SegmentedOption[] = [
    { id: 'none', label: 'None' },
    ...(PRESETS as any[])
      .filter((preset) => !preset.hsl)
      .map((preset) => ({ id: preset.id as string, label: preset.label as string })),
  ];

  /** The five that also carry an HSL block — the expensive per-pixel pass. */
  protected readonly shifting: SegmentedOption[] = (PRESETS as any[])
    .filter((preset) => preset.hsl)
    .map((preset) => ({ id: preset.id as string, label: preset.label as string }));

  protected readonly chosen = signal<string>('none');
  protected readonly intensityPercent = signal(100);
  private dragKey = signal<string | undefined>(undefined);
  private syncedFor: number | null = null;

  constructor() {
    // Adopt whatever the newly selected layer already carries, once per layer.
    // `presetAdjust`'s intensity is not stored on the model — it is a scale
    // applied before the object is built — so it restarts at full strength and
    // the sheet does not pretend to know a number it cannot read back.
    effect(() => {
      const layer = this.svc.selected();
      if (!layer || this.syncedFor === layer.id) return;
      this.syncedFor = layer.id;
      this.chosen.set(layer.adjust?.preset ?? 'none');
      this.intensityPercent.set(100);
    });
  }

  /** What a preset would overwrite, named. Empty when there is nothing to lose. */
  protected readonly replaces = computed(() => {
    this.svc.version();
    const adjust = this.svc.selected()?.adjust;
    if (!adjust) return '';
    const parts: string[] = [];
    if (adjust.hsl && !isNeutralHsl(adjust.hsl)) parts.push('HSL');
    if (adjust.overlay && !isNeutralOverlay(adjust.overlay)) parts.push('overlay');
    return parts.join(' and ');
  });

  /** The chip to light up. `null` means the parameters have drifted from any preset. */
  protected readonly highlight = computed<string | null>(() => {
    this.svc.version();
    const layer = this.svc.selected();
    const preset = layer?.adjust?.preset ?? 'none';
    if (preset === 'custom') return null;
    return this.chosen();
  });

  protected adjustFor(id: string): any {
    return this.adjusts.get(id) ?? NEUTRAL;
  }

  /** One handler for both rows. `none` is a clear, everything else an apply. */
  protected choose(layer: any, id: string): void {
    if (id === 'none') this.clear(layer);
    else this.apply(layer, id);
  }

  protected apply(layer: any, id: string): void {
    this.chosen.set(id);
    this.intensityPercent.set(100);
    // Spread the frozen object: `createAdjust` rebuilds and re-freezes it, and
    // handing a frozen object straight to `setLayer` would make its undo entry
    // and its new value the same reference.
    this.svc.setAdjust(layer.id, { ...presetAdjust(id, 1) });
  }

  protected clear(layer: any): void {
    this.chosen.set('none');
    this.intensityPercent.set(100);
    this.svc.setAdjust(layer.id, { ...NEUTRAL });
  }

  protected startDrag(): void {
    this.dragKey.set(this.svc.gestureKey('filter'));
  }

  protected endDrag(): void {
    this.dragKey.set(undefined);
  }

  protected setIntensity(layer: any, percent: number): void {
    const id = this.chosen();
    if (id === 'none') return;
    this.intensityPercent.set(percent);
    this.svc.setAdjust(layer.id, { ...presetAdjust(id, percent / 100) }, this.dragKey());
  }
}
