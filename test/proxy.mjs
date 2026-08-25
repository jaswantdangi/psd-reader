import assert from 'node:assert/strict';
import { proxyScaleFor, downscaleImage, DEFAULT_PROXY_EDGE, createProject, estimatePeakBytes, memoryBudgetBytes, guardFileSize, HARD_FILE_CAP_BYTES } from '../src/index.js';

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
  assert.equal(memoryBudgetBytes(undefined), memoryBudgetBytes(2));
  assert.equal(memoryBudgetBytes(0), memoryBudgetBytes(2));
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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
