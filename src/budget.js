/**
 * Memory budgeting for PSD loads.
 *
 * Peak memory was measured against two synthetic documents and follows
 *
 *     peak = file bytes + one full-res layer + sum of proxy layers
 *
 * to within 1%. The file term dominates at 68-78%, and is irreducible during
 * decode because ag-psd's readPsd() requires one contiguous ArrayBuffer.
 * The practical ceiling is therefore set by file size.
 *
 * A CLIPPING MASK WIDENS THE MIDDLE TERM, and only for the export path. A clip
 * run is composited as a unit -- the base into a group buffer, the base's alpha
 * taken from it, each clipped layer blended through that alpha -- so every
 * member's full-resolution pixels are resident at the same moment instead of
 * one at a time, and a group-and-alpha pair of `w * h * 5` bytes is live while
 * the run is drawn. Both are zero for a document that uses no clipping mask,
 * which is every one of the 21 fixtures: its runs are all of length one, which
 * takes the ordinary single-layer path and allocates nothing.
 */

const MB = 1024 * 1024;

/** Nothing above this opens, however much memory the device claims. */
export const HARD_FILE_CAP_BYTES = 150 * MB;

/** Used when navigator.deviceMemory is unavailable, as on many Android WebViews. */
const ASSUMED_DEVICE_MEMORY_GB = 1;

/**
 * Share of total device memory we are willing to spend on one document.
 * Deliberately small: the WebView, the page and the OS all want their share,
 * and being killed is far worse than refusing.
 *
 * Peak is roughly 1.4x the file size, so 0.08 of RAM as a file budget costs
 * about 0.11 of RAM at peak. Anything above ~0.14 makes every device clamp to
 * HARD_FILE_CAP_BYTES, which would silently stop the budget scaling at all.
 */
const BUDGET_FRACTION = 0.08;

export function memoryBudgetBytes(deviceMemoryGB) {
  const gb = typeof deviceMemoryGB === 'number' && deviceMemoryGB > 0
    ? deviceMemoryGB
    : ASSUMED_DEVICE_MEMORY_GB;
  return Math.min(HARD_FILE_CAP_BYTES, Math.round(gb * 1024 * MB * BUDGET_FRACTION));
}

/**
 * @param {object} terms
 * @param {number} [terms.fileBytes]         The source file, held whole during decode.
 * @param {number} [terms.largestLayerBytes] The biggest single full-resolution layer.
 * @param {number} [terms.proxyTotalBytes]   Every proxy layer the editor keeps.
 * @param {number} [terms.clipRunBytes]
 *   The biggest clip run: the SUM of its members' full-resolution pixels, all
 *   of which are resident together while the run is composited. It REPLACES the
 *   single-layer term rather than adding to it -- the same bytes, counted once
 *   -- but never shrinks it, because the largest single layer may sit outside
 *   every run and still has to fit. Zero when nothing is clipped.
 * @param {number} [terms.clipScratchBytes]
 *   `width * height * 5`: the run's group buffer (RGBA) and its alpha plane.
 *   One growing pair per export, live only while a run is being drawn and
 *   dropped before the encode peak, so it is one term and not one per run.
 *   Zero when nothing is clipped. 87,015,940 bytes on a 4961x3508 poster.
 */
export function estimatePeakBytes({
  fileBytes = 0, largestLayerBytes = 0, proxyTotalBytes = 0,
  clipRunBytes = 0, clipScratchBytes = 0,
}) {
  return fileBytes + Math.max(largestLayerBytes, clipRunBytes) + proxyTotalBytes + clipScratchBytes;
}

export function guardFileSize(fileBytes, budgetBytes) {
  if (fileBytes <= budgetBytes) return { ok: true, message: null };
  const mb = (n) => Math.round(n / MB);
  return {
    ok: false,
    message:
      `This file is ${mb(fileBytes)} MB. This device can open PSDs up to ` +
      `${mb(budgetBytes)} MB — opening it would run out of memory.`,
  };
}
