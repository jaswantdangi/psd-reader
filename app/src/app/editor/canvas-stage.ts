import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { renderProject } from '@engine/render.js';
import { createSandwichCache, renderSandwiched, sandwichStateFor, SANDWICH_FLAT_ABOVE } from '@engine/sandwich.js';
import {
  clampView,
  cssZoomFor,
  docToView,
  fitView,
  maxDocScale,
  renderScaleFor,
  viewToDoc,
  zoomAbout,
  MIN_DOC_SCALE,
} from '@engine/view.js';
import {
  arbitrate,
  chooseRenderMode,
  isTap,
  moveBy,
  resizeFrom,
  HANDLES,
  HANDLE_HIT_CSS_PX,
} from '@engine/gesture.js';
import { liveTextRect } from '@engine/creative/index.js';
import { ProjectService } from '../services/project.service';

/** Viewport origin for overlay geometry: the overlay is positioned inside the host. */
const ORIGIN = { left: 0, top: 0, width: 0, height: 0 };

/** Two taps closer together than this toggle fit ↔ proxy 1:1. */
const DOUBLE_TAP_MS = 300;

type Gesture = {
  kind: string;
  handle: string | null;
  key: string;
  startDoc: { x: number; y: number };
  startClient: { x: number; y: number };
  startRect: { x: number; y: number; w: number; h: number } | null;
  startView: { docScale: number; panX: number; panY: number };
  layerId: number | null;
  moved: boolean;
};

/**
 * The document, presented.
 *
 * Every decision this component could make has already been made in `src/`:
 * `arbitrate` says which gesture a pointer-down begins, `resizeFrom`/`moveBy`
 * produce the rect, `viewToDoc` maps the pointer, `chooseRenderMode` picks the
 * rung. What is left here is genuinely Angular's: listening for pointers,
 * owning a canvas element and painting a buffer into it.
 */
