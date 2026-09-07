import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SheetShell } from './sheet-shell';
import { Segmented, type SegmentedOption } from './segmented';
import { Icon } from './icon';
import { CropService } from '../services/crop.service';
import { ProjectService } from '../services/project.service';
import { ASPECT_RATIOS } from '@engine/frame/index.js';

/**
 * The crop sheet: a row of ratio chips, the cost of the crop, and Apply.
 *
 * The engine has had `setFrame`, the ratio presets and `framingReport` since
 * before this branch, and nothing in the app had ever reached them. This sheet
 * is the whole of what was missing.
 *
 * `✓` APPLIES here, which is the one place in this editor a tick means more
 * than "close". Everywhere else nothing bakes, so there is nothing to confirm;
 * a crop is pending until it is not, so the tick has a job. The shell's `✕` is
 * Cancel rather than a `discardTo` rollback for the same reason — there is no
 * history to roll back, because nothing was committed.
 */
@Component({
  selector: 'app-crop-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SheetShell, Segmented, Icon],
  template: `
    <app-sheet-shell
      title="Crop"
      cancelLabel="Cancel crop"
      maxHeight="46vh"
      (cancel)="crop.cancel()"
      (confirm)="crop.apply()"
    >
      <div class="flex flex-col gap-4 px-4 pb-6 pt-4">
        <app-segmented
          ariaLabel="Aspect ratio"
          variant="scroll"
          [options]="ratios()"
          [selected]="crop.ratioId()"
          (pick)="crop.chooseRatio($event)"
        />

        <p class="text-[13px] text-neutral-400">{{ size() }}</p>

        @for (warning of crop.warnings(); track warning) {
          <p class="flex gap-2 text-[13px] leading-relaxed text-amber-300">
            <app-icon name="warn" class="mt-0.5 shrink-0" />
            <span>{{ warning }}</span>
          </p>
        }
      </div>
    </app-sheet-shell>
  `,
})
export class CropSheet {
  protected readonly crop = inject(CropService);
  private readonly svc = inject(ProjectService);

  protected readonly ratios = computed<SegmentedOption[]>(() =>
    (ASPECT_RATIOS as ReadonlyArray<{ id: string; label: string }>)
      .map((preset) => ({ id: preset.id, label: preset.label })));

  /**
   * The result in pixels, next to the chips.
   *
   * A ratio chip says the shape; only this says whether the crop is about to
   * leave a usable image. Both matter and neither implies the other.
   */
  protected readonly size = computed(() => {
    this.svc.version();
    const r = this.crop.rect();
    return `${Math.round(r.width)} × ${Math.round(r.height)} px`;
  });
}
