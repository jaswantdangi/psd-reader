/**
 * Reading a font file's own name, and moving its bytes over a JSON wire.
 *
 * Photoshop's API lists the fonts it has (`app.fonts`: `postScriptName`,
 * `family`, `style`) but never where their files are. So the plugin has to
 * open files and ask each one what it is. The answer is the sfnt `name`
 * table's nameID 6 -- the PostScript name -- which is the same string a PSD
 * stores. A file name is never trusted for that: `HelvNeue_Rm.otf` names
 * nothing, and `candidateOrder` below only decides which files to OPEN first.
 *
 * Pure, and imported by both ends: vendored into the plugin as CommonJS, and
 * used by the app to reassemble and verify what arrived. Nothing here throws
 * on bad input; a file that cannot be read returns null.
 */
import { FONT_CHUNK_BYTES } from './protocol.js';

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** TrueType, Apple TrueType, and CFF-flavoured OpenType. */
const SFNT_SIGNATURES = new Set(['\0\x01\0\0', 'true', 'OTTO']);

/** Bytes from whatever the host handed over, across realms (UXP, a vm, a worker). */
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input && typeof input.byteLength === 'number') return new Uint8Array(input);
  return new Uint8Array(0);
}

const utf16 = (b, at, length) => {
  let s = '';
  for (let i = 0; i + 1 < length; i += 2) s += String.fromCharCode(u16(b, at + i));
  return s;
};
const latin = (b, at, length) => {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(b[at + i]);
  return s;
};

/**
 * The names of the one font whose offset table starts at `start`.
 *
 * Record preference: Windows Unicode US-English, any Windows Unicode, the
 * Unicode platform, then Mac Roman. The PostScript name is ASCII by
 * definition and normally identical across records; the order only matters
 * for a file that disagrees with itself.
 */
function namesAt(b, start) {
  if (start < 0 || start + 12 > b.length || !SFNT_SIGNATURES.has(tag(b, start))) return null;
  const numTables = u16(b, start + 4);
  const dirEnd = start + 12 + numTables * 16;
  if (dirEnd > b.length) return null;

  let table = -1;
  let tableLength = 0;
  for (let rec = start + 12; rec < dirEnd; rec += 16) {
    if (tag(b, rec) === 'name') { table = u32(b, rec + 8); tableLength = u32(b, rec + 12); break; }
  }
  if (table < 0 || table + 6 > b.length || table + tableLength > b.length) return null;

  const count = u16(b, table + 2);
  const strings = table + u16(b, table + 4);
  if (table + 6 + count * 12 > b.length) return null;

  const best = new Map();
  for (let i = 0; i < count; i++) {
    const r = table + 6 + i * 12;
    const platform = u16(b, r);
    const encoding = u16(b, r + 2);
    const language = u16(b, r + 4);
    const nameID = u16(b, r + 6);
    if (nameID !== 1 && nameID !== 2 && nameID !== 6) continue;
    const length = u16(b, r + 8);
    const at = strings + u16(b, r + 10);
    if (at + length > b.length) continue;

    let rank;
    let value;
    if (platform === 3 && (encoding === 1 || encoding === 10)) { rank = language === 0x409 ? 4 : 3; value = utf16(b, at, length); }
    else if (platform === 0) { rank = 2; value = utf16(b, at, length); }
    else if (platform === 1 && encoding === 0) { rank = 1; value = latin(b, at, length); }
    else continue;

    const prev = best.get(nameID);
    if (!prev || rank > prev.rank) best.set(nameID, { rank, value });
  }

  const postscriptName = best.get(6)?.value;
  if (!postscriptName) return null;
  return { postscriptName, family: best.get(1)?.value ?? '', subfamily: best.get(2)?.value ?? '' };
}

/**
 * What font(s) a file holds.
 *
 * @returns {{postscriptName:string,family:string,subfamily:string}
 *   | {collection:true,fonts:Array} | {unsupported:'woff'} | null}
 *   A collection is reported with its members so the plugin can say "that
 *   font is inside cambria.ttc" -- which `FontFace` cannot load -- rather than
 *   the less useful "not found".
 */
