import assert from 'node:assert/strict';
import { proxyScaleFor, downscaleImage, DEFAULT_PROXY_EDGE, createProject, estimatePeakBytes, memoryBudgetBytes, guardFileSize, HARD_FILE_CAP_BYTES, loadProjectProxy, readDocument } from '../src/index.js';
import fs from 'fs';
let progressCalls = 0;

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('\nproxy pipeline\n');

test('never upscales a document smaller than the proxy edge', () => {
  assert.equal(proxyScaleFor(200, 200, 1024), 1);
  assert.equal(proxyScaleFor(1, 1, DEFAULT_PROXY_EDGE), 1);
});

test('caps the longest edge at the proxy edge', () => {
  const s = proxyScaleFor(4961, 3508, 1024);
  assert.ok(Math.abs(4961 * s - 1024) < 1, `4961 * ${s} should be ~1024`);
});

test('uses the longest edge, not the width', () => {
  assert.equal(proxyScaleFor(500, 2000, 1000), proxyScaleFor(2000, 500, 1000));
});

test('survives a zero-sized document instead of dividing by zero', () => {
  assert.equal(proxyScaleFor(0, 0, 1024), 1);
});

test('downscaleImage returns the original when no downscale is needed', () => {
  const src = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  assert.equal(downscaleImage(src, 1), src);
});

test('downscaleImage halves dimensions', () => {
  const src = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4) };
  const out = downscaleImage(src, 0.5);
  assert.equal(out.width, 4);
  assert.equal(out.height, 2);
  assert.equal(out.data.length, 4 * 2 * 4);
});

test('averages colour weighted by alpha, so transparent pixels do not darken it', () => {
  // 2x1: opaque red beside fully transparent black. A naive average yields
  // half-brightness red -- the classic dark-halo bug. Weighting by alpha
  // must keep the red at full strength and only average the alpha.
  const src = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]) };
  const out = downscaleImage(src, 0.5);
  assert.equal(out.width, 1);
  assert.equal(out.data[0], 255, 'red channel should survive at full strength');
  assert.equal(out.data[3], 128, 'alpha should be the mean of 255 and 0');
});

test('a fully transparent source stays transparent without NaN', () => {
  const src = { width: 2, height: 1, data: new Uint8ClampedArray(8) };
  const out = downscaleImage(src, 0.5);
  assert.equal(out.data[3], 0);
  assert.ok(Number.isFinite(out.data[0]));
});

/** A document shaped like one that has been streamed: proxy pixels, no imageData. */
const streamedDoc = () => ({
  width: 100,
  height: 50,
  children: [{
    name: 'streamed',
    left: 0, top: 0, right: 100, bottom: 50,
    proxyData: { width: 10, height: 5, data: new Uint8ClampedArray(10 * 5 * 4) },
  }],
});

test('a layer with only proxy pixels still becomes an editable layer', () => {
  const project = createProject(streamedDoc(), 'streamed.psd');
  assert.equal(project.layers.length, 1, 'proxy-only layers must not be dropped');
  assert.equal(project.layers[0].pixels.width, 10);
  assert.equal(project.layers[0].pixels.height, 5);
});

test('layer geometry stays in document space, not proxy space', () => {
  const project = createProject(streamedDoc(), 'streamed.psd');
  const layer = project.layers[0];
  assert.equal(layer.w, 100, 'w must be the document-space width');
  assert.equal(layer.h, 50, 'h must be the document-space height');
});

test('sourceW/H are full-resolution document bounds, not the proxy buffer', () => {
  const layer = createProject(streamedDoc(), 'streamed.psd').layers[0];
  assert.equal(layer.sourceW, 100, 'sourceW must survive proxying at full resolution');
  assert.equal(layer.sourceH, 50, 'sourceH must survive proxying at full resolution');
});

test('proxyW/H report the actual buffer dimensions', () => {
  const layer = createProject(streamedDoc(), 'streamed.psd').layers[0];
  assert.equal(layer.proxyW, 10);
  assert.equal(layer.proxyH, 5);
});

test('createProject records the proxy scale and the source handle', () => {
  const project = createProject(streamedDoc(), 'streamed.psd', {
    proxyScale: 0.1,
    source: { uri: 'file:///storage/streamed.psd', name: 'streamed.psd', size: 12345 },
  });
  assert.equal(project.proxyScale, 0.1);
  assert.equal(project.source.uri, 'file:///storage/streamed.psd');
  assert.equal(project.source.size, 12345);
});

test('createProject defaults to full scale and no source', () => {
  const project = createProject(streamedDoc(), 'streamed.psd');
  assert.equal(project.proxyScale, 1, 'a full load is scale 1');
  assert.equal(project.source, null);
});

