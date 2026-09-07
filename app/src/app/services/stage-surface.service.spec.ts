import { TestBed } from '@angular/core/testing';
import { StageSurfaceService, type PixelSource } from './stage-surface.service';

/**
 * A stand-in for the stage canvas, because jsdom has no `getContext`.
 *
 * The same trade `FakeWorker` makes, and for the same reason: what this service
 * owns is the MAPPING — document point to canvas pixel, and what counts as "no
 * colour here" — and all of that is observable from this side of the boundary.
 * It is backed by a real byte array rather than a lookup table so the index
 * arithmetic is exercised rather than stubbed.
 *
 * What this cannot prove is that a real `CanvasRenderingContext2D` returns what
 * we expect. That is only settled when the app runs on a device.
 */
function pixelSource(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }

  return {
    width,
    height,
    getContext: () => ({
      getImageData: (sx: number, sy: number, sw: number, sh: number) => {
        const out = new Uint8ClampedArray(sw * sh * 4);
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const src = ((sy + y) * width + (sx + x)) * 4;
            const dst = (y * sw + x) * 4;
            out[dst] = data[src]; out[dst + 1] = data[src + 1];
            out[dst + 2] = data[src + 2]; out[dst + 3] = data[src + 3];
          }
        }
        return { data: out };
      },
    }),
  };
}

/** 10x10: opaque red in the left half, fully transparent in the right. */
const halfRed = () =>
  pixelSource(10, 10, (x) => (x < 5 ? [255, 0, 0, 255] : [0, 0, 0, 0]));

describe('StageSurfaceService', () => {
  let surface: StageSurfaceService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    surface = TestBed.inject(StageSurfaceService);
  });

  it('has nothing to sample before the stage registers a canvas', () => {
    expect(surface.sampleDoc(1, 1, 1)).toBeNull();
  });

  it('reads the composited colour as canonical hex', () => {
    surface.register(halfRed());
    expect(surface.sampleDoc(2, 2, 1)).toBe('#ff0000');
  });

  it('scales document coordinates by the render scale', () => {
    // The stage draws a proxy. Document x=8 is in the transparent half at 1:1
    // but lands on canvas x=4 — red — at half scale. Asserting both directions
    // is what proves the scale is applied rather than ignored.
    surface.register(halfRed());
    expect(surface.sampleDoc(8, 4, 0.5)).toBe('#ff0000');
    expect(surface.sampleDoc(8, 4, 1)).toBeNull();
  });

  it('returns null outside the canvas rather than clamping to an edge pixel', () => {
    surface.register(halfRed());
    expect(surface.sampleDoc(50, 50, 1)).toBeNull();
    expect(surface.sampleDoc(-1, 2, 1)).toBeNull();
  });

  it('returns null on a fully transparent pixel', () => {
    // Transparent is not a colour. Sampling it should leave the swatch alone,
    // not set it to the black that getImageData reports for rgba(0,0,0,0).
    surface.register(halfRed());
    expect(surface.sampleDoc(8, 2, 1)).toBeNull();
  });

  it('forgets the canvas when the stage tears down', () => {
    surface.register(halfRed());
    surface.register(null);
    expect(surface.sampleDoc(2, 2, 1)).toBeNull();
  });
});
