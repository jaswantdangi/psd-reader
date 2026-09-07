import { Injectable } from '@angular/core';

/** The part of a 2D context this service uses. */
export interface PixelReader {
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: ArrayLike<number> };
}

/**
 * The part of a canvas this service uses.
 *
 * Structural rather than `HTMLCanvasElement` because jsdom has no `getContext`,
 * so a spec cannot construct a real one — the same reason `FakeWorker` exists,
 * and the same shape `installPlainPixelBackend` uses in the engine. A real
 * `HTMLCanvasElement` satisfies this, so the stage passes its element straight in.
 */
export interface PixelSource {
  readonly width: number;
  readonly height: number;
  getContext(contextId: '2d', options?: any): PixelReader | null;
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/**
 * The stage's canvas, reachable by things that are not the stage.
 *
 * The eyedropper wants the COMPOSITED colour — what is actually on screen under
 * the finger — and only this canvas has it. A registry keeps the knowledge of
 * how to read a pixel out of canvas-stage.ts, which is a large file held by
 * another session, and makes all of it testable without rendering a component.
 */
@Injectable({ providedIn: 'root' })
export class StageSurfaceService {
  private source: PixelSource | null = null;

  /** Called once by the stage, and again with null when it tears down. */
  register(source: PixelSource | null): void {
    this.source = source;
  }

  /**
   * The colour at a DOCUMENT point, as `#rrggbb`.
   *
   * Null in four different cases, all of which mean "do not paint with this":
   * no canvas yet, no 2D context, the point is off the canvas, or the pixel is
   * fully transparent. Transparent matters most — `getImageData` reports
   * rgba(0,0,0,0) there, and treating that as a colour makes an eyedropper over
   * empty space silently set the foreground to black.
   *
   * @param renderScale what the stage is currently drawing at, from
   *                    `renderScaleFor(view, project.proxyScale)`.
   */
  sampleDoc(docX: number, docY: number, renderScale: number): string | null {
    const source = this.source;
    if (!source || !(renderScale > 0)) return null;

    const x = Math.floor(docX * renderScale);
    const y = Math.floor(docY * renderScale);
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null;

    const context = source.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    const { data } = context.getImageData(x, y, 1, 1);
    return data[3] === 0 ? null : hex(data[0], data[1], data[2]);
  }
}
