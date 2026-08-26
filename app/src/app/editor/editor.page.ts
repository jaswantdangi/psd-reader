import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { renderProject } from '@engine/render.js';
import { isPreviewQuality } from '@engine/view.js';
import { ProjectService } from '../services/project.service';
import { AdjustSheet } from './adjust-sheet';
import { CanvasStage } from './canvas-stage';
import { FilterSheet } from './filter-sheet';
import { Icon } from './icon';
import { LayerSheet } from './layer-sheet';
import { LayersSheet } from './layers-sheet';
import { SheetShell } from './sheet-shell';

type SheetId = 'layers' | 'layer' | 'adjust' | 'filter' | 'warnings' | 'export';

/** The rail carries only tools that work. Phase 4-5 entries are absent, not greyed. */
const RAIL: ReadonlyArray<{ id: SheetId; icon: string; label: string; needsLayer: boolean }> = [
  { id: 'layers', icon: 'layers', label: 'Layers', needsLayer: false },
  { id: 'layer', icon: 'layer', label: 'Layer', needsLayer: true },
  { id: 'adjust', icon: 'adjust', label: 'Adjust', needsLayer: true },
  { id: 'filter', icon: 'filter', label: 'Filter', needsLayer: true },
];

/** Sheets whose `✕` rolls their whole session back. The layers sheet has no session. */
const DISCARDABLE: ReadonlyArray<SheetId> = ['layer', 'adjust', 'filter'];

const TITLES: Record<SheetId, string> = {
  layers: 'Layers',
  layer: 'Layer',
  adjust: 'Adjust',
  filter: 'Filter',
  warnings: 'This file',
  export: 'Export',
};

