import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PANEL_FILTERS, panelRows } from '@engine/panel.js';
import { ProjectService } from '../services/project.service';
import { Icon } from './icon';
import { ImageActions } from './image-actions';
import { LayerThumb } from './layer-thumb';

/** Row height in CSS px. The reorder drag converts pointer travel into rows with it. */
const ROW_HEIGHT = 64;

/** Human labels for `PANEL_FILTERS`. The engine owns the axes; this owns the words. */
const FILTER_LABELS: Record<string, string> = {
  hidden: 'Hidden',
  text: 'Text',
  masked: 'Masked',
  clipped: 'Clipped',
  blended: 'Blended',
  faded: 'Faded',
  warned: 'Warned',
};

/**
 * The screen that makes this a PSD editor rather than a photo editor.
 *
 * `panelRows` does the whole derivation — top-of-stack-first ordering, search,
 * filters, duplicate-name discriminators, badges, and the empty-versus-
 * filtered-to-zero distinction. This component renders what it returns and
 * decides nothing about it.
 */
@Component({
  selector: 'app-layers-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, ImageActions, LayerThumb],
  styles: [
    `
      .is-selected {
        background-color: rgba(56, 189, 248, 0.12);
      }
    `,
  ],
  template: `
    @if (model(); as panel) {
      <!-- Adding a picture is a STACK operation, so it belongs where the stack
           is owned rather than as a ninth entry on a rail that already scrolls
           off the edge of a phone. Above the sticky search header, not inside
           it: it is the first thing seen when the sheet opens, and it scrolls
           away instead of permanently costing rows on a 60-layer file. -->
      <app-image-actions />

      <!-- Findability first: a 60-layer file is not scrollable by eye. -->
      <div class="sticky top-0 z-10 space-y-3 border-b border-white/10 bg-neutral-900 px-3 py-3">
        <label class="flex h-11 items-center gap-2 rounded-xl bg-white/5 px-3">
          <span class="text-neutral-400"><app-icon name="search" [size]="18" /></span>
          <input
            type="search"
            class="h-11 w-full bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
            placeholder="Search name, group or text"
            [value]="search()"
            (input)="onSearch($event)"
          />
        </label>

        <div class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          @for (id of filterIds; track id) {
            <button
              type="button"
              class="h-11 shrink-0 rounded-full border px-3 text-xs font-medium"
              [class]="
                filters().includes(id)
                  ? 'border-accent-400 bg-accent-400/15 text-accent-300'
                  : 'border-white/15 text-neutral-300'
              "
              (click)="toggleFilter(id)"
            >
              {{ label(id) }}
            </button>
          }
        </div>

        <p class="text-[11px] text-neutral-500">
          {{ panel.shown }} of {{ panel.total }} layers · top of the stack first
        </p>

        <!-- The selection survives filtering rather than being silently dropped,
             so the panel has to offer the way back to it. -->
        @if (panel.selectionHidden) {
          <button
            type="button"
            class="w-full rounded-lg bg-amber-400/10 px-3 py-2 text-left text-xs text-amber-300"
            (click)="clearFilters()"
          >
            The selected layer is hidden by the current filter — clear filters
          </button>
        }
      </div>

      @switch (panel.state) {
        @case ('empty-document') {
          <div class="px-6 py-10 text-center">
            <p class="text-sm text-neutral-300">This PSD has no editable layers.</p>
            <p class="mt-2 text-xs text-neutral-500">
              {{ panel.skippedLeaves }} layer(s) in the file had no pixels or text.
            </p>
          </div>
        }
        @case ('filtered-to-zero') {
          <div class="px-6 py-10 text-center">
            <p class="text-sm text-neutral-300">No layer matches this search and filter.</p>
            <button
              type="button"
              class="mt-3 h-11 rounded-xl bg-white/10 px-4 text-sm text-neutral-100"
              (click)="clearFilters()"
            >
              Clear filters
            </button>
          </div>
        }
        @default {
          <ul class="pb-6">
            @for (row of panel.rows; track row.layer.id; let i = $index) {
              <li
                class="relative flex items-center gap-3 border-b border-white/5 px-3"
                [style.height.px]="rowHeight"
                [class.is-selected]="row.selected"
                [style.transform]="rowTransform(i)"
                [style.zIndex]="dragIndex() === i ? 20 : 0"
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-3 text-left"
                  (click)="svc.select(row.layer.id)"
                >
                  <app-layer-thumb [layer]="row.layer" [size]="40" />

                  <span class="min-w-0 flex-1">
                    <span class="flex items-baseline gap-2">
                      <span class="truncate text-sm font-medium text-neutral-100">{{ row.name }}</span>
                      @if (row.discriminator) {
                        <span class="shrink-0 text-[11px] text-neutral-500">{{ row.discriminator }}</span>
                      }
                    </span>

                    <span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                      @if (row.secondary) {
                        <span class="max-w-[9rem] truncate text-neutral-500">{{ row.secondary }}</span>
                      }
                      @if (row.badges.text) {
                        <span class="rounded bg-white/10 px-1 text-neutral-300">T</span>
                      }
                      @if (row.badges.mask) {
                        <span class="rounded bg-white/10 px-1 text-neutral-300">
                          mask{{ row.badges.maskOff ? ' off' : '' }}
                        </span>
                      }
                      @if (row.badges.clipped) {
                        <span
                          class="rounded bg-amber-400/15 px-1 text-amber-300"
                          [title]="clipTitle(row.clipBase)"
                        >
                          clipped
                        </span>
                      }
                      @if (row.badges.opacity !== null) {
                        <span class="text-neutral-400">{{ row.badges.opacity }}%</span>
                      }
                      @if (row.badges.blendMode) {
                        <span class="text-neutral-400">{{ row.badges.blendMode }}</span>
                      }
                      @if (row.layer.adjust) {
                        <span class="rounded bg-accent-400/15 px-1 text-accent-300">adjusted</span>
                      }
                      @if (row.badges.warned) {
                        <span class="rounded bg-amber-400/15 px-1 text-amber-300">warned</span>
                      }
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-neutral-300 active:bg-white/10"
                  [attr.aria-label]="row.layer.visible ? 'Hide ' + row.name : 'Show ' + row.name"
                  [attr.aria-pressed]="row.layer.visible"
                  (click)="toggleVisible(row.layer)"
                >
                  <app-icon [name]="row.layer.visible ? 'eye' : 'eye-off'" [size]="20" />
                </button>

                <!-- A dedicated grip, not a long-press: long-press adds half a
                     second to every reorder and fights scroll-versus-drag. -->
                <span
                  class="flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-lg"
                  [class]="reorderable() ? 'text-neutral-400' : 'text-neutral-700'"
                  (pointerdown)="onGripDown($event, i, row.index)"
                  (pointermove)="onGripMove($event)"
                  (pointerup)="onGripUp($event)"
                  (pointercancel)="onGripUp($event)"
                >
                  <app-icon name="grip" [size]="18" />
                </span>
              </li>
            }
          </ul>

          @if (!reorderable()) {
            <p class="px-3 pb-6 text-[11px] text-neutral-500">
              Reordering is off while a search or filter is active — the list order
              is the stacking order, and a filtered list does not show it.
            </p>
          }
        }
      }
    }
  `,
})
export class LayersSheet {
  protected svc = inject(ProjectService);

  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly filterIds: string[] = PANEL_FILTERS;

