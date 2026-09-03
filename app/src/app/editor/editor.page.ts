import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { BUNDLE_FILE_ACCEPT } from '@engine/bundle.js';
import { renderProject } from '@engine/render.js';
import { isPreviewQuality } from '@engine/view.js';
import { BundleService } from '../services/bundle.service';
import { ExportService } from '../services/export.service';
import { FontsService } from '../services/fonts.service';
import { ProjectService } from '../services/project.service';
import { SegmentService } from '../services/segment.service';
import { AdjustSheet } from './adjust-sheet';
import { CanvasStage } from './canvas-stage';
import { CutoutPanel } from './cutout-panel';
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

/**
 * Sheets that change what the canvas looks like while they are open.
 *
 * A sheet that changes the canvas must never obscure the canvas. Every control
 * on these exists to be judged against the picture, so a 50% black wash over it
 * is not a focus aid — it is the tool not working. The Layers sheet is here for
 * the same reason: hiding, reordering and adding a layer all redraw the
 * document, and a reorder you cannot see the result of is a guess.
 *
 * The four that are absent report rather than edit. Fonts, This file and Export
 * change nothing behind them while they are up, so the tint costs them nothing
 * and buys the focus a modal report wants.
 */
const UNDIMMED: ReadonlyArray<SheetId> = [
  'layers', 'layer', 'text', 'adjust', 'filter', 'hsl', 'overlay',
];

/**
 * Of those, the ones driven by a slider or a preview tile.
 *
 * Not dimming the canvas is only half the fix: at 72vh a sheet leaves about a
 * finger's width of picture above it, which is not a preview either. These give
 * a sixth of the screen back. They all scroll, so nothing becomes unreachable —
 * it becomes one flick further away, which is the right price. The Layers sheet
 * keeps its full height: it is a list being read, not a picture being judged.
 */