@Component({
  selector: 'app-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdjustSheet,
    CanvasStage,
    FilterSheet,
    Icon,
    LayerSheet,
    LayersSheet,
    SheetShell,
  ],
  template: `
    <div class="fixed inset-0 flex flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <!-- ── top bar ─────────────────────────────────────────────── -->
      <header
        class="flex min-h-[56px] shrink-0 items-center gap-1 border-b border-white/10 bg-neutral-900 px-1"
        style="padding-top: env(safe-area-inset-top)"
      >
        <button
          type="button"
          class="flex h-12 w-12 items-center justify-center rounded-xl text-neutral-300 active:bg-white/10"
          aria-label="Close document"
          (click)="back()"
        >
          <app-icon name="back" />
        </button>

        <button
          type="button"
          class="flex h-12 w-12 items-center justify-center rounded-xl active:bg-white/10 disabled:opacity-30"
          aria-label="Undo"
          [disabled]="!svc.canUndo()"
          (click)="svc.undo()"
        >
          <app-icon name="undo" />
        </button>

        <button
          type="button"
          class="flex h-12 w-12 items-center justify-center rounded-xl active:bg-white/10 disabled:opacity-30"
          aria-label="Redo"
          [disabled]="!svc.canRedo()"
          (click)="svc.redo()"
        >
          <app-icon name="redo" />
        </button>

        <span class="mx-1 min-w-0 flex-1 truncate text-center text-[13px] text-neutral-400">
          {{ svc.fileName() || 'No document' }}
        </span>

        <!-- Permanent, never a toast: these are properties of the file, and a
             toast that vanished is indistinguishable from one nobody read. -->
        @if (svc.warnings().length) {
          <button
            type="button"
            class="flex h-12 items-center gap-1 rounded-xl px-2 text-amber-400 active:bg-white/10"
            [attr.aria-label]="svc.warnings().length + ' notes about this file'"
            (click)="open('warnings')"
          >
            <app-icon name="warn" [size]="20" />
            <span class="text-xs font-semibold tabular-nums">{{ svc.warnings().length }}</span>
          </button>
        }

        <button
          type="button"
          class="flex h-12 w-12 items-center justify-center rounded-xl text-sky-400 active:bg-white/10 disabled:opacity-30"
          aria-label="Export"
          [disabled]="svc.state() !== 'ready'"
          (click)="open('export')"
        >
          <app-icon name="export" />
        </button>
      </header>

      <!-- ── stage ───────────────────────────────────────────────── -->
      <main class="relative min-h-0 flex-1">
        @switch (svc.state()) {
          @case ('ready') {
            <app-canvas-stage />

            <div class="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-2">
              @if (previewQuality()) {
                <span class="rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-amber-300">
                  {{ zoomLabel() }} · preview quality
                </span>
              }
              @if (svc.previewPill(); as pill) {
                <span class="rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-amber-300">
                  {{ pill }}
                </span>
              }
            </div>

            <button
              type="button"
              class="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-xl bg-black/60 text-neutral-200 active:bg-black/80"
              aria-label="Fit to screen"
              (click)="stage()?.fit()"
            >
              <app-icon name="fit" [size]="20" />
            </button>

            <!-- The selection HUD lives low, inside one-handed reach. -->
            @if (svc.selected(); as layer) {
              <button
                type="button"
                class="absolute bottom-3 left-3 flex max-w-[85%] items-center gap-2 rounded-xl bg-black/70 px-3 py-2 text-left"
                (click)="open('layer')"
              >
                <span class="max-w-[9rem] truncate text-xs text-neutral-200">{{ layer.name }}</span>
                <span class="text-xs tabular-nums text-neutral-400">
                  {{ percent(layer.opacity) }}%
                </span>
                <span class="text-xs capitalize text-neutral-400">{{ layer.blendMode }}</span>
              </button>
            }
          }

          @case ('loading') {
            <div class="flex h-full flex-col items-center justify-center gap-4 px-8">
              <p class="text-sm text-neutral-300">Reading {{ svc.fileName() }}…</p>
              <div class="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/10">
                <div
                  class="h-full rounded-full bg-sky-400 transition-[width] duration-150"
                  [style.width.%]="progressPercent()"
                ></div>
              </div>
              <p class="text-xs text-neutral-500">
                @if (svc.total()) {
                  {{ svc.decoded() }} of {{ svc.total() }} layers decoded
                } @else {
                  Opening the file…
                }
              </p>
            </div>
          }

          @case ('refused') {
            <!-- No "try anyway": an out-of-memory WebView is a blank screen,
                 which is the failure the guard exists to prevent. -->
            <div class="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <span class="text-amber-400"><app-icon name="warn" [size]="32" /></span>
              <p class="text-sm text-neutral-200">{{ svc.message() }}</p>
              <label class="h-12 cursor-pointer rounded-xl bg-sky-500 px-5 text-sm font-medium leading-[3rem] text-white">
                Pick a smaller file
                <input type="file" class="hidden" accept=".psd,.psb" (change)="onPick($event)" />
              </label>
            </div>
          }

          @case ('error') {
            <div class="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <p class="text-sm text-red-400">{{ svc.message() }}</p>
              <p class="text-xs text-neutral-500">{{ svc.fileName() }}</p>
              <label class="h-12 cursor-pointer rounded-xl bg-white/10 px-5 text-sm leading-[3rem] text-neutral-100">
                Pick another file
                <input type="file" class="hidden" accept=".psd,.psb" (change)="onPick($event)" />
              </label>
            </div>
          }

          @default {
            <div class="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
              <span class="text-neutral-600"><app-icon name="file" [size]="40" /></span>
              <div>
                <p class="text-base font-medium text-neutral-200">Open a PSD</p>
                <p class="mt-1 text-xs text-neutral-500">
                  Layers stay separate. Nothing is flattened, and nothing is written
                  back to your file.
                </p>
              </div>
              <label class="h-12 cursor-pointer rounded-xl bg-sky-500 px-5 text-sm font-medium leading-[3rem] text-white">
                Choose file
                <input type="file" class="hidden" accept=".psd,.psb" (change)="onPick($event)" />
              </label>
            </div>
          }
        }
      </main>

      <!-- ── tool rail ───────────────────────────────────────────── -->
      @if (svc.state() === 'ready') {
        <nav
          class="flex min-h-[80px] shrink-0 items-stretch gap-1 overflow-x-auto border-t border-white/10 bg-neutral-900 px-2"
          style="padding-bottom: env(safe-area-inset-bottom)"
        >
          @for (tool of rail; track tool.id) {
            <button
              type="button"
              class="flex w-20 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl"
              [class]="sheet() === tool.id ? 'bg-white/10 text-sky-300' : 'text-neutral-300'"
              (click)="openTool(tool)"
            >
              <app-icon [name]="tool.icon" />
              <span class="text-[11px]">{{ tool.label }}</span>
            </button>
          }
        </nav>
      }

      <!-- ── sheets ──────────────────────────────────────────────── -->
      @if (sheet(); as id) {
        <div
          class="absolute inset-0 z-30 flex flex-col justify-end bg-black/50"
          (click)="dismiss()"
        >
          <!-- Stop a tap inside the sheet reaching the backdrop. -->
          <div (click)="$event.stopPropagation()">
            <app-sheet-shell
              [title]="titleOf(id)"
              [showConfirm]="id !== 'layers'"
              [cancelLabel]="discardable(id) ? 'Discard changes' : 'Close'"
              (cancel)="cancel(id)"
              (confirm)="close()"
            >
              @switch (id) {
                @case ('layers') {
                  @if (prompt()) {
                    <p class="border-b border-white/10 bg-sky-400/10 px-4 py-3 text-xs text-sky-300">
                      {{ prompt() }}
                    </p>
                  }
                  <app-layers-sheet />
                }
                @case ('layer') { <app-layer-sheet /> }
                @case ('adjust') { <app-adjust-sheet /> }
                @case ('filter') { <app-filter-sheet /> }
                @case ('warnings') {
                  <ul class="divide-y divide-white/5">
                    @for (warning of svc.warnings(); track $index) {
                      <li class="px-4 py-3 text-xs leading-relaxed text-neutral-300">{{ warning }}</li>
                    }
                  </ul>
                  <p class="px-4 py-3 text-[11px] text-neutral-500">
                    These describe what this editor does differently from Photoshop for
                    this file. They cannot be dismissed because they do not go away.
                  </p>
                }
                @case ('export') {
                  <div class="space-y-4 px-4 py-4">
                    <div class="space-y-1 text-xs text-neutral-400">
                      <p>Document <b class="text-neutral-200">{{ docSize() }}</b></p>
                      <p>This export <b class="text-neutral-200">{{ exportSize() }}</b></p>
                    </div>
                    <!-- Said plainly rather than discovered afterwards: the
                         resident pixels ARE the proxy, so this is what there is
                         to write. Full-resolution export re-reads the file and
                         is not wired into this screen yet. -->
                    <p class="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                      This writes the preview composite at proxy resolution, not the
                      document's full resolution. Full-resolution export re-reads the
                      source file and is not connected to this screen yet.
                    </p>
                    <button
                      type="button"
                      class="h-12 w-full rounded-xl bg-sky-500 text-sm font-medium text-white disabled:opacity-40"
                      [disabled]="exporting()"
                      (click)="exportPng()"
                    >
                      {{ exporting() ? 'Writing…' : 'Save PNG' }}
                    </button>
                    @if (exportNote()) {
                      <p class="text-[11px] text-neutral-400">{{ exportNote() }}</p>
                    }
                  </div>
                }
              }
            </app-sheet-shell>
          </div>
        </div>
      }
    </div>
  `,
})
export class EditorPage {
  protected svc = inject(ProjectService);
  protected stage = viewChild(CanvasStage);

