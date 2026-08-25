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

export function estimatePeakBytes({ fileBytes = 0, largestLayerBytes = 0, proxyTotalBytes = 0 }) {
  return fileBytes + largestLayerBytes + proxyTotalBytes;
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
