# Phase 1A — Workspace + Proxy Load Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a PSD at proxy resolution inside a Web Worker, render it with the existing JS renderer in a minimal Ionic app, with memory bounded and a size guard that refuses files too large for the device.

**Architecture:** Layer pixels are decoded one at a time via `pixels: 'stream'`, downscaled to a proxy on arrival, and the full-resolution raster is released immediately. The source file bytes — measured at 68–78% of peak memory — are released once decode finishes, leaving only proxies resident. Layer geometry (`x/y/w/h`) stays in **document coordinates**, so `renderProject`'s existing `scale` parameter is what draws the proxy, and transforms remain resolution-independent for a later full-resolution export.

**Tech Stack:** Node 24 (ESM, `node:assert/strict`), `ag-psd` 31, Ionic 8 + Angular standalone + Capacitor 8, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-08-25-phase-1-engine-gpu-memory-design.md`](../specs/2026-08-25-phase-1-engine-gpu-memory-design.md)

## Global Constraints

- **Engine code is plain ESM JavaScript in `src/`** — no TypeScript, no framework imports. It is consumed by Node tests, the existing `demo/` pages, and the Angular app alike.
- **Never route text through `resample()`.** Text is vector; it must be drawn at final size (HANDOFF Failed Approach 5).
- **Invalidate `renderedKey`, never `rendered` alone** — a stale key returns `null` and the layer disappears (HANDOFF Failed Approach 6).
- **Every `ag-psd` symbol used in `src/` must be listed in `demo/shims/ag-psd.js`** or the demo pages blank (HANDOFF Failed Approach 3). `test/shim.mjs` guards this and runs first.
- **Do not run build commands.** Per project rules, the user builds and verifies. Tasks that cannot be checked by `npm test` say so explicitly and hand verification to the user.
- **Stage exact files.** Never `git add .` or `git add <dir>`; read `git diff --staged` before every commit.
- **Comparison tolerance is 1**, via `stat.percentReal`, never `stat.percent` (HANDOFF Failed Approach 8).
- Test scripts run with `--max-old-space-size=6144`.
- Branch: `phase-1-engine-gpu-memory`. Do not push without explicit approval.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/proxy.js` | Proxy scale arithmetic and alpha-weighted box downscaling. Pure, no I/O. |
| `src/budget.js` | Device memory budget and the file-size guard. Pure arithmetic. |
| `src/load.js` | Orchestrates stream + downscale + `createProject` into one call. |
| `test/proxy.mjs` | Suite for `proxy.js`, `budget.js`, `load.js`, and the `edit.js` proxy changes. |
| `app/` | Minimal Ionic Angular workspace (Task 7). |
| `app/src/app/workers/psd-decode.worker.ts` | Runs the load pipeline off the main thread. |
| `app/src/app/services/psd-loader.service.ts` | Thin Angular wrapper over the worker. |
| `app/src/app/harness/harness.page.ts` | Deliberately ugly page proving the pipeline works. |

**Modified:**

| File | Change |
|---|---|
| `src/edit.js:115` | Accept nodes carrying only proxy pixels |
| `src/edit.js:58-60` | Proxy pixels; full-res `sourceW/H`; new `proxyW/H` |
| `src/edit.js:130-137` | `createProject` gains `proxyScale` and `source` |
| `src/reader.js:85` | `onStart` option, so proxy scale is known without a second parse |
| `src/index.js` | Export the new modules |
| `package.json` | `test:proxy` script |

Engine logic lives in `src/` — where the existing Node suites already run — precisely so the Angular layer stays thin plumbing that needs no framework test runner.

---

### Task 1: Proxy scale and downscaling

**Files:**
- Create: `src/proxy.js`
- Create: `test/proxy.mjs`
- Modify: `src/index.js`, `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `proxyScaleFor(width, height, edge = 1024) -> number`, `downscaleImage(img, scale) -> {width, height, data} | null`, `DEFAULT_PROXY_EDGE = 1024`

- [ ] **Step 1: Write the failing tests**

Create `test/proxy.mjs`:

```js
import assert from 'node:assert/strict';
import { proxyScaleFor, downscaleImage, DEFAULT_PROXY_EDGE } from '../src/index.js';

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

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/index.js' does not provide an export named 'proxyScaleFor'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/proxy.js`:

