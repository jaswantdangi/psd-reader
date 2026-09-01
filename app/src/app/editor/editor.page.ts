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
import { ExportService } from '../services/export.service';
import { FontsService } from '../services/fonts.service';
import { ProjectService } from '../services/project.service';
import { AdjustSheet } from './adjust-sheet';
import { CanvasStage } from './canvas-stage';
import { FilterSheet } from './filter-sheet';
import { FontsSheet } from './fonts-sheet';
import { HslSheet } from './hsl-sheet';
import { Icon } from './icon';
import { LayerSheet } from './layer-sheet';
import { LayersSheet } from './layers-sheet';
import { OverlaySheet } from './overlay-sheet';
import { SheetShell } from './sheet-shell';
import { TextSheet } from './text-sheet';

type SheetId =
  | 'layers' | 'layer' | 'text' | 'adjust' | 'filter' | 'hsl' | 'overlay'
  | 'fonts' | 'warnings' | 'export';

/** The rail carries only tools that work. Phase 4-5 entries are absent, not greyed. */
const RAIL: ReadonlyArray<{ id: SheetId; icon: string; label: string; needsLayer: boolean }> = [
  { id: 'layers', icon: 'layers', label: 'Layers', needsLayer: false },
  { id: 'layer', icon: 'layer', label: 'Layer', needsLayer: true },
  { id: 'text', icon: 'text', label: 'Text', needsLayer: true },
  { id: 'adjust', icon: 'adjust', label: 'Adjust', needsLayer: true },
  { id: 'filter', icon: 'filter', label: 'Filter', needsLayer: true },
  { id: 'hsl', icon: 'hsl', label: 'HSL', needsLayer: true },
  { id: 'overlay', icon: 'overlay', label: 'Overlay', needsLayer: true },
];

/** Sheets whose `✕` rolls their whole session back. The layers sheet has no session. */
const DISCARDABLE: ReadonlyArray<SheetId> = ['layer', 'text', 'adjust', 'filter', 'hsl', 'overlay', 'fonts'];

