import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { SyncService } from '../services/sync.service';

const LOCAL_RELAY = 'ws://localhost:8787';

/**
 * Where the relay lives, from `<meta name="psd-relay">` in index.html.
 *
 * Runtime rather than build time on purpose: one artifact then serves local
 * development, a Pages preview and production, and the Android wrapper does
 * not need a build of its own to point somewhere else. Falls back to loopback
 * so `npm start` works with no configuration at all.
 */
function configuredRelay(): string {
  const meta = typeof document === 'undefined'
    ? null
    : document.querySelector('meta[name="psd-relay"]');
  return meta?.getAttribute('content')?.trim() || LOCAL_RELAY;
}

/**
 * Connect this file to the same file open in Photoshop.
 *
 * The screen has one job at any moment, and which one changes with the state,
 * so it is built as five states rather than one form with things greyed out:
 *
 *   idle       -> one action: connect
 *   waiting    -> one thing to read: the code, set large enough to transcribe
 *   paired     -> nothing to do; say what is being waited for
 *   live       -> what matched, and what will never sync
 *   failed     -> what went wrong, and the way back
 *
 * The code is the only thing a person has to carry between two machines, so in
 * `waiting` it is the largest thing on screen and everything else recedes. The
 * alphabet already excludes `0/O` and `1/I`; wide tracking and a monospaced
 * face are the other half of making it transcribable.
 *
 * `Not syncing` is not a log and not an afterthought. Brush strokes, filters,
 * adjustments, mask painting and layer effects have no operation that can
 * represent them, and a sync that quietly dropped them would be worse than one
 * that refuses them — so they are counted on screen with the reason.
 */
