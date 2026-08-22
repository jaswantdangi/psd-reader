/**
 * Minimal ICC profile reader.
 *
 * The `icc` npm package needs Node's Buffer (`readUInt32BE`) and throws on a
 * plain Uint8Array, so it can't run in a browser or a worker. The header is
 * fixed-layout and the tag table is trivial, so we read it directly.
 *
 * This reads enough to identify and route a profile. Actually *converting*
 * colour still needs a CMS (lcms-wasm or similar) — `raw` is kept for that.
 */

const DEVICE_CLASS = {
  scnr: 'input', mntr: 'display', prtr: 'output', link: 'device-link',
  spac: 'colour-space', abst: 'abstract', nmcl: 'named-colour',
};

const INTENT = ['perceptual', 'relative-colorimetric', 'saturation', 'absolute-colorimetric'];

const sig = (dv, o) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** `desc` (v2) and `mluc` (v4) both carry the human-readable name, differently. */
function readTextTag(bytes, dv, offset, size) {
  const type = sig(dv, offset);

  if (type === 'desc') {
    const length = dv.getUint32(offset + 8);
    if (!length) return '';
    return new TextDecoder('ascii').decode(bytes.subarray(offset + 12, offset + 12 + length - 1));
  }

  if (type === 'mluc') {
    const count = dv.getUint32(offset + 8);
    if (!count) return '';
    const recordSize = dv.getUint32(offset + 12);
    const length = dv.getUint32(offset + 16 + 4);       // first record: lang(2) country(2) length(4)
    const strOffset = dv.getUint32(offset + 16 + 8);
    if (recordSize < 12) return '';
    return new TextDecoder('utf-16be').decode(bytes.subarray(offset + strOffset, offset + strOffset + length));
  }

  if (type === 'text') {
    return new TextDecoder('ascii').decode(bytes.subarray(offset + 8, offset + size)).replace(/\0+$/, '');
  }

  return '';
}

/**
 * @param {Uint8Array} bytes  Contents of image resource 1039.
 * @returns {{description:string, copyright:string, deviceClass:string, colorSpace:string,
 *            connectionSpace:string, version:string, intent:string, tags:string[], raw:Uint8Array}}
 */
export function parseIccProfile(bytes) {
  if (bytes.byteLength < 132) throw new Error('ICC profile too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (sig(dv, 36) !== 'acsp') throw new Error('Not an ICC profile (missing acsp signature)');

  const major = dv.getUint8(8);
  const minorByte = dv.getUint8(9);
  const version = `${major}.${minorByte >> 4}.${minorByte & 0x0f}`;

  const tagCount = dv.getUint32(128);
  const tags = {};
  for (let i = 0; i < tagCount; i++) {
    const at = 132 + i * 12;
    if (at + 12 > bytes.byteLength) break;
    tags[sig(dv, at)] = { offset: dv.getUint32(at + 4), size: dv.getUint32(at + 8) };
  }

  const text = (name) => {
    const t = tags[name];
    if (!t || t.offset + t.size > bytes.byteLength) return '';
    try { return readTextTag(bytes, dv, t.offset, t.size); } catch { return ''; }
  };

  return {
    description: text('desc'),
    copyright: text('cprt'),
    deviceClass: DEVICE_CLASS[sig(dv, 12)] || sig(dv, 12).trim(),
    colorSpace: sig(dv, 16).trim(),
    connectionSpace: sig(dv, 20).trim(),
    version,
    intent: INTENT[dv.getUint32(64)] || 'unknown',
    tags: Object.keys(tags),
    raw: bytes,
  };
}