```js
/**
 * Proxy-resolution helpers.
 *
 * A PSD's layers are decoded at full resolution -- ag-psd offers no partial
 * decode -- so the only way to edit a large document on a phone is to shrink
 * each layer as it arrives and release the full raster immediately.
 */

/** Longest edge, in pixels, that a proxy layer is allowed to occupy. */
export const DEFAULT_PROXY_EDGE = 1024;

/**
 * Scale factor that fits a document inside `edge`. Never upscales: a document
 * already smaller than the proxy edge is used at its natural size.
 */
export function proxyScaleFor(width, height, edge = DEFAULT_PROXY_EDGE) {
  const longest = Math.max(width || 0, height || 0);
  if (!longest || !edge) return 1;
  return Math.min(1, edge / longest);
}

/**
 * Box-average downscale.
 *
 * Deliberately NOT `resample()` from render.js: that is bilinear, which reads
 * only four neighbours and therefore aliases badly below about half scale --
 * exactly the range a proxy lives in. Averaging the whole source box is the
 * correct filter for downscaling.
 *
 * Colour is weighted by alpha. Averaging RGB straight through would let fully
 * transparent pixels (whose RGB is arbitrary, often zero) drag the result
 * toward black, producing dark fringes around every soft edge.
 */
export function downscaleImage(img, scale) {
  if (!img || !img.width || !img.height) return null;
  if (scale >= 1) return img;

  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };

  const xRatio = img.width / w;
  const yRatio = img.height / h;

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(img.height, Math.max(sy0 + 1, Math.ceil((y + 1) * yRatio)));

    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(img.width, Math.max(sx0 + 1, Math.ceil((x + 1) * xRatio)));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const alpha = img.data[i + 3];
          r += img.data[i] * alpha;
          g += img.data[i + 1] * alpha;
          b += img.data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }

      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = r / a;
        out.data[o + 1] = g / a;
        out.data[o + 2] = b / a;
      }
      out.data[o + 3] = a / n;
    }
  }

  return out;
}
```

Add to `src/index.js`:

```js
export { proxyScaleFor, downscaleImage, DEFAULT_PROXY_EDGE } from './proxy.js';
```

Add to the `scripts` block of `package.json`:

```json
"test:proxy": "node --max-old-space-size=6144 test/proxy.mjs",
```

…and append `&& node --max-old-space-size=6144 test/proxy.mjs` to the existing `test` script so it runs in the suite.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: PASS — `8 passed`

Then run the whole suite to prove nothing regressed: `npm test`
Expected: `shim OK` → `21 files | parsed 21 | failed 0` → `<0.5% diff: 12   <10%: 5   >=10%: 4` → `20 passed` → `8 passed`

- [ ] **Step 5: Commit**

```bash
git add src/proxy.js src/index.js test/proxy.mjs package.json
git diff --staged
git commit -m "Add proxy scale and alpha-weighted box downscaling"
```

---

### Task 2: Let createProject accept proxy-only layers

**Files:**
- Modify: `src/edit.js:115`, `src/edit.js:58`
- Test: `test/proxy.mjs`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `createProject` accepts nodes carrying `proxyData` instead of `imageData`

This is the defect that makes streaming useless today: `reader.js` nulls `imageData` after `onLayer`, and `flatten()` then drops every raster layer.

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.mjs`, before the final `console.log`:

```js
import { createProject } from '../src/index.js';

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
```

Move the `createProject` name into the existing import at the top of the file rather than adding a second import statement.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: FAIL — `proxy-only layers must not be dropped` (`project.layers.length` is 0)

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, change the skip condition in `flatten()` (line 115):

```js
    if (!node.imageData && !node.proxyData && !node.text) continue; // nothing to draw or edit
