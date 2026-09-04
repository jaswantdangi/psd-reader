import { TestBed } from '@angular/core/testing';
import { LayersSheet } from './layers-sheet';
import { ProjectService } from '../services/project.service';
import { installFakeWorker } from '../../testing/fake-worker';
import { makeProject } from '../../testing/project-fixture';

/**
 * The layers panel, as logic rather than as markup.
 *
 * It is built through the injector but never rendered: everything worth
 * asserting here is arithmetic and state — where a dragged row lands, and when
 * a drag is allowed at all — and a rendered fixture would add child components,
 * a canvas thumbnail and an image picker to the blast radius of a test about
 * none of them.
 *
 * Row ordering is `panelRows`, which is the engine's and is covered in Node.
 * What is only here is the conversion of pointer travel into a stack index,
 * which is the one place a wrong answer silently reorders the user's document.
 */
describe('LayersSheet', () => {
  let sheet: any;
  let svc: ProjectService;
  let restoreWorker: () => void;

  /** Display index 0 is the TOP of the stack; `project.layers` index 0 is the bottom. */
  const ROW = 64;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ProjectService);
    sheet = TestBed.runInInjectionContext(() => new LayersSheet());
  });

  afterEach(() => restoreWorker());

  function grip() {
    const captured = new Set<number>();
    return {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    };
  }

  function pointer(clientY: number, currentTarget: unknown): any {
    return { clientY, pointerId: 1, currentTarget, preventDefault() {} };
  }

  /** Grab the row at `displayIndex` and drop it `travel` pixels away. */
  function drag(displayIndex: number, travel: number): void {
    const rows = sheet.model().rows;
    const handle = grip();
    sheet.onGripDown(pointer(0, handle), displayIndex, rows[displayIndex].index);
    sheet.onGripMove(pointer(travel, handle));
    sheet.onGripUp(pointer(travel, handle));
  }

  function threeLayers() {
    const project = makeProject([{ name: 'bottom' }, { name: 'middle' }, { name: 'top' }]);
    svc.project.set(project);
    return project;
  }

  const order = (project: any) => project.layers.map((l: any) => l.name);

  // ------------------------------------------------------------ the model

  describe('model', () => {
    it('is null with no document, so the sheet renders nothing', () => {
      expect(sheet.model()).toBeNull();
    });

    it('lists the stack top first', () => {
      threeLayers();
      expect(sheet.model().rows.map((r: any) => r.name)).toEqual(['top', 'middle', 'bottom']);
      expect(sheet.model().state).toBe('ok');
    });

    it('passes the search through, and separates no-matches from no-layers', () => {
      threeLayers();
      sheet.onSearch({ target: { value: 'nothing matches this' } } as any);

      expect(sheet.model().shown).toBe(0);
      expect(sheet.model().total).toBe(3);
      // The two states have OPPOSITE remedies: clear the filter, or open a
      // different file. Showing onboarding copy to a mistyped search is the bug.
      expect(sheet.model().state).toBe('filtered-to-zero');
    });

    it('finds a text layer by what it says, not only by its name', () => {
      svc.project.set(makeProject([{ name: 'Layer 7', text: 'SUMMER SALE' }]));
      sheet.onSearch({ target: { value: 'summer' } } as any);
      expect(sheet.model().shown).toBe(1);
    });

    /**
     * The selection survives filtering rather than being silently dropped, so
     * the panel has to offer the way back to it.
     */
    it('flags a selection the filter is hiding', () => {
      const project = threeLayers();
      svc.select(project.layers[0].id);
      expect(sheet.model().selectionHidden).toBe(false);

      sheet.onSearch({ target: { value: 'top' } } as any);

      expect(sheet.model().selectionHidden).toBe(true);
      expect(svc.selectedId()).toBe(project.layers[0].id);
    });
  });

  describe('filters', () => {
    it('toggles one on and off again', () => {
      sheet.toggleFilter('text');
      expect(sheet.filters()).toEqual(['text']);
      sheet.toggleFilter('hidden');
      expect(sheet.filters()).toEqual(['text', 'hidden']);
      sheet.toggleFilter('text');
      expect(sheet.filters()).toEqual(['hidden']);
    });

    it('clears the search as well, since both hide rows', () => {
      sheet.onSearch({ target: { value: 'x' } } as any);
      sheet.toggleFilter('text');

      sheet.clearFilters();

      expect(sheet.filters()).toEqual([]);
      expect(sheet.search()).toBe('');
    });

    it('names every filter the engine offers', () => {
      for (const id of sheet.filterIds) expect(sheet.label(id)).toBeTruthy();
      // An axis the engine adds shows its own id rather than disappearing.
      expect(sheet.label('brand-new-axis')).toBe('brand-new-axis');
    });
  });

  // ------------------------------------------------------------ reorder

  describe('reorder', () => {
    /**
     * A reorder inside a filtered list moves a layer past rows that are not on
     * screen — a stacking change the user did not ask for and cannot see.
     */
    it('is off while a search or a filter is narrowing the list', () => {
      threeLayers();
      expect(sheet.reorderable()).toBe(true);

      sheet.onSearch({ target: { value: 'e' } } as any);
      expect(sheet.reorderable()).toBe(false);

      sheet.clearFilters();
      sheet.toggleFilter('text');
      expect(sheet.reorderable()).toBe(false);
    });

    it('ignores a drag that starts while the list is filtered', () => {
      const project = threeLayers();
      sheet.toggleFilter('text');

      const handle = grip();
      sheet.onGripDown(pointer(0, handle), 0, 2);
      sheet.onGripMove(pointer(ROW, handle));
      sheet.onGripUp(pointer(ROW, handle));

      expect(sheet.dragIndex()).toBeNull();
      expect(order(project)).toEqual(['bottom', 'middle', 'top']);
      expect(project.history.length).toBe(0);
    });

    it('drops one display row down, which is one place down the stack', () => {
      const project = threeLayers();
      drag(0, ROW);
      expect(order(project)).toEqual(['bottom', 'top', 'middle']);
    });

    it('drops one display row up, which is one place up the stack', () => {
      const project = threeLayers();
      drag(2, -ROW);
      expect(order(project)).toEqual(['middle', 'bottom', 'top']);
    });

    it('needs more than half a row of travel to move anything', () => {
      const project = threeLayers();
      drag(0, ROW / 2 - 1);
      expect(order(project)).toEqual(['bottom', 'middle', 'top']);
      expect(project.history.length).toBe(0);
    });

    it('clamps a drag past the end of the list to the last row', () => {
      const project = threeLayers();
      drag(0, ROW * 20);
      expect(order(project)).toEqual(['top', 'bottom', 'middle']);
    });

    it('clamps a drag above the first row rather than reordering to -1', () => {
      const project = threeLayers();
      drag(0, -ROW * 20);
      expect(order(project)).toEqual(['bottom', 'middle', 'top']);
      expect(project.history.length).toBe(0);
    });

    /** One command on drop, never per frame — `reorderLayer` cannot coalesce. */
    it('commits exactly one undo step for a whole drag', () => {
      const project = threeLayers();
      const handle = grip();
      sheet.onGripDown(pointer(0, handle), 0, 2);
      for (let y = 8; y <= 64; y += 8) sheet.onGripMove(pointer(y, handle));
      sheet.onGripUp(pointer(64, handle));

      expect(project.history.length).toBe(1);
      svc.undo();
      expect(order(project)).toEqual(['bottom', 'middle', 'top']);
    });

    it('keeps the selection on the layer that moved', () => {
      const project = threeLayers();
      svc.select(project.layers[2].id);          // 'top'
      drag(0, ROW);
      expect(svc.selected().name).toBe('top');
      expect(svc.selectionIndex()).toBe(1);
    });

    it('resets the drag state on drop, so no row stays offset', () => {
      threeLayers();
      const handle = grip();
      sheet.onGripDown(pointer(0, handle), 0, 2);
      sheet.onGripMove(pointer(30, handle));
      expect(sheet.dragIndex()).toBe(0);
      expect(sheet.rowTransform(0)).toBe('translateY(30px)');
      expect(sheet.rowTransform(1)).toBe('none');

      sheet.onGripUp(pointer(30, handle));

      expect(sheet.dragIndex()).toBeNull();
      expect(sheet.dragOffset()).toBe(0);
      expect(sheet.rowTransform(0)).toBe('none');
    });

    it('ignores a move or an up that no down started', () => {
      const project = threeLayers();
      sheet.onGripMove(pointer(80, grip()));
      sheet.onGripUp(pointer(80, grip()));
      expect(sheet.dragOffset()).toBe(0);
      expect(project.history.length).toBe(0);
    });
  });

  describe('visibility', () => {
    it('flips one layer and leaves the rest alone', () => {
      const project = threeLayers();
      sheet.toggleVisible(project.layers[1]);

      expect(project.layers.map((l: any) => l.visible)).toEqual([true, false, true]);
      expect(project.history.length).toBe(1);
    });
  });
});
