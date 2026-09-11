import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BundleService } from '../services/bundle.service';
import { FontsService } from '../services/fonts.service';
import { FontCacheService } from '../services/font-cache.service';
import { SyncService, type FontSync } from '../services/sync.service';
import { FontPicker } from './font-picker';

/**
 * Every typeface this document asks for, and whether we can actually draw it.
 *
 * The text sheet already discloses the substitution for the SELECTED layer.
 * That is the right place to say it and the wrong place to fix it: a poster
 * with four typefaces would have the user open every text layer in turn just to
 * collect the list of names to go and find. This screen is that list, once, at
 * document level, with the control to answer it.
 *
 * It reports three states and keeps them apart, because they need different
 * actions from the user:
 *
 *   - **substituted** — we have no file for this name. Go and find it. This is
 *     the number the header badges.
 *   - **loaded, not drawing** — a file answers the name, but some layer is
 *     showing something else, normally because a typeface was picked by hand on
 *     that layer. One button puts it back.
 *   - **loaded and drawing** — done. Still listed, so the user can see what a
 *     replacement would replace.
 *
 * A weight mismatch is its own line rather than being folded into "loaded":
 * Roboto Bold answering a document that asked for Roboto Regular is better than
 * Arial and is still not what the file says, and a user who sees the wrong
 * weight on screen deserves to be told why rather than left to wonder.
 */
@Component({
  selector: 'app-fonts-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FontPicker],
  template: `
    @if (fonts.demand(); as report) {
      <div class="space-y-4 px-4 pb-6 pt-4">
        <p class="text-[11px] leading-relaxed text-neutral-500">
          A PSD stores font <b class="text-neutral-300">names</b>, never the fonts
          themselves — so nothing in the file can put its own typeface on screen. Give
          this app the font file and it draws the real thing; until then it draws the
          closest stack it can guarantee and says so. Font files you load here stay in this
          tab and are not kept. Fonts synced from Photoshop are kept on this device until you
          remove them.
        </p>

        <!-- What the handover zip actually did, kept whole.

             The picker's own note below reports the last PICK and is cleared
             every time a sheet opens; this one has to survive until it is read,
             because it is the only place the three facts appear together — what
             drew, what the zip carried that nothing asked for, and what is
             still substituted. The third is the one that makes the feature
             trustworthy rather than magic, so it is never dropped for brevity. -->
        @if (bundle.note(); as note) {
          <p
            class="rounded-xl px-3 py-3 text-[11px] leading-relaxed"
            [class]="
              bundle.stillSubstituted().length
                ? 'bg-amber-400/10 text-amber-200'
                : 'bg-emerald-400/10 text-emerald-200'
            "
          >
            {{ note }}
          </p>
        }

        @if (report.wanted) {
          <ul class="divide-y divide-white/5 overflow-hidden rounded-xl bg-white/5">
            @for (font of report.fonts; track font.name) {
              <li class="space-y-2 px-3 py-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-medium text-neutral-100">{{ font.name }}</p>
                    <p class="mt-0.5 truncate text-[11px] text-neutral-500">
                      {{ font.layers.length }} layer{{ font.layers.length === 1 ? '' : 's' }} ·
                      {{ font.layers.join(', ') }}
                    </p>
                  </div>
                  <span
                    class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                    [class]="chip(font)"
                  >
                    {{ status(font) }}
                  </span>
                </div>

                <!-- Where this font is in its journey from the Photoshop PC, when
                     sync is asking for it. Every outcome is said, including the
                     ones that mean "you will have to find this file yourself". -->
                @if (sync.fontSync()[font.name]; as s) {
                  <p class="text-[11px] leading-relaxed" [class]="syncTone(s)">{{ syncLine(s) }}</p>
                }

                @if (font.match) {
                  <p class="text-[11px] leading-relaxed text-neutral-400">
                    Drawing from <b class="font-semibold text-neutral-200">{{ font.match.fileName }}</b>.
                    @if (!font.match.styleMatched) {
                      <span class="text-amber-300">
                        That file is a different weight or slant from the one the document
                        names, so the shapes are right and the emphasis may not be.
                      </span>
                    }
                  </p>

                  @if (pending(font); as more) {
                    <button
                      type="button"
                      class="h-11 w-full rounded-xl border border-accent-400/50 text-sm text-accent-300"
                      (click)="useEverywhere()"
                    >
                      Use it on {{ more }} more layer{{ more === 1 ? '' : 's' }}
                    </button>
                  }
                } @else {
                  <p class="text-[11px] leading-relaxed text-amber-300">
                    No file loaded for this name. Load
                    <b class="font-semibold">{{ font.name }}</b> below as a .ttf, .otf,
                    .woff or .woff2 — or, if your file is named differently, pick it here
                    and it will answer this name whatever it is called.
                  </p>

                  <!-- The escape hatch from name matching.
                       The matcher is deliberately dumb and will not guess, which is
                       right — but it leaves a licensed HelvNeue_Rm.otf unable to ever
                       answer HelveticaNeue, however many times it is loaded. This
                       binds the two by hand, which is a fact the user supplies rather
                       than a guess anyone made. -->
                  <app-font-picker
                    variant="quiet"
                    [assignTo]="font.name"
                    [label]="'Use a file for ' + font.name + '…'"
                  />
                }
              </li>
            }
          </ul>
        } @else {
          <p class="rounded-xl bg-white/5 px-3 py-3 text-xs leading-relaxed text-neutral-400">
            No text layer in this document names a typeface, so there is nothing to go and
            find. Loading a font file here would change nothing on screen.
          </p>
        }

        @if (report.unnamed) {
          <p class="text-[11px] leading-relaxed text-neutral-500">
            {{ report.unnamed }} text layer{{ report.unnamed === 1 ? '' : 's' }} name no
            typeface at all — either the file wrote Photoshop's placeholder instead of a
            font, or the layer was added here. Nothing is being substituted for those, so
            no font file can answer them; pick a typeface in the Text sheet.
          </p>
        }

        @if (report.failures.length) {
          <ul class="space-y-1 rounded-xl bg-red-500/10 px-3 py-3">
            @for (failure of report.failures; track failure.fileName) {
              <li class="text-[11px] leading-relaxed text-red-400">
                <b class="font-semibold">{{ failure.fileName }}</b> — {{ failure.message }}
              </li>
            }
          </ul>
        }

        @if (cache.totalBytes(); as total) {
          <div class="space-y-2 rounded-xl bg-white/5 px-3 py-3">
            <p class="text-[11px] leading-relaxed text-neutral-400">
              Fonts synced from your PC are kept on this device ({{ mb(total) }}), so the next
              session does not send them again.
            </p>
            <button
              type="button"
              class="h-11 w-full rounded-xl border border-white/10 text-sm text-neutral-200"
              (click)="forget()"
            >
              Remove synced fonts ({{ mb(total) }})
            </button>
          </div>
        }

        @if (fonts.supported) {
          <app-font-picker label="Load font files…" />
          @if (fonts.note(); as note) {
            <p class="text-[11px] leading-relaxed text-accent-300">{{ note }}</p>
          }
          <p class="text-[11px] leading-relaxed text-neutral-500">
            Loading a font re-draws every layer that asks for it — this app takes over from
            Photoshop's own pixels for those layers, on screen and at export. Each layer is
            its own undo step, and <b class="text-neutral-300">✕ Discard changes</b> backs
            all of them out at once.
          </p>
        } @else {
          <p class="rounded-xl bg-white/5 px-3 py-3 text-[11px] leading-relaxed text-neutral-400">
            This browser has no FontFace API, so font files cannot be loaded here. The
            substitutions above are the best it can do.
          </p>
        }
      </div>
    }
  `,
})
export class FontsSheet {
  protected fonts = inject(FontsService);
  protected bundle = inject(BundleService);
  protected sync = inject(SyncService);
  protected cache = inject(FontCacheService);

