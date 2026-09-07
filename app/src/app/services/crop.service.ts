import { Injectable, computed, inject, signal } from '@angular/core';
import { ProjectService } from './project.service';
import { ToolService } from './tool.service';
import {
  frameOf, moveRect, resizeRect, largestCentredRect, ratioOf, MIN_FRAME_SIZE,
} from '@engine/frame/index.js';
import { handleAt } from '@engine/gesture.js';

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Handle = 'nw' | 'ne' | 'se' | 'sw';

/**
 * The engine is plain JavaScript, so TypeScript reads its JSDoc as the
 * signature — the same discrepancy `project.service.ts` documents for
 * `setLayer`. Two tags do not survive the trip:
 *
 *   `moveRect(rect, dx, dy, bounds = null)` infers `bounds` as `null` from its
 *   default, so passing a real rect is an error;
 *   `resizeRect`'s `@param` narrows `handle` to the four corner literals, which
 *   `handleAt` — typed as returning `string | null` — cannot satisfy.
 *
 * Both are the JSDoc being narrower than the engine, its tests and every
 * caller. Re-stated once here rather than cast at each call site.
 */
const moveRectFn = moveRect as unknown as
  (rect: Rect, dx: number, dy: number, bounds?: Rect | null) => Rect;
const resizeRectFn = resizeRect as unknown as
  (rect: Rect, handle: string, docX: number, docY: number,
   options?: { ratio?: number | null; bounds?: Rect | null; min?: number }) => Rect;

/**
 * One drag of the crop rect.
 *
 * Both branches are the engine's, INCLUDING the clamping: `moveRect` slides
 * against `bounds`, and `resizeRect` caps against the dragged corner's anchor,
 * honours a locked ratio and refuses to go under MIN_FRAME_SIZE. Nothing here
 * re-derives any of that — the value of this function is that it is one of the
 * only two places the two rect shapes meet, and it is tested.
 */
export function cropDrag(
  start: Rect,
  handle: string | null,
  from: Point,
  to: Point,
  bounds: Rect,
  ratio: number | null,
): Rect {
  if (!handle) return moveRectFn(start, to.x - from.x, to.y - from.y, bounds);
  return resizeRectFn(start, handle, to.x, to.y, { bounds, ratio, min: MIN_FRAME_SIZE });
}

/**
 * The pending crop.
 *
 * NOTHING IS COMMITTED UNTIL `apply`. Cropping live would put a history entry
 * behind every drag frame and make Cancel a stack of undos; it would also mean
 * the framing warning could only appear after the layers had already gone.
 *
 * Held in a service rather than in the overlay component so the overlay (which
 * draws and drags it) and the sheet (which shows its cost and applies it) can
 * both reach it without the editor page plumbing a signal between two children.
 */
@Injectable({ providedIn: 'root' })
export class CropService {
  private readonly svc = inject(ProjectService);
  private readonly tool = inject(ToolService);

  /** The pending frame, in document units. */
  readonly rect = signal<Rect>({ x: 0, y: 0, width: 0, height: 0 });

  /** The chosen ratio chip. `'free'` is unlocked. */
  readonly ratioId = signal<string>('free');

  private readonly ratio = computed(() => ratioOf(this.ratioId()));

  /** What this crop would cost, asked about the PENDING rect. */
  readonly warnings = computed<string[]>(() => {
    this.svc.version();
    return this.svc.framingReport(this.rect())?.warnings ?? [];
  });

  /** Arm the tool: start from whatever the document is framed to now. */
  begin(): void {
    const project = this.svc.project();
    if (!project) return;
    this.ratioId.set('free');
    this.rect.set({ ...frameOf(project) });
  }

  /**
   * A ratio chip is a RESET, not a refinement — derived from the source
   * document rather than from the pending rect, so tapping the same chip twice
   * is a no-op and tapping three chips does not shrink the crop to nothing.
   * The same bargain `setRatio` makes in the engine.
   */
  chooseRatio(id: string): void {
    const project = this.svc.project();
    if (!project) return;
    this.ratioId.set(id);
    const ratio = ratioOf(id);
    this.rect.set(ratio
      ? largestCentredRect(project.width, project.height, ratio)
      : { x: 0, y: 0, width: project.width, height: project.height });
  }

  /** Which corner handle is under a document point, or null for the body. */
  handleAtPoint(docX: number, docY: number, radiusDoc: number): string | null {
    const r = this.rect();
    // `handleAt` is gesture.js and speaks {x,y,w,h}; the rect is a FRAME and
    // speaks {x,y,width,height}. This is one of the two conversions.
    return handleAt({ x: r.x, y: r.y, w: r.width, h: r.height }, docX, docY, radiusDoc);
  }

  drag(handle: string | null, from: Point, to: Point): void {
    const project = this.svc.project();
    if (!project) return;
    this.rect.set(cropDrag(
      this.rect(), handle, from, to,
      { x: 0, y: 0, width: project.width, height: project.height },
      this.ratio(),
    ));
  }

  /** The one commit, and the only history entry a whole crop produces. */
  apply(): void {
    const project = this.svc.project();
    if (!project) return;
    this.svc.setFrame(this.rect());
    this.tool.reset();
  }

  /** Nothing was committed, so cancelling is just leaving. */
  cancel(): void {
    this.tool.reset();
  }
}
