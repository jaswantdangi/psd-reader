import { ChangeDetectionStrategy, Component, ElementRef, computed, inject } from '@angular/core';
import { CropService } from '../services/crop.service';
import { ProjectService } from '../services/project.service';
import { viewToDoc } from '@engine/view.js';
import { HANDLE_HIT_CSS_PX } from '@engine/gesture.js';

/**
 * The crop rect over the stage.
 *
 * POINTER-EVENTS-NONE EXCEPT ON ITSELF. The host covers the whole stage so the
 * dimming can, but only the rect body and the four handles accept a pointer —
 * so a pinch that starts anywhere else still reaches the stage underneath, and
 * cropping does not cost you zoom. That is also why this tool needs no change
 * to `canvas-stage.ts`, which another session holds.
 *
 * Positions are computed from the view directly (`docScale`, `panX`, `panY`)
 * rather than through `docToView`, because that returns CLIENT coordinates and
 * these are CSS offsets inside a host that is already `inset-0` on the same
 * viewport. Going through it would offset everything by the stage's own left
 * and top.
 *
 * All state lives in `CropService`; this component draws it and drags it.
 */
@Component({
  selector: 'app-crop-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pointer-events-none absolute inset-0 overflow-hidden' },
  template: `
    @if (box(); as b) {
      <!-- Four dimming panels rather than one huge box-shadow, which would
           repaint the whole stage on every drag frame. -->
      <div class="absolute inset-x-0 top-0 bg-black/50" [style.height.px]="b.top"></div>
      <div class="absolute inset-x-0 bottom-0 bg-black/50" [style.top.px]="b.top + b.height"></div>
      <div class="absolute left-0 bg-black/50"
           [style.top.px]="b.top" [style.width.px]="b.left" [style.height.px]="b.height"></div>
      <div class="absolute right-0 bg-black/50"
           [style.top.px]="b.top" [style.left.px]="b.left + b.width" [style.height.px]="b.height"></div>

      <div
        class="pointer-events-auto absolute touch-none border border-sky-400"
        [style.left.px]="b.left" [style.top.px]="b.top"
        [style.width.px]="b.width" [style.height.px]="b.height"
        role="application"
        aria-label="Crop area — drag to move, drag a corner to resize"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onUp($event)"
      ></div>

      @for (h of handles(); track h.id) {
        <div
          class="pointer-events-auto absolute -ml-3 -mt-3 h-6 w-6 touch-none rounded-[3px] border-2 border-sky-500 bg-white"
          [style.left.px]="h.left" [style.top.px]="h.top"
          (pointerdown)="onDown($event)"
          (pointermove)="onMove($event)"
          (pointerup)="onUp($event)"
          (pointercancel)="onUp($event)"
        ></div>
      }
    }
  `,
})
export class CropOverlay {
  private readonly crop = inject(CropService);
  private readonly svc = inject(ProjectService);
  private readonly el = inject(ElementRef<HTMLElement>);

  private drag: {
    handle: string | null;
    from: { x: number; y: number };
    startRect: { x: number; y: number; width: number; height: number };
  } | null = null;

  /** The pending rect as CSS offsets inside this host. */
  protected readonly box = computed(() => {
    if (!this.svc.project()) return null;
    const view = this.svc.view();
    const r = this.crop.rect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      left: r.x * view.docScale + view.panX,
      top: r.y * view.docScale + view.panY,
      width: r.width * view.docScale,
      height: r.height * view.docScale,
    };
  });

  protected readonly handles = computed(() => {
    const b = this.box();
    if (!b) return [];
    return [
      { id: 'nw', left: b.left, top: b.top },
      { id: 'ne', left: b.left + b.width, top: b.top },
      { id: 'se', left: b.left + b.width, top: b.top + b.height },
      { id: 'sw', left: b.left, top: b.top + b.height },
    ];
  });

  protected onDown(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const view = this.svc.view();
    const from = viewToDoc(view, event.clientX, event.clientY, this.viewport());
    this.drag = {
      handle: this.crop.handleAtPoint(from.x, from.y, HANDLE_HIT_CSS_PX / view.docScale),
      from,
      startRect: this.crop.rect(),
    };
    // The stage is underneath and would start a layer drag from the same press.
    event.stopPropagation();
    event.preventDefault();
  }

  protected onMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const to = viewToDoc(this.svc.view(), event.clientX, event.clientY, this.viewport());
    this.crop.drag(drag.handle, drag.from, to, drag.startRect);
    event.stopPropagation();
  }

  protected onUp(event: PointerEvent): void {
    this.drag = null;
    event.stopPropagation();
  }

  private viewport(): DOMRect {
    return this.el.nativeElement.getBoundingClientRect();
  }
}