const TITLES: Record<SheetId, string> = {
  layers: 'Layers',
  layer: 'Layer',
  text: 'Text',
  adjust: 'Adjust',
  filter: 'Filter',
  hsl: 'HSL',
  overlay: 'Overlay',
  fonts: 'Fonts',
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
    FontsSheet,
    HslSheet,
    Icon,
    LayerSheet,
    LayersSheet,
    OverlaySheet,
    SheetShell,
    TextSheet,
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

        <!-- The document-level half of the typeface disclosure. The text sheet
             can only speak for the layer that happens to be selected, so on a
             file with four typefaces it is the user who has to go and find the
             other three by clicking. This is the count of names we cannot draw,
             next to the way to answer them. It goes quiet — not away — once
             every name has a file, because that is when a user wants to check
             what is drawing. -->
        @if (fonts.demand().wanted) {
          <button
            type="button"
            class="flex h-12 items-center gap-1 rounded-xl px-2 active:bg-white/10"
            [class]="fonts.missing() ? 'text-amber-400' : 'text-neutral-500'"
            [attr.aria-label]="fontsLabel()"
            (click)="open('fonts')"
          >
            <app-icon name="text" [size]="20" />
            @if (fonts.missing()) {
              <span class="text-xs font-semibold tabular-nums">{{ fonts.missing() }}</span>
            }
          </button>
        }

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
          <!-- The sheet says an export keeps running after it is closed, so a
               running export has to be visible from outside the sheet or that
               sentence is a claim with nothing behind it. -->
          @if (exporter.running()) {
            <span class="text-[11px] font-semibold tabular-nums">{{ exporter.percent() }}%</span>
          } @else {
            <app-icon name="export" />
          }
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
                @case ('text') { <app-text-sheet /> }
                @case ('adjust') { <app-adjust-sheet /> }
                @case ('filter') { <app-filter-sheet /> }
                @case ('hsl') { <app-hsl-sheet /> }
                @case ('overlay') { <app-overlay-sheet /> }
                @case ('fonts') { <app-fonts-sheet /> }
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
                      <p>Preview composite <b class="text-neutral-200">{{ exportSize() }}</b></p>
                    </div>

                    @if (exporter.running()) {
                      <div class="space-y-3">
                        <div class="flex items-baseline justify-between gap-3">
                          <p class="text-sm text-neutral-200">{{ exporter.phaseLabel() }}…</p>
                          @if (exporter.determinate()) {
                            <span class="text-sm tabular-nums text-neutral-400">
                              {{ exporter.percent() }}%
                            </span>
                          }
                        </div>

                        <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                          @if (exporter.determinate()) {
                            <div
                              class="h-full rounded-full bg-sky-400 transition-[width] duration-150"
                              [style.width.%]="exporter.percent()"
                            ></div>
                          } @else {
                            <!-- The engine marks this phase indeterminate: it is
                                 one synchronous call with no interior yield
                                 point, so a creeping bar here would be invented.
                                 A bar that pretends to move during a freeze is
                                 worse than one that admits it. -->
                            <div class="h-full w-1/3 animate-pulse rounded-full bg-sky-400"></div>
                          }
                        </div>

                        @if (exporter.detail()) {
                          <p class="text-[11px] tabular-nums text-neutral-500">
                            {{ exporter.detail() }} layers
                          </p>
                        } @else if (!exporter.determinate()) {
                          <p class="text-[11px] leading-relaxed text-neutral-500">
                            This step runs in one pass and cannot report progress. It has
                            not stalled.
                          </p>
                        }

                        <button
                          type="button"
                          class="h-12 w-full rounded-xl border border-white/15 text-sm text-neutral-200"
                          (click)="exporter.cancel()"
                        >
                          Cancel
                        </button>
                        <p class="text-[11px] leading-relaxed text-neutral-500">
                          Cancelling stops immediately and writes nothing. The export runs
                          off the main thread, so you can close this sheet and keep
                          editing while it finishes.
                        </p>
                      </div>
                    } @else {
                      @if (!sourceReady()) {
                        <p class="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                          This session no longer holds the original file, so full
                          resolution is unavailable. Reopen the file to export it at
                          document size.
                        </p>
                      }

                      <div class="space-y-2">
                        <button
                          type="button"
                          class="h-12 w-full rounded-xl bg-sky-500 text-sm font-medium text-white disabled:opacity-40"
                          [disabled]="!sourceReady() || exporting()"
                          (click)="exportFull()"
                        >
                          Export at full resolution
                        </button>
                        <!-- Stated in units, before it is started, rather than
                             discovered by watching a spinner. -->
                        <p class="text-[11px] leading-relaxed text-neutral-500">
                          Re-reads the original file and composites every layer at
                          {{ docSize() }}. Measured at 3–4 s on a desktop; estimated
                          12–20 s on a phone.
                        </p>
                      </div>

                      <div class="space-y-2 border-t border-white/10 pt-4">
                        <button
                          type="button"
                          class="h-12 w-full rounded-xl border border-white/15 text-sm text-neutral-200 disabled:opacity-40"
                          [disabled]="exporting()"
                          (click)="exportPng()"
                        >
                          {{ exporting() ? 'Writing…' : 'Quick export at preview size' }}
                        </button>
                        <p class="text-[11px] leading-relaxed text-neutral-500">
                          Writes the preview composite at {{ exportSize() }} — instant, and
                          exactly the pixels on screen. A check, not the finished image.
                        </p>
                      </div>
                    }

                    @if (exporter.note()) {
                      <p
                        class="text-[11px] leading-relaxed"
                        [class]="exporter.failed() ? 'text-red-400' : 'text-neutral-400'"
                      >
                        {{ exporter.note() }}
                      </p>
                    }
                    @if (exporter.spilledToMemory()) {
                      <p class="text-[11px] leading-relaxed text-amber-300">
                        No private filesystem was available, so layers waiting to be
                        blended were held in memory. On a large reordered document that
                        is the shape that runs the device out of memory.
                      </p>
                    }
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
  protected exporter = inject(ExportService);
  protected fonts = inject(FontsService);
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

  /**
   * Full resolution needs the file back, and `project.source.uri` is a
   * synthetic `file://<name>` nothing can open — so the picker's handle is the
   * only route to it. Checked here rather than after a 20-second export.
   */
  protected readonly sourceReady = computed(() => !!this.svc.sourceFile());

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

  /** Spoken form of the fonts chip — the number alone tells a screen reader nothing. */
  protected fontsLabel(): string {
    const missing = this.fonts.missing();
    const wanted = this.fonts.demand().wanted;
    return missing
      ? `${missing} of ${wanted} typefaces in this file are substituted`
      : `Typefaces in this file — all ${wanted} loaded`;
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
    // Closing the document abandons the thing being exported. Leaving the
    // worker alive would hold the file, a copy of the project and a
    // document-sized buffer for a PNG nobody is waiting for any more.
    this.exporter.cancel();
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
    // The font note reports what the LAST pick did. Carrying it into a fresh
    // sheet would report a change that is several actions old as if it had just
    // happened.
    this.fonts.note.set('');
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

  /**
   * The real one: `exportFullRes` re-reads the file and composites every layer
   * at document resolution, in a worker. Nothing about the walk is decided
   * here — this hands the engine a project, a file and a place to spill.
   */
  protected exportFull(): void {
    const project = this.svc.project();
    const file = this.svc.sourceFile();
    if (!project || !file) return;
    this.exportNote.set('');
    this.exporter.start(project, file);
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