const SHARES_CANVAS: ReadonlyArray<SheetId> = [
  'layer', 'text', 'adjust', 'filter', 'hsl', 'overlay',
];

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
    CutoutPanel,
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
      <!-- relative z-40 so the header outranks the sheet layer below (z-30).
           The Select toggle has to be reachable WHILE a sheet is open, and the
           sheet overlay is inset-0 — without this it would cover the one
           control that makes the canvas tappable again. -->
      <header
        class="relative z-40 flex min-h-[56px] shrink-0 items-center gap-1 border-b border-white/10 bg-neutral-900 px-1"
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

        <!-- The Select tool.
             In the HEADER, not the rail, because it is the one control that
             has to work WHILE a tool sheet is open — and the rail is behind
             the sheet, already scrolls horizontally at eight tools, and would
             put a mode switch among seven sheet openers that are not modes.
             A sticky toggle rather than a press-and-hold: holding it needs the
             second hand that is already holding the phone, and the whole point
             is repeated taps on the canvas. It is left ON until turned off, so
             it says so — lit, labelled, and echoed on the canvas. -->
        <button
          type="button"
          class="flex h-12 min-w-[48px] items-center justify-center gap-1.5 rounded-xl px-2.5 disabled:opacity-30"
          [class]="svc.selectMode() ? 'bg-sky-500 text-white' : 'text-neutral-300 active:bg-white/10'"
          [disabled]="svc.state() !== 'ready'"
          [attr.aria-pressed]="svc.selectMode()"
          aria-label="Select tool — one tap picks the layer under it"
          (click)="toggleSelectMode()"
        >
          <app-icon name="select" [size]="20" />
          @if (svc.selectMode()) {
            <span class="text-[11px] font-semibold">Select</span>
          }
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
        <!-- Reading a handover zip.

             An OVERLAY rather than another arm of the state switch below, on
             purpose: a zip that turns out to be unusable — two documents in it,
             a bomb, no PSD at all — must not have thrown away the document the
             user already had open. Cancel puts them straight back. -->
        @if (bundle.status() !== 'idle') {
          <div class="absolute inset-0 z-20 overflow-y-auto bg-neutral-950">
            <div class="flex min-h-full flex-col items-center justify-center gap-4 px-8 py-8 text-center">
              @switch (bundle.status()) {
                @case ('reading') {
                  <p class="text-sm text-neutral-300">Reading {{ bundle.fileName() }}…</p>
                  <p class="text-xs leading-relaxed text-neutral-500">
                    Unpacking the document and the font files beside it. The zip is read
                    here in the browser — nothing is uploaded.
                  </p>
                }

                @case ('choose') {
                  <span class="text-amber-400"><app-icon name="warn" [size]="32" /></span>
                  <p class="text-sm text-neutral-200">{{ bundle.message() }}</p>
                  <!-- No default and no "first one": two PSDs in a handover are
                       normally a final and a draft, and opening the draft looks
                       exactly like this working until the wrong artwork ships. -->
                  <ul class="w-full max-w-sm space-y-2">
                    @for (choice of bundle.choices(); track choice.path) {
                      <li>
                        <button
                          type="button"
                          class="flex min-h-[56px] w-full flex-col justify-center rounded-xl border border-white/15 px-4 py-2 text-left active:bg-white/10"
                          (click)="chooseBundlePsd(choice.path)"
                        >
                          <span class="truncate text-sm text-neutral-100">{{ choice.name }}</span>
                          <span class="truncate text-[11px] text-neutral-500">
                            {{ choice.path }} · {{ sizeLabel(choice.size) }}
                          </span>
                        </button>
                      </li>
                    }
                  </ul>
                  <button
                    type="button"
                    class="h-11 rounded-xl px-4 text-sm text-neutral-400 active:bg-white/10"
                    (click)="bundle.reset()"
                  >
                    Cancel
                  </button>
                }

                @case ('refused') {
                  <span class="text-amber-400"><app-icon name="warn" [size]="32" /></span>
                  <p class="text-sm leading-relaxed text-neutral-200">{{ bundle.message() }}</p>
                  <p class="text-xs text-neutral-500">{{ bundle.fileName() }}</p>
                  <label class="h-12 cursor-pointer rounded-xl bg-sky-500 px-5 text-sm font-medium leading-[3rem] text-white">
                    Pick another file
                    <input type="file" class="hidden" [accept]="accept" (change)="onPick($event)" />
                  </label>
                  <button
                    type="button"
                    class="h-11 rounded-xl px-4 text-sm text-neutral-400 active:bg-white/10"
                    (click)="bundle.reset()"
                  >
                    Cancel
                  </button>
                }
              }
            </div>
          </div>
        }

        @switch (svc.state()) {
          @case ('ready') {
            <app-canvas-stage />

            <div class="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-2">
              <!-- What the zip actually achieved, stated where it cannot be
                   missed. The number that matters is the one that is NOT good
                   news: a document rendering three real typefaces and one
                   fallback looks finished, so the user ships it. Tapping opens
                   the Fonts sheet, which names each substituted typeface and
                   the layers still drawing a substitute for it. -->
              @if (bundle.note()) {
                <div class="pointer-events-auto flex max-w-[min(22rem,85vw)] items-stretch gap-1 rounded-xl bg-black/80">
                  <button
                    type="button"
                    class="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-l-xl px-3 py-2 text-left active:bg-white/10"
                    (click)="open('fonts')"
                  >
                    <span
                      class="shrink-0"
                      [class]="bundle.stillSubstituted().length ? 'text-amber-300' : 'text-emerald-300'"
                    >
                      <app-icon name="text" [size]="16" />
                    </span>
                    <span class="min-w-0 text-[11px] leading-relaxed text-neutral-300">
                      {{ bundleHeadline() }}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="flex h-11 w-11 shrink-0 items-center justify-center rounded-r-xl text-neutral-400 active:bg-white/10"
                    aria-label="Dismiss the handover report"
                    (click)="bundle.note.set('')"
                  >
                    ✕
                  </button>
                </div>
              }
              <!-- The mode, where the taps it changes the meaning of land. The
                   header button is lit too, but a thumb on the canvas is not
                   looking at the top of the screen. -->
              @if (svc.selectMode()) {
                <span class="rounded-full bg-sky-500/20 px-2.5 py-1 text-[11px] text-sky-200 ring-1 ring-sky-400/40">
                  Select · tap to pick
                </span>
              }
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
                <input type="file" class="hidden" [accept]="accept" (change)="onPick($event)" />
              </label>
            </div>
          }

          @case ('error') {
            <div class="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
              <p class="text-sm text-red-400">{{ svc.message() }}</p>
              <p class="text-xs text-neutral-500">{{ svc.fileName() }}</p>
              <label class="h-12 cursor-pointer rounded-xl bg-white/10 px-5 text-sm leading-[3rem] text-neutral-100">
                Pick another file
                <input type="file" class="hidden" [accept]="accept" (change)="onPick($event)" />
              </label>
            </div>
          }

          @default {
            <div class="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
              <span class="text-neutral-600"><app-icon name="file" [size]="40" /></span>
              <div>
                <p class="text-base font-medium text-neutral-200">Open a PSD, or a zip of one</p>
                <p class="mt-1 text-xs leading-relaxed text-neutral-500">
                  Layers stay separate. Nothing is flattened, and nothing is written
                  back to your file.
                </p>
                <!-- A PSD names its typefaces and carries none of them, so a bare
                     PSD always leaves the user a list of files to go and find. A
                     handover folder already has them next to the document. -->
                <p class="mt-2 text-xs leading-relaxed text-neutral-500">
                  Zip the document together with its font files and this opens in the
                  real typefaces. The zip is unpacked here in the browser — nothing is
                  uploaded, and the fonts are not kept.
                </p>
              </div>
              <label class="h-12 cursor-pointer rounded-xl bg-sky-500 px-5 text-sm font-medium leading-[3rem] text-white">
                Choose file
                <input type="file" class="hidden" [accept]="accept" (change)="onPick($event)" />
              </label>
            </div>
          }
        }

        <!-- ── cut out ──────────────────────────────────────────────
             INSIDE main on purpose. The sheets below render after the closing
             main tag with "absolute inset-0", so their backdrop covers the
             header as well as the stage — fine for a modal tool you dismiss
             before looking at the result, wrong for this one. Cutting a
             background out is a look-at-it-while-you-tune-it job, and the
             document title and export button have to stay reachable the whole
             time. main is "relative", so anchoring here bounds the panel to
             the stage and it cannot reach the header however it is styled.

             NOTE: no backticks in this comment. The whole template is a
             template literal, so a backtick here terminates it and the file
             stops parsing — which is exactly what happened. -->
        <!-- Cut-out progress.
             On the STAGE rather than in the panel, and above it (z-30 against
             the panel's z-20): a CPU cut takes several seconds, the panel
             scrolls, and a spinner the user has scrolled past is a spinner that
             is not doing its job. pointer-events-none everywhere except the
             card, so it explains the wait without blocking a pinch. -->
        @if (seg.running()) {
          <div class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <div class="pointer-events-auto flex min-w-[220px] max-w-[80%] flex-col items-center gap-3
                        rounded-2xl border border-white/10 bg-neutral-900/95 px-6 py-5
                        shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-sm"
                 role="status" aria-live="polite">
              <!-- Determinate while the model downloads, because the total is
                   known; indeterminate during inference, because it is not.
                   A bar that pretends to know is worse than a spinner. -->
              @if (seg.downloadPercent() >= 0) {
                <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div class="h-full rounded-full bg-sky-400 transition-[width]"
                       [style.width.%]="seg.downloadPercent()"></div>
                </div>
                <p class="text-[13px] font-medium text-neutral-200">
                  Downloading model — {{ seg.downloadPercent() }}%
                </p>
                <p class="text-center text-[11px] leading-relaxed text-neutral-500">
                  One time only. It stays cached for the rest of this session.
                </p>
              } @else {
                <span class="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-sky-400"></span>
                <p class="text-[13px] font-medium text-neutral-200">Cutting out…</p>
                <p class="text-center text-[11px] leading-relaxed text-neutral-500">
                  This runs on the CPU, so it takes a few seconds.
                </p>
              }
            </div>
          </div>
        }

        @if (cutout()) {
          <app-cutout-panel
            [layerId]="svc.selectedId()"
            (close)="cutout.set(false)"
            (modeChange)="cutMode.set($event)"
          />
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

          <!-- Its own button rather than a RAIL entry: everything in RAIL is a
               SheetId and goes through the shared sheet shell, and this tool
               deliberately does not — see the note on app-cutout-panel. -->
          <button
            type="button"
            class="flex w-20 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl disabled:opacity-40"
            [class]="cutout() ? 'bg-white/10 text-sky-300' : 'text-neutral-300'"
            [disabled]="svc.selectedId() === null"
            [attr.aria-pressed]="cutout()"
            (click)="toggleCutout()"
          >
            <app-icon name="layer" />
            <span class="text-[11px]">Cut out</span>
          </button>
        </nav>
      }

      <!-- ── sheets ──────────────────────────────────────────────── -->
      @if (sheet(); as id) {
        <!-- The layer between the canvas and the sheet.
             In select mode it shrinks to the sheet's own footprint, so the
             canvas above it is live and a tap there picks a layer instead of
             closing the sheet. That was the concrete reason selection did not
             work with a tool open — not pointer-events, an element in the way.

             Otherwise it stays full-screen, because tap-to-close is worth a
             very large target and losing it would leave the tick as the only
             way out. What it no longer does is TINT: see UNDIMMED. The
             separation a tint was providing is drawn at the sheet's own edge
             instead, by the shell's border and lift shadow. -->
        <div
          class="absolute z-30 flex flex-col justify-end"
          [class]="scrimClass()"
          (click)="dismiss()"
        >
          <!-- The pick has to be visible while the sheet is still open, or the
               user is tapping into a mode with no feedback. The bottom-left
               selection HUD is behind the sheet, so the name is repeated here,
               directly above it. -->
          @if (svc.selectMode()) {
            <div class="px-3 pb-2" (click)="$event.stopPropagation()">
              <div class="flex min-h-[44px] items-center gap-2 rounded-xl bg-neutral-900 px-3 py-2 ring-1 ring-sky-400/50">
                <span class="shrink-0 text-sky-300"><app-icon name="select" [size]="16" /></span>
                <span class="min-w-0 flex-1 text-[11px] leading-relaxed text-sky-100">
                  {{ selectBanner() }}
                </span>
              </div>
            </div>
          }

          <!-- Stop a tap inside the sheet reaching the backdrop. -->
          <div (click)="$event.stopPropagation()">
            <app-sheet-shell
              [title]="titleOf(id)"
              [showConfirm]="id !== 'layers'"
              [cancelLabel]="discardable(id) ? 'Discard changes' : 'Close'"
              [maxHeight]="sheetMaxHeight()"
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
  protected bundle = inject(BundleService);
  protected stage = viewChild(CanvasStage);

  protected readonly rail = RAIL;

  /**
   * `.psd,.psb,.zip` — one list, derived from the engine's own extensions so a
   * picker and a classifier can never disagree about what is openable.
   */
  protected readonly accept = BUNDLE_FILE_ACCEPT;

  protected readonly sheet = signal<SheetId | null>(null);
  /**
   * The cut-out panel, tracked separately from `sheet`.
   *
   * It is a side panel inside the stage rather than a modal sheet over
   * everything, so it can be open WHILE another sheet is — and folding it into
   * `sheet` would have made those mutually exclusive for no reason.
   */
  protected readonly cutout = signal(false);
  /** Which meaning a canvas tap currently has: '', 'add', 'subtract', 'erase', 'restore'. */
  protected readonly cutMode = signal('');
  protected readonly seg = inject(SegmentService);
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

  /**
   * What the select-mode strip above an open sheet says.
   *
   * It leads with the layer's NAME because that is the only proof the tap
   * landed — the selection box is behind the sheet on a short document, and a
   * pick with no visible result reads as a mode that does not work. The second
   * clause is the only place the cycle is discoverable: nothing about a tap
   * suggests that doing it again reaches the layer underneath.
   */
  protected readonly selectBanner = computed(() => {
    const layer = this.svc.selected();
    if (!layer) return 'Select mode — tap the canvas above to pick a layer.';
    return `${layer.name} — tap the same spot again for the layer below it.`;
  });

  /**
   * Position and tint for the layer under the sheet.
   *
   * Select mode shrinks it to the sheet's footprint; everything else keeps a
   * full-screen tap target and only the reporting sheets darken what is behind
   * it.
   */
  protected readonly scrimClass = computed(() => {
    if (this.svc.selectMode()) return 'inset-x-0 bottom-0';
    const id = this.sheet();
    return id && UNDIMMED.includes(id) ? 'inset-0' : 'inset-0 bg-black/50';
  });

  /** How much of the screen the sheet may take. See SHARES_CANVAS. */
  protected readonly sheetMaxHeight = computed(() => {
    if (this.svc.selectMode()) return '40vh';
    const id = this.sheet();
    return id && SHARES_CANVAS.includes(id) ? '56vh' : '72vh';
  });

  protected percent(value: number): number {
    return Math.round(value * 100);
  }

  /**
   * Turn select mode on or off.
   *
   * Nothing else is disarmed with it: the mode changes what ONE finger on the
   * canvas means, and touches no sheet's session — so leaving it discards
   * nothing and an open sheet keeps whatever it was doing.
   */
  protected toggleSelectMode(): void {
    this.svc.selectMode.set(!this.svc.selectMode());
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
    // A zip is a handover — document AND the fonts it names — so it takes the
    // route that unpacks and registers both. A bare PSD is unchanged.
    if (this.bundle.handles(file)) {
      await this.bundle.open(file);
      return;
    }
    // A plain PSD has no handover report to show, and leaving the last one up
    // would attribute this file's typefaces to a zip it never came from.
    this.bundle.reset();
    await this.svc.open(file);
  }

  protected async chooseBundlePsd(path: string): Promise<void> {
    await this.bundle.choose(path);
  }

  /** Whole MB above 10 MB, one decimal below it — a 400 KB draft must not read as 1 MB. */
  protected sizeLabel(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }

  /**
   * The handover in one line, leading with the part that is not good news.
   *
   * The full three-part report lives in the Fonts sheet, which this opens. What
   * belongs on the canvas is the count a user would otherwise never look for:
   * a document rendering three real typefaces and one substitute looks
   * finished, and gets shipped.
   */
  protected bundleHeadline(): string {
    const missing = this.bundle.stillSubstituted().length;
    if (!missing) return 'Every typeface this file names came with the zip. Tap to check.';
    return `${missing} typeface${missing === 1 ? '' : 's'} still substituted — the zip did not `
      + `include ${missing === 1 ? 'it' : 'them'}. Tap for the list.`;
  }

  protected back(): void {
    this.sheet.set(null);
    this.bundle.reset();
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

  /**
   * Open or close the cut-out panel.
   *
   * Closing also disarms the canvas mode. Leaving a brush or a tap-to-correct
   * armed after the panel that explains it has gone is how a user ends up
   * painting a mask they cannot see the controls for — and the mask is
   * invisible until it hides something, so the first sign would be the layer
   * disappearing under their finger.
   */
  protected toggleCutout(): void {
    const next = !this.cutout();
    this.cutout.set(next);
    if (!next) { this.cutMode.set(''); this.seg.tool.set(''); }
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