```

And in `toLayer()` (line 58):

```js
    // Original decoded pixels — never mutated. A streamed load supplies a
    // downscaled proxy here instead; geometry below stays in document space
    // either way, so the renderer's `scale` handles the difference.
    pixels: source.proxyData || source.imageData || null,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: PASS — `10 passed`

Run: `npm test`
Expected: all suites still green, `20 passed` for the edit suite unchanged

- [ ] **Step 5: Commit**

```bash
git add src/edit.js test/proxy.mjs
git diff --staged
git commit -m "Accept proxy-only layers in createProject"
```

---

### Task 3: Record full-resolution source dimensions

**Files:**
- Modify: `src/edit.js:59-60`
- Test: `test/proxy.mjs`

**Interfaces:**
- Consumes: Task 2's `proxyData` support
- Produces: layer fields `sourceW`, `sourceH` (document-space, full resolution) and `proxyW`, `proxyH` (actual buffer dimensions)

`sourceW/sourceH` currently read `source.imageData?.width`. Under a proxy load that silently records *proxy* dimensions, and a later full-resolution export would size every layer wrong. They are only set and asserted today — nothing consumes them — so correcting the semantics is safe.

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.mjs`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: FAIL — `sourceW must survive proxying at full resolution` (it is 10, not 100)

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, replace lines 59-60:

```js
    // Full-resolution dimensions, always in document space. Under a proxy load
    // the buffer is smaller than this — export re-reads the file at full
    // resolution and needs the true size, so it must not be taken from `pixels`.
    sourceW: w,
    sourceH: h,
    /** Actual dimensions of whatever is in `pixels` — equal to sourceW/H on a full load. */
    proxyW: (source.proxyData || source.imageData)?.width ?? w,
    proxyH: (source.proxyData || source.imageData)?.height ?? h,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: PASS — `12 passed`

Run: `npm test`
Expected: still green. `test/edit.mjs:30-31` asserts `l.w === l.sourceW`, which now holds by construction.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js test/proxy.mjs
git diff --staged
git commit -m "Record full-resolution source dimensions alongside proxy dimensions"
```

---

### Task 4: Carry proxy scale and the source handle on the project

**Files:**
- Modify: `src/edit.js:130-137`
- Test: `test/proxy.mjs`

**Interfaces:**
- Consumes: Tasks 2–3
- Produces: `createProject(doc, fileName, options)` where `options = { proxyScale?: number, source?: {uri, name, size} | null }`; project gains `proxyScale` and `source`

Export re-reads the original file, so the project must remember where it came from and what scale its pixels are at.

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.mjs`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: FAIL — `project.proxyScale` is `undefined`

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, change the `createProject` signature and its return object:

```js
/**
 * @param {object} doc  Result of `readDocument()` — either `pixels: 'eager'`,
 *   or `pixels: 'stream'` with proxies stashed on each node as `proxyData`.
 * @param {string} fileName
 * @param {{proxyScale?: number, source?: {uri: string, name: string, size: number} | null}} [options]
 */
export function createProject(doc, fileName = 'untitled.psd', options = {}) {
  const { proxyScale = 1, source = null } = options;
  const warnings = new Set();
  const layers = flatten(doc.children, [], warnings);

  return {
    fileName,
    width: doc.width,
    height: doc.height,
    /** Scale of every layer's `pixels` relative to document space. 1 = full resolution. */
    proxyScale,
    /** Where the file came from, so a full-resolution export can re-read it. */
    source,
    layers,                       // index 0 = bottom, matching the file
    warnings: [...warnings],
    history: [],
    future: [],
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: PASS — `14 passed`

Run: `npm test`
Expected: green. The two-argument calls in `test/edit.mjs` are unaffected because `options` defaults.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js test/proxy.mjs
git diff --staged
git commit -m "Carry proxy scale and source handle on the project"
```

---

### Task 5: Memory budget and file-size guard

