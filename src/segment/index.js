/**
 * Background removal, as one module.
 *
 * Re-exported through src/index.js as well, unlike src/frame and src/creative
 * which the barrel still does not carry -- an app importing only from the
 * barrel cannot crop a document or add a sticker today, and repeating that
 * mistake for a third subsystem was not worth the consistency.
 */
export {
  MODELS, BASE, CLICK, PORTRAIT, FAST,
  availableModels, canSegment, fitsBudget, unavailableReason,
  totalDownloadBytes, DOCUMENT_HEADROOM_BYTES,
} from './models.js';
export {
  fullMask, emptyMask, combineMask, invertMask, boxBlur, featherMask,
  stampBrush, stampInto, strokeMask, isOpaque, cutFraction, MASK_MODES,
} from './mask-ops.js';
export { guidedRefine, decontaminate, refineCutout } from './refine.js';
export {
  resampleLogits, buildCutout, applyCutout, paintMask, clearCutout,
  exportSoftnessNote,
} from './cutout.js';
