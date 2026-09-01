/**
 * Phase 4 — creative tools.
 *
 * Two capabilities, both pure engine logic and both producing layers that the
 * existing renderer, sandwich cache, layers panel and export walk cannot tell
 * apart from ones read out of a PSD:
 *
 *   - text layers created from nothing, and bounds that follow the string
 *   - image layers inserted into the document, and existing ones replaced
 *
 * Nothing here decodes an image, reads a file, or ships an asset. Pixels come
 * in already decoded; where they came from is the app's problem.
 *
 * The public surface is deliberately small. `src/index.js` is owned elsewhere,
 * so import from this file directly.
 */
export { insertLayer, removeLayer, nextLayerId, blankLayer } from './layers.js';
export { naturalTextSize, insertTextLayer, retypeText, liveTextRect } from './text.js';
export { insertImageLayer, replaceImage, IMAGE_FITS } from './image.js';
