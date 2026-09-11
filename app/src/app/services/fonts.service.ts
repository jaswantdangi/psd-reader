import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  FONT_FILE_ACCEPT,
  assignFont,
  createFontRegistry,
  fontDemand,
  loadedFontFamilyFor,
  planFont,
  recordFontFailure,
  registerFont,
  resolveFont,
} from '@engine/fonts.js';
import { ProjectService } from './project.service';
import { FontCacheService } from './font-cache.service';

/**
 * Giving the browser the font files a PSD asks for.
 *
 * ## Why there is no shaping engine in here
 *
 * The obvious way to render `MyriadPro-Regular` faithfully is to ship a shaper.
 * It is the wrong call: the browser already embeds HarfBuzz, and
 * `canvas.fillText` shapes through it. Bundling harfbuzzjs would ship about a
 * megabyte of WASM to duplicate the runtime's own engine and would still not
 * have the glyphs, because a PSD stores font NAMES and never font FILES.
 *
 * The missing thing is the file. `new FontFace(family, bytes)` hands it to the
 * engine that is already there, and from that moment `ctx.font` naming the
 * family draws the user's own outlines, correctly shaped, for zero extra bytes.
 * The renderer needs nothing new — see `src/render.js:fontSpec`.
 *
 * ## The files never leave the tab
 *
 * A font file is a licensed asset the user has on their machine. It is read
 * with `file.arrayBuffer()`, handed to `FontFace`, and dropped. There is no
 * backend in this app and this feature does not add one: nothing is uploaded,
 * nothing is persisted, and the registry dies with the tab. Reopening the app
 * means picking the files again, which is the correct trade for not holding
 * somebody's licensed fonts.
 *
 * ## Why loading has to WRITE to the layers
 *
 * Registering a face changes nothing on screen by itself. A text layer read
 * from a PSD is still showing Photoshop's own baked pixels, and even a
 * re-drawn one holds a rasterised cache. So a load applies the family through
 * `retypeText`, which is the sanctioned path for a text field:
 *
 *   - `setLayer` sees `text` among the changes and clears BOTH `layer.rendered`
 *     and `layer.renderedKey`. Clearing only the pixels would leave a matching
 *     key that returns null, and the layer would vanish (src/edit.js:455).
 *   - `retypeText` re-measures the box with the new face before writing, so the
 *     glyphs are not squeezed into a box measured for Arial. Metrics differ
 *     between typefaces; a stale box makes `rasteriseTextAt` scale the block to
 *     fit, which shows the right font at the wrong size.
 *   - `setLayer` flips `rerendered`, which is what moves the layer off
 *     Photoshop's bitmap and onto our rasteriser. That is the visible change,
 *     and it is the only way the real typeface can ever appear.
 *
 * Each layer is its own undo step, because `setLayer` only coalesces commands
 * that target the same layer. That is stated in the note this service publishes
 * rather than left for the user to discover on their fourth undo.
 */
@Injectable({ providedIn: 'root' })
export class FontsService {
  private svc = inject(ProjectService);

  /** Name matching only. Everything in it is pure data; see src/fonts.js. */
  private readonly registry = createFontRegistry();

  /**
   * The live `FontFace` per family, so a file that REPLACES another can drop
   * the one it replaced out of the document. Leaving it in would keep a face
   * the registry no longer points at resident for the life of the tab.
   */
  private readonly faces = new Map<string, FontFace>();

  /**
   * The picked FILE behind each loaded family.
   *
   * `document.fonts` is main-thread only. Full-resolution export rasterises
   * re-drawn text inside a worker (`isSelfRendering` in src/export/order.js),
   * and an `OffscreenCanvas` there draws from the WORKER's own `FontFaceSet` —
   * which knows nothing about a face added here. Without this the exported PNG
   * would quietly come back in the substitute while the screen showed the real
   * typeface, which is the worst available outcome: the divergence appears only
   * in the file the user ships.
   *
   * A `File` is a Blob HANDLE, so holding it costs a reference and not the font
   * bytes. It crosses structured clone by reference too, so the worker reads
   * each font once per export and nothing is copied to get it there.
   */
  private readonly sources = new Map<string, File>();

  private readonly fontSet = typeof document !== 'undefined' ? document.fonts : undefined;

  /** For a file input's `accept`. */
  readonly accept = FONT_FILE_ACCEPT;

  /** Every WebView this app targets has it; a desktop browser in a lab may not. */
  readonly supported = typeof FontFace === 'function' && !!this.fontSet;

  /** Bumped on every registration, failure and application — the registry is a mutable Map. */
  readonly version = signal(0);

  /** A pick is `await`ed per file; the control disables itself rather than queueing. */
  readonly busy = signal(false);

  /** What the last pick did, in layers and names. Cleared when a new pick starts. */
  readonly note = signal('');

