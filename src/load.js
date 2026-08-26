/**
 * One-call proxy load: stream each layer, shrink it on arrival, drop the
 * full-resolution raster, and hand back an editable project.
 *
 * The caller should release the file bytes once this resolves. They are
 * 68-78% of peak memory and are not needed again until export, which re-reads
 * the file from `project.source.uri`.
 */
import { readDocument } from './reader.js';
import { proxyScaleFor, downscaleImage, DEFAULT_PROXY_EDGE } from './proxy.js';
import { createProject } from './edit.js';
import { projectMask, pixelRect, downscaleMask } from './mask.js';

/**
 * @param {Uint8Array} bytes
 * @param {{fileName?: string, source?: object|null, proxyEdge?: number,
 *          onStart?: (info: {width: number, height: number, layers: number}) => any,
 *          onProgress?: (decoded: number, total: number) => void}} [options]
 */
export async function loadProjectProxy(bytes, options = {}) {
  const {
    fileName = 'untitled.psd',
    source = null,
    proxyEdge = DEFAULT_PROXY_EDGE,
    onProgress,
    onStart,
  } = options;

  let scale = 1;
  let decoded = 0;
  let total = 0;

  const doc = await readDocument(bytes, {
    pixels: 'stream',
    metadata: false,
    onStart: (info) => {
      scale = proxyScaleFor(info.width, info.height, proxyEdge);
      total = info.layers;
      if (onStart) onStart(info);
    },
    onLayer: (node) => {
      // Stash the proxy on the node itself: `doc.children` holds these same
      // object references, so createProject sees it. The full raster is
      // released by the reader as soon as this returns.
      if (node.imageData) node.proxyData = downscaleImage(node.imageData, scale);

      // The mask has to be reprojected and shrunk HERE, for two reasons.
      //
      // 1. reader.js clears `node.mask.imageData` the moment this returns, so
      //    this is the only moment the full-resolution mask exists. Do not
      //    change that release -- it is the fix for a measured leak. Work with
      //    it, exactly as proxy pixels already do.
      // 2. Order matters. Projecting at FULL resolution and shrinking second
      //    resolves any sub-pixel offset between the mask's origin and the
      //    layer's while there is still sub-pixel precision to resolve it with.
      //    Shrinking first would quantise that offset into a half-proxy-pixel
      //    error, which is several document pixels on a large document.
      //
      // The proxy's dimensions are READ FROM node.proxyData rather than
      // recomputed, so mask and pixels are the same grid by construction.
      if (node.mask?.imageData && node.imageData && node.proxyData) {
        const rect = pixelRect(node, node.imageData);
        const full = projectMask(node, rect);
        const small = full && downscaleMask(full, rect, node.proxyData);
        if (small) node.proxyMask = small.data;
      }

      decoded++;
      if (onProgress) onProgress(decoded, total);
    },
  });

  return createProject(doc, fileName, { proxyScale: scale, source });
}