**Files:**
- Create: `src/budget.js`
- Modify: `src/index.js`
- Test: `test/proxy.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `memoryBudgetBytes(deviceMemoryGB) -> number`, `estimatePeakBytes({fileBytes, largestLayerBytes, proxyTotalBytes}) -> number`, `guardFileSize(fileBytes, budgetBytes) -> {ok: boolean, message: string | null}`, `HARD_FILE_CAP_BYTES`

An out-of-memory kill inside a WebView is a silent blank screen — the worst failure available. Refusing clearly is the feature.

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.mjs`:

```js
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
```

Add `estimatePeakBytes`, `memoryBudgetBytes`, `guardFileSize` and `HARD_FILE_CAP_BYTES` to the existing import at the top of `test/proxy.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: FAIL — `does not provide an export named 'memoryBudgetBytes'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/budget.js`:

```js
/**
 * Memory budgeting for PSD loads.
 *
 * Peak memory was measured against two synthetic documents and follows
 *
 *     peak = file bytes + one full-res layer + sum of proxy layers
 *
 * to within 1%. The file term dominates at 68-78%, and is irreducible during
 * decode because ag-psd's readPsd() requires one contiguous ArrayBuffer.
 * The practical ceiling is therefore set by file size.
 */

const MB = 1024 * 1024;

/** Nothing above this opens, however much memory the device claims. */
export const HARD_FILE_CAP_BYTES = 150 * MB;

/** Used when navigator.deviceMemory is unavailable, as on many Android WebViews. */
const ASSUMED_DEVICE_MEMORY_GB = 2;

/**
 * Share of total device memory we are willing to spend on one document.
 * Deliberately small: the WebView, the page and the OS all want their share,
 * and being killed is far worse than refusing.
 *
 * Peak is roughly 1.4x the file size, so 0.08 of RAM as a file budget costs
 * about 0.11 of RAM at peak. Anything above ~0.14 makes every device clamp to
 * HARD_FILE_CAP_BYTES, which would silently stop the budget scaling at all.
 */
const BUDGET_FRACTION = 0.08;

export function memoryBudgetBytes(deviceMemoryGB) {
  const gb = typeof deviceMemoryGB === 'number' && deviceMemoryGB > 0
    ? deviceMemoryGB
    : ASSUMED_DEVICE_MEMORY_GB;
  return Math.min(HARD_FILE_CAP_BYTES, Math.round(gb * 1024 * MB * BUDGET_FRACTION));
}

export function estimatePeakBytes({ fileBytes = 0, largestLayerBytes = 0, proxyTotalBytes = 0 }) {
  return fileBytes + largestLayerBytes + proxyTotalBytes;
}

export function guardFileSize(fileBytes, budgetBytes) {
  if (fileBytes <= budgetBytes) return { ok: true, message: null };
  const mb = (n) => Math.round(n / MB);
  return {
    ok: false,
    message:
      `This file is ${mb(fileBytes)} MB. This device can open PSDs up to ` +
      `${mb(budgetBytes)} MB — opening it would run out of memory.`,
  };
}
```

Add to `src/index.js`:

```js
export { memoryBudgetBytes, estimatePeakBytes, guardFileSize, HARD_FILE_CAP_BYTES } from './budget.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: PASS — `19 passed`

- [ ] **Step 5: Commit**

```bash
git add src/budget.js src/index.js test/proxy.mjs
git diff --staged
git commit -m "Add device memory budget and file-size guard"
```

---

### Task 6: Single-parse proxy load

**Files:**
- Modify: `src/reader.js:85`, `src/reader.js` stream branch
- Create: `src/load.js`
- Modify: `src/index.js`
- Test: `test/proxy.mjs`

**Interfaces:**
- Consumes: `proxyScaleFor`, `downscaleImage` (Task 1); `createProject` options (Task 4)
- Produces: `readDocument` option `onStart({width, height})`; `loadProjectProxy(bytes, {fileName, source, proxyEdge, onProgress}) -> Promise<project>`

Proxy scale depends on document dimensions, which are known only after parsing. Reading the file twice to learn them costs roughly 2.3× the time. An `onStart` hook fires after the structure parse and before layer decoding, so one parse suffices.

