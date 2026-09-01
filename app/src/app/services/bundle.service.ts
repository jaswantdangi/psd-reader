import { Injectable, computed, inject, signal } from '@angular/core';
import { unzip, unzipSync } from 'fflate';
import {
  BUNDLE_ENTRY_CAP,
  bundleFontOutcome,
  classifyBundle,
  isBundleFileName,
} from '@engine/bundle.js';
import { memoryBudgetBytes } from '@engine/budget.js';
import { planFont } from '@engine/fonts.js';
import { FontsService } from './fonts.service';
import { ProjectService } from './project.service';

/**
 * Re-view fflate bytes as a plain `Uint8Array<ArrayBuffer>`.
 *
 * fflate returns `Uint8Array<ArrayBufferLike>`, and `BlobPart` demands
 * `ArrayBufferView<ArrayBuffer>` — the same rejection the export worker hits on
 * engine buffers, with the same fix. It builds a VIEW over the existing bytes
 * and must never copy: a copy here is a second whole PSD.
 */
const asBytes = (view: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);

/** Nothing is happening / reading the archive / which PSD? / refused with a reason. */
export type BundleStatus = 'idle' | 'reading' | 'choose' | 'refused';

interface PsdChoice {
  path: string;
  name: string;
  size: number;
}

/**
 * Opening a designer's handover folder — PSD and fonts together — as one zip.
 *
 * ## Why a zip reader at all
 *
 * `FontsService` can already turn a font file into real glyphs on screen. What
 * it cannot do is tell the user WHICH files to go and find: a PSD names its
 * typefaces and carries none, so the Fonts sheet ends up as a shopping list the
 * user takes to their filesystem. A handover is never a bare PSD — it is a
 * folder — so accepting the folder deletes the shopping trip instead of
 * formatting it more nicely.
 *
 * ## Why fflate, and why the engine does not know about it
 *
 * Browsers have no zip reader. `DecompressionStream` does raw deflate and knows
 * nothing about the container — central directory, local headers, zip64, data
 * descriptors — and hand-rolling that is about 150 lines that break on the first
 * archive a Windows zipper wrote. fflate is ~8 kB, MIT, zero dependencies, and
 * handles stored and deflated entries alike.
 *
 * It is a dependency of `app/` only. `src/bundle.js` decides WHAT to do with a
 * manifest and never sees a compressed byte, which is what keeps that decision
 * testable in Node and keeps the engine dependency-free.
 *
 * ## Three passes, on purpose
 *
 * 1. **Manifest** — `unzipSync` with a filter that records every central
 *    directory record and returns `false`, so nothing is inflated at all. This
 *    is where a zip bomb is refused: the archive's own declared uncompressed
 *    sizes are checked before a byte of it is expanded.
 * 2. **Fonts** — inflate only the entries `classifyBundle` named as fonts,
 *    register them, drop the bytes.
 * 3. **The PSD** — inflate one entry, wrap it as a `File`, release the archive,
 *    then hand it to the ordinary loader.
 *
 * Two inflate passes rather than one because the peak matters: doing both at
 * once holds the archive, the PSD and every font simultaneously. The font bytes
 * are gone before the PSD's arrive, so the peak is
 * `zip + PSD + one copy of the PSD` — the copy being the `File` the export path
 * needs to re-read the document at full resolution.
 *
 * ## What is not done
 *
 * Nothing is written, nothing is executed, and nothing leaves the tab. Only
 * entries whose extension is a PSD or a font are read at all; everything else in
 * the archive is ignored by name, and the fonts are the user's licensed files —
 * they live as `FontFace` objects for the life of the tab and are not persisted.
 */
@Injectable({ providedIn: 'root' })
export class BundleService {
  private svc = inject(ProjectService);
  private fonts = inject(FontsService);

  readonly status = signal<BundleStatus>('idle');

  /** Why the archive was refused. Never a generic failure — see `classifyBundle`. */
  readonly message = signal('');

  /** The archive's own name, so a refusal screen can say which file it means. */
  readonly fileName = signal('');

  /** Populated only when the archive holds more than one document. */
  readonly choices = signal<PsdChoice[]>([]);

  /**
   * What the last handover achieved, in the three facts that make it trustworthy
   * rather than magic: which fonts drew, which the archive carried that nothing
   * asked for, and which typefaces are STILL substituted.
   *
   * Kept here rather than in `FontsService.note` because the editor clears that
   * note every time a sheet opens — it reports what the last PICK did — and this
   * has to survive until the user has read it.
   */
  readonly note = signal('');

  /** Names the archive did not answer. Listed, not counted, so they can be found. */
  readonly stillSubstituted = signal<string[]>([]);

  readonly busy = computed(() => this.status() === 'reading');

  /** The archive itself, kept as a handle so the "which document?" answer can re-read it. */
  private archive: File | null = null;

  /** Does this file go through the zip path rather than straight to the loader? */
  handles(file: File): boolean {
    return isBundleFileName(file.name);
  }

