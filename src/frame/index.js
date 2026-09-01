/**
 * Phase 5 framing: crop, aspect ratio and canvas resize.
 *
 * Public surface. `src/index.js` is another task's file, so this is the import
 * path until it is folded in there.
 */
export {
  ASPECT_RATIOS, RATIO_IDS, ratioOf, MIN_FRAME_SIZE,
  normaliseRect, sameRect, largestCentredRect, moveRect, resizeRect,
} from './rect.js';
export {
  fullFrame, frameOf, isCropped,
  setFrame, setRatio, undo, redo, discardTo,
  framedLayer, framedProject, framedTarget,
  CANVAS_ANCHORS, canvasRect, resizeCanvas,
  layerFate, framingReport,
} from './frame.js';