- [ ] **Step 1: Write the failing test**

Append to `test/proxy.mjs`:

```js
// `vectors.src.psd` is 1080x1080 with 4 pixel-bearing layers, so a small proxy
// edge forces real downscaling. Loaded at top level because `test` is sync.
const proxyProject = await loadProjectProxy(
  new Uint8Array(fs.readFileSync('fixtures/vectors.src.psd')),
  { fileName: 'vectors.src.psd', proxyEdge: 256, source: { uri: 'file:///vectors.src.psd', name: 'vectors.src.psd', size: 1 } },
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
```

Add near the top of `test/proxy.mjs`, after the imports:

```js
import fs from 'fs';
let progressCalls = 0;
```

…and pass `onProgress: () => { progressCalls++; }` in the `loadProjectProxy` options above. Add `loadProjectProxy` to the import from `../src/index.js`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: FAIL — `does not provide an export named 'loadProjectProxy'`

- [ ] **Step 3: Write the minimal implementation**

In `src/reader.js`, add `onStart` to the options destructuring on line 85:

```js
  const { pixels = 'none', onLayer, onStart, metadata: wantMetadata = true, embedded = false } = options;
```

In the stream branch, call it before the decode loop:

```js
  if (pixels === 'stream') {
    // Fires after the structure parse, before any layer is decoded, so a
    // caller can size its proxies without parsing the file a second time.
    if (typeof onStart === 'function') await onStart({ width: psd.width, height: psd.height });

    for (const layer of layers) {
```

Create `src/load.js`:

```js
/**
 * One-call proxy load: stream each layer, shrink it on arrival, drop the
 * full-resolution raster, and hand back an editable project.
 *
 * The caller should release the file bytes once this resolves. They are
 * 68-78% of peak memory and are not needed again until export, which re-reads
 * the file from `project.source.uri`.
 */
import { readDocument } from './reader.js';
import { proxyScaleFor, downscaleImage, DEFAULT_PROXY_EDGE } from './proxy.js';
import { createProject } from './edit.js';

/**
 * @param {Uint8Array} bytes
 * @param {{fileName?: string, source?: object|null, proxyEdge?: number,
 *          onProgress?: (decoded: number) => void}} [options]
 */
export async function loadProjectProxy(bytes, options = {}) {
  const {
    fileName = 'untitled.psd',
    source = null,
    proxyEdge = DEFAULT_PROXY_EDGE,
    onProgress,
  } = options;

  let scale = 1;
  let decoded = 0;

  const doc = await readDocument(bytes, {
    pixels: 'stream',
    metadata: false,
    onStart: ({ width, height }) => { scale = proxyScaleFor(width, height, proxyEdge); },
    onLayer: (node) => {
      // Stash the proxy on the node itself: `doc.children` holds these same
      // object references, so createProject sees it. The full raster is
      // released by the reader as soon as this returns.
      if (node.imageData) node.proxyData = downscaleImage(node.imageData, scale);
      decoded++;
      if (onProgress) onProgress(decoded);
    },
  });

  return createProject(doc, fileName, { proxyScale: scale, source });
}
```

Add to `src/index.js`:

```js
export { loadProjectProxy } from './load.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/proxy.mjs`
Expected: PASS — `25 passed`

Run: `npm test`
Expected: all suites green, including `test/shim.mjs` — `readDocument`, `decodeLayerPixels` and `getCompositeImageData` are already listed in `demo/shims/ag-psd.js` and no new `ag-psd` symbol was introduced.

- [ ] **Step 5: Commit**

```bash
git add src/reader.js src/load.js src/index.js test/proxy.mjs
git diff --staged
git commit -m "Add single-parse proxy load with onStart hook"
```

---

### Task 7: Minimal Ionic workspace

**Files:**
- Create: `app/` (Ionic Angular + Capacitor)
- Modify: `app/package.json` (declare `ag-psd`, `exifr` as direct dependencies)

