import { TestBed } from '@angular/core/testing';
import { ProjectService } from './project.service';
import { PsdLoaderService } from './psd-loader.service';
import { makeProject, rgba, fileOf } from '../../testing/project-fixture';
import { FakeWorker, installFakeWorker } from '../../testing/fake-worker';

/**
 * The one place every mutation in the app funnels through.
 *
 * Every engine call below is the REAL engine — `src/edit.js` and
 * `src/creative/` run identically in Node and the browser, which is why they
 * are plain ESM. Only the worker is faked, and only because jsdom has none.
 */
describe('ProjectService', () => {
  let svc: ProjectService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ProjectService);
  });

  afterEach(() => restoreWorker());

  // ------------------------------------------------------------ the version signal

  describe('version', () => {
    it('bumps on a mutation, because the project is mutated in place', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      const before = svc.version();

      svc.setLayer(project.layers[0].id, { x: 5 });

      expect(svc.version()).toBe(before + 1);
      expect(project.layers[0].x).toBe(5);
    });

    /**
     * The asymmetry the whole design rests on: `project.revision` deliberately
     * stays put across a coalesced drag so the sandwich cache survives it, so
     * the UI cannot read it. `version` must move on every frame anyway.
     */
    it('moves on every coalesced drag frame even though project.revision does not', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      const revision = project.revision;
      const version = svc.version();
      const key = svc.gestureKey('drag');

      for (let i = 1; i <= 5; i++) svc.setLayer(project.layers[0].id, { x: i }, key);

      expect(svc.version()).toBe(version + 5);
      expect(project.revision).toBe(revision + 1);
      expect(project.history.length).toBe(1);
    });

    it('mints a distinct key per gesture', () => {
      expect(svc.gestureKey('drag')).not.toBe(svc.gestureKey('drag'));
    });

    it('does not bump when there is no project', () => {
      const version = svc.version();
      svc.setLayer(1, { x: 1 });
      svc.setAdjust(1, { brightness: 1 });
      svc.reorder(0, 1);
      svc.undo();
      svc.redo();
      svc.discardTo(0);
      expect(svc.version()).toBe(version);
    });

    it('does not bump for a reorder that goes nowhere', () => {
      svc.project.set(makeProject([{}, {}]));
      const version = svc.version();
      svc.reorder(1, 1);
      expect(svc.version()).toBe(version);
    });
  });

  // ------------------------------------------------------------ selection

  describe('selection', () => {
    it('follows the layer through a reorder rather than the index', () => {
      const project = makeProject([{ name: 'bottom' }, { name: 'middle' }, { name: 'top' }]);
      svc.project.set(project);
      svc.select(project.layers[0].id);
      expect(svc.selectionIndex()).toBe(0);

      svc.reorder(0, 2);

      expect(svc.selected().name).toBe('bottom');
      expect(svc.selectionIndex()).toBe(2);
    });

    it('reports -1 and null when nothing is selected', () => {
      svc.project.set(makeProject([{}]));
      expect(svc.selectionIndex()).toBe(-1);
      expect(svc.selected()).toBeNull();
    });

    /**
     * A selection that outlives its layer would hand every sheet a null target.
     * This pins what actually happens today: the id stays set and `selected`
     * resolves to null, so callers must branch on the layer, never on the id.
     */
    it('resolves to null when the selected id is not in the project', () => {
      svc.project.set(makeProject([{}]));
      svc.select(9999);
      expect(svc.selectedId()).toBe(9999);
      expect(svc.selected()).toBeNull();
      expect(svc.selectionIndex()).toBe(-1);
    });
  });

  // ------------------------------------------------------------ hit testing

  describe('hitTest', () => {
    it('picks the topmost covered layer', () => {
      const project = makeProject([
        { name: 'bottom', x: 0, y: 0, w: 40, h: 40 },
        { name: 'top', x: 0, y: 0, w: 40, h: 40 },
      ]);
      svc.project.set(project);
      expect(svc.hitTest(5, 5).name).toBe('top');
    });

    it('skips a layer that is transparent under the finger', () => {
      const project = makeProject([
        { name: 'bottom', x: 0, y: 0, w: 40, h: 40, alpha: 255 },
        { name: 'top', x: 0, y: 0, w: 40, h: 40, alpha: 0 },
      ]);
      svc.project.set(project);
      expect(svc.hitTest(5, 5).name).toBe('bottom');
    });

    it('walks down the stack for a repeated select-mode tap', () => {
      const project = makeProject([
        { name: 'bottom', x: 0, y: 0, w: 40, h: 40 },
        { name: 'top', x: 0, y: 0, w: 40, h: 40 },
      ]);
      svc.project.set(project);

      const first = svc.hitTest(5, 5);
      expect(first.name).toBe('top');
      const index = project.layers.findIndex((l: any) => l.id === first.id);

      expect(svc.hitTestBelow(5, 5, index).name).toBe('bottom');
    });

    it('has nothing below the bottom layer, so the walk stops', () => {
      svc.project.set(makeProject([{ x: 0, y: 0, w: 40, h: 40 }]));
      expect(svc.hitTestBelow(5, 5, 0)).toBeNull();
    });

    it('returns null with no project rather than throwing', () => {
      expect(svc.hitTest(1, 1)).toBeNull();
      expect(svc.hitTestBelow(1, 1, 3)).toBeNull();
    });
  });

  // ------------------------------------------------------------ history

  describe('history', () => {
    it('reports what undo and redo can do, and moves them', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      expect(svc.canUndo()).toBe(false);
      expect(svc.canRedo()).toBe(false);

      svc.setLayer(project.layers[0].id, { x: 12 });
      expect(svc.canUndo()).toBe(true);

      svc.undo();
      expect(project.layers[0].x).toBe(0);
      expect(svc.canUndo()).toBe(false);
      expect(svc.canRedo()).toBe(true);

      svc.redo();
      expect(project.layers[0].x).toBe(12);
    });

    it('rolls a whole sheet session back to the length it opened at', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      const id = project.layers[0].id;

      svc.setLayer(id, { x: 1 });
      const opened = svc.historyLength();
      svc.setLayer(id, { x: 2 });
      svc.setLayer(id, { y: 3 });

      svc.discardTo(opened);

      expect(project.layers[0].x).toBe(1);
      expect(project.layers[0].y).toBe(0);
      expect(svc.historyLength()).toBe(opened);
    });

    /**
     * `✕` must not leave the discarded work on the redo stack, where the user
     * would find it again by accident.
     */
    it('leaves nothing on the redo stack after a discard', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      const opened = svc.historyLength();
      svc.setLayer(project.layers[0].id, { x: 2 });

      svc.discardTo(opened);

      expect(svc.canRedo()).toBe(false);
    });

    it('reports zero history with no project', () => {
      expect(svc.historyLength()).toBe(0);
    });
  });

  // ------------------------------------------------------------ creative commands

  describe('insertImage', () => {
    it('selects the layer the engine minted, and makes it one undo step', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      const before = project.layers.length;

      const refusal = svc.insertImage({ pixels: rgba(4, 4, 255), name: 'Sticker' });

      expect(refusal).toBeNull();
      expect(project.layers.length).toBe(before + 1);
      expect(svc.selected().name).toBe('Sticker');
      expect(project.history.length).toBe(1);

      svc.undo();
      expect(project.layers.length).toBe(before);
    });

    /**
     * An added picture has no file to be re-read from, so its own buffer IS its
     * full-resolution material. Export gates on this flag; without it the whole
     * export is refused with NO_IDENTITY.
     */
    it('marks the layer selfSupplied so export blends its own pixels', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      svc.insertImage({ pixels: rgba(4, 4, 255) });
      expect(svc.selected().selfSupplied).toBe(true);
      expect(svc.selected().sourceIndex).toBeNull();
    });

    it('returns the engine message and selects nothing when the pixels are wrong', () => {
      const project = makeProject([{ name: 'a' }]);
      svc.project.set(project);
      svc.select(project.layers[0].id);

      const refusal = svc.insertImage({ pixels: { width: 4, height: 4 } });

      expect(typeof refusal).toBe('string');
      expect(refusal!.length).toBeGreaterThan(0);
      expect(project.layers.length).toBe(1);
      expect(svc.selectedId()).toBe(project.layers[0].id);
    });
  });

  describe('replaceImage', () => {
    it('keeps the layer in place and contains the new picture in its box', () => {
      const project = makeProject([{ name: 'photo', x: 10, y: 10, w: 40, h: 20 }]);
      svc.project.set(project);
      const id = project.layers[0].id;

      const refusal = svc.replaceImage(id, rgba(8, 8, 255));

      expect(refusal).toBeNull();
      expect(project.layers.length).toBe(1);
      // 'contain', never 'stretch': a square inside a 40x20 box is 20x20.
      expect(project.layers[0].w).toBe(project.layers[0].h);
      expect(project.layers[0].selfSupplied).toBe(true);
      // Export matches arrivals on sourceIndex; a replaced layer must not keep
      // one, or it exports the picture the user just got rid of.
      expect(project.layers[0].sourceIndex).toBeNull();
    });

    it('returns the engine refusal for a text layer instead of throwing', () => {
      const project = makeProject([{ name: 'words', text: 'hi' }]);
      svc.project.set(project);

      const refusal = svc.replaceImage(project.layers[0].id, rgba(4, 4, 255));

      expect(typeof refusal).toBe('string');
      expect(refusal).toContain('words');
    });

    it('is a no-op with no project', () => {
      expect(svc.replaceImage(1, rgba(2, 2, 255))).toBeNull();
    });
  });

  /**
   * There is no 2D canvas context in this environment, which is exactly the
   * "no measurer" case the engine refuses rather than guessing a glyph width.
   * What is pinned here is the SHAPE of the refusal: a message comes back, the
   * project is untouched, and nothing throws into the caller.
   */
  describe('text commands with no measurer', () => {
    it('reports rather than throws, and commits nothing', () => {
      const project = makeProject([{ name: 'words', text: 'hello' }]);
      svc.project.set(project);
      const id = project.layers[0].id;
      const version = svc.version();

      const retype = svc.retypeText(id, { content: 'goodbye' });
      const resize = svc.resizeTextBox(id, { w: 200 });
      const insert = svc.insertText({ content: 'new' });

      for (const refusal of [retype, resize, insert]) expect(typeof refusal).toBe('string');
      expect(project.history.length).toBe(0);
      expect(project.layers.length).toBe(1);
      expect(svc.version()).toBe(version);
      expect(svc.selectedId()).toBeNull();
    });

    it('is a no-op with no project', () => {
      expect(svc.retypeText(1, { content: 'x' })).toBeNull();
      expect(svc.resizeTextBox(1, { w: 10 })).toBeNull();
      expect(svc.insertText({ content: 'x' })).toBeNull();
    });
  });

  // ------------------------------------------------------------ document lifetime

  describe('open', () => {
    it('reports a file it cannot read by name, and does not sit in loading', async () => {
      const file = {
        name: 'broken.psd',
        arrayBuffer: () => Promise.reject(new Error('device is gone')),
      } as unknown as File;

      await svc.open(file);

      expect(svc.state()).toBe('error');
      expect(svc.message()).toContain('broken.psd');
      expect(svc.message()).toContain('device is gone');
      expect(svc.project()).toBeNull();
    });

    /**
     * `refused` is a separate state from `error` on purpose: the remedies
     * differ, and an out-of-memory WebView is a blank screen.
     */
    it('separates a size refusal from a decode failure', async () => {
      const loader = TestBed.inject(PsdLoaderService);
      const guard = { ok: false as const, reason: 'guard' as const, message: 'too big' };
      const decode = { ok: false as const, reason: 'decode' as const, message: 'bad bytes' };
      const outcomes = [guard, decode];
      loader.load = () => Promise.resolve(outcomes.shift()!);

      await svc.open(fileOf('big.psd'));
      expect(svc.state()).toBe('refused');
      expect(svc.message()).toBe('too big');

      await svc.open(fileOf('bad.psd'));
      expect(svc.state()).toBe('error');
      expect(svc.message()).toBe('bad bytes');
    });

    it('clears the previous document before the new one is read', async () => {
      svc.project.set(makeProject([{}]));
      svc.select(svc.project().layers[0].id);

      const loader = TestBed.inject(PsdLoaderService);
      let stateDuringLoad = '';
      let projectDuringLoad: any = 'unset';
      loader.load = () => {
        stateDuringLoad = svc.state();
        projectDuringLoad = svc.project();
        return Promise.resolve({ ok: false as const, reason: 'decode' as const, message: 'x' });
      };

      await svc.open(fileOf('next.psd'));

      expect(stateDuringLoad).toBe('loading');
      expect(projectDuringLoad).toBeNull();
      expect(svc.selectedId()).toBeNull();
    });

    /**
     * `project.source.uri` is a synthetic `file://<name>` nothing can open, so
     * this handle is the only route back to the bytes for a full export.
     */
    it('keeps the picker handle even when the decode fails', async () => {
      const loader = TestBed.inject(PsdLoaderService);
      loader.load = () => Promise.resolve({ ok: false as const, reason: 'decode' as const, message: 'x' });
      const file = fileOf('kept.psd');

      await svc.open(file);

      expect(svc.sourceFile()).toBe(file);
    });

    it('publishes the project and goes ready on success', async () => {
      const project = makeProject([{}]);
      const loader = TestBed.inject(PsdLoaderService);
      loader.load = () => Promise.resolve({ ok: true as const, project });
      const version = svc.version();

      await svc.open(fileOf('good.psd'));

      expect(svc.state()).toBe('ready');
      expect(svc.project()).toBe(project);
      expect(svc.fileName()).toBe('good.psd');
      expect(svc.version()).toBe(version + 1);
    });
  });

  describe('close', () => {
    it('drops every trace of the document, sticky modes included', () => {
      svc.project.set(makeProject([{}]));
      svc.select(svc.project().layers[0].id);
      svc.sourceFile.set(fileOf('a.psd'));
      svc.state.set('ready');
      svc.message.set('note');
      svc.fileName.set('a.psd');
      svc.previewPill.set('preview');
      svc.gesturing.set(true);
      svc.selectMode.set(true);
      svc.lastLiveMs.set(12);
      svc.lastSandwichMs.set(34);

      svc.close();

      expect(svc.project()).toBeNull();
      expect(svc.selectedId()).toBeNull();
      expect(svc.sourceFile()).toBeNull();
      expect(svc.state()).toBe('empty');
      expect(svc.message()).toBe('');
      expect(svc.fileName()).toBe('');
      expect(svc.previewPill()).toBeNull();
      expect(svc.gesturing()).toBe(false);
      // A mode the user turned on for one document must not survive it.
      expect(svc.selectMode()).toBe(false);
      expect(svc.lastLiveMs()).toBeNull();
      expect(svc.lastSandwichMs()).toBeNull();
    });
  });

  describe('warnings', () => {
    it('surfaces what the engine recorded while flattening', () => {
      expect(svc.warnings()).toEqual([]);
      const project = makeProject([{}]);
      project.warnings = ['a group was flattened'];
      svc.project.set(project);
      svc.version.update((v) => v + 1);
      expect(svc.warnings()).toEqual(['a group was flattened']);
    });
  });

  /** The decode worker's own progress, republished so a bar can be determinate. */
  describe('decode progress', () => {
    it('mirrors the loader signals', () => {
      const loader = TestBed.inject(PsdLoaderService);
      loader.progress.set(7);
      loader.total.set(48);
      expect(svc.decoded()).toBe(7);
      expect(svc.total()).toBe(48);
      expect(FakeWorker.instances.length).toBe(0);
    });
  });

  describe('crop', () => {
    it('locks the frame to the largest centred rect of a named ratio', () => {
      svc.project.set(makeProject([{}], { width: 200, height: 100 }));
      const before = svc.version();

      svc.setRatio('1:1');

      // Derived from the SOURCE document, not from the current frame — which is
      // what makes a second tap on the same chip a no-op rather than a shrink.
      expect(svc.project().frame).toEqual({ x: 50, y: 0, width: 100, height: 100 });
      expect(svc.version()).toBeGreaterThan(before);
    });

    it('restores the whole document on free', () => {
      svc.project.set(makeProject([{}], { width: 200, height: 100 }));
      svc.setRatio('1:1');
      svc.setRatio('free');
      expect(svc.project().frame).toBeNull();
    });

    it('reports what a crop would cost, for a frame not yet applied', () => {
      // Leaves default to 0,0,10,10. A frame in the far corner leaves both of
      // them outside it — without ever committing that frame.
      svc.project.set(makeProject([{}, {}]));

      const report = svc.framingReport({ x: 50, y: 50, width: 20, height: 20 });

      expect(report!.outside.length).toBe(2);
      expect(report!.warnings.length).toBe(1);
      // The engine's own sentence, which says the layers are recoverable.
      expect(report!.warnings[0]).toContain('not deleted');
      // Asking did not change anything.
      expect(svc.project().frame).toBeNull();
    });

    it('reports against the committed frame when asked about none', () => {
      svc.project.set(makeProject([{}, {}]));
      expect(svc.framingReport()!.outside.length).toBe(0);
    });

    it('reports nothing when no document is open', () => {
      svc.project.set(null);
      expect(svc.framingReport()).toBeNull();
    });
  });
});
