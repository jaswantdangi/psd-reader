import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Icon } from './icon';
import { SegmentService } from '../services/segment.service';
import { ProjectService } from '../services/project.service';

/**
 * Background removal, as a side panel on the stage.
 *
 * ## Why this is not an app-sheet-shell
 *
 * Every other tool here is a bottom sheet rendered AFTER `</main>` with
 * `absolute inset-0`, so its backdrop covers the header as well as the canvas.
 * That is fine for a modal tool you dismiss before looking at the result. It is
 * wrong for this one: cutting out a background is a look-at-it-while-you-tune-it
 * job, and the header carries the document title and the export button that
 * have to stay reachable throughout.
 *
 * So this panel is positioned INSIDE `<main>`, whose `relative` bounds it to the
 * stage. Mount it there and it cannot cover the header no matter what it does.
 *
 * ## Why it owns its own panel rather than joining the sheet switch
 *
 * The sheet system gives every tool the same `✕ / TITLE / ✓` and the same
 * roll-back-on-cancel session. This tool's expensive action is a 115 MB
 * download, which must not be rolled back on cancel and must not be repeated
 * when the panel reopens. Keeping it self-contained is what stops that
 * behaviour leaking into the shared shell.
 */
@Component({
  selector: 'app-cutout-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <aside
      class="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-white/10
             bg-neutral-900/95 backdrop-blur-sm shadow-[-12px_0_40px_rgba(0,0,0,0.45)]
             sm:w-[320px]"
      role="region"
      aria-label="Cut out background"
    >
      <header class="flex h-12 shrink-0 items-center justify-between border-b border-white/10 pl-4 pr-1">
        <h2 class="text-[13px] font-semibold uppercase tracking-[0.18em] text-neutral-200">
          Cut out
        </h2>
        <button
          type="button"
          class="flex h-11 w-11 items-center justify-center rounded-xl text-neutral-300 active:bg-white/10"
          aria-label="Close"
          (click)="close.emit()"
        >
          <app-icon name="close" />
        </button>
      </header>

      <div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
        @if (!layerId()) {
          <p class="text-[13px] leading-relaxed text-neutral-400">
            Select a layer on the canvas to cut its background out.
          </p>
        } @else {

          <!-- ── automatic cut ───────────────────────────────────── -->
          <section class="space-y-3">
            @if (seg.unavailable(); as why) {
              <!-- The gate, said out loud. A feature that is absent without a
                   reason reads as a bug; this names the constraint and points
                   at the path that still works. -->
              <p class="rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2.5
                        text-[12px] leading-relaxed text-amber-200">
                {{ why }}
              </p>
            } @else {
              <div class="flex gap-1 rounded-xl bg-white/5 p-1">
                @for (m of models; track m.id) {
                  <button
                    type="button"
                    class="min-h-[38px] flex-1 rounded-lg px-2 text-[12px] font-medium transition-colors"
                    [class]="role() === m.id ? 'bg-white/15 text-sky-300' : 'text-neutral-400 active:bg-white/10'"
                    [attr.aria-pressed]="role() === m.id"
                    (click)="role.set(m.id)"
                  >
                    {{ m.label }}
                  </button>
                }
              </div>
              <p class="text-[12px] leading-relaxed text-neutral-500">{{ purpose() }}</p>

              <button
                type="button"
                class="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl
                       bg-sky-500 px-4 text-[14px] font-semibold text-white
                       active:bg-sky-600 disabled:opacity-40"
                [disabled]="seg.running()"
                (click)="cut()"
              >
                @if (seg.running()) { Working… } @else { Remove background }
              </button>

              <!-- The download, priced before it starts. 115 MB on mobile data
                   is the user's decision to make, not ours to spend quietly. -->
              @if (cost() > 0) {
                <p class="text-[12px] leading-relaxed text-neutral-500">
                  First use downloads a {{ mb(cost()) }} MB model. It stays cached
                  for the rest of this session.
                </p>
              }
              @if (seg.downloadPercent() >= 0) {
                <div class="space-y-1.5">
                  <div class="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div class="h-full rounded-full bg-sky-400 transition-[width]"
                         [style.width.%]="seg.downloadPercent()"></div>
                  </div>
                  <p class="text-[11px] text-neutral-500">
                    Downloading model — {{ seg.downloadPercent() }}%
                  </p>
                </div>
              }
              @if (seg.device() === 'wasm') {
                <p class="text-[11px] leading-relaxed text-neutral-500">
                  This device has no WebGPU, so the cut runs on the CPU and takes
                  noticeably longer.
                </p>
              }
            }
          </section>

          <!-- ── tap to correct ──────────────────────────────────── -->
          @if (!seg.unavailable()) {
            <section class="space-y-2 border-t border-white/10 pt-4">
              <h3 class="text-[12px] font-semibold uppercase tracking-wider text-neutral-400">
                Tap to correct
              </h3>
              <div class="flex gap-2">
                <button
                  type="button"
                  class="min-h-[40px] flex-1 rounded-xl border border-white/10 text-[12px] font-medium
                         text-neutral-200 active:bg-white/10"
                  [class]="mode() === 'add' ? 'bg-white/10 text-sky-300' : ''"
                  [attr.aria-pressed]="mode() === 'add'"
                  (click)="setMode('add')"
                >Keep this</button>
                <button
                  type="button"
                  class="min-h-[40px] flex-1 rounded-xl border border-white/10 text-[12px] font-medium
                         text-neutral-200 active:bg-white/10"
                  [class]="mode() === 'subtract' ? 'bg-white/10 text-sky-300' : ''"
                  [attr.aria-pressed]="mode() === 'subtract'"
                  (click)="setMode('subtract')"
                >Remove this</button>
              </div>
              <p class="text-[12px] leading-relaxed text-neutral-500">
                Then tap the object on the canvas. Adds a {{ mb(clickCost()) }} MB
                model the first time.
              </p>
            </section>
          }

          <!-- ── brush ───────────────────────────────────────────── -->
          <section class="space-y-3 border-t border-white/10 pt-4">
            <h3 class="text-[12px] font-semibold uppercase tracking-wider text-neutral-400">
              Brush
            </h3>
            <!-- Deliberately NOT behind the memory gate above: the brush needs
                 no model, so it is the whole feature on devices where the
                 automatic cut cannot run. Hiding it with the rest would leave
                 those devices with nothing. -->
            <div class="flex gap-2">
              <button
                type="button"
                class="min-h-[40px] flex-1 rounded-xl border border-white/10 text-[12px] font-medium
                       text-neutral-200 active:bg-white/10"
                [class]="mode() === 'erase' ? 'bg-white/10 text-sky-300' : ''"
                [attr.aria-pressed]="mode() === 'erase'"
                (click)="setMode('erase')"
              >Erase</button>
              <button
                type="button"
                class="min-h-[40px] flex-1 rounded-xl border border-white/10 text-[12px] font-medium
                       text-neutral-200 active:bg-white/10"
                [class]="mode() === 'restore' ? 'bg-white/10 text-sky-300' : ''"
                [attr.aria-pressed]="mode() === 'restore'"
                (click)="setMode('restore')"
              >Restore</button>
            </div>

            <label class="block space-y-1.5">
              <span class="flex items-center justify-between text-[12px] text-neutral-400">
                Size <span class="tabular-nums text-neutral-500">{{ radius() }} px</span>
              </span>
              <input
                type="range" min="4" max="120" step="1"
                class="h-11 w-full accent-sky-400"
                [value]="radius()"
                (input)="radius.set($any($event.target).valueAsNumber)"
              />
            </label>

            <label class="block space-y-1.5">
              <span class="flex items-center justify-between text-[12px] text-neutral-400">
                Hardness <span class="tabular-nums text-neutral-500">{{ hardnessPercent() }}%</span>
              </span>
              <input
                type="range" min="0" max="1" step="0.05"
                class="h-11 w-full accent-sky-400"
                [value]="hardness()"
                (input)="hardness.set($any($event.target).valueAsNumber)"
              />
            </label>
          </section>

          <!-- ── outcome ─────────────────────────────────────────── -->
          @if (seg.note()) {
            <p
              class="rounded-xl px-3 py-2.5 text-[12px] leading-relaxed"
              [class]="seg.failed()
                ? 'border border-rose-400/25 bg-rose-400/10 text-rose-200'
                : 'border border-white/10 bg-white/5 text-neutral-300'"
              role="status"
            >{{ seg.note() }}</p>
          }

          <!-- The export disclosure. Lives in the UI rather than a code comment
               because the softness only appears in the exported file, which is
               the artefact the user keeps and the one place they cannot check
               before committing. -->
          @if (softness(); as note) {
            <p class="rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2.5
                      text-[12px] leading-relaxed text-amber-200">
              {{ note }}
            </p>
          }

          @if (hasCut()) {
            <button
              type="button"
              class="min-h-[44px] w-full rounded-xl border border-white/10 text-[13px]
                     text-neutral-300 active:bg-white/10"
              (click)="clear()"
            >Remove the cut-out</button>
          }
        }
      </div>
    </aside>
  `,
})
export class CutoutPanel {
  /** The layer being cut. Null disables everything but the prompt to pick one. */
  readonly layerId = input<number | null>(null);
  readonly close = output<void>();
  /** Which canvas interaction the stage should arm. @see setMode */
  readonly modeChange = output<string>();

  protected readonly seg = inject(SegmentService);
  private readonly projects = inject(ProjectService);

  protected readonly models = [
    { id: 'base', label: 'General' },
    { id: 'portrait', label: 'People' },
    { id: 'fast', label: 'Quick' },
  ];

  protected readonly role = signal('base');
  protected readonly mode = signal('');
  protected readonly radius = signal(24);
  protected readonly hardness = signal(0.5);

  protected readonly purpose = computed(
    () => ({
      base: 'Works on any subject. Start here.',
      portrait: 'Tuned for people — better on hair and shoulders.',
      fast: 'Half resolution. Quicker, with coarser edges.',
    })[this.role()] ?? '',
  );

  protected readonly cost = computed(() => this.seg.costOf(this.role()));
  protected readonly clickCost = computed(() => this.seg.costOf('click'));
  protected readonly hardnessPercent = computed(() => Math.round(this.hardness() * 100));

  protected readonly hasCut = computed(() => {
    // `version()` first, always. The engine mutates the project object in
    // place, so the `project` signal's reference never changes on a cut — this
    // counter is the only thing that tells a computed to run again. Every
    // project-derived computed in ProjectService opens the same way.
    this.projects.version();
    const project: any = this.projects.project();
    const id = this.layerId();
    if (!project || !id) return false;
    return project.layers.some((l: any) => l.id === id && l.mask?.generated);
  });

  protected readonly softness = computed(() => {
    this.projects.version();
    const project: any = this.projects.project();
    if (!project) return null;
    return this.seg.softnessNote(project, project.proxyScale ?? 1);
  });

  protected mb(bytes: number): number {
    return Math.round(bytes / (1024 * 1024));
  }

  /**
   * Arm a canvas interaction, or disarm it by tapping the same button again.
   *
   * The panel does not handle pointer events itself -- the canvas does, and it
   * needs to know which of the four meanings a tap currently has. Emitting
   * rather than reaching into the stage keeps this panel a leaf.
   */
  protected setMode(next: string): void {
    this.mode.set(this.mode() === next ? '' : next);
    this.modeChange.emit(this.mode());
  }

  protected cut(): void {
    const project = this.projects.project();
    const id = this.layerId();
    if (project && id) void this.seg.cut(project, id, { role: this.role() as any });
  }

  protected clear(): void {
    const project = this.projects.project();
    const id = this.layerId();
    if (project && id) this.seg.clear(project, id);
  }
}
