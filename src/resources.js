/**
 * Raw PSD/PSB image-resource extraction.
 *
 * ag-psd parses 21 resource types into a typed model but discards the rest,
 * including the ICC profile, EXIF and IPTC. This walks the resource section
 * directly and hands back the raw bytes so specialist parsers can take over.
 *
 * No dependencies. No DOM. Works identically in a browser, a worker and Node.
 */

/** Image resource IDs we care about. @see https://www.adobe.io/photoshop/psd */
export const RESOURCE = {
  ICC_PROFILE: 1039,
  EXIF: 1058,
  EXIF_3: 1059,
  XMP: 1060,
  IPTC_NAA: 1028,
  CAPTION_DIGEST: 1061,
  PRINT_SCALE: 1062,
};

const ascii = (dv, o) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/**
 * Extract every image-resource block, keyed by resource ID.
 *
 * @param {Uint8Array} bytes  Whole PSD/PSB file.
 * @returns {Map<number, Uint8Array>} Views into `bytes` — no copying.
 */
export function extractResources(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;

  if (ascii(dv, o) !== '8BPS') throw new Error('Not a PSD/PSB file (bad signature)');
  o += 4;
  o += 2 + 6 + 2 + 4 + 4 + 2 + 2; // version, reserved, channels, height, width, depth, colour mode
  o += 4 + dv.getUint32(o); // colour mode data section

  const sectionLength = dv.getUint32(o);
  o += 4;

  const end = o + sectionLength;
  const out = new Map();

  while (o < end - 4) {
    if (ascii(dv, o) !== '8BIM') break; // corrupt or unexpected padding — stop, don't guess
    o += 4;

    const id = dv.getUint16(o);
    o += 2;

    const nameLength = dv.getUint8(o); // Pascal string, padded to even
    o += 1 + nameLength;
    if ((nameLength + 1) % 2) o += 1;

    const size = dv.getUint32(o);
    o += 4;

    out.set(id, bytes.subarray(o, o + size));
    o += size + (size % 2); // block data is padded to even
  }

  return out;
}