  protected readonly rail = RAIL;

  protected readonly sheet = signal<SheetId | null>(null);
  protected readonly prompt = signal('');
  protected readonly exporting = signal(false);
  protected readonly exportNote = signal('');

  /** History length when the open sheet started, so `✕` can roll back to it. */
  private sessionStart = 0;

  protected readonly progressPercent = computed(() => {
    const total = this.svc.total();
    if (!total) return 4;
    return Math.max(4, Math.round((this.svc.decoded() / total) * 100));
  });

  protected readonly previewQuality = computed(() => {
    const project = this.svc.project();
    return project ? isPreviewQuality(this.svc.view(), project.proxyScale) : false;
  });

  protected readonly zoomLabel = computed(() => {
    const project = this.svc.project();
    if (!project) return '';
    return `${(this.svc.view().docScale / project.proxyScale).toFixed(1)}×`;
  });

  protected readonly docSize = computed(() => {
    const project = this.svc.project();
    return project ? `${project.width} × ${project.height}` : '—';
  });

  protected readonly exportSize = computed(() => {
    const project = this.svc.project();
    if (!project) return '—';
    const width = Math.max(1, Math.round(project.width * project.proxyScale));
    const height = Math.max(1, Math.round(project.height * project.proxyScale));
    return `${width} × ${height}`;
  });

