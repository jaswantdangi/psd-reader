import { TestBed } from '@angular/core/testing';
import { ExportService } from './export.service';
import { FontsService } from './fonts.service';
import { FakeWorker, installFakeWorker } from '../../testing/fake-worker';
import { makeProject, rgba, fileOf } from '../../testing/project-fixture';

/**
 * The export worker's protocol and its lifetime.
 *
 * `exportFullRes` itself is the engine's and is covered in Node. What lives
 * only here is the payload — which is a CORRECTNESS decision, not a memory one
 * — and cancellation, which is `terminate()` and nothing else.
 */
describe('ExportService', () => {
  let svc: ExportService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ExportService);
  });

  afterEach(() => restoreWorker());

  function startExport(project: any = makeProject([{}]), name = 'poster.psd') {
    project.fileName = name;
    svc.start(project, fileOf(name));
    return project;
  }

  // ------------------------------------------------------------ starting

  describe('start', () => {
    it('arms the progress signals and hands the worker the file and the fonts', () => {
      const project = startExport();

      expect(svc.running()).toBe(true);
      expect(svc.phase()).toBe('read');
      expect(svc.percent()).toBe(0);
      expect(svc.determinate()).toBe(true);
      expect(svc.failed()).toBe(false);

      const sent = FakeWorker.last.posted[0];
      expect(sent.file).toBeInstanceOf(File);
      expect(sent.fonts).toEqual(TestBed.inject(FontsService).fontFiles());
      expect(sent.project.width).toBe(project.width);
      expect(sent.project.layers.length).toBe(project.layers.length);
    });

    it('refuses a second export while one is in flight', () => {
      startExport();
      startExport(makeProject([{}]), 'other.psd');
      expect(FakeWorker.instances.length).toBe(1);
    });

    it('clears the previous outcome so a stale note cannot be read as this run', () => {
      svc.note.set('Saved earlier.png');
      svc.failed.set(true);
      svc.spilledToMemory.set(true);

      startExport();

      expect(svc.note()).toBe('');
      expect(svc.failed()).toBe(false);
      expect(svc.spilledToMemory()).toBe(false);
    });
  });

  // ------------------------------------------------------------ the payload

  describe('what crosses to the worker', () => {
    /**
     * Not only a memory saving. `target.blend` never consults `layer.pixels` on
     * the export path, so sending the proxy would leave open the one failure
     * `stream.js` names as the worst available: a full-size image quietly
     * upscaled from the proxy, which looks like it worked.
     */
    it('drops the proxy pixels of every layer the file will supply', () => {
      const project = makeProject([{ name: 'from file' }]);
      expect(project.layers[0].pixels).not.toBeNull();

      startExport(project);

      const sent = FakeWorker.last.posted[0].project;
      expect(sent.layers[0].pixels).toBeNull();
      // The live project is not touched — the screen still has to draw.
      expect(project.layers[0].pixels).not.toBeNull();
    });

    /**
     * The inverse case, and dropping these does not degrade the export, it
     * BREAKS it: `drawsOwnPixels` is gated on `selfSupplied && !!pixels`, and a
     * stripped layer then fails `assertIdentifiable` with NO_IDENTITY.
     */
    it('keeps the pixels of a layer that supplies its own', () => {
      const project = makeProject([{ name: 'from file' }]);
      const pixels = rgba(4, 4, 255);
      project.layers.push({
        ...project.layers[0],
        id: 999,
        name: 'sticker',
        selfSupplied: true,
        sourceIndex: null,
        pixels,
      });

      startExport(project);

      const sent = FakeWorker.last.posted[0].project;
      expect(sent.layers[0].pixels).toBeNull();
      expect(sent.layers[1].pixels).toBe(pixels);
    });

    /**
     * An image overlay carries its texture inside the adjustment and has no
     * other route across. Stripping it "for symmetry" would give a preview that
     * shows the overlay and a PNG that does not.
     */
    it('keeps the adjust stack whole, textures included', () => {
      const project = makeProject([{ name: 'a' }]);
      const texture = rgba(2, 2, 255);
      project.layers[0].adjust = { overlay: { pixels: texture } };

      startExport(project);

      const sent = FakeWorker.last.posted[0].project;
      expect(sent.layers[0].adjust.overlay.pixels).toBe(texture);
    });
  });

  // ------------------------------------------------------------ progress

  describe('progress', () => {
    it('takes determinacy from the engine, never from the phase name', () => {
      startExport();
      const worker = FakeWorker.last;

      worker.emit({ type: 'progress', phase: 'layers', done: 12, total: 48, fraction: 0.5, determinate: true });
      expect(svc.phase()).toBe('layers');
      expect(svc.percent()).toBe(50);
      expect(svc.determinate()).toBe(true);
      expect(svc.detail()).toBe('12 of 48');

      // `parse` and `encode` have no interior yield point; a creeping bar over
      // a three-second freeze is worse than one that admits it.
      worker.emit({ type: 'progress', phase: 'encode', done: 0, total: 0, fraction: 0.92, determinate: false });
      expect(svc.determinate()).toBe(false);
      expect(svc.detail()).toBe('');
    });

    it('shows no n-of-N for a phase with a single step', () => {
      startExport();
      FakeWorker.last.emit({ type: 'progress', phase: 'write', done: 1, total: 1, fraction: 1, determinate: true });
      expect(svc.detail()).toBe('');
    });

    it('treats a missing fraction as zero rather than NaN', () => {
      startExport();
      FakeWorker.last.emit({ type: 'progress', phase: 'read', determinate: true });
      expect(svc.percent()).toBe(0);
    });

    it('names each phase in words, and falls back to a phase it does not know', () => {
      svc.phase.set('readback');
      expect(svc.phaseLabel()).toBe('Reading back the composite');
      svc.phase.set('something-new');
      expect(svc.phaseLabel()).toBe('something-new');
    });
  });

  // ------------------------------------------------------------ finishing

  describe('done', () => {
    it('stops, names the saved PNG after the document, and reports its size', () => {
      startExport(makeProject([{}]), 'poster.psd');
      FakeWorker.last.emit({
        type: 'done',
        blob: new Blob([new Uint8Array(2048)], { type: 'image/png' }),
        width: 4961,
        height: 3508,
        spill: 'disk',
      });

      expect(svc.running()).toBe(false);
      expect(svc.failed()).toBe(false);
      expect(FakeWorker.last.terminated).toBe(1);
      expect(svc.note()).toContain('poster.png');
      expect(svc.note()).toContain('4961 × 3508');
      expect(svc.note()).toContain('2 KB');
      expect(svc.spilledToMemory()).toBe(false);
    });

    /** Shown, not hidden: the heap fallback is the memory risk this avoids. */
    it('discloses when the spill fell back to the heap', () => {
      startExport();
      FakeWorker.last.emit({
        type: 'done', blob: new Blob([new Uint8Array(8)]), width: 1, height: 1, spill: 'memory',
      });
      expect(svc.spilledToMemory()).toBe(true);
    });

    it('reports megabytes with one decimal above a megabyte', () => {
      startExport();
      FakeWorker.last.emit({
        type: 'done',
        blob: new Blob([new Uint8Array(3 * 1024 * 1024)]),
        width: 10, height: 10, spill: 'disk',
      });
      expect(svc.note()).toContain('3.0 MB');
    });
  });

  describe('failure', () => {
    it('reports the engine message and stops', () => {
      startExport();
      FakeWorker.last.emit({ type: 'error', message: 'The file changed on disk.', code: 'SOURCE_CHANGED' });

      expect(svc.running()).toBe(false);
      expect(svc.failed()).toBe(true);
      expect(svc.note()).toBe('The file changed on disk.');
      expect(FakeWorker.last.terminated).toBe(1);
    });

    it('never leaves a failure without words', () => {
      startExport();
      FakeWorker.last.emit({ type: 'error', message: '' });
      expect(svc.note()).toBe('Export failed.');
    });

    it('reports a worker that could not start', () => {
      startExport();
      FakeWorker.last.fail('');
      expect(svc.failed()).toBe(true);
      expect(svc.note()).toBe('The export worker failed to start.');
      expect(svc.running()).toBe(false);
    });

    /**
     * A worker killed mid-export raises no `error` event. Without this the
     * sheet sits on a frozen bar forever, which reads exactly like a slow
     * export.
     */
    it('reports a worker that stopped responding', () => {
      startExport();
      FakeWorker.last.garble();
      expect(svc.failed()).toBe(true);
      expect(svc.note()).toContain('stopped responding');
      expect(svc.running()).toBe(false);
    });
  });

  // ------------------------------------------------------------ cancellation

  describe('cancel', () => {
    /**
     * THE contract worth pinning. `exportFullRes` accepts a `{cancelled}`
     * signal, but on the fast path this worker never returns to its own event
     * loop, so the message that would set it can never be delivered. Cancel is
     * therefore `terminate()` and nothing else — which is also why the engine's
     * `finally` never runs, and why setup wipes the spill directory BEFORE
     * every export rather than only after one.
     */
    it('terminates instead of asking the worker to stop', () => {
      startExport();
      const worker = FakeWorker.last;
      const postsBeforeCancel = worker.posted.length;

      svc.cancel();

      expect(worker.terminated).toBe(1);
      // No graceful request was sent: there is nothing that could deliver it.
      expect(worker.posted.length).toBe(postsBeforeCancel);
      expect(svc.running()).toBe(false);
    });

    it('is not a failure, and says nothing was written', () => {
      startExport();
      svc.cancel();

      expect(svc.failed()).toBe(false);
      expect(svc.note()).toBe('Export cancelled. Nothing was written.');
    });

    it('does nothing when no export is running', () => {
      svc.note.set('Saved poster.png');
      svc.cancel();
      expect(svc.note()).toBe('Saved poster.png');
      expect(FakeWorker.instances.length).toBe(0);
    });

    it('frees the slot, so the next export starts a fresh worker', () => {
      startExport();
      svc.cancel();
      startExport(makeProject([{}]), 'second.psd');

      expect(FakeWorker.instances.length).toBe(2);
      expect(svc.running()).toBe(true);
    });
  });
});
