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

/**
 * @param {Uint8Array} bytes
 * @param {{fileName?: string, source?: object|null, proxyEdge?: number,
 *          onProgress?: (decoded: number) => void}} [options]
 */
export async function loadProjectProxy(bytes, options = {}) {
  const {
    fileName = 'untitled.psd',
    source = null,
    proxyEdge = DEFAULT_PROXY_EDGE,
    onProgress,
  } = options;

  let scale = 1;
  let decoded = 0;

  const doc = await readDocument(bytes, {
    pixels: 'stream',
    metadata: false,
    onStart: ({ width, height }) => { scale = proxyScaleFor(width, height, proxyEdge); },
    onLayer: (node) => {
      // Stash the proxy on the node itself: `doc.children` holds these same
      // object references, so createProject sees it. The full raster is
      // released by the reader as soon as this returns.
      if (node.imageData) node.proxyData = downscaleImage(node.imageData, scale);
      decoded++;
      if (onProgress) onProgress(decoded);
    },
  });

  return createProject(doc, fileName, { proxyScale: scale, source });
}