**Interfaces:**
- Consumes: nothing
- Produces: an Angular app that can `import { loadProjectProxy } from '@engine/index.js'`

> **This task cannot be verified by `npm test`.** Per project rules the user runs the build. Step 4 hands verification over explicitly.

- [ ] **Step 1: Scaffold the app**

```bash
cd a:/test-rnd
npx @angular/cli@latest new app --style=scss --routing --skip-git --package-manager=npm --defaults
cd app
npm install @ionic/angular @capacitor/core @capacitor/cli @capacitor/filesystem @capacitor/share
npx cap init "PSD Editor" com.digitaaz.psdeditor --web-dir=dist/app/browser
npm install -D tailwindcss @tailwindcss/postcss postcss
```

- [ ] **Step 2: Wire Ionic (no root workspaces field)**

> **Amended 2026-08-25, post-Task-7 review:** this step originally added
> `"workspaces": ["app"]` to the root `package.json`, reasoning that
> without it the two `package.json` files would fight over a single
> lockfile. In practice `app/package-lock.json` was generated by Task 7's
> `ng new`/`npm install` before the field was ever activated by a root
> `npm install`, so the field delivered nothing it promised while
> continuing to invite the next ordinary `npm install` at the repo root to
> hoist the whole Angular/Ionic/Capacitor tree into the root `node_modules`
> that the six completed engine tasks depend on. Removed rather than
> activated — activating it would mean deleting `app/`'s lockfile and
> reconciling at the root, unverifiable here since this project forbids
> running the Angular build. **Do not add a `workspaces` field to the root
> `package.json`.** Instead, `app/` declares its own dependency on the
> engine's runtime packages directly (see below) — nested `node_modules`
> under `app/` is expected and fine.

`app/src/app/...` imports the engine at `../src`, and `src/reader.js`
imports `ag-psd` and (lazily) `exifr` directly — so `app/` is transitively
dependent on both. With no `workspaces` field, module resolution would
otherwise fall back to walking up the directory tree to the root
`node_modules` for these two packages: implicit, undeclared, and it would
break if `app/` ever moved. Declare them explicitly in `app/package.json`
and install them there too, at the same ranges the root `package.json`
uses:

```bash
cd a:/test-rnd/app
npm install ag-psd@^31.0.2 exifr@^7.1.3
```

Make the app genuinely an Ionic app — installing `@ionic/angular` is not
enough, its providers must be registered. In `app/src/app/app.config.ts`:

```ts
import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideIonicAngular(),
  ],
};
```

Add Ionic's stylesheets to `app/src/styles.scss`, above the Tailwind import:

```scss
@import "@ionic/angular/css/core.css";
@import "@ionic/angular/css/normalize.css";
@import "@ionic/angular/css/structure.css";
```

- [ ] **Step 3: Wire the engine path mapping**

In `app/tsconfig.json`, inside `compilerOptions`:

```json
"baseUrl": ".",
"paths": {
  "@engine/*": ["../src/*"]
},
"allowJs": true
```

`allowJs` is required — the engine is plain ESM JavaScript, not TypeScript.

- [ ] **Step 4: Allow the CommonJS dependency**

`ag-psd` ships no ESM build (`dist/index.js` and `dist-es/index.js` are byte-identical CommonJS), so Angular's bundler warns about an optimization bailout unless told this is expected. In `app/angular.json`, under `projects.app.architect.build.options`:

```json
"allowedCommonJsDependencies": ["ag-psd"]
```

Add Tailwind by creating `app/.postcssrc.json`:

```json
{ "plugins": { "@tailwindcss/postcss": {} } }
```

…and adding `@import "tailwindcss";` to `app/src/styles.scss`, **below** the
Ionic imports added in Step 2, so Tailwind's utilities win over Ionic's base
styles rather than the other way round.

- [ ] **Step 5: Hand verification to the user**

Do **not** run the build. Ask the user to run:

```bash
cd a:/test-rnd/app && npm run build
```