  protected percent(value: number): number {
    return Math.round(value * 100);
  }

  protected titleOf(id: SheetId): string {
    return TITLES[id];
  }

  protected discardable(id: SheetId): boolean {
    return DISCARDABLE.includes(id);
  }

  protected async onPick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Clear the input so picking the SAME file twice still fires a change event.
    input.value = '';
    if (!file) return;
    this.sheet.set(null);
    await this.svc.open(file);
  }

  protected back(): void {
    this.sheet.set(null);
    this.svc.close();
  }

  /**
   * A tool that needs a target asks for one where targets are chosen, rather
   * than opening a sheet whose every control is disabled.
   */
  protected openTool(tool: { id: SheetId; needsLayer: boolean }): void {
    if (tool.needsLayer && !this.svc.selected()) {
      this.prompt.set('Pick a layer first — this tool works on one layer at a time.');
      this.open('layers');
      return;
    }
    this.open(tool.id);
  }

  protected open(id: SheetId): void {
    if (id !== 'layers') this.prompt.set('');
    this.exportNote.set('');
    this.sessionStart = this.svc.historyLength();
    this.sheet.set(id);
  }

  protected close(): void {
    this.sheet.set(null);
    this.prompt.set('');
  }

  /** Tapping the backdrop is a close, never a discard — it is too easy to hit. */
  protected dismiss(): void {
    this.close();
  }

  protected cancel(id: SheetId): void {
    // Nothing bakes in this editor, so there is no apply step for `✓` to run.
    // `✕` therefore has to mean "undo this whole sheet's session", however many
    // sliders it touched — one action, and not left on the redo stack where the
    // user would find it again by accident.
    if (this.discardable(id)) this.svc.discardTo(this.sessionStart);
    this.close();
  }

  protected exportPng(): void {
    const project = this.svc.project();
    if (!project || this.exporting()) return;
    this.exporting.set(true);
    this.exportNote.set('');

    try {
      // scale: project.proxyScale — layer geometry is in document coordinates,
      // so this is what draws the resident proxy pixels at their natural size.
      const buffer = renderProject(project, { scale: project.proxyScale });

      const canvas = document.createElement('canvas');
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser refused a 2D canvas context.');

      const image = context.createImageData(buffer.width, buffer.height);
      image.data.set(buffer.data);
      context.putImageData(image, 0, 0);

      canvas.toBlob((blob) => {
        this.exporting.set(false);
        if (!blob) {
          this.exportNote.set('The browser could not encode the PNG.');
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = project.fileName.replace(/\.psd$|\.psb$/i, '') + '.png';
        link.click();
        URL.revokeObjectURL(url);
        this.exportNote.set(`Saved ${link.download} · ${Math.round(blob.size / 1024)} KB`);
      }, 'image/png');
    } catch (error: any) {
      this.exporting.set(false);
      this.exportNote.set(error?.message ?? String(error));
    }
  }
}
