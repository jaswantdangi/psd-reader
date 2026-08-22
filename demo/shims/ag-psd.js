/**
 * ag-psd ships UMD for browsers — its `dist-es` folder is mislabelled and
 * actually contains CommonJS, so it can't be imported directly. The UMD bundle
 * is loaded by a <script> tag in index.html, which puts it on `globalThis`.
 *
 * ESM named exports must be static, so every name has to be listed here. If you
 * import a new ag-psd symbol in src/, add it below — `npm run check:shim`
 * (test/shim.mjs) fails the build when they drift apart.
 */
const g = globalThis.agPsd;

if (!g) {
  throw new Error(
    'ag-psd bundle did not load. index.html must include ' +
    '<script src="/node_modules/ag-psd/dist/bundle.js"> BEFORE the module graph.',
  );
}

export const ChannelID = g.ChannelID;
export const ColorMode = g.ColorMode;
export const Compression = g.Compression;
export const LayerCompCapturedInfo = g.LayerCompCapturedInfo;
export const SectionDividerType = g.SectionDividerType;
export const byteArrayToBase64 = g.byteArrayToBase64;
export const decodeLayerPixels = g.decodeLayerPixels;
export const getCompositeCanvas = g.getCompositeCanvas;
export const getCompositeImageData = g.getCompositeImageData;
export const getLayerCanvas = g.getLayerCanvas;
export const getLayerImageData = g.getLayerImageData;
export const getLayerMaskCanvas = g.getLayerMaskCanvas;
export const getLayerMaskImageData = g.getLayerMaskImageData;
export const getLayerRealMaskCanvas = g.getLayerRealMaskCanvas;
export const getLayerRealMaskImageData = g.getLayerRealMaskImageData;
export const initializeCanvas = g.initializeCanvas;
export const readAbr = g.readAbr;
export const readCsh = g.readCsh;
export const readPsd = g.readPsd;
export const writePsd = g.writePsd;
export const writePsdBuffer = g.writePsdBuffer;
export const writePsdUint8Array = g.writePsdUint8Array;

export default g;