Expected: build completes with no `ag-psd` CommonJS warning and no unresolved `@engine/*` import. Report the exact output back before continuing.

If `@engine/*` fails to resolve across the workspace boundary, the spec's recorded fallback is a path-mapped local copy of `src/` inside `app/`.

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/angular.json app/tsconfig.json app/.postcssrc.json \
        app/src/styles.scss app/src/app/app.config.ts app/capacitor.config.ts package.json
git diff --staged
git commit -m "Scaffold minimal Ionic Angular workspace"
```

Do not stage `app/node_modules` — confirm `.gitignore` covers it before committing.

---

### Task 8: Decode worker and loader service

**Files:**
- Create: `app/src/app/workers/psd-decode.worker.ts`
- Create: `app/src/app/services/psd-loader.service.ts`

**Interfaces:**
- Consumes: `loadProjectProxy` (Task 6), `memoryBudgetBytes`/`guardFileSize` (Task 5)
- Produces: `PsdLoaderService.load(bytes: Uint8Array, fileName: string, uri: string) -> Promise<LoadResult>` where `LoadResult = {ok: true, project: object} | {ok: false, message: string}`

> **Not covered by `npm test`.** The logic it wraps is covered by Tasks 1–6; this task is plumbing, verified by Task 9's harness.

- [ ] **Step 1: Create the worker**

```bash
cd a:/test-rnd/app && npx ng generate web-worker app
```

Then replace `app/src/app/workers/psd-decode.worker.ts` with:

```ts
/// <reference lib="webworker" />
import { loadProjectProxy } from '@engine/load.js';

addEventListener('message', async ({ data }) => {
  const { bytes, fileName, source, proxyEdge } = data;
  try {
    const project = await loadProjectProxy(new Uint8Array(bytes), {
      fileName,
      source,
      proxyEdge,
      onProgress: (decoded: number) => postMessage({ type: 'progress', decoded }),
    });
    // Transfer the proxy buffers rather than copying them.
    const transfers = project.layers
      .filter((l: any) => l.pixels?.data?.buffer)
      .map((l: any) => l.pixels.data.buffer);
    postMessage({ type: 'done', project }, transfers);
  } catch (error: any) {
    postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
});
```

- [ ] **Step 2: Create the service**

Create `app/src/app/services/psd-loader.service.ts`:

```ts
import { Injectable, signal } from '@angular/core';
import { memoryBudgetBytes, guardFileSize } from '@engine/budget.js';

export type LoadResult =
  | { ok: true; project: any }
  | { ok: false; message: string };

@Injectable({ providedIn: 'root' })
export class PsdLoaderService {
  readonly progress = signal(0);

  load(bytes: Uint8Array, fileName: string, uri: string): Promise<LoadResult> {
    // navigator.deviceMemory is non-standard and absent on many WebViews;
    // memoryBudgetBytes falls back to a conservative default when undefined.
    const budget = memoryBudgetBytes((navigator as any).deviceMemory);
    const guard = guardFileSize(bytes.byteLength, budget);
    if (!guard.ok) return Promise.resolve({ ok: false, message: guard.message! });

    return new Promise<LoadResult>((resolve) => {
      const worker = new Worker(new URL('../workers/psd-decode.worker', import.meta.url));
      this.progress.set(0);

      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') { this.progress.set(data.decoded); return; }
        worker.terminate();
        resolve(data.type === 'done'
          ? { ok: true, project: data.project }
          : { ok: false, message: data.message });
      };

      worker.onerror = (e) => {
        worker.terminate();
        resolve({ ok: false, message: e.message || 'Decode worker failed' });
      };

      const source = { uri, name: fileName, size: bytes.byteLength };
      // Transfer the file bytes into the worker; the main thread must not keep
      // them, they are 68-78% of peak memory.
      worker.postMessage(
        { bytes: bytes.buffer, fileName, source, proxyEdge: 1024 },
        [bytes.buffer],
      );
    });
  }
}
```

- [ ] **Step 3: Hand verification to the user**

Ask the user to run `cd a:/test-rnd/app && npm run build` and report the output. Expected: builds clean; the worker is emitted as a separate chunk.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/workers/psd-decode.worker.ts app/src/app/services/psd-loader.service.ts app/tsconfig.worker.json app/angular.json
git diff --staged
git commit -m "Add PSD decode worker and loader service"
```

