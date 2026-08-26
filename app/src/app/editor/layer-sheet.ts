import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BLEND_MODES } from '@engine/edit.js';
import { ProjectService } from '../services/project.service';
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

const GROUPS = (() => {
  const claimed = new Set<string>();
  const groups = GROUP_ORDER.map((group) => {
    const modes = ALL_MODES.filter((mode) => group.ids.includes(mode));
    for (const mode of modes) claimed.add(mode);
    return { label: group.label, modes };
  }).filter((group) => group.modes.length > 0);

  const rest = ALL_MODES.filter((mode) => !claimed.has(mode));
  return rest.length > 0 ? [...groups, { label: 'Other', modes: rest }] : groups;
})();

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
  imports: [Slider],
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

        <!-- A mask toggle is ABSENT when the layer has none, not disabled. -->
        @if (layer.mask) {
          <label class="flex min-h-[44px] items-center justify-between gap-3">
            <span class="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Layer mask
            </span>
            <button
              type="button"
              class="h-11 rounded-xl border px-4 text-sm"
              [class]="
                layer.mask.disabled
                  ? 'border-white/15 text-neutral-400'
                  : 'border-sky-400 bg-sky-400/15 text-sky-300'
              "
              (click)="toggleMask(layer)"
            >
              {{ layer.mask.disabled ? 'Off' : 'On' }}
            </button>
          </label>
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
                <div class="flex flex-wrap gap-2">
                  @for (mode of group.modes; track mode) {
                    <button
                      type="button"
                      class="h-11 rounded-xl border px-3 text-sm capitalize"
                      [class]="
                        layer.blendMode === mode
                          ? 'border-sky-400 bg-sky-400/15 text-sky-300'
                          : 'border-white/15 text-neutral-300'
                      "
                      (click)="setBlend(layer, mode)"
                    >
                      {{ mode }}
                    </button>
                  }
                </div>
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
  protected readonly groups = GROUPS;

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

  protected toggleMask(layer: any): void {
    // The mask object is replaced rather than mutated: `setLayer` captures the
    // previous VALUE for undo, and for an object field that is the same
    // reference — mutating in place destroys the undo entry before it is written.
    this.svc.setLayer(layer.id, {
      mask: { ...layer.mask, disabled: !layer.mask.disabled },
    });
  }
}