@Component({
  selector: 'app-sync-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    <div class="space-y-4 px-4 pb-6 pt-4">
      <p class="text-[11px] leading-relaxed text-neutral-500">
        Sync moves <b class="text-neutral-300">changes, not the file</b>. Open the same
        PSD in Photoshop and here, pair the two, and edits made in Photoshop follow into
        this canvas. Nothing is uploaded and no document crosses the network.
      </p>

      @switch (sync.status()) {
        <!-- ── idle / failed: the one action ──────────────────────── -->
        @case ('idle') {
          <ng-container *ngTemplateOutlet="connectForm" />
        }
        @case ('failed') {
          <div
            class="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[12px] text-red-300"
            role="alert"
          >
            {{ sync.message() }}
          </div>
          <ng-container *ngTemplateOutlet="connectForm" />
        }

        @case ('connecting') {
          <p class="py-6 text-center text-[13px] text-neutral-400">{{ sync.message() }}</p>
        }

        <!-- ── waiting: the code is the whole screen ──────────────── -->
        @case ('waiting') {
          <div class="rounded-2xl border border-white/10 bg-black/30 px-4 py-6 text-center">
            <p class="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
              Type this into the Photoshop panel
            </p>
            <p
              class="mt-3 font-mono text-[34px] font-bold leading-none tracking-[0.28em] text-sky-300"
              aria-label="Pairing code {{ spelled() }}"
            >
              {{ sync.code() }}
            </p>
            <p class="mt-3 text-[11px] text-neutral-500">
              Valid for five minutes, and once only.
            </p>
          </div>
          <button type="button" class="w-full rounded-xl bg-white/10 py-3 text-[13px] font-semibold text-neutral-200 active:bg-white/20" (click)="sync.disconnect()">
            Cancel
          </button>
        }

        @case ('paired') {
          <p class="py-6 text-center text-[13px] text-neutral-400">{{ sync.message() }}</p>
        }

        <!-- ── live: what matched, and what never will ────────────── -->
        @case ('live') {
          <div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
            <p class="text-[13px] font-semibold text-emerald-300">{{ sync.message() }}</p>
            <p class="mt-1 text-[11px] tabular-nums text-emerald-400/70">
              {{ sync.applied() }} change{{ sync.applied() === 1 ? '' : 's' }} applied
            </p>
          </div>

          @if (sync.documentMismatch(); as mismatch) {
            <!-- Nothing can enforce that both sides opened the same file, because
                 no document ever crosses. Saying it is the only defence there is:
                 without this, "0 of 12 matched" reads as a broken matcher. -->
            <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-300" role="alert">
              {{ mismatch }}
            </div>
          }

          @if (unsyncable().length) {
            <section>
              <h3 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
                Not syncing
              </h3>
              <ul class="mt-2 space-y-1">
                @for (row of unsyncable(); track row.reason) {
                  <li class="flex items-baseline justify-between rounded-lg bg-white/5 px-3 py-2">
                    <span class="text-[12px] text-neutral-300">{{ row.label }}</span>
                    <span class="text-[12px] tabular-nums text-amber-400">{{ row.count }}</span>
                  </li>
                }
              </ul>
              <p class="mt-2 text-[11px] leading-relaxed text-neutral-500">
                These have no operation that can represent them. Re-open the file here to
                pick them up.
              </p>
            </section>
          }

          @if (sync.unmatched().length) {
            <section>
              <h3 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
                Layers with no counterpart
              </h3>
              <ul class="mt-2 space-y-1">
                @for (layer of sync.unmatched(); track layer.name + layer.reason) {
                  <li class="flex items-baseline justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
                    <span class="truncate text-[12px] text-neutral-300">{{ layer.name }}</span>
                    <span class="shrink-0 text-[11px] text-neutral-500">{{ layer.reason }}</span>
                  </li>
                }
              </ul>
              <p class="mt-2 text-[11px] leading-relaxed text-neutral-500">
                Groups and adjustment layers have no equivalent here, so they are listed
                rather than guessed at. Changes to them will not arrive.
              </p>
            </section>
          }

          <button type="button" class="w-full rounded-xl bg-white/10 py-3 text-[13px] font-semibold text-neutral-200 active:bg-white/20" (click)="sync.disconnect()">
            Disconnect
          </button>
        }
      }
    </div>

    <ng-template #connectForm>
      <label class="block">
        <span class="text-[11px] uppercase tracking-[0.18em] text-neutral-500">Relay</span>
        <input
          type="text"
          class="mt-1.5 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-[13px] text-neutral-200"
          [value]="relay()"
          (input)="relay.set($any($event.target).value)"
        />
      </label>
      <button
        type="button"
        class="w-full rounded-xl bg-sky-500 py-3 text-[13px] font-semibold text-white active:bg-sky-600 disabled:opacity-30"
        [disabled]="!relay().trim()"
        (click)="connect()"
      >
        Connect
      </button>
    </ng-template>
  `,
})
export class SyncSheet {
  protected sync = inject(SyncService);
  protected relay = signal(configuredRelay());

  /**
   * Refusals grouped by reason and counted.
   *
   * A list of every skipped event would be dozens of lines from one brush
   * stroke, which buries the thing worth reading. The count is the disclosure;
   * the individual events are not.
   */
  protected unsyncable = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.sync.refused()) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    return [...counts].map(([reason, count]) => ({ reason, count, label: LABELS[reason] ?? reason }));
  });

  /** The code read out one character at a time, for a screen reader. */
  protected spelled = computed(() => (this.sync.code() ?? '').split('').join(' '));

  protected connect(): void {
    this.sync.connect(this.relay().trim());
  }
}

/** Refusal reasons in the words of someone who did not write the protocol. */
const LABELS: Record<string, string> = {
  'needs-pixels': 'Brush, filter, adjustment and effect changes',
  'unknown-layer': 'Changes to layers that never matched',
  'not-reconciled': 'Changes that arrived before the layer list',
  'bad-props': 'Changes that arrived incomplete',
  'unknown-change': 'Changes this version does not understand',
  'no-document': 'Changes that arrived with no file open',
  'not-applied': 'Changes the editor could not apply',
};
