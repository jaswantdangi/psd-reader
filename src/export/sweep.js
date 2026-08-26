/**
 * Spill directory naming, and the sweep that recovers what a kill left behind.
 *
 * exportFullRes cleans up in a `finally`, which covers success, failure and
 * cancellation. It does NOT cover the OS killing the process -- and an app
 * backgrounded while holding roughly 450 MB is a prime OOM-kill target. Up to
 * 398 MB of orphaned spill is what this recovers.
 *
 * Filesystem access is injected for the same reason the rest of the export path
 * injects it: this file must run under Node, and Capacitor must stay out of
 * src/.
 */

/** Under Directory.Cache, which the OS may reclaim and which is excluded from backup. */
export const SPILL_ROOT = 'psd-export';

/** Timestamp plus randomness, so two exports in the same millisecond cannot collide. */
export function newExportId(now = Date.now(), random = Math.random) {
  const suffix = Math.floor(random() * 0x100000000).toString(36);
  return `${now.toString(36)}-${suffix}`;
}

export const spillDirFor = (exportId) => `${SPILL_ROOT}/${exportId}`;

/**
 * @param {{readdir(path: string): Promise<string[]>, rmdir(path: string): Promise<void>}} fs
 * @param {{keep?: string[]}} [options]  Export ids NOT to touch -- an export
 *   running right now owns its own directory.
 * @returns {Promise<string[]>} the ids actually removed.
 */
export async function sweepSpillDirectories(fs, options = {}) {
  const keep = new Set(options.keep || []);

  let entries;
  try {
    entries = await fs.readdir(SPILL_ROOT);
  } catch {
    // No root yet. That is the normal first-run case, not a failure.
    return [];
  }

  const removed = [];
  for (const id of entries) {
    if (keep.has(id)) continue;
    try {
      await fs.rmdir(spillDirFor(id));
      removed.push(id);
    } catch {
      // Another export may own it, or the OS may be holding a handle. Sweeping
      // is best effort by definition -- one failure must not abort the rest.
    }
  }
  return removed;
}
