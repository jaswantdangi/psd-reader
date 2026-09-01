/**
 * The view transform: how the composited buffer is PRESENTED, never how the
 * document is stored.
 *
 * Three coordinate spaces, exactly one conversion between each pair:
 *
 *     document px --(renderScale)--> composite buffer px
 *     composite px --(cssZoom, panX/panY)--> CSS px in the viewport
 *
 * `renderProject` receives renderScale and nothing else. It never sees a pan and
 * never sees the user's zoom, so the document model cannot observe that zoom
 * exists -- which is what keeps geometry resolution-independent for export.
 *
 * The view model is explicit and is the source of truth. getBoundingClientRect
 * is a dev-time cross-check only, never the mapping: it silently absorbs layout
 * it should not.
 *
 * `viewport` throughout is {left, top, width, height} in CSS pixels.
 */
import { canvasSize } from './edit.js';

/** Zoom stops at 4x proxy 1:1. A chosen limit, not a measurement. */
export const ZOOM_MAX_FACTOR = 4;
/** Below this the document is a dot and panning stops meaning anything. */
export const MIN_DOC_SCALE = 0.02;
/** CSS px of the document that must stay inside the viewport after a pan. */
export const MIN_VISIBLE_PX = 48;

/**
 * @typedef {{docScale:number, panX:number, panY:number}} View
 *   `docScale` maps ONE DOCUMENT PIXEL to CSS pixels. `panX`/`panY` are CSS px
 *   from the viewport's top-left corner to the document's origin.
 */
export const createView = ({ docScale = 1, panX = 0, panY = 0 } = {}) => ({ docScale, panX, panY });

export const viewToDoc = (view, clientX, clientY, viewport) => ({
  x: (clientX - viewport.left - view.panX) / view.docScale,
  y: (clientY - viewport.top - view.panY) / view.docScale,
});

export const docToView = (view, docX, docY, viewport) => ({
  x: docX * view.docScale + view.panX + viewport.left,
  y: docY * view.docScale + view.panY + viewport.top,
});

/**
 * The scale renderProject is given -- and the only one it ever is.
 *
 * Capped at proxyScale because there is no full-resolution data resident to
 * zoom into: layer.pixels IS the proxy. Asking for more would upscale a
 * 1024-edge raster inside the compositor, which costs real time to produce the
 * same blur a CSS transform gives for free.
 */
export const renderScaleFor = (view, proxyScale) => Math.min(proxyScale, view.docScale);

/** Whatever magnification renderScaleFor could not supply, as a CSS transform. */
export const cssZoomFor = (view, renderScale) => view.docScale / renderScale;

/** Hard ceiling on docScale for a given proxy. */
export const maxDocScale = (proxyScale) => ZOOM_MAX_FACTOR * proxyScale;

/**
 * Above proxy 1:1 the canvas is showing proxy pixels enlarged. The UI must say
 * so -- a persistent chip -- because the alternative is a user judging an
 * export from a preview that cannot represent it.
 */
export const isPreviewQuality = (view, proxyScale) => view.docScale > proxyScale;

/**
 * Scale the whole CANVAS into the viewport with a margin, centred.
 *
 * `canvasSize`, not `project.width`/`height`: those are the SOURCE document and
 * do not change when the document is cropped, so reading them here would fit a
 * 16x12 crop as though it were the 40x30 file it came out of — the view sized
 * to something the user cannot see.
 */
export function fitView(project, viewport, options = {}) {
  const { margin = 16 } = options;
  const canvas = canvasSize(project);
  const usableW = Math.max(1, viewport.width - margin * 2);
  const usableH = Math.max(1, viewport.height - margin * 2);
  const docScale = Math.min(usableW / canvas.width, usableH / canvas.height);
  return {
    docScale,
    panX: (viewport.width - canvas.width * docScale) / 2,
    panY: (viewport.height - canvas.height * docScale) / 2,
  };
}

/**
 * Zoom by `factor`, keeping the document point under (clientX, clientY) fixed.
 *
 * Anchoring on the pointer is what makes a pinch feel like the image is being
 * stretched rather than replaced.
 */
export function zoomAbout(view, factor, clientX, clientY, viewport, options = {}) {
  const { min = MIN_DOC_SCALE, max = Infinity } = options;
  const docScale = Math.min(max, Math.max(min, view.docScale * factor));
  const anchor = viewToDoc(view, clientX, clientY, viewport);
  return {
    docScale,
    panX: clientX - viewport.left - anchor.x * docScale,
    panY: clientY - viewport.top - anchor.y * docScale,
  };
}

/**
 * Stop a pan from throwing the document off screen.
 *
 * Deliberately loose: at least `minVisible` CSS px of the document stays inside
 * the viewport on each axis. Clamping to full containment instead would fight
 * the user at every zoom level above fit.
 */
export function clampView(view, project, viewport, options = {}) {
  const { minVisible = MIN_VISIBLE_PX } = options;
  // The CANVAS, not the source document -- see fitView. A cropped document
  // clamped to its uncropped size can be dragged entirely off screen.
  const canvas = canvasSize(project);
  const w = canvas.width * view.docScale;
  const h = canvas.height * view.docScale;
  const keepX = Math.min(minVisible, w);
  const keepY = Math.min(minVisible, h);
  return {
    docScale: view.docScale,
    panX: Math.min(viewport.width - keepX, Math.max(keepX - w, view.panX)),
    panY: Math.min(viewport.height - keepY, Math.max(keepY - h, view.panY)),
  };
}
