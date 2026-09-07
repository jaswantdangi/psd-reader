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

      <!-- A DASHED WHITE frame, not a solid accent one.
           The rect is drawn over a photograph, and a solid line of any single
           colour disappears wherever the picture happens to match it. Dashes
           alternate against whatever is beneath them, which is why every
           editor that has ever drawn a crop uses them. White rather than the
           accent for the same reason: the accent is for controls you press,
           and this edge is a boundary being reported. -->
      <div
        class="pointer-events-auto absolute touch-none border border-dashed border-white/90"
        [style.left.px]="b.left" [style.top.px]="b.top"
        [style.width.px]="b.width" [style.height.px]="b.height"
        role="application"
        aria-label="Crop area — drag to move, drag a corner to resize"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onUp($event)"
      ></div>

      <!-- Corner brackets, not beads.
           A filled 24px square sits ON the corner it is meant to show you, so
           the one pixel you are aiming at is under your own control. An L
           bracket draws the corner instead of covering it, and still gives a
           44px touch target through the transparent padding around it. -->
      @for (h of handles(); track h.id) {
        <div
          class="pointer-events-auto absolute h-11 w-11 touch-none"
          [style.left.px]="h.left" [style.top.px]="h.top"
          [style.margin-left.px]="-22" [style.margin-top.px]="-22"
          (pointerdown)="onDown($event)"
          (pointermove)="onMove($event)"
          (pointerup)="onUp($event)"
          (pointercancel)="onUp($event)"
        >
          <span
            class="absolute h-5 w-5 border-white"
            [class]="h.bracket"
          ></span>
        </div>
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

  /**
   * The four corners, each with the two borders that draw its bracket.
   *
   * `bracket` is a class rather than a computed style so Tailwind can see the
   * literal strings and keep them in the build — a class assembled at runtime
   * would be purged.
   */
  protected readonly handles = computed(() => {
    const b = this.box();
    if (!b) return [];
    // The hit area is 44px with a -22px margin, so its centre sits ON the
    // corner. Each 20px bracket is then placed so ITS corner lands on that
    // centre and it grows INWARDS: 22px from the near edges, 2px from the far.
    return [
      { id: 'nw', left: b.left, top: b.top, bracket: 'left-[22px] top-[22px] border-l-[3px] border-t-[3px]' },
      { id: 'ne', left: b.left + b.width, top: b.top, bracket: 'left-[2px] top-[22px] border-r-[3px] border-t-[3px]' },
      { id: 'se', left: b.left + b.width, top: b.top + b.height, bracket: 'left-[2px] top-[2px] border-r-[3px] border-b-[3px]' },
      { id: 'sw', left: b.left, top: b.top + b.height, bracket: 'left-[22px] top-[2px] border-l-[3px] border-b-[3px]' },
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