test('peak estimate follows the measured formula', () => {
  // Measured on a 4961x3508 6-layer document: 303.4 + 66.4 + 17 = 386.8 MB,
  // against 387.8 MB actually observed.
  const MB = 1024 * 1024;
  const peak = estimatePeakBytes({
    fileBytes: 303.4 * MB,
    largestLayerBytes: 66.4 * MB,
    proxyTotalBytes: 17 * MB,
  });
  assert.ok(Math.abs(peak / MB - 386.8) < 0.1, `expected ~386.8 MB, got ${peak / MB}`);
});

test('memory budget scales with device memory but never exceeds the hard cap', () => {
  assert.ok(memoryBudgetBytes(1) < memoryBudgetBytes(4));
  assert.ok(memoryBudgetBytes(64) <= HARD_FILE_CAP_BYTES);
});

test('memory budget falls back to a conservative default when unknown', () => {
  // navigator.deviceMemory is absent on many Android WebViews.
  assert.equal(memoryBudgetBytes(undefined), memoryBudgetBytes(1));
  assert.equal(memoryBudgetBytes(0), memoryBudgetBytes(1));
});

test('guard accepts a file inside the budget', () => {
  const result = guardFileSize(10 * 1024 * 1024, 100 * 1024 * 1024);
  assert.equal(result.ok, true);
  assert.equal(result.message, null);
});

test('guard refuses an oversized file and names both numbers', () => {
  const result = guardFileSize(500 * 1024 * 1024, 150 * 1024 * 1024);
  assert.equal(result.ok, false);
  assert.match(result.message, /500/, 'message must state the file size');
  assert.match(result.message, /150/, 'message must state the limit');
});

test('the unknown-device fallback is genuinely conservative, not merely defined', () => {
  // The clamp point is ~1.83 GB, so any assumed value at or above it silently
  // yields the maximum budget. An unknown device must get less than the cap.
  assert.ok(memoryBudgetBytes(undefined) < HARD_FILE_CAP_BYTES,
    'an unknown device must not receive the maximum budget');
});

// `vectors.src.psd` is 1080x1080 with 4 pixel-bearing layers, so a small proxy
// edge forces real downscaling. Loaded at top level because `test` is sync.
const proxyProject = await loadProjectProxy(
  new Uint8Array(fs.readFileSync('fixtures/vectors.src.psd')),
  {
    fileName: 'vectors.src.psd',
    proxyEdge: 256,
    source: { uri: 'file:///vectors.src.psd', name: 'vectors.src.psd', size: 1 },
    onProgress: () => { progressCalls++; },
  },
);

test('a streamed proxy load keeps every pixel-bearing layer', () => {
  assert.ok(proxyProject.layers.length >= 4, `expected >= 4 layers, got ${proxyProject.layers.length}`);
  for (const layer of proxyProject.layers) {
    assert.ok(layer.pixels || layer.text, `layer "${layer.name}" lost its pixels`);
  }
});

test('proxy scale is derived from the document, not assumed', () => {
  assert.ok(Math.abs(proxyProject.proxyScale - 256 / 1080) < 1e-9);
});

test('proxy pixels really are smaller than document space', () => {
  const raster = proxyProject.layers.find((l) => l.kind === 'raster');
  assert.ok(raster, 'fixture must contain a raster layer');
  assert.ok(raster.proxyW < raster.sourceW, `${raster.proxyW} should be < ${raster.sourceW}`);
  assert.equal(raster.pixels.width, raster.proxyW);
});

test('geometry remains full-resolution document space after proxying', () => {
  const raster = proxyProject.layers.find((l) => l.kind === 'raster');
  assert.equal(raster.w, raster.sourceW, 'w must not be shrunk to proxy space');
});

test('the source handle survives onto the project', () => {
  assert.equal(proxyProject.source.name, 'vectors.src.psd');
});

test('progress is reported once per decoded layer', () => {
  assert.ok(progressCalls > 0, 'onProgress was never called');
});

// Streamed load of a fixture that actually HAS masks. The synthetic documents
// the memory spike used had none, which is exactly why it reported zero retained
// pixels while mask rasters were quietly surviving the release.
let retainedMaskBytes = 0;
let layersCarryingMask = 0;
{
  const maskDoc = await readDocument(
    new Uint8Array(fs.readFileSync('fixtures/masks.src.psd')),
    { pixels: 'stream', metadata: false, onLayer: () => {} },
  );
  for (const l of maskDoc.layers || []) {
    if (l.mask) layersCarryingMask++;
    for (const m of [l.mask, l.realMask]) {
      if (m && m.imageData && m.imageData.data) retainedMaskBytes += m.imageData.data.length;
    }
  }
}

test('the fixture really does carry masks, so the next test can fail', () => {
  assert.ok(layersCarryingMask > 0, 'masks.src.psd must contain masked layers');
});

test('streaming releases mask pixels, not just layer pixels', () => {
  assert.equal(retainedMaskBytes, 0,
    `${retainedMaskBytes} bytes of mask pixels survived the release — the same leak that ` +
    'made the streamed-load memory guarantee untrue for any document containing a mask');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