---

### Task 9: Harness page

**Files:**
- Create: `app/src/app/harness/harness.page.ts`
- Modify: `app/src/app/app.routes.ts`

**Interfaces:**
- Consumes: `PsdLoaderService` (Task 8), `renderProject` (existing)
- Produces: a route at `/harness` proving the pipeline end to end

Deliberately ugly. This is not Phase 0's UI; it exists to prove the definition of done.

- [ ] **Step 1: Create the page**

```ts
import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { PsdLoaderService } from '../services/psd-loader.service';
import { renderProject } from '@engine/render.js';

@Component({
  selector: 'app-harness',
  standalone: true,
  template: `
    <div class="p-4 space-y-4 font-mono text-sm">
      <input type="file" accept=".psd,.psb" (change)="onPick($event)" class="block" />

      @if (status()) { <p class="text-slate-600">{{ status() }}</p> }
      @if (error()) { <p class="text-red-600 font-bold">{{ error() }}</p> }

      @if (info()) {
        <pre class="bg-slate-100 p-3 overflow-x-auto">{{ info() }}</pre>
      }

      <canvas #cv class="border border-slate-300 max-w-full"></canvas>
    </div>
  `,
})
export class HarnessPage {
  private loader = inject(PsdLoaderService);

  /** Bound to the #cv template ref — never reach for document.querySelector here. */
  private cv = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');

  status = signal('');
  error = signal('');
  info = signal('');

  async onPick(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.error.set('');
    this.status.set(`reading ${file.name}…`);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const t0 = performance.now();
    const result = await this.loader.load(bytes, file.name, `file://${file.name}`);
    const ms = Math.round(performance.now() - t0);

    if (!result.ok) { this.error.set(result.message); this.status.set(''); return; }

    const project = result.project;
    this.status.set(`decoded in ${ms} ms`);
    this.info.set(JSON.stringify({
      canvas: `${project.width}x${project.height}`,
      layers: project.layers.length,
      proxyScale: +project.proxyScale.toFixed(4),
      warnings: project.warnings,
    }, null, 1));

    // Render at proxy scale: geometry is in document space, so this is what
    // draws the proxy pixels at their natural size.
    const buffer = renderProject(project, { scale: project.proxyScale });
    const canvas = this.cv().nativeElement;
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    canvas.getContext('2d')!.putImageData(
      new ImageData(buffer.data, buffer.width, buffer.height), 0, 0,
    );
  }
}
```

- [ ] **Step 2: Register the route**

In `app/src/app/app.routes.ts`:

```ts
import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: 'harness', loadComponent: () => import('./harness/harness.page').then((m) => m.HarnessPage) },
  { path: '', redirectTo: 'harness', pathMatch: 'full' },
];
```

- [ ] **Step 3: Hand verification to the user**

Ask the user to run `cd a:/test-rnd/app && npm start`, open `/harness`, and pick a PSD. Expected: the document renders, `proxyScale` is below 1 for any document larger than 1024px, and layer count matches the file. Ask them to confirm an oversized file produces the guard message rather than a blank screen.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/harness/harness.page.ts app/src/app/app.routes.ts
git diff --staged
git commit -m "Add proxy load harness page"
```

---

## What this plan does not cover

Deferred to **Plan 1B** (GPU compositor): WebGL2 compositing, the three-tier selection, sandwich caching for the JS fallback, the `OffscreenCanvas` abstraction that stops text vanishing in a worker, and the in-app conformance route.

Deferred to **Plan 1C** (export): full-resolution streaming export, spill-to-disk when layer order changed, and tiled compositing for `MAX_TEXTURE_SIZE`.

Both depend on this plan's `loadProjectProxy` and project shape.
