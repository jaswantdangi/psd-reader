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
              <!-- Only the models this device can actually run. A picker that
                   lists an option and then refuses it is worse than one that
                   never offered it — so the filtering happens in the engine
                   (availableModels) and this renders whatever survived. -->
              <div class="flex gap-1 rounded-xl bg-white/5 p-1">
                <button
                  type="button"
                  class="min-h-[38px] flex-1 rounded-lg px-2 text-[12px] font-medium transition-colors"
                  [class]="role() === '' ? 'bg-white/15 text-accent-300' : 'text-neutral-400 active:bg-white/10'"
                  [attr.aria-pressed]="role() === ''"
                  (click)="role.set('')"
                >Auto</button>
                @for (m of seg.choices(); track m.role) {
                  <button
                    type="button"
                    class="min-h-[38px] flex-1 rounded-lg px-2 text-[12px] font-medium transition-colors"
                    [class]="role() === m.role ? 'bg-white/15 text-accent-300' : 'text-neutral-400 active:bg-white/10'"
                    [attr.aria-pressed]="role() === m.role"
                    (click)="role.set(m.role)"
                  >
                    {{ m.label }}
                  </button>
                }
              </div>
              <p class="text-[12px] leading-relaxed text-neutral-500">{{ purpose() }}</p>

              <!-- The quality this device gives up, named. Silence here would
                   make a soft edge look like a bug rather than a budget. -->
              @if (role() === '' && seg.tier(); as note) {
                <p class="text-[12px] leading-relaxed text-neutral-500">{{ note }}</p>
              }

              <button
                type="button"
                class="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl
                       bg-accent-500 px-4 text-[14px] font-semibold text-white
                       active:bg-accent-600 disabled:opacity-40"
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
                    <div class="h-full rounded-full bg-accent-400 transition-[width]"
                         [style.width.%]="seg.downloadPercent()"></div>
                  </div>
                  <p class="text-[11px] text-neutral-500">
                    Downloading model — {{ seg.downloadPercent() }}%
                  </p>
                </div>
              }
              <!-- Says CPU because it IS the CPU, on every device. GPU
                   acceleration is off: onnxruntime-web's WebGPU backend cannot
                   run the MaxPool these models use. Claiming "your device has
                   no WebGPU" here would be blaming the user's hardware for our
                   own constraint. -->
              @if (seg.device()) {
                <p class="text-[11px] leading-relaxed text-neutral-500">
                  Cuts run on the CPU, so allow a few seconds. Larger pictures take
                  proportionally longer.
                </p>
              }
            }
          </section>

          <!-- The armed state, stated. The canvas gives no other sign that it
               has stopped moving the layer and started cutting, and a tool you
               cannot tell is on is a tool that feels broken. -->
          @if (seg.tool(); as armed) {
            <p class="rounded-xl border border-accent-400/30 bg-accent-400/10 px-3 py-2.5
                      text-[12px] leading-relaxed text-accent-200" role="status">
              {{ armedHint() }}
              <button type="button" class="ml-1 underline" (click)="setMode(armed)">Done</button>
            </p>
          }

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
                  [class]="seg.tool() === 'keep' ? 'bg-white/10 text-accent-300' : ''"
                  [attr.aria-pressed]="seg.tool() === 'keep'"
                  (click)="setMode('keep')"
                >Keep this</button>
                <button
                  type="button"
                  class="min-h-[40px] flex-1 rounded-xl border border-white/10 text-[12px] font-medium
                         text-neutral-200 active:bg-white/10"
                  [class]="seg.tool() === 'remove' ? 'bg-white/10 text-accent-300' : ''"
                  [attr.aria-pressed]="seg.tool() === 'remove'"
                  (click)="setMode('remove')"
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
                [class]="seg.tool() === 'erase' ? 'bg-white/10 text-accent-300' : ''"
                [attr.aria-pressed]="seg.tool() === 'erase'"
                (click)="setMode('erase')"
              >Erase</button>
              <button
                type="button"
                class="min-h-[40px] flex-1 rounded-xl border border-white/10 text-[12px] font-medium
                       text-neutral-200 active:bg-white/10"
                [class]="seg.tool() === 'restore' ? 'bg-white/10 text-accent-300' : ''"
                [attr.aria-pressed]="seg.tool() === 'restore'"
                (click)="setMode('restore')"
              >Restore</button>
            </div>

            <label class="block space-y-1.5">
              <span class="flex items-center justify-between text-[12px] text-neutral-400">
                Size <span class="tabular-nums text-neutral-500">{{ seg.brushRadius() }} px</span>
              </span>
              <input
                type="range" min="4" max="120" step="1"
                class="h-11 w-full accent-accent-400"
                [value]="seg.brushRadius()"
                (input)="seg.brushRadius.set($any($event.target).valueAsNumber)"
              />
            </label>

            <label class="block space-y-1.5">
              <span class="flex items-center justify-between text-[12px] text-neutral-400">
                Hardness <span class="tabular-nums text-neutral-500">{{ hardnessPercent() }}%</span>
              </span>
              <input
                type="range" min="0" max="1" step="0.05"
                class="h-11 w-full accent-accent-400"
                [value]="seg.brushHardness()"
                (input)="seg.brushHardness.set($any($event.target).valueAsNumber)"
              />
            </label>
          </section>

          <!-- ── edge ────────────────────────────────────────────── -->
          @if (hasCut()) {
            <section class="space-y-3 border-t border-white/10 pt-4">
              <div class="flex items-center justify-between">
                <h3 class="text-[12px] font-semibold uppercase tracking-wider text-neutral-400">
                  Edge
                </h3>
                <button
                  type="button"
                  class="min-h-[32px] rounded-lg px-2 text-[11px] text-neutral-400 active:bg-white/10"
                  (click)="resetEdge()"
                >Reset</button>
              </div>

              <!-- Each slider re-derives the drawn mask from the model's own
                   output, so dragging one back to its default restores exactly
                   the bytes the model produced rather than an approximation. -->
              @for (s of edgeControls; track s.key) {
                <label class="block space-y-1.5">
                  <span class="flex items-center justify-between text-[12px] text-neutral-400">
                    {{ s.label }}
                    <span class="tabular-nums text-neutral-500">{{ edgeLabel(s) }}</span>
                  </span>
                  <input
                    type="range"
                    class="h-11 w-full accent-accent-400"
                    [min]="s.min" [max]="s.max" [step]="s.step"
                    [value]="edge()[s.key]"
                    [disabled]="seg.running()"
                    (input)="onEdge(s.key, $any($event.target).valueAsNumber)"
                    (change)="endEdge()"
                  />
                  <span class="block text-[11px] leading-relaxed text-neutral-600">{{ s.hint }}</span>
                </label>
              }
            </section>
          }

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

  /** '' means let the engine pick the best model this device can run. */
  protected readonly role = signal('');

  /** The model a cut would actually use right now — the auto pick, or the override. */
  private readonly chosen = computed(() => {
    const picked = this.role();
    const usable = this.seg.choices();
    return picked ? usable.find((m: any) => m.role === picked) ?? null : usable[0] ?? null;
  });

  protected readonly purpose = computed(() => this.chosen()?.purpose ?? '');
  protected readonly cost = computed(() => this.seg.costOf(this.chosen()?.role ?? ''));
  protected readonly clickCost = computed(() => this.seg.costOf('click'));
  protected readonly hardnessPercent = computed(() => Math.round(this.seg.brushHardness() * 100));

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

  protected readonly armedHint = computed(() => ({
    keep: 'Tap the part of the picture you want to KEEP.',
    remove: 'Tap the part you want to REMOVE.',
    erase: 'Drag on the picture to erase. Pinch still zooms.',
    restore: 'Drag on the picture to bring it back. Pinch still zooms.',
  })[this.seg.tool() as string] ?? '');

  /**
   * The edge sliders. Data, so the template is one loop rather than five
   * near-identical blocks that drift apart the first time one is edited.
   *
   * `hint` is not decoration: "Shift" and "Contrast" mean nothing to someone who
   * has not used Select and Mask, and a slider whose effect you have to discover
   * by dragging is one people leave alone.
   */
  protected readonly edgeControls = [
    { key: 'feather', label: 'Blur', min: 0, max: 32, step: 1, unit: 'px',
      hint: 'Softens the cut edge. Use for hair and fur.' },
    { key: 'shift', label: 'Shrink / grow', min: -1, max: 1, step: 0.05, unit: '%',
      hint: 'Pulls the edge in to remove a halo, or pushes it out.' },
    { key: 'contrast', label: 'Sharpness', min: -1, max: 1, step: 0.05, unit: '%',
      hint: 'Hardens or softens the transition without moving it.' },
    { key: 'smooth', label: 'Smooth', min: 0, max: 8, step: 1, unit: 'px',
      hint: 'Removes jagged steps along the edge.' },
    { key: 'fade', label: 'Strength', min: 0, max: 1, step: 0.05, unit: '%',
      hint: 'How much of the background is removed. 0 shows it all again.' },
  ];

  protected readonly edge = computed(() => {
    this.projects.version();
    return this.seg.edgeOf(this.projects.project(), this.layerId() as number) as any;
  });

  protected edgeLabel(s: any): string {
    const v = this.edge()[s.key];
    return s.unit === 'px' ? `${Math.round(v)} px` : `${Math.round(v * 100)}%`;
  }

  /**
   * One coalesce key per drag, minted on the first input and dropped on change.
   *
   * `setLayer` merges commands sharing a key, so a whole sweep of the slider is
   * one undo step. A literal key would also merge two SEPARATE drags minutes
   * apart and make the earlier one unreachable — which is the exact trap
   * `nextGestureKey` exists to prevent.
   */
  private edgeKey: string | null = null;

  protected onEdge(key: string, value: number): void {
    this.edgeKey ??= `edge#${Date.now()}`;
    const project = this.projects.project();
    const id = this.layerId();
    if (project && id !== null) this.seg.setEdge(project, id, { [key]: value }, this.edgeKey);
  }

  protected endEdge(): void {
    this.edgeKey = null;
  }

  protected resetEdge(): void {
    const project = this.projects.project();
    const id = this.layerId();
    if (project && id !== null)
      this.seg.setEdge(project, id, { feather: 0, shift: 0, contrast: 0, smooth: 0, fade: 1 });
  }

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
  protected setMode(next: any): void {
    // Tapping the armed button again disarms it. Without that there is no way
    // back to moving the layer except closing the panel, and the canvas would
    // stay captured by a tool the user has finished with.
    const value = this.seg.tool() === next ? '' : next;
    this.seg.tool.set(value);
    this.modeChange.emit(value);
  }

  protected cut(): void {
    const project = this.projects.project();
    const id = this.layerId();
    // An empty role is passed as undefined, not as '': the service reads
    // "absent" as "pick for me", and '' would be a lookup miss instead.
    if (project && id) void this.seg.cut(project, id, { role: (this.role() || undefined) as any });
  }

  protected clear(): void {
    const project = this.projects.project();
    const id = this.layerId();
    if (project && id) this.seg.clear(project, id);
  }
}