export function fontNamesIn(input) {
  const b = toBytes(input);
  if (b.length < 12) return null;
  const signature = tag(b, 0);
  if (signature === 'wOFF' || signature === 'wOF2') return { unsupported: 'woff' };
  if (signature === 'ttcf') {
    const n = u32(b, 8);
    if (n < 1 || n > 256 || 12 + n * 4 > b.length) return null;
    const fonts = [];
    for (let i = 0; i < n; i++) {
      const names = namesAt(b, u32(b, 12 + i * 4));
      if (names) fonts.push(names);
    }
    return { collection: true, fonts };
  }
  return namesAt(b, 0);
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');

/**
 * The file names, reordered so the ones resembling a wanted name open first.
 *
 * An ORDERING HINT, not a matcher: every file it puts first is still opened
 * and asked its name, so a wrong guess costs one read and never a wrong font.
 * That is why it can be this crude, and why it is not a second copy of the
 * matching in `src/fonts.js`.
 */
export function candidateOrder(names, fileNames) {
  const wants = (Array.isArray(names) ? names : [names]).map(squash).filter(Boolean);
  const score = (file) => {
    const s = squash(file);
    let best = 2;
    for (const w of wants) {
      if (s === w) return 0;
      if (s.length >= 4 && w.length >= 4 && (w.startsWith(s.slice(0, 4)) || s.startsWith(w.slice(0, 4)))) best = 1;
    }
    return best;
  };
  return fileNames
    .map((file, i) => [score(file), i, file])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    .map((entry) => entry[2]);
}

// ---------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Ours, not `btoa`: UXP's `btoa` over binary is not something to bet a font on. */
export function bytesToBase64(input) {
  const b = toBytes(input);
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[n >>> 18] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += B64[n >>> 18] + B64[(n >>> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64[n >>> 18] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + '=';
  }
  return out;
}

const b64At = (s, i) => {
  const c = s.charCodeAt(i);
  return c < 128 ? B64_VALUE[c] : -1;
};

/** The bytes, or null for anything that is not well-formed base64. */
export function base64ToBytes(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0) return null;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    const c0 = b64At(text, i);
    const c1 = b64At(text, i + 1);
    const c2 = last && pad === 2 ? 0 : b64At(text, i + 2);
    const c3 = last && pad >= 1 ? 0 : b64At(text, i + 3);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < out.length) out[o++] = n >>> 16;
    if (o < out.length) out[o++] = (n >>> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ---------------------------------------------------------------- sha256

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256, as lowercase hex.
 *
 * Ours because the two ends differ: the app has `crypto.subtle`, and UXP's
 * support for it is not documented. One implementation on both ends means
 * the checksum cannot disagree for a reason that is not the bytes.
 */
export function sha256Hex(input) {
  const bytes = toBytes(input);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  return Array.from(h, (v) => v.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------- chunks

/** The `font-chunk` frames for one file. The caller has already checked its size. */
export function chunkFont(input, { name, fileName }) {
  const bytes = toBytes(input);
  const sha256 = sha256Hex(bytes);
  const count = Math.max(1, Math.ceil(bytes.length / FONT_CHUNK_BYTES));
  const frames = [];
  for (let index = 0; index < count; index++) {
    const slice = bytes.subarray(index * FONT_CHUNK_BYTES, (index + 1) * FONT_CHUNK_BYTES);
    frames.push({ type: 'font-chunk', name, fileName, index, count, bytes: bytes.length, sha256, data: bytesToBase64(slice) });
  }
  return frames;
}

/**
 * One file from its chunks, in any order -- or the reason it cannot be.
 *
 * The checksum is the last word: a file that decodes, adds up to the right
 * length and still hashes wrong is refused, because handing `FontFace` a
 * truncated font fails later and less clearly than refusing it here.
 */
export function assembleFont(frames) {
  if (!Array.isArray(frames) || !frames.length) return { ok: false, reason: 'no chunks arrived' };
  const { count, bytes: total, sha256 } = frames[0];
  const parts = new Array(count);
  for (const f of frames) {
    if (f.count !== count || f.bytes !== total || f.sha256 !== sha256) {
      return { ok: false, reason: 'the chunks disagree about which file they belong to' };
    }
    const data = base64ToBytes(f.data);
    if (!data) return { ok: false, reason: `chunk ${f.index + 1} is not valid base64` };
    parts[f.index] = data;
  }
  for (let i = 0; i < count; i++) {
    if (!parts[i]) return { ok: false, reason: `chunk ${i + 1} of ${count} never arrived` };
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    if (at + p.length > total) return { ok: false, reason: 'the chunks add up to more than the file size' };
    out.set(p, at);
    at += p.length;
  }
  if (at !== total) return { ok: false, reason: `received ${at} of ${total} bytes` };
  if (sha256Hex(out) !== sha256) return { ok: false, reason: 'the file arrived damaged (checksum mismatch)' };
  return { ok: true, bytes: out };
}