  reset(): void {
    this.archive = null;
    this.status.set('idle');
    this.message.set('');
    this.fileName.set('');
    this.choices.set([]);
    this.note.set('');
    this.stillSubstituted.set([]);
  }

  /**
   * Read an archive and open the document inside it.
   *
   * `pick` is the path of the PSD to use, supplied only after the user has
   * answered the "which one?" question. The archive is re-read from scratch for
   * that answer rather than being cached: holding a whole zip's bytes across a
   * user decision of unknown length is the wrong thing to keep resident on a
   * phone, and re-reading the central directory is microseconds.
   */
  async open(file: File, pick?: string): Promise<void> {
    this.reset();
    this.archive = file;
    this.status.set('reading');
    this.fileName.set(file.name);

    let archive: Uint8Array;
    try {
      archive = new Uint8Array(await file.arrayBuffer());
    } catch (error: any) {
      this.refuse(`Could not read ${file.name}: ${error?.message ?? error}`);
      return;
    }

    let manifest: { path: string; size: number }[];
    try {
      manifest = this.readManifest(archive);
    } catch {
      // fflate throws on a missing end-of-central-directory record, which is
      // what a renamed file or a truncated download looks like.
      this.refuse(
        `${file.name} is not a readable zip — it may have been renamed, or the download may be incomplete.`,
      );
      return;
    }

    const report = classifyBundle(manifest, {
      budgetBytes: memoryBudgetBytes((navigator as any).deviceMemory),
      pick,
    });

    if (!report.ok) {
      if (report.reason === 'many-psds') {
        this.choices.set(report.psds);
        this.message.set(report.message ?? '');
        this.status.set('choose');
        return;
      }
      this.refuse(report.message ?? 'This zip cannot be opened.');
      return;
    }

    // `ok` is a boolean rather than a discriminant, so the compiler cannot see
    // that it implies a document. Re-asking is one line, and cheaper than an
    // assertion that would go quietly wrong the day the return shape changes.
    const psd = report.psd;
    if (!psd) { this.refuse('This zip cannot be opened.'); return; }

    // --- fonts first, and their bytes released before the PSD's arrive -------
    let fontFamilies: string[] = [];
    let fontTrouble = '';
    if (report.fonts.length) {
      try {
        const bytes = await this.extract(archive, report.fonts.map((f: any) => f.path));
        const files = report.fonts
          .filter((f: any) => bytes.has(f.path))
          .map((f: any) => new File([asBytes(bytes.get(f.path)!)], f.name));
        bytes.clear();
        // A font the browser refuses is recorded against its own name by
        // `FontsService` and does not stop the others — one broken file in a
        // folder of twelve must not cost the user the whole import.
        await this.fonts.load(files);
        fontFamilies = this.familiesFrom(files);
      } catch (error: any) {
        // Unpacking the fonts failed as a whole. The document is still openable,
        // so this is carried into the final note rather than replacing it —
        // "the fonts failed" and "here is what is substituted" are both true.
        fontTrouble =
          `The font files in ${file.name} could not be unpacked (${error?.message ?? error}). `
          + 'Loading them by hand still works.';
      }
    }

    // --- then the document ---------------------------------------------------
    let psdFile: File;
    try {
      const bytes = await this.extract(archive, [psd.path]);
      const data = bytes.get(psd.path);
      if (!data) throw new Error('the entry was not in the archive after all');
      // The `File` is what the full-resolution export re-reads, so it has to
      // outlive this method. Making it here and dropping every other reference
      // means the archive can be collected before the decode worker starts.
      psdFile = new File([asBytes(data)], psd.name);
      bytes.clear();
    } catch (error: any) {
      this.refuse(`${psd.name} could not be unpacked from ${file.name}: ${error?.message ?? error}`);
      return;
    }

    archive = new Uint8Array(0);
    this.status.set('idle');

    await this.svc.open(psdFile);
    if (this.svc.state() !== 'ready') return;

    // Fonts registered before a project existed applied to nothing. This is the
    // call that actually re-draws the text layers in their real typefaces.
    const applied = this.fonts.applyLoaded();
    this.fonts.version.update((v) => v + 1);

    const outcome = bundleFontOutcome(this.fonts.demand(), fontFamilies);
    this.stillSubstituted.set(outcome.substituted);
    this.note.set(
      [fontTrouble, this.summarise(report, outcome, applied.layers), applied.refusal]
        .filter(Boolean)
        .join(' '),
    );
  }

  /**
   * The user answered which document; read the archive again for that one.
   *
   * The archive is a `File` HANDLE, so keeping it across the question costs a
   * reference and not a zip. Its BYTES were dropped when the question was
   * asked — holding a whole archive resident across a decision of unknown
   * length is exactly the thing a phone cannot afford.
   */
  async choose(path: string): Promise<void> {
    const file = this.archive;
    if (file) await this.open(file, path);
  }

