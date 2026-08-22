/**
 * Renders an editable project.
 *
 * Differs from `composite.js` in two ways: layers carry an arbitrary
 * position/size rather than their original bounds, and text layers may need
 * re-drawing because their content changed.
 *
 * Rendering at a reduced `scale` keeps dragging interactive on large documents
 * — the whole stack is recomposited on every change, so a 4000x4000 canvas at
 * full resolution would not keep up.
 */
import { createBuffer, blendInto } from './composite.js';

/**
 * Bilinear resample. Written by hand rather than going through Canvas
 * `drawImage` so the pixel path stays free of premultiplied-alpha rounding.
 */
export function resample(src, width, height) {
  if (src.width === width && src.height === height) return src;

  const out = createBuffer(width, height);
  const xRatio = src.width / width;
  const yRatio = src.height / height;

  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;

      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const o = (y * width + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = src.data[i00 + c] + (src.data[i10 + c] - src.data[i00 + c]) * fx;
        const bottom = src.data[i01 + c] + (src.data[i11 + c] - src.data[i01 + c]) * fx;
        out.data[o + c] = top + (bottom - top) * fy;
      }
    }
  }
  return out;
}

/** CSS font shorthand from a layer's text settings. */
const fontSpec = (text, scale = 1) =>
  `${text.italic ? 'italic ' : ''}${text.bold ? 'bold ' : ''}${Math.max(1, text.fontSize * scale)}px ${text.fontFamily}`;

/**
 * Measure re-drawn text so the layer box can follow the string as it's typed.
 * Returns null outside a browser — Node has no text rasteriser.
 */
export function measureText(text) {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = fontSpec(text);
  const lines = String(text.content ?? '').split('\n');
  const lineHeight = Math.round(text.fontSize * 1.25);
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  return { width: Math.ceil(width) || 1, height: lines.length * lineHeight || 1, lineHeight, lines };
}

/**
 * Rasterise a text layer with the browser's own renderer.
 *
 * This is the one place we generate pixels through Canvas, and it is a
 * deliberate compromise: the PSD names its font as a placeholder
 * (`AdobeInvisFont`) and does not embed the font file, so matching Photoshop's
 * output is not achievable. Callers must mark such layers in the UI.
 */
export function rasteriseText(layer, scale = 1) {
  if (typeof document === 'undefined') return null;

  const metrics = measureText(layer.text);
  if (!metrics) return null;

  const width = Math.max(1, Math.ceil(metrics.width * scale));
  const height = Math.max(1, Math.ceil(metrics.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = fontSpec(layer.text, scale);
  ctx.fillStyle = layer.text.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = layer.text.align;

  const originX = layer.text.align === 'center' ? width / 2 : layer.text.align === 'right' ? width : 0;
  metrics.lines.forEach((line, i) => {
    ctx.fillText(line, originX, i * metrics.lineHeight * scale);
  });

  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

/** Pixels for a layer at its natural size — Photoshop's, or ours if it was retyped. */
function pixelsFor(layer) {
  if (layer.kind === 'text' && layer.rerendered) {
    if (!layer.rendered) layer.rendered = rasteriseText(layer, 1);
    return layer.rendered;
  }
  return layer.pixels;
}

/**
 * @param {object} project
 * @param {{scale?: number, skipHidden?: boolean}} [options]
 *   `scale` 1 renders at document resolution; lower values are for interactive preview.
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderProject(project, options = {}) {
  const { scale = 1 } = options;
  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));
  const dest = createBuffer(width, height);

  for (const layer of project.layers) { // bottom to top
    if (!layer.visible || layer.opacity <= 0) continue;

    const pixels = pixelsFor(layer);
    if (!pixels || !pixels.width || !pixels.height) continue;

    const rect = {
      left: Math.round(layer.x * scale),
      top: Math.round(layer.y * scale),
      width: Math.max(1, Math.round(layer.w * scale)),
      height: Math.max(1, Math.round(layer.h * scale)),
    };
    if (rect.left >= width || rect.top >= height) continue;
    if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0) continue;

    const scaled = resample(pixels, rect.width, rect.height);
    blendInto(dest, scaled.data, rect, layer.opacity, layer.blendMode);
  }

  return dest;
}
