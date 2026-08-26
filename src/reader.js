/**
 * PSD/PSB reader: ag-psd for structure, direct block extraction for the
 * metadata ag-psd discards.
 *
 * Measured against 21 Photoshop-authored files: ag-psd surfaces 343/343 layer
 * block keys, but reads none of the ICC profile, EXIF or IPTC, and does not
 * expose pattern definitions at all.
 */
import { readPsd, decodeLayerPixels, getCompositeImageData } from 'ag-psd';
import { installPlainPixelBackend } from './canvas.js';
import { extractResources, RESOURCE } from './resources.js';
import { parseIccProfile } from './icc.js';
import { parseIptc } from './iim.js';

/** Pattern definitions. No library on any platform reads these — we can only warn. */
const PATTERN_KEYS = ['Patt', 'Pat2', 'Pat3'];

/** Byte-scan for `8BIM<key>`. Only drives a warning, so a false positive is harmless. */
function containsKey(bytes, key) {
  const needle = [0x38, 0x42, 0x49, 0x4d, ...key.split('').map((c) => c.charCodeAt(0))];
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function flattenLayers(children, out = []) {
  for (const layer of children || []) {
    out.push(layer);
    if (layer.children) flattenLayers(layer.children, out);
  }
  return out;
}

async function readMetadata(bytes, warnings) {
  const resources = extractResources(bytes);
  const metadata = { icc: null, exif: null, iptc: null };

  const icc = resources.get(RESOURCE.ICC_PROFILE);
  if (icc) {
    try { metadata.icc = parseIccProfile(icc); }
    catch (e) { warnings.push(`ICC profile present (${icc.length}B) but unreadable: ${e.message}`); }
  }

  const iptc = resources.get(RESOURCE.IPTC_NAA);
  if (iptc) {
    try {
      const parsed = parseIptc(iptc);
      if (Object.keys(parsed).length) metadata.iptc = parsed;
    } catch (e) { warnings.push(`IPTC present but unreadable: ${e.message}`); }
  }

  const exif = resources.get(RESOURCE.EXIF) || resources.get(RESOURCE.EXIF_3);
  if (exif) {
    try {
      // Imported lazily: exifr is the only dependency a caller may not want.
      // Its ESM build exports `parse` by name and has NO default export, while the
      // CJS build only yields one through interop. Take whichever this host gives us,
      // or EXIF silently stops working in browsers while Node tests still pass.
      const mod = await import('exifr');
      const parse = mod.parse || (mod.default && mod.default.parse);
      if (!parse) throw new Error('exifr exposed no parse()');
      metadata.exif = await parse(exif, { tiff: true, ifd0: true, exif: true, gps: true });
    } catch (e) { warnings.push(`EXIF present but unreadable: ${e.message}`); }
  }

  return metadata;
}

/**
 * @param {Uint8Array|ArrayBuffer} source
 * @param {object} [options]
 * @param {'none'|'eager'|'stream'} [options.pixels='none']
 *   `none`   structure and metadata only — cheapest.
 *   `eager`  decode every layer and keep it. Peak memory scales with the document.
 *   `stream` decode one layer at a time, hand it to `onLayer`, then release.
 *            Peak stays at roughly file size + one layer.
 * @param {(layer: object, pixels: {width:number,height:number,data:Uint8ClampedArray}|undefined) => any} [options.onLayer]
 *   Required when `pixels: 'stream'`. Copy what you need before returning —
 *   the buffer is released immediately afterwards.
 * @param {(size: {width: number, height: number}) => any} [options.onStart]
 *   `pixels: 'stream'` only. Fires once, after the structure parse and before
 *   any layer is decoded, so a caller can size proxies without a second parse.
 * @param {(layer: object, sourceIndex: number) => boolean} [options.wantLayer]
 *   `pixels: 'stream'` only. Return false to skip the decode entirely. The
 *   sourceIndex counter still advances for a skipped layer, so refusing one
 *   does not shift the identity of any layer after it.
 * @param {boolean} [options.metadata=true]
 * @param {boolean} [options.patterns=true]
 *   Scan the whole file three times for pattern definitions. Only drives a
 *   warning. Full-resolution export passes false: the warning was already
 *   surfaced when the document was opened, and three O(n) passes over a
 *   300 MB file is not free on a phone.
 */
export async function readDocument(source, options = {}) {
  const { pixels = 'none', onLayer, onStart, wantLayer, metadata: wantMetadata = true, embedded = false, patterns = true } = options;

  if (pixels === 'stream' && typeof onLayer !== 'function')
    throw new Error("pixels: 'stream' requires an onLayer callback");

  installPlainPixelBackend();

  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  // Avoid copying the whole file when the view already spans its buffer — on a
  // 260MB PSD that copy alone costs 260MB of peak.
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const warnings = [];

  const psd = readPsd(buffer, {
    skipCompositeImageData: !embedded,
    skipThumbnail: true,
    skipLayerImageData: pixels === 'none',
    useRawData: pixels === 'stream',
    useImageData: pixels === 'eager',
    logMissingFeatures: true,
    log: (...args) => {
      const message = args.join(' ');
      if (/Unhandled/.test(message)) warnings.push(message.replace(/\s+/g, ' ').trim());
    },
  });

  const layers = flattenLayers(psd.children);

  if (pixels === 'stream') {
    // Fires after the structure parse, before any layer is decoded, so a
    // caller can size its proxies without parsing the file a second time.
    if (typeof onStart === 'function') await onStart({ width: psd.width, height: psd.height });

    // Identity for every leaf the file contains, assigned before any decision
    // about whether to decode it. edit.js's flatten() drops leaves with neither
    // pixels nor text, so project order and decode order have the same ORDER but
    // different MEMBERSHIP -- matching them by array position misaligns every
    // layer after the first gap, and the result looks like a plausible image.
    // This counter is the only thing both sides can agree on.
    let sourceIndex = 0;

    for (const layer of layers) {
      if (layer.children) continue; // groups carry no pixels of their own
      layer.sourceIndex = sourceIndex++;
      // Skip the decode for layers the caller will not use. The counter above
      // has already advanced, which is the whole point -- a skipped layer must
      // not renumber the ones after it.
      if (typeof wantLayer === 'function' && !wantLayer(layer, layer.sourceIndex)) continue;
      decodeLayerPixels(layer, true);
      await onLayer(layer, layer.imageData);
      layer.imageData = undefined;
      layer.canvas = undefined;
      layer.rawData = undefined; // the retained compressed channels — the big one

      // `decodeLayerPixels` also fills in the mask, and releasing only the three
      // fields above left those pixels resident for the life of the document —
      // measured at 104 KB on a 200x200 fixture, and it scales with layer area,
      // so a poster-sized masked layer held tens of MB. That silently broke the
      // memory guarantee this whole streaming path exists to provide.
      //
      // The mask is released here, not kept, for the same reason `imageData` is:
      // a caller that wants it downscales inside `onLayer` above, while the
      // full-resolution original is still in scope. That is how proxy pixels
      // already work, and it keeps one rule instead of two.
      if (layer.mask) {
        layer.mask.imageData = undefined;
        layer.mask.canvas = undefined;
      }
      if (layer.realMask) {
        layer.realMask.imageData = undefined;
        layer.realMask.canvas = undefined;
      }
    }
  }

  if (patterns && PATTERN_KEYS.some((key) => containsKey(bytes, key)))
    warnings.push('Pattern definitions (Patt) present but not readable — no library supports them. Layers using pattern fills will not render correctly.');

  // The flattened preview Photoshop wrote on save — exact by definition.
  let embeddedComposite = null;
  if (embedded) {
    try { embeddedComposite = psd.imageData || getCompositeImageData(psd) || null; }
    catch (e) { warnings.push(`Embedded composite present but undecodable: ${e.message}`); }
  }

  return {
    width: psd.width,
    embeddedComposite,
    height: psd.height,
    channels: psd.channels,
    bitsPerChannel: psd.bitsPerChannel,
    colorMode: psd.colorMode,
    children: psd.children,
    layers,
    resources: psd.imageResources || {},
    linkedFiles: psd.linkedFiles || [],
    artboards: psd.artboards,
    annotations: psd.annotations || [],
    metadata: wantMetadata
      ? { ...(await readMetadata(bytes, warnings)), xmp: (psd.imageResources || {}).xmpMetadata || null }
      : null,
    warnings: [...new Set(warnings)],
  };
}
