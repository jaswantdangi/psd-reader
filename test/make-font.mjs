/**
 * Minimal sfnt font files, built in memory for tests.
 *
 * Only a table directory and a `name` table -- enough for a reader that looks
 * up a font's PostScript name, and nothing FontFace could draw with. The repo
 * holds no font files (they are licensed assets), so the tests make their own.
 */
const push16 = (a, v) => a.push((v >>> 8) & 255, v & 255);
const push32 = (a, v) => a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const utf16be = (s) => { const out = []; for (let i = 0; i < s.length; i++) push16(out, s.charCodeAt(i)); return out; };
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

/**
 * @param {string} postscriptName  nameID 6
 * @param {object} [o]
 * @param {string} [o.family]     nameID 1
 * @param {string} [o.subfamily]  nameID 2
 * @param {string} [o.signature]  '\0\x01\0\0' (TrueType), 'true', or 'OTTO' (CFF)
 * @param {'windows'|'mac'|'both'} [o.platform]  'both' prefixes the Mac strings with "mac-"
 * @param {number} [o.padding]    trailing zero bytes, to make a file of a given size
 * @param {number} [o.base]       where this font starts inside a collection (offsets are absolute)
 */
export function makeFont(postscriptName, {
  family = 'Test Family', subfamily = 'Regular', signature = '\0\x01\0\0',
  platform = 'windows', padding = 0, base = 0,
} = {}) {
  const strings = [];
  const records = [];
  const add = (platformID, encodingID, languageID, nameID, bytes) => {
    records.push([platformID, encodingID, languageID, nameID, bytes.length, strings.length]);
    strings.push(...bytes);
  };
  for (const [id, s] of [[1, family], [2, subfamily], [6, postscriptName]]) {
    if (platform === 'mac' || platform === 'both') add(1, 0, 0, id, ascii(platform === 'both' ? `mac-${s}` : s));
    if (platform === 'windows' || platform === 'both') add(3, 1, 0x409, id, utf16be(s));
  }
  const name = [];
  push16(name, 0); push16(name, records.length); push16(name, 6 + records.length * 12);
  for (const r of records) r.forEach((v) => push16(name, v));
  name.push(...strings);

  const head = ascii(signature);
  push16(head, 1); push16(head, 16); push16(head, 0); push16(head, 0);
  const dir = ascii('name');
  push32(dir, 0); push32(dir, base + 12 + 16); push32(dir, name.length);

  const out = new Uint8Array(head.length + dir.length + name.length + padding);
  out.set(head, 0);
  out.set(dir, head.length);
  out.set(name, head.length + dir.length);
  return out;
}

/** A `.ttc` holding one minimal font per name. */
export function makeCollection(postscriptNames) {
  const header = 12 + 4 * postscriptNames.length;
  const offsets = [];
  let at = header;
  for (const n of postscriptNames) { offsets.push(at); at += makeFont(n).length; }
  const out = new Uint8Array(at);
  const h = ascii('ttcf');
  push32(h, 0x00010000); push32(h, postscriptNames.length);
  offsets.forEach((o) => push32(h, o));
  out.set(h, 0);
  postscriptNames.forEach((n, i) => out.set(makeFont(n, { base: offsets[i] }), offsets[i]));
  return out;
}
