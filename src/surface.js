/**
 * A 2D drawing surface, wherever this happens to be running.
 *
 * render.js reaches for a canvas to rasterise re-drawn text. Both entry points
 * opened with `if (typeof document === 'undefined') return null`, which inside a
 * Web Worker is a silent null -- and renderProject's `if (!pixels) continue`
 * then drops the layer. An edited text layer simply vanishes, with no error
 * anywhere.
 *
 * Same idea as canvas.js one level up: keep the DOM out of the pixel path, and
 * make the absence of a surface explicit rather than incidental.
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvas | HTMLCanvasElement | null} null in Node, which has
 *   no text rasteriser at all.
 */
export function create2dSurface(width, height) {
  const w = Math.max(1, Math.round(width) || 1);
  const h = Math.max(1, Math.round(height) || 1);

  // OffscreenCanvas FIRST. Order matters in both directions: reversing it would
  // put a worker on the document path, and checking document first would break
  // test/edit.mjs, which stubs globalThis.document to observe the canvas calls
  // and relies on that stub winning under Node (which has no global
  // OffscreenCanvas).
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  return null;
}