@Component({
  selector: 'app-canvas-stage',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        position: absolute;
        inset: 0;
      }
      .checker {
        background-color: #101013;
        background-image: linear-gradient(45deg, #1b1b20 25%, transparent 25%),
          linear-gradient(-45deg, #1b1b20 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #1b1b20 75%),
          linear-gradient(-45deg, transparent 75%, #1b1b20 75%);
        background-size: 16px 16px;
        background-position: 0 0, 0 8px, 8px -8px, -8px 0;
      }
    `,
  ],
  template: `
    <div
      #host
      class="checker absolute inset-0 touch-none select-none overflow-hidden"
      (pointerdown)="onPointerDown($event)"
      (pointermove)="onPointerMove($event)"
      (pointerup)="onPointerUp($event)"
      (pointercancel)="onPointerUp($event)"
      (wheel)="onWheel($event)"
    >
      <canvas
        #cv
        class="absolute left-0 top-0 origin-top-left"
        [style.transform]="transform()"
      ></canvas>

      @if (box(); as b) {
        <div
          class="pointer-events-none absolute border border-sky-400"
          [style.left.px]="b.left"
          [style.top.px]="b.top"
          [style.width.px]="b.width"
          [style.height.px]="b.height"
        ></div>

        <!-- Handles hide while a gesture is in flight, so the finger is not
             covering the corner it is dragging. -->
        @if (!svc.gesturing()) {
          @for (h of handles(); track h.id) {
            <div
              class="pointer-events-none absolute -ml-3 -mt-3 h-6 w-6 rounded-[3px] border-2 border-sky-500 bg-white"
              [style.left.px]="h.x"
              [style.top.px]="h.y"
            ></div>
          }
        }
      }
    </div>
  `,
})
export class CanvasStage implements OnDestroy {
  protected svc = inject(ProjectService);

  private host = viewChild<ElementRef<HTMLDivElement>>('host');
  private cv = viewChild<ElementRef<HTMLCanvasElement>>('cv');

  /** The scale the resident buffer was composited at — the CSS zoom's denominator. */
  private paintedScale = signal(1);
  private size = signal({ width: 0, height: 0 });

  private cache = createSandwichCache();
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private pinch: { dist: number; midX: number; midY: number } | null = null;
  private rect = { left: 0, top: 0, width: 1, height: 1 };
  private frame = 0;
  private lastTapAt = 0;
  private fittedFor: any = null;
  /** Reused destination for putImageData. Allocated here, so writing into it is ours to do. */
  private image: ImageData | null = null;

  /** Chosen ONCE at pointer-down by `chooseRenderMode`, held for the whole gesture. */
  private mode = 'live';
  private modeScale = 1;

  protected readonly transform = computed(() => {
    const view = this.svc.view();
    // Whatever magnification the composite could not supply is a CSS scale —
    // free, and honest about showing enlarged proxy pixels.
    const zoom = cssZoomFor(view, this.paintedScale());
    return `translate(${view.panX}px, ${view.panY}px) scale(${zoom})`;
  });

  protected readonly box = computed(() => {
    this.svc.version();
    const layer = this.svc.selected();
    const view = this.svc.view();
    if (!layer) return null;
    const a = docToView(view, layer.x, layer.y, ORIGIN);
    const b = docToView(view, layer.x + layer.w, layer.y + layer.h, ORIGIN);
    return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  });

  protected readonly handles = computed(() => {
    const b = this.box();
    if (!b) return [];
    const corners: Record<string, { x: number; y: number }> = {
      nw: { x: b.left, y: b.top },
      ne: { x: b.left + b.width, y: b.top },
      se: { x: b.left + b.width, y: b.top + b.height },
      sw: { x: b.left, y: b.top + b.height },
    };
    return HANDLES.map((id: string) => ({ id, x: corners[id].x, y: corners[id].y }));
  });

  constructor() {
    // Track the viewport. `fitView` needs its size, and `clampView` needs it on
    // every pan, so a stale value would let the document be thrown off screen.
    effect((onCleanup) => {
      const element = this.host()?.nativeElement;
      if (!element) return;
      const observer = new ResizeObserver(() => {
        this.size.set({ width: element.clientWidth, height: element.clientHeight });
      });
      observer.observe(element);
      this.size.set({ width: element.clientWidth, height: element.clientHeight });
      onCleanup(() => observer.disconnect());
    });

    // Fit once per document, as soon as there is a viewport to fit into.
    effect(() => {
      const project = this.svc.project();
      const size = this.size();
      if (!project || size.width < 1 || size.height < 1) return;
      if (this.fittedFor === project) return;
      this.fittedFor = project;
      queueMicrotask(() => this.fit());
    });

    // Repaint on anything that changes the picture or how it is presented.
    effect(() => {
      this.svc.version();
      this.svc.project();
      this.svc.view();
      this.svc.selectionIndex();
      this.size();
      this.cv();
      this.schedule();
    });
  }

  ngOnDestroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  /** Scale the whole document into the viewport, centred. Called by the top bar too. */
  fit(): void {
    const project = this.svc.project();
    if (!project) return;
    this.rect = this.viewportRect();
    if (this.rect.width < 1 || this.rect.height < 1) return;
    this.svc.view.set(fitView(project, this.rect, { margin: 16 }));
  }

  // ------------------------------------------------------------ painting

  private schedule(): void {
    // One composite in flight. Several hundred pointer events become as many
    // frames as the device can actually finish, rather than an unbounded queue
    // that keeps moving after the finger stops.
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const canvas = this.cv()?.nativeElement;
    const project = this.svc.project();
    if (!canvas || !project) return;

    const view = this.svc.view();
    // Capped at proxyScale: `layer.pixels` IS the proxy, so asking for more
    // upscales a 1024-edge raster inside the compositor to produce the same
    // blur a CSS transform gives for free.
    const base = renderScaleFor(view, project.proxyScale);
    const gesturing = this.svc.gesturing();
    const scale = Math.max(0.01, base * (gesturing ? this.modeScale : 1));

    const index = this.svc.selectionIndex();
    const sandwiched = gesturing && this.mode !== 'live' && index >= 0;

    const started = performance.now();
    const buffer = sandwiched
      ? renderSandwiched(this.cache, project, index, { scale })
      : renderProject(project, { scale });
    const elapsed = performance.now() - started;

    // Feed the measurement back so the NEXT gesture picks its rung from a real
    // number on this device rather than from an assumption about phones.
    if (sandwiched) this.svc.lastSandwichMs.set(elapsed);
    else this.svc.lastLiveMs.set(elapsed);

    this.paintedScale.set(scale);

    if (canvas.width !== buffer.width || canvas.height !== buffer.height) {
      canvas.width = buffer.width;
      canvas.height = buffer.height;
    }

    const context = canvas.getContext('2d');
    if (!context) return;
    // createImageData + set, never `new ImageData(buffer.data, …)` — the engine
    // is untyped JS and its buffer types as Uint8ClampedArray<ArrayBufferLike>,
    // which that constructor rejects.
    //
    // The ImageData is kept between frames rather than allocated per frame: at
    // a 1024-edge proxy that is ~3 MB of garbage per drag frame otherwise. It
    // is OURS, allocated here, so writing into it is safe — unlike the engine's
    // buffers, which are only ever read.
    if (!this.image || this.image.width !== buffer.width || this.image.height !== buffer.height)
      this.image = context.createImageData(buffer.width, buffer.height);
    this.image.data.set(buffer.data);
    context.putImageData(this.image, 0, 0);
  }

  private viewportRect() {
    const element = this.host()?.nativeElement;
    if (!element) return { left: 0, top: 0, width: 1, height: 1 };
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // ------------------------------------------------------------ pointers

  protected onPointerDown(event: PointerEvent): void {
    const element = this.host()?.nativeElement;
    const project = this.svc.project();
    if (!element || !project) return;

    element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.rect = this.viewportRect();

    if (this.pointers.size >= 2) {
      // A second pointer ENDS the layer drag rather than cancelling it: what it
      // did is already committed, so a stray finger never destroys work.
      this.gesture = null;
      this.svc.previewPill.set(null);
      // A pinch changes only how the composite is PRESENTED, so it starts from
      // the top of the ladder rather than inheriting a rung chosen for the last
      // layer drag — which would otherwise pinch at half resolution for no
      // reason a user could see.
      this.mode = 'live';
      this.modeScale = 1;
      this.svc.renderMode.set('live');
      this.beginPinch();
      this.svc.gesturing.set(true);
      return;
    }

    const view = this.svc.view();
    const docPoint = viewToDoc(view, event.clientX, event.clientY, this.rect);
    const layer = this.svc.selected();
    const selection = layer ? { x: layer.x, y: layer.y, w: layer.w, h: layer.h } : null;

    const decision = arbitrate({
      pointerCount: 1,
      selection,
      docPoint,
      // A 44px touch target in CSS px is this many document units.
      handleRadius: HANDLE_HIT_CSS_PX / view.docScale,
    });

    // A scale drag re-draws a text layer, and a text layer still showing
    // Photoshop's own pixels is bounded by the FILE's box -- the ink extent of
    // the glyphs, which our renderer would read as a line box and fit ~1.4x too
    // small. So the drag starts from the box that layer is ABOUT to have, and
    // the first frame both re-fits and resizes, in one history entry. Null for
    // every other layer, and for a text layer already re-drawn.
    const startRect =
      decision.kind === 'scale' ? liveTextRect(layer) ?? selection : selection;

    this.gesture = {
      kind: decision.kind,
      handle: decision.handle,
      key: this.svc.gestureKey('xform'),
      startDoc: docPoint,
      startClient: { x: event.clientX, y: event.clientY },
      startRect,
      startView: view,
      layerId: layer ? layer.id : null,
      moved: false,
    };

    this.chooseMode(layer);
    this.svc.gesturing.set(true);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }

    const gesture = this.gesture;
    const project = this.svc.project();
    if (!gesture || !project) return;

    const view = this.svc.view();
    const dx = event.clientX - gesture.startClient.x;
    const dy = event.clientY - gesture.startClient.y;

    if (gesture.kind === 'view-pan') {
      if (!isTap(dx, dy)) gesture.moved = true;
      this.svc.view.set(
        clampView(
          { docScale: view.docScale, panX: gesture.startView.panX + dx, panY: gesture.startView.panY + dy },
          project,
          this.rect,
        ),
      );
      return;
    }

    // Below the slop this is still a tap. Mutating here would put a zero-delta
    // move in the undo history for every attempt to select a layer.
    if (!gesture.moved && isTap(dx, dy)) return;
    gesture.moved = true;

    if (gesture.layerId === null || !gesture.startRect) return;
    const doc = viewToDoc(view, event.clientX, event.clientY, this.rect);

    if (gesture.kind === 'move') {
      const next = moveBy(gesture.startRect, doc.x - gesture.startDoc.x, doc.y - gesture.startDoc.y);
      this.svc.setLayer(gesture.layerId, { x: next.x, y: next.y }, gesture.key);
    } else if (gesture.kind === 'scale') {
      const next = resizeFrom(gesture.startRect, gesture.handle, doc.x, doc.y);
      this.svc.setLayer(
        gesture.layerId,
        { x: next.x, y: next.y, w: next.w, h: next.h },
        gesture.key,
      );
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    const element = this.host()?.nativeElement;
    this.pointers.delete(event.pointerId);
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);

    if (this.pointers.size >= 1) {
      // Still pinching with what is left; rebase so the remaining fingers do
      // not jump the view by the departed one's contribution.
      this.beginPinch();
      return;
    }

    const gesture = this.gesture;
    this.gesture = null;
    this.pinch = null;
    this.svc.gesturing.set(false);
    this.svc.previewPill.set(null);
    this.svc.renderMode.set('live');
    this.mode = 'live';
    this.modeScale = 1;

    if (gesture) {
      const dx = event.clientX - gesture.startClient.x;
      const dy = event.clientY - gesture.startClient.y;
      if (!gesture.moved && isTap(dx, dy)) this.tap(event);
    }

    // Pointer-up always runs one exact composite: any approximation lasts
    // exactly the length of the gesture that justified it.
    this.schedule();
  }

  protected onWheel(event: WheelEvent): void {
    const project = this.svc.project();
    if (!project) return;
    event.preventDefault();
    this.rect = this.viewportRect();
    const factor = Math.pow(2, -event.deltaY / 400);
    this.zoomBy(factor, event.clientX, event.clientY, project);
  }

  private tap(event: PointerEvent): void {
    const now = performance.now();
    if (now - this.lastTapAt < DOUBLE_TAP_MS) {
      this.lastTapAt = 0;
      this.toggleZoom(event);
      return;
    }
    this.lastTapAt = now;

    const doc = viewToDoc(this.svc.view(), event.clientX, event.clientY, this.rect);
    const hit = this.svc.hitTest(doc.x, doc.y);
    this.svc.select(hit ? hit.id : null);
  }

  private toggleZoom(event: PointerEvent): void {
    const project = this.svc.project();
    if (!project) return;
    const view = this.svc.view();
    // Proxy 1:1 is the sharpest zoom that reveals anything; past it there is no
    // information left to show.
    if (view.docScale >= project.proxyScale * 0.999) {
      this.fit();
      return;
    }
    this.zoomBy(project.proxyScale / view.docScale, event.clientX, event.clientY, project);
  }

  private zoomBy(factor: number, clientX: number, clientY: number, project: any): void {
    const zoomed = zoomAboutSafe(this.svc.view(), factor, clientX, clientY, this.rect, project);
    this.svc.view.set(clampView(zoomed, project, this.rect));
  }

  // ------------------------------------------------------------ pinch

  private beginPinch(): void {
    const points = [...this.pointers.values()];
    if (points.length < 2) {
      this.pinch = null;
      return;
    }
    const [a, b] = points;
    this.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }

  private updatePinch(): void {
    const points = [...this.pointers.values()];
    const project = this.svc.project();
    if (points.length < 2 || !this.pinch || !project) return;

    const [a, b] = points;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    // Zoom about the pinch centre, then carry the centre's own travel as a pan:
    // that is what makes a two-finger drag pan and a pinch stretch, from one
    // gesture, with no mode between them.
    const zoomed = zoomAboutSafe(this.svc.view(), dist / this.pinch.dist, midX, midY, this.rect, project);
    const panned = {
      docScale: zoomed.docScale,
      panX: zoomed.panX + (midX - this.pinch.midX),
      panY: zoomed.panY + (midY - this.pinch.midY),
    };

    this.svc.view.set(clampView(panned, project, this.rect));
    this.pinch = { dist, midX, midY };
  }

  // ------------------------------------------------------------ the ladder

  private chooseMode(layer: any): void {
    const project = this.svc.project();
    const index = this.svc.selectionIndex();
    const sandwichMs = this.svc.lastSandwichMs();

    const decision = chooseRenderMode(
      {
        liveMs: this.svc.lastLiveMs(),
        sandwichMs,
        // Ghost — freezing both halves and overlaying the live layer — is not
        // implemented in this phase. Its rung is served by the sandwich, so it
        // is measured as the sandwich rather than reported as free. The effect
        // is that a device over budget on the sandwich falls straight to the
        // bottom rung, `reduced`, and the pill still tells the truth.
        ghostMs: sandwichMs,
      },
      {
        aboveAllNormal:
          project && index >= 0 ? sandwichStateFor(project, index) === SANDWICH_FLAT_ABOVE : true,
        liveModeIsNormal: layer ? layer.blendMode === 'normal' : true,
      },
    );

    this.mode = decision.mode;
    this.modeScale = decision.scale;
    this.svc.renderMode.set(decision.mode);
    this.svc.previewPill.set(decision.pill);
  }
}

/**
 * `zoomAbout` with the document's own ceiling applied.
 *
 * Pulled out because both the pinch and the wheel need exactly the same bounds
 * and a second copy is how the two drift apart.
 */
function zoomAboutSafe(
  view: any,
  factor: number,
  clientX: number,
  clientY: number,
  viewport: any,
  project: any,
) {
  return zoomAbout(view, factor, clientX, clientY, viewport, {
    min: MIN_DOC_SCALE,
    max: maxDocScale(project.proxyScale),
  });
}
