import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BLEND_MODES } from '@engine/edit.js';
import { ProjectService } from '../services/project.service';
import { Segmented, SegmentedOption } from './segmented';
import { Slider } from './slider';

/**
 * Photoshop's own grouping of the blend menu.
 *
 * 26 modes in one flat list is a Hick's-law problem. The groups are display
 * metadata — the engine has no label for them — but the MEMBERSHIP is taken
 * from `BLEND_MODES` by filtering, and anything the engine adds that no group
 * claims falls into a final group rather than disappearing from the picker.
 */
const GROUP_ORDER: ReadonlyArray<{ label: string; ids: readonly string[] }> = [
  { label: 'Normal', ids: ['normal'] },
  { label: 'Darken', ids: ['darken', 'multiply', 'color burn', 'linear burn', 'darker color'] },
  { label: 'Lighten', ids: ['lighten', 'screen', 'color dodge', 'linear dodge', 'lighter color'] },
  {
    label: 'Contrast',
    ids: ['overlay', 'soft light', 'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix'],
  },
  { label: 'Comparative', ids: ['difference', 'exclusion', 'subtract', 'divide'] },
  { label: 'Component', ids: ['hue', 'saturation', 'color', 'luminosity'] },
];

const ALL_MODES: string[] = BLEND_MODES;

/**
 * Exported: the Overlay sheet paints a gradient carrying its OWN blend mode,
 * drawn from the same 26. One grouping, or two pickers over one list would
 * teach two different mental models of it.
 */
export const BLEND_GROUPS = (() => {
  const claimed = new Set<string>();
  const groups = GROUP_ORDER.map((group) => {
    const modes = ALL_MODES.filter((mode) => group.ids.includes(mode));
    for (const mode of modes) claimed.add(mode);
    return { label: group.label, modes };
  }).filter((group) => group.modes.length > 0);

  const rest = ALL_MODES.filter((mode) => !claimed.has(mode));
  return rest.length > 0 ? [...groups, { label: 'Other', modes: rest }] : groups;
})();

/** A mode id IS its label — the picker capitalises it, the engine does not. */
export const asOptions = (modes: readonly string[]): SegmentedOption[] =>
  modes.map((mode) => ({ id: mode, label: mode }));

/**
 * Opacity and blend mode for the selected layer.
 *
 * Both are one `setLayer` each. Opacity coalesces under a gesture key so a
 * whole drag is one undo entry; blend mode is a discrete choice and does not.
 */
@Component({
  selector: 'app-layer-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Segmented, Slider],
  template: `
    @if (svc.selected(); as layer) {
      <div class="space-y-5 px-4 py-4">
        <div>
          <p class="truncate text-sm font-medium text-neutral-100">{{ layer.name }}</p>
          <p class="mt-0.5 text-[11px] text-neutral-500">
            {{ layer.x }}, {{ layer.y }} · {{ layer.w }} × {{ layer.h }} px
            @if (layer.sourceW) {
              · source {{ layer.sourceW }} × {{ layer.sourceH }}
            }
          </p>
        </div>

        <app-slider
          label="Opacity"
          [value]="opacityPercent()"
          [min]="0"
          [max]="100"
          [step]="1"
          [readout]="opacityPercent() + '%'"
          (knobStart)="startOpacity()"
          (valueChange)="setOpacity($event)"
          (knobEnd)="endOpacity()"
        />

        <!-- A mask toggle is ABSENT when the layer has none, not disabled.
             Two segments rather than one button whose label IS its state: a
             button reading "On" is read half the time as the state and half the
             time as what tapping it will do. -->
        @if (layer.mask) {
          <div>
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Layer mask
            </p>
            <app-segmented
              ariaLabel="Layer mask"
              [options]="maskOptions"
              [selected]="layer.mask.disabled ? 'off' : 'on'"
              (pick)="setMask(layer, $event)"
            />
          </div>
        }

        <div>
          <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-400">
            Blend mode
          </p>

          <!-- A file can carry a mode the compositor does not implement.
               "dissolve" is the live example: it is drawn as normal. Showing it
               as the current value, and saying it is not supported, beats a
               picker that silently disagrees with the document. -->
          @if (unsupported(); as mode) {
            <div class="mb-3 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
              This layer is set to <b>{{ mode }}</b>, which this editor draws as Normal.
              Choosing another mode cannot be undone from this picker — only by Undo.
            </div>
          }

          <div class="space-y-3">
            @for (group of groups; track group.label) {
              <div>
                <p class="mb-1 text-[10px] uppercase tracking-[0.18em] text-neutral-600">
                  {{ group.label }}
                </p>
                <!-- Wrapping, not scrolling. Every mode in a group was visible
                     at once before this was a shared control and trading that
                     for a tidier row would cost findability to buy tidiness. -->
                <app-segmented
                  variant="scroll"
                  [wrap]="true"
                  [ariaLabel]="group.label + ' blend modes'"
                  [options]="group.options"
                  [selected]="layer.blendMode"
                  (pick)="setBlend(layer, $event)"
                />
              </div>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class LayerSheet {
  protected svc = inject(ProjectService);
  protected readonly groups = BLEND_GROUPS.map((group) => ({
    label: group.label,
    options: asOptions(group.modes),
  }));

  protected readonly maskOptions: SegmentedOption[] = [
    { id: 'on', label: 'On' },
    { id: 'off', label: 'Off' },
  ];

  private opacityKey = signal<string | undefined>(undefined);

  protected readonly opacityPercent = computed(() => {
    const layer = this.svc.selected();
    return layer ? Math.round(layer.opacity * 100) : 100;
  });

  /** The current mode when the picker cannot offer it — `dissolve`, in practice. */
  protected readonly unsupported = computed(() => {
    const layer = this.svc.selected();
    if (!layer) return null;
    return ALL_MODES.includes(layer.blendMode) ? null : layer.blendMode;
  });

  protected startOpacity(): void {
    this.opacityKey.set(this.svc.gestureKey('opacity'));
  }

  protected endOpacity(): void {
    this.opacityKey.set(undefined);
  }

  protected setOpacity(percent: number): void {
    const layer = this.svc.selected();
    if (!layer) return;
    this.svc.setLayer(layer.id, { opacity: percent / 100 }, this.opacityKey());
  }

  protected setBlend(layer: any, mode: string): void {
    this.svc.setLayer(layer.id, { blendMode: mode });
  }

  protected setMask(layer: any, state: string): void {
    const disabled = state === 'off';
    if (!!layer.mask.disabled === disabled) return;
    // The mask object is replaced rather than mutated: `setLayer` captures the
    // previous VALUE for undo, and for an object field that is the same
    // reference — mutating in place destroys the undo entry before it is written.
    this.svc.setLayer(layer.id, { mask: { ...layer.mask, disabled } });
  }
}
