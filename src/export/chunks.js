/**
 * Chunking for the Capacitor bridge.
 *
 * Filesystem.writeFile takes base64 on native. A 303 MB file encoded in one
 * call materialises an approximately 404 MB string on top of the bytes it
 * already holds; a 66 MB PNG becomes approximately 88.6 MB. Either one raises
 * the memory ceiling by itself, so everything crossing the bridge is chunked
 * and the extra is capped at roughly 5.6 MB per call.
 */

/**
 * 4,194,303 bytes -- just under 4 MiB and divisible by 3, so no chunk except
 * the last one carries base64 padding. Each appendFile call decodes on its own,
 * so mid-stream padding would still be correct; this just keeps it clean.
 */
export const BRIDGE_CHUNK_BYTES = 4194303;

/** @returns {Array<[number, number]>} half-open [start, end) ranges. */
export function chunkRanges(total, size = BRIDGE_CHUNK_BYTES) {
  const ranges = [];
  for (let start = 0; start < total; start += size)
    ranges.push([start, Math.min(total, start + size)]);
  return ranges;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Hand-written because this runs in Node, in a browser and in a worker, and
 * `btoa` exists in only two of those -- and `btoa` would need a binary string
 * built first, which is another full-size allocation.
 */
export function bytesToBase64(bytes) {
  let out = '';
  const tail = bytes.length % 3;
  const end = bytes.length - tail;

  for (let i = 0; i < end; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  }

  if (tail === 1) {
    const v = bytes[end] << 16;
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + '==';
  } else if (tail === 2) {
    const v = (bytes[end] << 16) | (bytes[end + 1] << 8);
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + '=';
  }

  return out;
}