  /**
   * Which typefaces this document wants, which are loaded, which are still
   * substituted. Recomputed on a project edit as well as on a font load,
   * because `applied` counts layers and a layer's family can be changed by hand.
   */
  readonly demand = computed<any>(() => {
    this.version();
    this.svc.version();
    const project = this.svc.project();
    return fontDemand(project?.layers ?? [], this.registry);
  });

  /** Typefaces this file names that we still cannot draw. The number worth badging. */
  readonly missing = computed<number>(() => this.demand().substituted);

  /** The loaded face answering the SELECTED layer's typeface, or null. */
  readonly selectedMatch = computed<any>(() => {
    this.version();
    const layer = this.svc.selected();
    const name = layer?.text?.sourceFont;
    return name ? resolveFont(this.registry, name) : null;
  });

  /** Is the selected layer actually drawing the face that answers its name? */
  readonly selectedIsLoaded = computed<boolean>(() => {
    const match = this.selectedMatch();
    const layer = this.svc.selected();
    return !!match && layer?.text?.fontFamily === loadedFontFamilyFor(match.record, layer.text.sourceFont);
  });

  /** Fonts synced from Photoshop in an earlier session, kept on this device. */
  private readonly cache = inject(FontCacheService);

  constructor() {
    // A document reopened without syncing still draws the fonts synced into
    // it last time. `loadCached` does nothing without FontFace, and asks the
    // cache only for names this document is actually substituting.
    effect(() => {
      if (!this.svc.project()) return;
      untracked(() => { void this.loadCached(this.missingNames()); });
    });
  }

  /** The PostScript names this document asks for and no loaded file answers. */
  missingNames(): string[] {
    return this.demand().fonts.filter((f: any) => !f.match).map((f: any) => f.name);
  }

  /**
   * Load whichever of `names` this device kept from an earlier sync, each bound
   * to its exact name the way a synced file is.
   *
   * @returns the names that are now answered by a loaded face
   */
  async loadCached(names: string[]): Promise<string[]> {
    if (!names.length || !this.supported) return [];
    const hits = await this.cache.get(names);
    for (const hit of hits) await this.assignTo(hit.name, [new File([hit.bytes], hit.fileName)]);
    const still = new Set(this.missingNames());
    return hits.map((h) => h.name).filter((n) => !still.has(n));
  }

  // ------------------------------------------------------------ loading

  /**
   * Read every picked file, register the ones that parse, then apply.
   *
   * Files are taken one at a time rather than in parallel: a user picking six
   * weights of a family would otherwise hold six whole font files in memory at
   * once on a phone, and the ordering of replacements would stop being the
   * order they picked them in.
   */
  async load(files: FileList | File[] | null): Promise<void> {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;

    this.note.set('');
    if (!this.supported) {
      this.note.set('This browser has no FontFace API, so font files cannot be loaded here.');
      this.version.update((v) => v + 1);
      return;
    }

    this.busy.set(true);
    const loaded: string[] = [];
    const replaced: string[] = [];
    let failed = 0;

    for (const file of list) {
      const outcome = await this.loadOne(file);
      if (!outcome.ok) { failed++; continue; }
      loaded.push(outcome.family);
      if (outcome.replaced) replaced.push(outcome.replaced);
    }

    const application = this.applyLoaded();
    this.busy.set(false);
    this.version.update((v) => v + 1);
    this.note.set(this.summarise(loaded, replaced, failed, application));
  }

  /**
   * Load a file and bind it to ONE font name the document asks for.
   *
   * The escape hatch from name matching. `load` above can only connect a file
   * to a name when the two are spelled compatibly; a licensed `HelvNeue_Rm.otf`
   * shares no stem with `HelveticaNeue`, so no number of picks will ever answer
   * that row. Here the user names the pairing and the matcher does not get a
   * vote.
   *
   * Takes a list and uses the FIRST file for the binding, because the same
   * `<input multiple>` serves both controls — the rest are still loaded and
   * still matched normally, so picking a family and binding one of them is one
   * trip through the picker rather than two.
   */
  async assignTo(psdFontName: string, files: FileList | File[] | null): Promise<void> {
    const list = files ? Array.from(files) : [];
    if (!list.length || !psdFontName) return;

    this.note.set('');
    if (!this.supported) {
      this.note.set('This browser has no FontFace API, so font files cannot be loaded here.');
      this.version.update((v) => v + 1);
      return;
    }

    this.busy.set(true);
    const loaded: string[] = [];
    const replaced: string[] = [];
    let failed = 0;
    let bound = '';

    for (const file of list) {
      const outcome = await this.loadOne(file);
      if (!outcome.ok) { failed++; continue; }
      loaded.push(outcome.family);
      if (outcome.replaced) replaced.push(outcome.replaced);
      // The first file that actually parsed is the one bound. A file that
      // failed to load must never become the answer to a name.
      if (!bound) {
        bound = outcome.family;
        assignFont(this.registry, psdFontName, outcome.key);
      }
    }

    const application = this.applyLoaded();
    this.busy.set(false);
    this.version.update((v) => v + 1);
    this.note.set(bound
      ? `${bound} is now drawing ${psdFontName}. ${this.summarise(loaded, replaced, failed, application)}`
      : this.summarise(loaded, replaced, failed, application));
  }

