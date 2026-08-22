/**
 * IPTC-NAA (IIM) parsing for PSD image resource 1028.
 *
 * exifr can read IPTC, but only when it's wrapped in a JPEG APP13 segment.
 * PSD stores the bare IIM stream, so it needs handling directly.
 *
 * IIM record layout: 0x1C, record#, dataset#, length(uint16, or extended), data
 */

/** Record 2 ("application") datasets — the ones that carry authorship and rights. */
const APPLICATION = {
  5: 'objectName', 10: 'urgency', 15: 'category', 20: 'supplementalCategories',
  25: 'keywords', 40: 'specialInstructions', 55: 'dateCreated', 60: 'timeCreated',
  65: 'originatingProgram', 80: 'byline', 85: 'bylineTitle', 90: 'city',
  92: 'subLocation', 95: 'provinceState', 100: 'countryCode', 101: 'country',
  103: 'originalTransmissionReference', 105: 'headline', 110: 'credit',
  115: 'source', 116: 'copyrightNotice', 118: 'contact', 120: 'caption',
  122: 'captionWriter',
};

/** Datasets that may legitimately repeat. Everything else takes the last value. */
const REPEATABLE = new Set(['keywords', 'supplementalCategories', 'byline', 'contact']);

/**
 * @param {Uint8Array} bytes  Contents of image resource 1028.
 * @returns {Record<string, string|string[]>}
 */
export function parseIptc(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const out = {};
  let o = 0;

  while (o + 5 <= bytes.byteLength) {
    if (dv.getUint8(o) !== 0x1c) { o += 1; continue; }

    const record = dv.getUint8(o + 1);
    const dataset = dv.getUint8(o + 2);
    let length = dv.getUint16(o + 3);
    o += 5;

    if (length & 0x8000) { // extended: low bits give the size of the real length field
      const n = length & 0x7fff;
      length = 0;
      for (let i = 0; i < n; i++) length = length * 256 + dv.getUint8(o + i);
      o += n;
    }
    if (o + length > bytes.byteLength) break; // truncated block

    // Record 1 is envelope metadata (character set, etc). Only record 2 is content.
    if (record === 2) {
      const key = APPLICATION[dataset];
      if (key) {
        const value = decoder.decode(bytes.subarray(o, o + length));
        if (REPEATABLE.has(key)) (out[key] ||= []).push(value);
        else out[key] = value;
      }
    }
    o += length;
  }

  return out;
}
