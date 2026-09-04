import { TestBed } from '@angular/core/testing';
import { zipSync } from 'fflate';
import { BundleService } from './bundle.service';
import { ProjectService } from './project.service';
import { FakeWorker, installFakeWorker, nextWorker } from '../../testing/fake-worker';
import { makeProject, fileOf } from '../../testing/project-fixture';

/**
 * Opening a designer's handover folder as one zip.
 *
 * These use REAL zips, built with the same fflate the service reads them with,
 * and the engine's real `classifyBundle`. Only the decode worker is faked. A
 * mocked unzip would prove the service can call fflate and nothing about
 * whether fflate accepts what it is given.
 */
describe('BundleService', () => {
  let bundle: BundleService;
  let svc: ProjectService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    bundle = TestBed.inject(BundleService);
    svc = TestBed.inject(ProjectService);
  });

  afterEach(() => restoreWorker());

  /** A real archive. Entries stay small so fflate never reaches for a worker. */
  function zipOf(entries: Record<string, number>): File {
    const contents: Record<string, Uint8Array> = {};
    for (const [path, size] of Object.entries(entries)) contents[path] = new Uint8Array(size);
    const bytes = zipSync(contents) as Uint8Array<ArrayBuffer>;
    return fileOf('handover.zip', bytes);
  }

  describe('handles', () => {
    it('claims a zip and leaves a bare document alone', () => {
      expect(bundle.handles(fileOf('a.zip'))).toBe(true);
      expect(bundle.handles(fileOf('A.ZIP'))).toBe(true);
      expect(bundle.handles(fileOf('a.psd'))).toBe(false);
      expect(bundle.handles(fileOf('a.psb'))).toBe(false);
    });
  });

  describe('refusals', () => {
    it('refuses a file that is not a zip, and names it', async () => {
      await bundle.open(fileOf('renamed.zip', new Uint8Array([1, 2, 3, 4])));

      expect(bundle.status()).toBe('refused');
      expect(bundle.message()).toContain('renamed.zip');
      expect(bundle.message()).toContain('not a readable zip');
      expect(FakeWorker.instances.length).toBe(0);
    });

    it('refuses an archive with no document in it', async () => {
      await bundle.open(zipOf({ 'fonts/Inter-Regular.otf': 64, 'notes.txt': 8 }));

      expect(bundle.status()).toBe('refused');
      expect(bundle.message()).toContain('no .psd or .psb');
      expect(FakeWorker.instances.length).toBe(0);
    });

    /**
     * A handover is a document and the fonts it names. An archive of this size
     * is a backup, or a bomb — and it is refused off the central directory,
     * before an entry is inflated.
     */
    it('refuses an archive with more entries than a handover can have', async () => {
      const entries: Record<string, number> = { 'poster.psd': 32 };
      for (let i = 0; i < 600; i++) entries[`junk/${i}.bin`] = 1;

      await bundle.open(zipOf(entries));

      expect(bundle.status()).toBe('refused');
      expect(bundle.message()).toContain('entries');
      expect(FakeWorker.instances.length).toBe(0);
    });
  });

  /**
   * Two documents are usually a final and a draft. Picking the first would look
   * exactly like the feature working until the user noticed the wrong artwork.
   */
  describe('more than one document', () => {
    it('asks which one instead of guessing', async () => {
      await bundle.open(zipOf({ 'final.psd': 32, 'drafts/old.psd': 32 }));

      expect(bundle.status()).toBe('choose');
      expect(bundle.choices().map((c) => c.path).sort()).toEqual(['drafts/old.psd', 'final.psd']);
      expect(bundle.message()).toContain('2 documents');
      expect(FakeWorker.instances.length).toBe(0);
    });

    it('opens the one the user picked, by path and not by name', async () => {
      const zip = zipOf({ 'final.psd': 32, 'drafts/old.psd': 32 });
      await bundle.open(zip);

      const project = makeProject([{}]);
      const opening = bundle.choose('drafts/old.psd');
      (await nextWorker()).emit({ type: 'done', project });
      await opening;

      expect(svc.state()).toBe('ready');
      expect(svc.project()).toBe(project);
      // The document's own name, not the archive's.
      expect(svc.fileName()).toBe('old.psd');
    });

    it('does nothing when a choice arrives with no archive held', async () => {
      await bundle.choose('final.psd');
      expect(bundle.status()).toBe('idle');
      expect(FakeWorker.instances.length).toBe(0);
    });
  });

  describe('a single document', () => {
    it('unpacks it, opens it, and says the zip carried no fonts', async () => {
      const project = makeProject([{}]);
      const opening = bundle.open(zipOf({ 'art/poster.psd': 64 }));
      (await nextWorker()).emit({ type: 'done', project });
      await opening;

      expect(bundle.status()).toBe('idle');
      expect(svc.state()).toBe('ready');
      expect(svc.fileName()).toBe('poster.psd');
      expect(bundle.note()).toContain('no font files');
    });

    /**
     * The document has to open even when the fonts do not. This environment has
     * no `FontFace`, which is the same shape of failure as a browser that
     * refuses one: the import must not cost the user the whole handover.
     */
    it('still opens the document when the fonts cannot be registered', async () => {
      const project = makeProject([{ text: 'SALE', font: 'MyriadPro-Regular' }]);
      const opening = bundle.open(zipOf({ 'poster.psd': 64, 'fonts/Myriad Pro Regular.otf': 64 }));
      (await nextWorker()).emit({ type: 'done', project });
      await opening;

      expect(svc.state()).toBe('ready');
      // ...and the typeface it could not answer is NAMED, not counted, so it
      // can be found. A document rendering one substitute looks finished.
      expect(bundle.stillSubstituted()).toEqual(['MyriadPro-Regular']);
      expect(bundle.note()).toContain('MyriadPro-Regular');
    });

    it('reports a refused document rather than leaving the screen reading', async () => {
      const opening = bundle.open(zipOf({ 'poster.psd': 64 }));
      (await nextWorker()).emit({ type: 'error', message: 'not a PSD' });
      await opening;

      expect(svc.state()).toBe('error');
      // The bundle's own status is already idle — the archive was fine.
      expect(bundle.status()).toBe('idle');
    });
  });

  describe('reset', () => {
    it('clears everything a previous archive left behind', async () => {
      await bundle.open(zipOf({ 'a.psd': 32, 'b.psd': 32 }));
      expect(bundle.status()).toBe('choose');

      bundle.reset();

      expect(bundle.status()).toBe('idle');
      expect(bundle.message()).toBe('');
      expect(bundle.fileName()).toBe('');
      expect(bundle.choices()).toEqual([]);
      expect(bundle.note()).toBe('');
      expect(bundle.stillSubstituted()).toEqual([]);
      // The archive handle goes too, so a stale choice cannot reopen it.
      await bundle.choose('a.psd');
      expect(bundle.status()).toBe('idle');
    });

    it('reports reading while an archive is in flight', () => {
      bundle.open(zipOf({ 'poster.psd': 64 }));
      expect(bundle.busy()).toBe(true);
      expect(bundle.fileName()).toBe('handover.zip');
    });
  });
});
