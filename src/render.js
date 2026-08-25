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
 * Rasterise a text layer directly at its final pixel size.
 *
 * Text is vector, so drawing it once at its natural size and then resampling
 * the bitmap up is exactly how you get pixelated text. Scaling the canvas
 * transform instead re-shapes the glyphs at the target size, which stays sharp
 * at any scale — including a non-uniform one, since sx and sy are independent.
 */
export function rasteriseTextAt(layer, width, height) {
  if (typeof document === 'undefined') return null;

  const natural = measureText(layer.text);
  if (!natural || !natural.width || !natural.height) return null;

  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(w / natural.width, 0, 0, h / natural.height, 0, 0);
  ctx.font = fontSpec(layer.text, 1);
  ctx.fillStyle = layer.text.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = layer.text.align;

  const originX = layer.text.align === 'center' ? natural.width / 2
    : layer.text.align === 'right' ? natural.width : 0;
  natural.lines.forEach((line, i) => ctx.fillText(line, originX, i * natural.lineHeight));

  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

/** Cached by target size — a resize drag re-rasterises, a static frame does not. */
function textPixelsAt(layer, width, height) {
  const key = `${width}x${height}|${layer.text.fontSize}|${layer.text.fontFamily}|${layer.text.color}` +
    `|${layer.text.align}|${layer.text.bold}|${layer.text.italic}|${layer.text.content}`;
  if (layer.renderedKey !== key) {
    layer.rendered = rasteriseTextAt(layer, width, height);
    layer.renderedKey = key;
  }
  return layer.rendered;
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

    const rect = {
      left: Math.round(layer.x * scale),
      top: Math.round(layer.y * scale),
      width: Math.max(1, Math.round(layer.w * scale)),
      height: Math.max(1, Math.round(layer.h * scale)),
    };
    if (rect.left >= width || rect.top >= height) continue;
    if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0) continue;

    let pixels;
    if (layer.kind === 'text' && layer.rerendered) {
      // Draw the glyphs at their final size. Rasterising once and resampling
      // the bitmap is what made scaled text look pixelated.
      pixels = textPixelsAt(layer, rect.width, rect.height);
    } else {
      // Raster layers really are bitmaps — resampling is all there is.
      const source = layer.pixels;
      if (!source || !source.width || !source.height) continue;
      pixels = resample(source, rect.width, rect.height);
    }
    if (!pixels) continue;

    blendInto(dest, pixels.data, rect, layer.opacity, layer.blendMode);
  }

  return dest;
}
