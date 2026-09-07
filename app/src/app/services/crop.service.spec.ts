import { TestBed } from '@angular/core/testing';
import { CropService, cropDrag } from './crop.service';
import { ProjectService } from './project.service';
import { ToolService } from './tool.service';
import { makeProject } from '../../testing/project-fixture';
import { installFakeWorker } from '../../testing/fake-worker';

const DOC = { x: 0, y: 0, width: 100, height: 100 };

/**
 * The crop drag, which is one adaptation over two engine functions.
 *
 * `handleAt` speaks `{x,y,w,h}` because it was written for layers; `moveRect`
 * and `resizeRect` speak `{x,y,width,height}` because they were written for
 * frames. Both shapes are live in this codebase and a silent mix reads as a
 * crop rect that jumps on first touch, so the conversion is pinned here rather
 * than trusted.
 */
describe('cropDrag', () => {
  const start = { x: 20, y: 20, width: 40, height: 30 };

  it('moves the whole rect when no handle was grabbed', () => {
    expect(cropDrag(start, null, { x: 30, y: 30 }, { x: 45, y: 35 }, DOC, null))
      .toEqual({ x: 35, y: 25, width: 40, height: 30 });
  });

  it('slides a moved rect back inside rather than shrinking it', () => {
    // The user is positioning a rect whose size they already chose. A rect that
    // silently got smaller is one they have to notice and undo.
    expect(cropDrag(start, null, { x: 30, y: 30 }, { x: 500, y: 30 }, DOC, null))
      .toEqual({ x: 60, y: 20, width: 40, height: 30 });
  });

  it('drags one corner against its opposite anchor', () => {
    expect(cropDrag(start, 'se', { x: 60, y: 50 }, { x: 70, y: 60 }, DOC, null))
      .toEqual({ x: 20, y: 20, width: 50, height: 40 });
  });

  it('holds a locked ratio while resizing', () => {
    const out = cropDrag(start, 'se', { x: 60, y: 50 }, { x: 80, y: 90 }, DOC, 1);
    expect(out.width).toBe(out.height);
  });
});

describe('CropService', () => {
  let crop: CropService;
  let svc: ProjectService;
  let tool: ToolService;
  let restoreWorker: () => void;

  beforeEach(() => {
    restoreWorker = installFakeWorker();
    TestBed.configureTestingModule({});
    crop = TestBed.inject(CropService);
    svc = TestBed.inject(ProjectService);
    tool = TestBed.inject(ToolService);
    svc.project.set(makeProject([{}, {}], { width: 200, height: 100 }));
  });

  afterEach(() => restoreWorker());

  it('begins from the whole document when nothing is cropped', () => {
    crop.begin();
    expect(crop.rect()).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(crop.ratioId()).toBe('free');
  });

  it('refits the pending rect when a ratio chip is tapped', () => {
    crop.begin();
    crop.chooseRatio('1:1');
    // The largest centred square of a 200x100 document.
    expect(crop.rect()).toEqual({ x: 50, y: 0, width: 100, height: 100 });
  });

  it('treats a second tap on the same chip as a no-op, not a shrink', () => {
    crop.begin();
    crop.chooseRatio('1:1');
    crop.chooseRatio('1:1');
    expect(crop.rect()).toEqual({ x: 50, y: 0, width: 100, height: 100 });
  });

  it('converts the frame shape to the layer shape for hit testing', () => {
    // handleAt wants {x,y,w,h}. Getting this wrong makes every corner miss.
    crop.begin();
    crop.rect.set({ x: 20, y: 20, width: 40, height: 30 });
    expect(crop.handleAtPoint(60, 50, 5)).toBe('se');
    expect(crop.handleAtPoint(20, 20, 5)).toBe('nw');
    expect(crop.handleAtPoint(40, 35, 5)).toBeNull();
  });

  it('commits nothing while the rect is being dragged', () => {
    crop.begin();
    crop.drag('se', { x: 200, y: 100 }, { x: 120, y: 60 });
    expect(svc.project().frame).toBeNull();
    expect(svc.project().history.length).toBe(0);
  });

  it('warns about the pending rect, not the committed frame', () => {
    crop.begin();
    // Leaves default to 0,0,10,10; a rect in the far corner leaves both out.
    crop.rect.set({ x: 150, y: 50, width: 40, height: 40 });

    const warnings = crop.warnings();

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('not deleted');
  });

  it('commits once on apply and leaves the tool', () => {
    crop.begin();
    crop.rect.set({ x: 10, y: 10, width: 50, height: 50 });
    tool.select('crop');

    crop.apply();

    expect(svc.project().frame).toEqual({ x: 10, y: 10, width: 50, height: 50 });
    expect(svc.project().history.length).toBe(1);
    expect(tool.active()).toBe('move');
  });

  it('leaves the document untouched on cancel', () => {
    crop.begin();
    crop.rect.set({ x: 10, y: 10, width: 50, height: 50 });
    tool.select('crop');

    crop.cancel();

    expect(svc.project().frame).toBeNull();
    expect(svc.project().history.length).toBe(0);
    expect(tool.active()).toBe('move');
  });

  it('does nothing at all with no document open', () => {
    svc.project.set(null);
    crop.begin();
    crop.drag(null, { x: 0, y: 0 }, { x: 5, y: 5 });
    crop.apply();
    expect(crop.warnings()).toEqual([]);
  });
});
