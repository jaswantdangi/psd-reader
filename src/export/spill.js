/**
 * Spill format: a 16-byte header then raw RGBA, no compression.
 *
 * These files live for seconds. Deflating 66 MB in JavaScript costs more than
 * the write it would save, so the format is deliberately dumb. The header is
 * what earns its place: it makes the file self-describing, so a short file --
 * a full disk, most likely -- is CAUGHT rather than blended as a layer with
 * nonsense geometry.
 *
 * Alpha is STRAIGHT (unassociated), because that is what composite.js and
 * render.js use end to end. A premultiplied spill would round-trip through a
 * lossy conversion twice for no benefit.
 *
 *   offset 0   4  magic 'PSDX'
 *   offset 4   4  version
 *   offset 8   4  width
 *   offset 12  4  height
 *   offset 16  width * height * 4  RGBA
 *
 * All header fields are little-endian.
 */
import { ExportError } from './errors.js';

/** 'PSDX' read back as a little-endian uint32. */
export const SPILL_MAGIC = 0x58445350;
export const SPILL_VERSION = 1;
export const SPILL_HEADER_BYTES = 16;

export function spillHeader(width, height) {
  const header = new Uint8Array(SPILL_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, SPILL_MAGIC, true);
  view.setUint32(4, SPILL_VERSION, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  return header;
}

/**
 * Header and pixels in one buffer.
 *
 * ALLOCATES A FULL COPY -- at 66 MB that briefly doubles the resident layer.
 * Use it for tests and in-memory adapters only. A real filesystem adapter
 * writes `[spillHeader(w, h), image.data]` as two chunks and never calls this.
 */
export function encodeSpill(image) {
  const out = new Uint8Array(SPILL_HEADER_BYTES + image.width * image.height * 4);
  out.set(spillHeader(image.width, image.height), 0);
  out.set(image.data, SPILL_HEADER_BYTES);
  return out;
}

/** Returns a VIEW onto `bytes` -- no copy, so do not reuse the input buffer. */
export function decodeSpill(bytes) {
  if (bytes.byteLength < SPILL_HEADER_BYTES)
    throw new ExportError(
      `Spill file is ${bytes.byteLength} bytes, too short to hold a header — the write was truncated.`,
      'SPILL_TRUNCATED',
    );

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPILL_MAGIC)
    throw new ExportError('Spill file has the wrong magic — it was not written by this exporter.', 'SPILL_CORRUPT');

  const version = view.getUint32(4, true);
  if (version !== SPILL_VERSION)
    throw new ExportError(`Spill file is version ${version}; this build writes version ${SPILL_VERSION}.`, 'SPILL_CORRUPT');

  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const expected = SPILL_HEADER_BYTES + width * height * 4;
  if (bytes.byteLength !== expected)
    throw new ExportError(
      `Spill file for a ${width}x${height} layer should be ${expected} bytes but is ${bytes.byteLength} — ` +
      `the write was truncated, most likely because the disk filled up.`,
      'SPILL_TRUNCATED',
    );

  return {
    width,
    height,
    data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + SPILL_HEADER_BYTES, width * height * 4),
  };
}

/**
 * The spill adapter export takes, backed by a Map.
 *
 * This is what makes the whole export walk testable in Node. The device adapter
 * lands in 1C-2 and implements the same four methods over Capacitor Filesystem.
 *
 * `writes` records every name written, in order, so a test can assert that the
 * walk parked exactly what planSpill predicted and nothing more.
 */
export function createMemorySpill() {
  const files = new Map();
  const writes = [];
  return {
    files,
    writes,
    async write(name, chunks) {
      let total = 0;
      for (const chunk of chunks) total += chunk.byteLength;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        // image.data is a Uint8ClampedArray, which `set` accepts, but wrapping
        // keeps one code path for both.
        out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
        offset += chunk.byteLength;
      }
      files.set(name, out);
      writes.push(name);
    },
    async read(name) {
      const bytes = files.get(name);
      if (!bytes) throw new ExportError(`Spill file "${name}" is missing.`, 'SPILL_MISSING');
      return bytes;
    },
    async remove(name) { files.delete(name); },
    async dispose() { files.clear(); },
  };
}
