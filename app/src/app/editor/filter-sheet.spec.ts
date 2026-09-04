import { TestBed } from '@angular/core/testing';
import { PRESETS, presetAdjust } from '@engine/adjust/presets.js';
import { FilterSheet } from './filter-sheet';
import { ProjectService } from '../services/project.service';
import { installFakeWorker } from '../../testing/fake-worker';
import { makeProject } from '../../testing/project-fixture';

/**
 * The preset sheet, and the state it adopts when it opens.
 *
 * A sheet that opens showing the previous layer's chip is the classic bug in
 * this shape of UI: the user sees "Noir" lit, taps Strength, and silently
 * applies Noir to a layer that had nothing on it. The `effect` that syncs is
 * the fix, and it is worth having pinned in both directions — it must adopt on
 * a NEW layer, and it must not clobber a choice made inside the sheet on the
 * layer already selected.
 *
 * Not rendered: the sheet's own markup is fourteen live thumbnails, and none of
 * this is about them. `TestBed.tick()` drives the effect, which is how a
 * zoneless app runs one.
 */
describe('FilterSheet', () => {
  let sheet: any;
  let svc: ProjectService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ProjectService);
  });

  afterEach(() => restoreWorker());

  /** Built after the project, so the first effect run sees a real selection. */
  function open(): void {
    sheet = TestBed.runInInjectionContext(() => new FilterSheet());
    TestBed.tick();
  }

  function twoLayers() {
    const project = makeProject([{ name: 'sky' }, { name: 'model' }]);
    svc.project.set(project);
    return project;
  }

  describe('the chips it offers', () => {
    it('splits the cheap presets from the ones that also cost an HSL pass', () => {
      open();
      const plain = sheet.plain.map((o: any) => o.id);
      const shifting = sheet.shifting.map((o: any) => o.id);

      expect(plain[0]).toBe('none');
      expect(plain).toContain('ember');
      expect(shifting).toContain('noir');
      // Every preset the engine has is on exactly one row — a preset it adds
      // must not vanish from the picker.
      expect(new Set([...plain.slice(1), ...shifting]).size).toBe(PRESETS.length);
      for (const id of plain.slice(1)) expect(shifting).not.toContain(id);
    });

    it('previews a preset at full strength, and reuses one object per chip', () => {
      open();
      expect(sheet.adjustFor('ember')).toBe(sheet.adjustFor('ember'));
      expect(sheet.adjustFor('ember').preset).toBe('ember');
      expect(sheet.adjustFor('nothing-like-this')).toBe(sheet.adjustFor('none'));
    });
  });

  describe('adopting the selected layer', () => {
    it('opens on the chip the layer already carries', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      svc.setAdjust(project.layers[0].id, { ...presetAdjust('noir', 1) });

      open();

      expect(sheet.chosen()).toBe('noir');
      expect(sheet.intensityPercent()).toBe(100);
    });

    /**
     * The stale-state case. Without the re-sync the sheet keeps showing the
     * previous layer's chip over a layer that has nothing on it.
     */
    it('re-adopts when the selection moves to a different layer', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      svc.setAdjust(project.layers[0].id, { ...presetAdjust('noir', 1) });
      open();
      expect(sheet.chosen()).toBe('noir');

      svc.select(project.layers[1].id);
      TestBed.tick();

      expect(sheet.chosen()).toBe('none');
      expect(sheet.intensityPercent()).toBe(100);
    });

    /**
     * ...and only once per layer. Re-running on every edit would snap the chip
     * and the strength back mid-drag.
     */
    it('does not re-adopt while the same layer stays selected', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();

      sheet.apply(project.layers[0], 'ember');
      sheet.setIntensity(project.layers[0], 40);
      TestBed.tick();

      expect(sheet.chosen()).toBe('ember');
      expect(sheet.intensityPercent()).toBe(40);
    });
  });

  describe('choose', () => {
    it('applies a preset as one command and lights its chip', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();

      sheet.choose(project.layers[0], 'ember');

      expect(sheet.chosen()).toBe('ember');
      expect(project.layers[0].adjust.preset).toBe('ember');
      expect(project.history.length).toBe(1);
    });

    it('treats none as a clear rather than as a preset', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      sheet.choose(project.layers[0], 'ember');

      sheet.choose(project.layers[0], 'none');

      expect(sheet.chosen()).toBe('none');
      // A neutral adjustment is stored as null — 0% of a filter is no filter.
      expect(project.layers[0].adjust).toBeNull();
    });

    it('resets the strength when a new preset is picked', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      sheet.choose(project.layers[0], 'ember');
      sheet.setIntensity(project.layers[0], 25);

      sheet.choose(project.layers[0], 'dusk');

      expect(sheet.intensityPercent()).toBe(100);
    });
  });

  describe('strength', () => {
    /** A whole drag is one undo entry — that is what the gesture key buys. */
    it('coalesces a drag into a single history step', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      sheet.choose(project.layers[0], 'ember');
      const afterApply = project.history.length;

      sheet.startDrag();
      for (const percent of [90, 70, 50, 30]) sheet.setIntensity(project.layers[0], percent);
      sheet.endDrag();

      expect(project.history.length).toBe(afterApply + 1);
      expect(sheet.intensityPercent()).toBe(30);
    });

    it('starts a new history step for the next drag', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      sheet.choose(project.layers[0], 'ember');
      const afterApply = project.history.length;

      sheet.startDrag();
      sheet.setIntensity(project.layers[0], 60);
      sheet.endDrag();
      sheet.startDrag();
      sheet.setIntensity(project.layers[0], 20);
      sheet.endDrag();

      expect(project.history.length).toBe(afterApply + 2);
    });

    it('does nothing when no preset is chosen', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();

      sheet.setIntensity(project.layers[0], 50);

      expect(project.history.length).toBe(0);
      expect(sheet.intensityPercent()).toBe(100);
    });

    it('scales the preset toward neutral', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      sheet.choose(project.layers[0], 'ember');
      const full = project.layers[0].adjust.contrast;

      sheet.setIntensity(project.layers[0], 50);

      expect(project.layers[0].adjust.contrast).toBeCloseTo(full / 2, 6);
    });
  });

  describe('what a preset would overwrite', () => {
    it('says nothing when there is nothing to lose', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      expect(sheet.replaces()).toBe('');

      sheet.choose(project.layers[0], 'ember');
      expect(sheet.replaces()).toBe('');
    });

    it('names an HSL block a preset would replace', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();

      svc.setAdjust(project.layers[0].id, { hsl: { saturation: -40 } });

      expect(sheet.replaces()).toBe('HSL');
    });
  });

  describe('highlight', () => {
    it('lights the chosen chip', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      sheet.choose(project.layers[0], 'frost');
      expect(sheet.highlight()).toBe('frost');
    });

    /** Parameters edited by hand no longer describe any chip, so none lights. */
    it('lights nothing once the parameters have drifted', () => {
      const project = twoLayers();
      svc.select(project.layers[0].id);
      open();
      sheet.choose(project.layers[0], 'frost');

      svc.setAdjust(project.layers[0].id, { preset: 'custom' });

      expect(sheet.highlight()).toBeNull();
    });
  });
});
