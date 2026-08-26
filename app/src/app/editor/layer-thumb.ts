import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { createBuffer } from '@engine/composite.js';
import { drawLayerInto } from '@engine/render.js';
import { ProjectService } from '../services/project.service';

/** Device pixels per CSS pixel for the thumbnail raster. 2 is enough at 40px. */
const DPR = 2;

/**
 * A layer preview, drawn by the engine.
 *
 * `drawLayerInto` is the same call `renderProject` and the export walk make,
 * so the thumbnail honours the mask, the adjustment and the text re-rasterise
 * for free. A thumbnail that ignored the mask would lie about the one thing
 * the mask work exists for, and a hand-rolled downscale here would be a second
 * renderer to keep in step with the first.
 *
 * The layer is SHALLOW-COPIED before its geometry is changed. Writing `x/y/w/h`
 * onto the real layer would edit the document; and `resample()` identity-
 * returns its input on the common path, so anything that wrote into the pixels
 * it hands back would destroy `layer.pixels` permanently.
 */
@Component({
  selector: 'app-layer-thumb',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      canvas {
        background-color: #18181b;
        background-image: linear-gradient(45deg, #2b2b31 25%, transparent 25%),
          linear-gradient(-45deg, #2b2b31 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #2b2b31 75%),
          linear-gradient(-45deg, transparent 75%, #2b2b31 75%);
        background-size: 8px 8px;
        background-position: 0 0, 0 4px, 4px -4px, -4px 0;
      }
    `,
  ],
  template: `
    <canvas
      #cv
      class="block rounded-md ring-1 ring-white/10"
      [style.width.px]="size()"
      [style.height.px]="size()"
    ></canvas>
  `,
})
export class LayerThumb {
  private svc = inject(ProjectService);
  private cv = viewChild<ElementRef<HTMLCanvasElement>>('cv');

  readonly layer = input.required<any>();
  readonly size = input(40);
  /**
   * An adjustment to preview INSTEAD of the layer's own — the filter strip
   * uses it to show each preset on the user's own pixels. `null` means the
   * layer's own adjustment.
   */
  readonly previewAdjust = input<any>(null);

  /** What was last drawn, so an unchanged thumbnail costs a string compare. */
  private lastKey = '';
  private lastAdjust: any = undefined;

  constructor() {
    effect(() => {
      // Reading these declares the dependencies: the canvas element as it
      // appears, the layer, the preview override, and every committed edit.
      const canvas = this.cv()?.nativeElement;
      const layer = this.layer();
      const preview = this.previewAdjust();
      this.svc.version();
      if (!canvas || !layer) return;

      const box = Math.max(1, Math.round(this.size() * DPR));

      // `version` moves on every coalesced frame of a slider drag, and the
      // filter strip holds fifteen of these. Redrawing all of them per frame
      // would cost ~15 resamples out of a 1024-edge proxy to show pictures that
      // did not change. So: the signal triggers the check, and the check —
      // scalars by value, the frozen adjust object by identity, since a new one
      // is built on every change — decides whether there is anything to draw.
      const source = preview ?? layer.adjust ?? null;
      const key = [
        layer.id,
        layer.w,
        layer.h,
        layer.mask ? (layer.mask.disabled ? 0 : 1) : -1,
        layer.rerendered ? 1 : 0,
        layer.text?.content ?? '',
        box,
      ].join('|');
      if (key === this.lastKey && source === this.lastAdjust) return;
      this.lastKey = key;
      this.lastAdjust = source;
      if (canvas.width !== box || canvas.height !== box) {
        canvas.width = box;
        canvas.height = box;
      }

      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, box, box);

      const aspect = layer.w > 0 && layer.h > 0 ? layer.w / layer.h : 1;
      const width = Math.max(1, Math.round(aspect >= 1 ? box : box * aspect));
      const height = Math.max(1, Math.round(aspect >= 1 ? box / aspect : box));

      const dest = createBuffer(box, box);
      drawLayerInto(dest, {
        ...layer,
        x: (box - width) / 2,
        y: (box - height) / 2,
        w: width,
        h: height,
        // A hidden layer still needs a picture in the row that toggles it, and
        // its own opacity and blend mode describe how it meets the layers
        // BELOW it — neither means anything against an empty square.
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        adjust: preview ?? layer.adjust,
      });

      // createImageData, never `new ImageData(dest.data, …)`: the engine is
      // untyped JS, so its buffer types as Uint8ClampedArray<ArrayBufferLike>
      // and the constructor rejects it.
      const image = context.createImageData(box, box);
      image.data.set(dest.data);
      context.putImageData(image, 0, 0);
    });
  }
}
