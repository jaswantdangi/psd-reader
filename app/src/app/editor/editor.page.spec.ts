import { TestBed } from '@angular/core/testing';
import { EditorPage } from './editor.page';
import { ProjectService } from '../services/project.service';
import { ToolService } from '../services/tool.service';
import { SegmentService } from '../services/segment.service';
import { makeProject } from '../../testing/project-fixture';
import { installFakeWorker } from '../../testing/fake-worker';
import { presetAdjust } from '@engine/adjust/presets.js';
import { NEUTRAL_ADJUST } from '@engine/adjust/ops.js';

/**
 * The editor page, as logic rather than markup — the trade sync-sheet's spec
 * makes, and for the same reason: what is worth asserting here is not the
 * template but the two things this component actually decides.
 *
 * ONE: which canvas mode is armed. Crop, the eyedropper and the cut-out brush
 * all claim the single-pointer path in `canvas-stage.onPointerDown`, which
 * reads them in a fixed order — so two armed at once does not mean "both", it
 * means whichever is checked first, silently.
 *
 * TWO: which rail entries carry an edit, which has to distinguish an Adjust
 * change from an HSL one even though both live on `layer.adjust`.
 */
describe('EditorPage', () => {
  let page: any;
  let svc: ProjectService;
  let tool: ToolService;
  let seg: SegmentService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ProjectService);
    tool = TestBed.inject(ToolService);
    seg = TestBed.inject(SegmentService);
    page = TestBed.runInInjectionContext(() => new EditorPage());
    svc.project.set(makeProject([{ name: 'a' }, { name: 'b' }]));
  });

  afterEach(() => restoreWorker());

  describe('canvas modes are mutually exclusive', () => {
    it('stands the cut-out tool down when crop is armed', () => {
      page.cutout.set(true);
      seg.tool.set('keep');

      page.toggleCrop();

      expect(tool.active()).toBe('crop');
      expect(page.cutout()).toBe(false);
      expect(seg.tool()).toBe('');
    });

    it('stands crop down when the cut-out panel is opened', () => {
      page.toggleCrop();
      expect(tool.active()).toBe('crop');

      page.toggleCutout();

      expect(page.cutout()).toBe(true);
      expect(tool.active()).toBe('move');
    });

    it('stands the cut-out tool down when the eyedropper is armed', () => {
      page.cutout.set(true);
      seg.tool.set('erase');

      page.toggleEyedropper();

      expect(tool.active()).toBe('eyedropper');
      expect(seg.tool()).toBe('');
    });

    it('leaves crop armed when a second tap turns it off, not on', () => {
      page.toggleCrop();
      page.toggleCrop();
      expect(tool.active()).toBe('move');
    });

    it('disarms crop when any sheet opens, however it was reached', () => {
      // Guarded in open() rather than openTool(), because the fonts, warnings,
      // export and sync buttons all reach a sheet without touching the rail.
      page.toggleCrop();
      page.open('export');
      expect(tool.active()).toBe('move');
    });
  });

  describe('which rail entries carry an edit', () => {
    function selectFirst(): number {
      const id = svc.project().layers[0].id;
      svc.select(id);
      return id;
    }

    it('marks nothing on a layer with no adjustment', () => {
      selectFirst();
      expect(page.touched()['adjust']).toBeFalsy();
      expect(page.touched()['hsl']).toBeFalsy();
    });

    it('marks Adjust for a class-A change', () => {
      svc.setAdjust(selectFirst(), { brightness: 20 });
      expect(page.touched()['adjust']).toBe(true);
    });

    it('does NOT mark Adjust for an HSL-only change', () => {
      // isNeutralAdjust would say "not neutral" here and light three lamps,
      // sending the user hunting for an exposure change nobody made.
      svc.setAdjust(selectFirst(), { hsl: { saturation: 30 } });
      expect(page.touched()['hsl']).toBe(true);
      expect(page.touched()['adjust']).toBe(false);
    });

    it('marks Filter only for a named preset', () => {
      const id = selectFirst();
      svc.setAdjust(id, presetAdjust('noir'));
      expect(page.touched()['filter']).toBe(true);

      svc.setAdjust(id, { ...NEUTRAL_ADJUST });
      // A fully neutral adjustment is stored as null, so the key is absent
      // rather than false. The template reads it as a truthiness test.
      expect(page.touched()['filter']).toBeFalsy();
    });
  });
});
