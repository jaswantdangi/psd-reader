/**
 * Synthetic documents for the app's own tests.
 *
 * These build a project through the ENGINE's own `createProject`, from a doc
 * tree shaped exactly the way `src/reader.js` hands one over. Nothing here
 * re-implements a layer: the ids, the geometry, the `text` block, the warnings
 * and the history are all the engine's, so a test written against this fails
 * when the app diverges from the engine rather than when it diverges from a
 * second copy of the engine that lives in `app/`.
 *
 * A PSD fixture would be more faithful still, but the engine's own suite
 * already reads all 21 of them in Node; what `app/` needs is a project it can
 * build in a millisecond inside jsdom, with the exact layer shapes a given
 * behaviour turns on.
 */
import { createProject } from '@engine/edit.js';

export interface LeafSpec {
  name?: string;
  /** Document-space bounds. Default 0,0,10,10. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Uniform coverage for every pixel, 0-255. `hitTest` takes a layer above 8. */
  alpha?: number;
  /** Omit the pixel buffer entirely — `hitTest` then falls back to bounds. */
  noPixels?: boolean;
  hidden?: boolean;
  opacity?: number;
  blendMode?: string;
  clipping?: boolean;
  /** Makes this a text leaf. */
  text?: string;
  /** What the file NAMES as the typeface, which is what the fonts feature reads. */
  font?: string;
  fontSize?: number;
}

/** A uniform RGBA buffer, shaped like ag-psd's `imageData`. */
export function rgba(width: number, height: number, alpha: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 255;
    data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}

function leafOf(spec: LeafSpec, index: number): any {
  const x = spec.x ?? 0;
  const y = spec.y ?? 0;
  const w = spec.w ?? 10;
  const h = spec.h ?? 10;

  const node: any = {
    name: spec.name ?? `Layer ${index}`,
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    hidden: spec.hidden === true,
    opacity: spec.opacity ?? 1,
    blendMode: spec.blendMode ?? 'normal',
    clipping: spec.clipping === true,
  };

  if (spec.text !== undefined) {
    node.text = {
      text: spec.text,
      style: {
        fontSize: spec.fontSize ?? 24,
        fillColor: { r: 0, g: 0, b: 0 },
        ...(spec.font ? { font: { name: spec.font } } : {}),
      },
      shapeType: 'point',
    };
  } else if (!spec.noPixels) {
    node.imageData = rgba(w, h, spec.alpha ?? 255);
  }

  return node;
}

/**
 * A project, bottom layer first — the same order as `project.layers`.
 *
 * @param leaves  one spec per layer, index 0 = bottom of the stack
 */
export function makeProject(
  leaves: LeafSpec[] = [{}],
  options: { width?: number; height?: number; fileName?: string } = {},
): any {
  const doc = {
    width: options.width ?? 100,
    height: options.height ?? 100,
    children: leaves.map(leafOf),
    warnings: [],
  };
  return createProject(doc as any, options.fileName ?? 'fixture.psd');
}

/** A `File` whose bytes are readable, for the paths that re-read the source. */
export function fileOf(name: string, bytes: Uint8Array<ArrayBuffer> | number = 8): File {
  const data = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  return new File([data], name);
}
