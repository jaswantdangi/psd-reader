import { TestBed } from '@angular/core/testing';
import { FONT_FILE_ACCEPT } from '@engine/fonts.js';
import { FontsService } from './fonts.service';
import { ProjectService } from './project.service';
import { installFakeWorker } from '../../testing/fake-worker';
import { makeProject, fileOf } from '../../testing/project-fixture';

/**
 * The typeface disclosure — which faces a document wants, and which it is
 * still substituting.
 *
 * `missing()` is the number the editor badges, and it is the only warning a
 * user gets that the PNG they are about to ship is not in the typeface they can
 * see in Photoshop. It is derived from the engine's `fontDemand` over the live
 * project, so it is worth pinning that it actually moves with both inputs.
 *
 * There is no `FontFace` in this environment, which is not a limitation here —
 * it is one of the two shapes the service must survive (the other being a
 * browser that has the API and refuses a particular file). What it must never
 * do is claim a face is loaded when nothing was registered.
 */
describe('FontsService', () => {
  let fonts: FontsService;
  let svc: ProjectService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    fonts = TestBed.inject(FontsService);
    svc = TestBed.inject(ProjectService);
  });

  afterEach(() => restoreWorker());

  it('offers the engine own extension list to a file picker', () => {
    expect(fonts.accept).toBe(FONT_FILE_ACCEPT);
  });

  describe('demand', () => {
    it('is empty with no document', () => {
      expect(fonts.demand().wanted).toBe(0);
      expect(fonts.missing()).toBe(0);
    });

    it('counts each named typeface once, however many layers ask for it', () => {
      svc.project.set(makeProject([
        { name: 'headline', text: 'SALE', font: 'MyriadPro-Bold' },
        { name: 'body', text: 'terms', font: 'MyriadPro-Bold' },
        { name: 'price', text: '£9', font: 'Helvetica' },
      ]));
      svc.version.update((v) => v + 1);

      const demand = fonts.demand();
      expect(demand.wanted).toBe(2);
      expect(demand.loaded).toBe(0);
      expect(demand.substituted).toBe(2);
      expect(fonts.missing()).toBe(2);
      expect(demand.fonts.find((f: any) => f.name === 'MyriadPro-Bold').layers)
        .toEqual(['headline', 'body']);
    });

    /** A layer whose file names no typeface cannot be badged as substituted. */
    it('counts an unnamed text layer apart from the substituted ones', () => {
      svc.project.set(makeProject([{ name: 'plain', text: 'hi' }]));
      svc.version.update((v) => v + 1);

      expect(fonts.demand().unnamed).toBe(1);
      expect(fonts.missing()).toBe(0);
    });

    it('ignores raster layers', () => {
      svc.project.set(makeProject([{ name: 'photo' }]));
      svc.version.update((v) => v + 1);
      expect(fonts.demand().wanted).toBe(0);
    });

    /**
     * A layer's family can be changed by hand, so the count has to recompute on
     * a project edit and not only on a font load.
     */
    it('recomputes when the project changes under it', () => {
      svc.project.set(makeProject([{ name: 'a', text: 'x', font: 'Helvetica' }]));
      svc.version.update((v) => v + 1);
      expect(fonts.missing()).toBe(1);

      svc.project.set(makeProject([{ name: 'a' }]));
      svc.version.update((v) => v + 1);
      expect(fonts.missing()).toBe(0);
    });
  });

  describe('the selected layer', () => {
    it('has no match and is not drawing one when nothing is loaded', () => {
      svc.project.set(makeProject([{ name: 'a', text: 'x', font: 'Helvetica' }]));
      svc.select(svc.project().layers[0].id);

      expect(fonts.selectedMatch()).toBeNull();
      expect(fonts.selectedIsLoaded()).toBe(false);
    });

    it('has no match when the selected layer is not text', () => {
      svc.project.set(makeProject([{ name: 'photo' }]));
      svc.select(svc.project().layers[0].id);
      expect(fonts.selectedMatch()).toBeNull();
    });
  });

  describe('load', () => {
    it('does nothing at all for an empty pick', async () => {
      fonts.note.set('previous');
      await fonts.load(null);
      await fonts.load([]);
      expect(fonts.note()).toBe('previous');
      expect(fonts.busy()).toBe(false);
    });

    /**
     * Reported, never silent. A browser with no `FontFace` cannot draw the
     * user's own outlines, and saying nothing would leave the substituted badge
     * unexplained.
     */
    it('says so when the browser has no FontFace API, and registers nothing', async () => {
      expect(fonts.supported).toBe(false);
      const version = fonts.version();

      await fonts.load([fileOf('Inter-Regular.otf')]);

      expect(fonts.note()).toContain('FontFace');
      expect(fonts.fontFiles()).toEqual([]);
      expect(fonts.busy()).toBe(false);
      expect(fonts.version()).toBe(version + 1);
    });
  });

  describe('applying', () => {
    it('reports nothing to do with no document', () => {
      expect(fonts.applyLoaded()).toEqual({ layers: 0, refusal: '' });
    });

    /**
     * Nothing is registered, so nothing resolves, so no layer is touched. The
     * assertion that matters is the history: a font pass that re-committed a
     * no-op onto every text layer would fill the undo stack with steps that
     * change nothing.
     */
    it('touches no layer when no face answers its name', () => {
      const project = makeProject([
        { name: 'a', text: 'x', font: 'Helvetica' },
        { name: 'b', text: 'y', font: 'MyriadPro-Bold' },
      ]);
      svc.project.set(project);

      expect(fonts.applyLoaded()).toEqual({ layers: 0, refusal: '' });
      expect(project.history.length).toBe(0);
    });

    it('is a no-op for a layer id the document does not have', () => {
      const project = makeProject([{ name: 'a', text: 'x', font: 'Helvetica' }]);
      svc.project.set(project);
      const version = fonts.version();

      fonts.applyToLayer(4242);

      expect(project.history.length).toBe(0);
      expect(fonts.version()).toBe(version);
    });
  });

  describe('fontFiles', () => {
    it('starts empty, so an export cannot be told a face is available', () => {
      expect(fonts.fontFiles()).toEqual([]);
    });
  });
});