  protected readonly search = signal('');
  protected readonly filters = signal<string[]>([]);

  /** Display position of the row being dragged, and how far it has travelled. */
  protected readonly dragIndex = signal<number | null>(null);
  protected readonly dragOffset = signal(0);
  private dragFromModel = -1;
  private dragStartY = 0;

  protected readonly model = computed(() => {
    this.svc.version();
    const project = this.svc.project();
    if (!project) return null;
    return panelRows(project, {
      search: this.search(),
      filters: this.filters(),
      selectedId: this.svc.selectedId(),
    });
  });

  /**
   * A reorder inside a filtered list would move a layer past rows that are not
   * on screen, which is a stacking change the user did not ask for and cannot
   * see. Off, with the reason shown, beats plausible and wrong.
   */
  protected readonly reorderable = computed(
    () => this.search().trim() === '' && this.filters().length === 0,
  );

  protected label(id: string): string {
    return FILTER_LABELS[id] ?? id;
  }

  protected clipTitle(base: string | null): string {
    return base
      ? `Clipped to "${base}". Clipping is carried but not applied — this layer is drawn in full.`
      : 'Clipped, but there is no layer below to clip to. Photoshop draws it unclipped too.';
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected toggleFilter(id: string): void {
    this.filters.update((current) =>
      current.includes(id) ? current.filter((f) => f !== id) : [...current, id],
    );
  }

  protected clearFilters(): void {
    this.filters.set([]);
    this.search.set('');
  }

  protected toggleVisible(layer: any): void {
    this.svc.setLayer(layer.id, { visible: !layer.visible });
  }

  // ------------------------------------------------------------ reorder

  protected rowTransform(displayIndex: number): string {
    const dragging = this.dragIndex();
    if (dragging === null || dragging !== displayIndex) return 'none';
    return `translateY(${this.dragOffset()}px)`;
  }

  protected onGripDown(event: PointerEvent, displayIndex: number, modelIndex: number): void {
    if (!this.reorderable()) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragIndex.set(displayIndex);
    this.dragFromModel = modelIndex;
    this.dragStartY = event.clientY;
    this.dragOffset.set(0);
  }

  protected onGripMove(event: PointerEvent): void {
    if (this.dragIndex() === null) return;
    this.dragOffset.set(event.clientY - this.dragStartY);
  }

  protected onGripUp(event: PointerEvent): void {
    const from = this.dragIndex();
    if (from === null) return;
    const grip = event.currentTarget as HTMLElement | null;
    if (grip?.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);

    const model = this.model();
    const offset = this.dragOffset();
    this.dragIndex.set(null);
    this.dragOffset.set(0);
    if (!model) return;

    const slot = Math.min(
      model.rows.length - 1,
      Math.max(0, from + Math.round(offset / ROW_HEIGHT)),
    );
    const target = model.rows[slot];
    if (!target) return;

    // One command on drop, never per frame: `reorderLayer` cannot coalesce, and
    // one `from → to` is also what the user thinks they did.
    this.svc.reorder(this.dragFromModel, target.index);
  }
}