  constructor() {
    // How much the device holds is read once per opening, not polled.
    void this.cache.refresh();
  }

  protected syncLine(s: FontSync): string {
    if (s.state === 'receiving' && s.count) return `Receiving from Photoshop… ${s.received} of ${s.count}`;
    return s.detail;
  }

  protected syncTone(s: FontSync): string {
    if (s.state === 'synced' || s.state === 'cached') return 'text-emerald-300';
    if (s.state === 'missing' || s.state === 'failed') return 'text-amber-300';
    return 'text-neutral-400';
  }

  protected mb(bytes: number): string {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /** Removes the device copies. Faces already on screen stay until the app closes. */
  protected async forget(): Promise<void> {
    await this.cache.clear();
    this.fonts.note.set('Synced fonts removed from this device. Fonts already on screen stay until you close the app.');
  }

  /**
   * Layers that ask for this typeface and are not drawing it.
   *
   * A method rather than the comparison written inline, so no `<` ends up in a
   * template expression — and so the number in the button and the state the
   * chip reports can never drift apart.
   */
  protected pending(font: any): number {
    return font.layers.length - font.applied;
  }

  protected status(font: any): string {
    if (!font.match) return 'Substituted';
    if (this.pending(font)) return 'Loaded';
    return 'Drawing';
  }

  protected chip(font: any): string {
    if (!font.match) return 'bg-amber-400/15 text-amber-300';
    if (this.pending(font)) return 'bg-accent-400/15 text-accent-300';
    return 'bg-emerald-400/15 text-emerald-300';
  }

  /**
   * One button for every font, not one per font: `applyLoaded` already walks
   * the whole document and skips layers that are drawing the right face, so
   * "use it here" and "use them all" are the same operation.
   */
  protected useEverywhere(): void {
    const applied = this.fonts.applyLoaded();
    this.fonts.version.update((v) => v + 1);
    this.fonts.note.set(
      applied.refusal
        || (applied.layers
          ? `Re-drawn ${applied.layers} text layer${applied.layers === 1 ? '' : 's'}. `
            + `That is ${applied.layers} undo step${applied.layers === 1 ? '' : 's'}, one per layer.`
          : 'Every layer was already drawing its own typeface.'),
    );
  }
}