  /**
   * The families THIS archive contributed, and only those.
   *
   * `FontsService.fontFiles()` is every face the session holds, hand-picked ones
   * included, so reading it directly would credit the zip with a font the user
   * loaded ten minutes ago — and then report it as "in the zip and unused" when
   * nothing asks for it. `planFont` derives the same family the registry keyed
   * the file under, and intersecting with what is actually registered drops the
   * files the browser refused, which must never be reported as loaded.
   */
  private familiesFrom(files: File[]): string[] {
    const registered = new Set(this.fonts.fontFiles().map((entry) => entry.family));
    const families: string[] = [];
    for (const file of files) {
      let family = '';
      try {
        family = planFont(file.name).family;
      } catch {
        continue;                     // already recorded as a failure by FontsService
      }
      if (registered.has(family) && !families.includes(family)) families.push(family);
    }
    return families;
  }

  // ------------------------------------------------------------ zip reading

  /**
   * Every central directory record, and NOTHING inflated.
   *
   * The filter returns `false` for every entry, so fflate walks the directory
   * and expands nothing — which is the only order in which a declared 10 GB can
   * be refused before it costs 10 GB. `unzipSync` rather than the async form
   * because no decompression happens here, and because fflate's async `unzip`
   * never calls back at all for an archive with zero entries.
   *
   * Collection stops at `BUNDLE_ENTRY_CAP + 1`: that is enough for
   * `classifyBundle` to refuse on, and building the whole list for an archive
   * with a million records is the cost the cap exists to avoid.
   */
  private readManifest(archive: Uint8Array): { path: string; size: number }[] {
    const entries: { path: string; size: number }[] = [];
    unzipSync(archive, {
      filter: (entry) => {
        if (entries.length <= BUNDLE_ENTRY_CAP)
          entries.push({ path: entry.name, size: entry.originalSize });
        return false;
      },
    });
    return entries;
  }

  /**
   * Inflate exactly the named entries and nothing else.
   *
   * Async rather than `unzipSync`: fflate moves anything above 512 kB onto a
   * worker, and a PSD is always above 512 kB. Inflating one synchronously would
   * freeze the main thread for the whole expansion, during which the "Reading…"
   * screen cannot paint.
   */
  private extract(archive: Uint8Array, paths: string[]): Promise<Map<string, Uint8Array>> {
    // Entry names are compared against the NORMALISED paths classifyBundle
    // returned, so a Windows archive's `fonts\Foo.otf` still matches.
    const wanted = new Set(paths);
    const normalise = (name: string) => name.replace(/\\/g, '/');

    return new Promise((resolve, reject) => {
      unzip(
        archive,
        { filter: (entry) => wanted.has(normalise(entry.name)) },
        (error, files) => {
          if (error) { reject(error); return; }
          const out = new Map<string, Uint8Array>();
          for (const [name, data] of Object.entries(files ?? {}))
            out.set(normalise(name), data as Uint8Array);
          resolve(out);
        },
      );
    });
  }

  // ------------------------------------------------------------ words

  private refuse(message: string): void {
    this.message.set(message);
    this.status.set('refused');
  }

  /**
   * What the archive actually did, including the parts that did not work.
   *
   * The temptation is to report only "loaded 4 fonts", which reads as finished.
   * A document rendering three real typefaces and one substitute LOOKS right,
   * so the user ships it — which is the same failure as a silent substitution,
   * arrived at from the other end. So the still-substituted names come last and
   * always, and the fonts nothing asked for are named too, because that is
   * usually the sign that the wrong folder was zipped.
   */
  private summarise(
    report: any,
    outcome: { used: string[]; unused: string[]; substituted: string[] },
    layers: number,
  ): string {
    const parts: string[] = [];

    if (outcome.used.length) {
      parts.push(
        `${outcome.used.join(', ')} came from the zip and ${outcome.used.length === 1 ? 'is' : 'are'} drawing`
        + `${layers ? ` on ${layers} text layer${layers === 1 ? '' : 's'}` : ''}.`,
      );
    }

    if (outcome.unused.length) {
      parts.push(
        `${outcome.unused.join(', ')} ${outcome.unused.length === 1 ? 'was' : 'were'} in the zip and no `
        + 'layer in this document asks for '
        + `${outcome.unused.length === 1 ? 'it' : 'them'}.`,
      );
    }

    if (outcome.substituted.length) {
      parts.push(
        `Still substituted: ${outcome.substituted.join(', ')} — the zip did not include `
        + `${outcome.substituted.length === 1 ? 'that font' : 'those fonts'}, so `
        + `${outcome.substituted.length === 1 ? 'that name is' : 'those names are'} drawn in the `
        + 'closest stack this device can guarantee.',
      );
    } else if (outcome.used.length) {
      parts.push('Every typeface this document names has a file. Nothing is being substituted.');
    }

    if (!report.fonts.length)
      parts.push('This zip had no font files in it, so only the document was opened.');

    const ignored = report.ignored.filter((i: any) => i.why === 'unsafe-path').length;
    if (ignored)
      parts.push(`${ignored} entr${ignored === 1 ? 'y' : 'ies'} with an unsafe path were ignored.`);

    return parts.join(' ');
  }
}