  /** One file: parse it, register it, keep its face. Never throws. */
  private async loadOne(file: File): Promise<{ ok: boolean; family: string; replaced: string; key: string }> {
    const miss = { ok: false, family: '', replaced: '', key: '' };
    let plan: any;
    try {
      plan = planFont(file.name);
    } catch (error: any) {
      recordFontFailure(this.registry, file.name, error?.message ?? String(error));
      return miss;
    }

    try {
      const face = new FontFace(plan.family, await file.arrayBuffer());
      // `load()` is where a corrupt file, a wrong extension or an unsupported
      // format is found out. Nothing is registered until it resolves, or the
      // renderer would be handed a family the font database does not have and
      // canvas would fall back silently — which looks exactly like the
      // substitution this whole feature exists to remove.
      await face.load();
      this.fontSet!.add(face);

      const { replaced } = registerFont(this.registry, plan);
      if (replaced) {
        const stale = this.faces.get(replaced.family);
        if (stale && stale !== face) this.fontSet!.delete(stale);
        this.faces.delete(replaced.family);
        this.sources.delete(replaced.family);
      }
      this.faces.set(plan.family, face);
      this.sources.set(plan.family, file);
      return { ok: true, family: plan.family, replaced: replaced ? replaced.family : '', key: plan.key };
    } catch (error: any) {
      recordFontFailure(
        this.registry,
        file.name,
        error?.message || 'The browser could not read this font file.',
      );
      return miss;
    }
  }

  /**
   * The loaded faces, as something a worker can install for itself.
   *
   * Handed to the export worker at the start of every export. If this ever
   * returns less than what the screen is drawing, the PNG and the preview
   * disagree — so it is derived from the same map the loader writes, and never
   * from a snapshot taken earlier.
   */
  fontFiles(): { family: string; file: File }[] {
    return [...this.sources.entries()].map(([family, file]) => ({ family, file }));
  }

  // ------------------------------------------------------------ applying

  /**
   * Point every text layer at the loaded face that answers its own typeface.
   *
   * Layers already drawing it are skipped, so a second pick does not re-commit
   * a no-op onto the undo stack for every layer in the document.
   */
  applyLoaded(): { layers: number; refusal: string } {
    const project = this.svc.project();
    if (!project) return { layers: 0, refusal: '' };

    let layers = 0;
    let refusal = '';
    for (const layer of project.layers) {
      if (layer.kind !== 'text' || !layer.text?.sourceFont) continue;
      const message = this.applyTo(layer);
      if (message === null) continue;
      if (message) refusal = message;
      else layers++;
    }
    return { layers, refusal };
  }

  /** The same, for one layer — what the text sheet's "use it here" button calls. */
  applyToLayer(id: number): void {
    const project = this.svc.project();
    const layer = project?.layers.find((l: any) => l.id === id);
    if (!layer) return;
    const message = this.applyTo(layer);
    this.version.update((v) => v + 1);
    if (message) this.note.set(message);
  }

  /**
   * @returns null when there is nothing to do, '' on success, a message on refusal
   */
  private applyTo(layer: any): string | null {
    const match = resolveFont(this.registry, layer.text?.sourceFont);
    if (!match) return null;

    // The substitute stays BEHIND the loaded family, and it is derived from the
    // NAME THE DOCUMENT ASKS FOR rather than from whatever the layer currently
    // holds — so loading a second font can never nest one loaded family inside
    // another's fallback list, and the string compared here is byte-identical
    // to the one fontDemand counts as "drawing it".
    const family = loadedFontFamilyFor(match.record, layer.text.sourceFont);
    if (layer.text.fontFamily === family) return null;

    return this.svc.retypeText(layer.id, { fontFamily: family }) ?? '';
  }

  // ------------------------------------------------------------ words

  private summarise(
    loaded: string[],
    replaced: string[],
    failed: number,
    application: { layers: number; refusal: string },
  ): string {
    const parts: string[] = [];

    if (loaded.length) parts.push(`Loaded ${loaded.join(', ')}.`);
    if (replaced.length)
      parts.push(`${replaced.join(', ')} replaced the file you loaded earlier for the same face.`);
    if (failed) parts.push(`${failed} file${failed === 1 ? '' : 's'} could not be read — see below.`);

    if (application.layers) {
      parts.push(
        `Re-drawn ${application.layers} text layer${application.layers === 1 ? '' : 's'} in it. `
        + `That is ${application.layers} undo step${application.layers === 1 ? '' : 's'}, one per layer.`,
      );
    } else if (loaded.length) {
      parts.push('No text layer in this document asks for it, so nothing changed on screen.');
    }

    if (application.refusal) parts.push(application.refusal);
    return parts.join(' ');
  }
}
