/**
 * A PNG writer with no dependencies and no canvas.
 *
 * The primary encode route is OffscreenCanvas + convertToBlob, but
 * 4961 x 3508 = 17,403,188 px, which is over the 16,777,216 px canvas-area cap
 * older iOS enforces -- so the obvious route can fail on exactly the document
 * this phase exists for.
 *
 * Compression is deliberately absent: every deflate block is STORED, so the
 * output is roughly the size of the raw pixels (about 66.5 MB for the poster).
 * Deflating that in JavaScript would cost more time than the bytes are worth
 * for a file that is about to be shared and deleted.
 *
 * Note for the canvas route: putImageData premultiplies and convertToBlob
 * un-premultiplies, so RGB under partial alpha can shift by +/-1 there. This
 * writer does not touch the pixels at all.
 */

/** Largest canvas area older iOS will allocate. */
export const CANVAS_AREA_CAP = 16777216;

export function canUseCanvasEncoder(width, height) {
  return width * height <= CANVAS_AREA_CAP;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  // 5552 is the largest run that cannot overflow a 32-bit accumulator.
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** One PNG chunk: length, type, body, CRC32 of type+body. All big-endian. */
function chunk(type, body) {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)), false);
  return out;
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image  Straight alpha.
 * @returns {Uint8Array} A complete 8-bit RGBA, non-interlaced PNG.
 */
export function encodePngStored(image) {
  const { width, height, data } = image;

  // Raw scanlines: one filter byte (0 = none) then the row's RGBA.
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }

  // zlib stream of stored deflate blocks. 0x78 0x01 is CMF/FLG for a 32K
  // window with no preset dictionary; 0x7801 is divisible by 31, as the header
  // check requires.
  const MAX_BLOCK = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX_BLOCK));
  const z = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let p = 0;
  z[p++] = 0x78;
  z[p++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX_BLOCK;
    const length = Math.min(MAX_BLOCK, raw.length - start);
    z[p++] = i === blocks - 1 ? 1 : 0;               // BFINAL, BTYPE 00 (stored)
    z[p++] = length & 0xff;
    z[p++] = (length >> 8) & 0xff;
    z[p++] = ~length & 0xff;
    z[p++] = (~length >> 8) & 0xff;
    z.set(raw.subarray(start, start + length), p);
    p += length;
  }
  const sum = adler32(raw);
  z[p++] = (sum >>> 24) & 0xff;
  z[p++] = (sum >>> 16) & 0xff;
  z[p++] = (sum >>> 8) & 0xff;
  z[p++] = sum & 0xff;

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width, false);
  header.setUint32(4, height, false);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // compression: deflate
  ihdr[11] = 0;   // filter method: adaptive
  ihdr[12] = 0;   // interlace: none

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];

  let total = 0;
  for (const part of parts) total += part.length;
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}
