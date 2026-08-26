# Phase 1C-1 — The Streaming Export Walk

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every part of full-resolution export that a machine with no GPU, no device and no build can prove correct — layer identity, the fast/spill decision, the spill codec, the export walk itself, the JS composite target, the tile arithmetic, the dependency-free PNG writer, the launch sweep — and land the one app-side prerequisite the whole phase is blocked on: a `project.source.uri` that can actually be re-read.

**Architecture:** Editing happens against a 1024-edge proxy, so export cannot use the pixels the editor is holding — compositing them at `scale: 1` would produce a correctly-sized *blurred* image, the one failure shape that looks like success. Export therefore re-reads the file and streams full-resolution layers one at a time. `src/reader.js` stamps every leaf with a `sourceIndex`, which `src/edit.js` copies onto the layer, so arrivals can be matched to project layers by identity rather than by array position. `src/export/order.js` decides whether arrival order is already blend order (fast path) or whether some layers must be parked on disk (spill path), and computes the minimum spill set. `src/export/stream.js` drives the walk against three injected adapters — `readSource`, `spill`, `createTarget` — so the entire walk runs in Node against `fs` and a `Map`, and 1C-2 fills the GPU target in without touching it.

**Tech Stack:** Node 24 (ESM, `node:assert/strict`), `ag-psd` 31, Ionic 8 + Angular standalone + Capacitor 8, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-08-26-phase-1c-streaming-export-design.md`](../specs/2026-08-26-phase-1c-streaming-export-design.md)

---

## This is part 1 of 2

Phase 1C's spec is larger than one executable plan. As in 1B, it is split at the
line where verification changes hands:

| Plan | Covers | Verified by |
|---|---|---|
| **1C-1 — this document** | `sourceIndex`, `wantLayer`, pattern-scan suppression, export order and spill planning, the spill codec, the export walk, the JS composite target, the reordered oracle, tile arithmetic, the JS PNG writer, the launch sweep, base64 chunking — and copy-at-load so a real source URI exists | `npm test` (Tasks 1–13) and the user's build + device (Task 14) |
| 1C-2 — *not yet written* | `createGpuExportTarget` (tiled compositing, `texSubImage2D` sub-rect uploads, per-tile readback), the Capacitor spill adapter, the export worker, the progress/cancel UI, chunked `Filesystem` write + `Share`, the sweep wired to app launch, the conformance route's export column | a real device, only |

The split is not a scope cut. Every requirement in the spec lands in one of the
two plans, and 1C-1 leaves 1C-2 **named, typed slots** rather than gaps — most
visibly `exportFullRes`'s `createTarget` parameter, which 1C-2 fills with the
GPU target and which 1C-1 already exercises end to end through the JS one.

1C-1 ships something real on its own: the prerequisite that blocks the entire
phase (a re-readable source URI) lands and is proven by a round-trip readback in
the harness, and the export walk becomes a green Node suite that asserts
**pixel-equality against `renderProject(eagerProject, { scale: 1 })` with layers
reordered** — the first bullet of the spec's definition of done.

---

## Deviations from the spec, and why

Six, all found by reading the code and the fixtures the spec describes. Each is
implemented the corrected way; the spec's text is otherwise binding.

1. **The spec's two spill examples are the wrong way round.** It says *"Moving one
   layer from the top of the stack to the bottom spills one layer, not six"* and
   *"Moving one from the bottom to the top spills the layers it jumped."* Simulate
   it: arrival order is ascending `sourceIndex`, which is the file's bottom-to-top
   order. Moving the **top** layer to the bottom makes the *last* arrival the
   *first* thing needed, so everything that arrives before it spills — five of six.
   Moving the **bottom** layer to the top makes the *first* arrival the *last*
   thing needed, so exactly one spills. The algorithm the spec describes is right;
   only the illustration is inverted. Task 4 asserts both directions with the real
   numbers so the mistake cannot survive.

2. **No fixture has a mid-stack pixel-less leaf, so the misalignment test must be
   synthetic.** Every one of the 21 fixtures was checked. Three have leaves that
   `flatten()` drops — `adjustments.src.psd` (17 leaves → 1 layer),
   `masks.src.psd` (3 → 1), `float-color.src.psd` (3 → 2) — but in all three the
   dropped leaves are **trailing**, where positional matching still happens to
   work. Do not spend time hunting for a fixture that discriminates; there isn't
   one. Task 1 builds the gap document by hand, exactly as `test/proxy.mjs`
   already builds `streamedDoc()`.

3. **`drawLayerInto` gains an options bag rather than export duplicating the rect
   math.** Same reasoning as 1B's deviation 4: the alternative is a second copy of
   the text-versus-resample branch in `src/export/`, which is precisely how text
   ends up going through `resample()`. The change is behaviour-preserving for
   `renderProject`, and Task 6 proves it.

4. **When export supplies pixels, `layer.pixels` must never be a fallback.** The
   options bag is read with `'pixels' in options`, not `options.pixels ||`. Under
   a proxy load `layer.pixels` is a 1024-edge thumbnail; a `||` fallback would
   blend it at `scale: 1` and produce a full-size blurred layer — the exact
   failure this phase exists to prevent, and one that no assertion on dimensions
   would catch because the *output* is the right size. Task 6 has a test that
   fails loudly if the fallback is reintroduced.

5. **No new picker plugin.** The spec's prerequisite table proposes a native file
   picker. `<input type="file">` already works inside the Capacitor WebView and is
   already in `harness.page.ts`; what is missing is not the picker but the *copy*.
   Task 14 copies the picked bytes into `Directory.Data` through the already
   installed `@capacitor/filesystem`, which is what actually buys a URI that
   survives a process restart with no SAF permission model. Zero new
   dependencies, and the spec's recommended mechanism (copy at load) is honoured
   exactly.

6. **Pattern-scan suppression is a new `patterns` option, not a side effect of
   `metadata: false`.** `containsKey` runs unconditionally today
   (`src/reader.js:153`) — outside the metadata branch — so `loadProjectProxy`,
   which already passes `metadata: false`, still surfaces the pattern warning at
   load. Folding the scan into `metadata` would silently delete a real warning
   from the load path. Export passes `patterns: false` explicitly instead.

---

## Global Constraints

- **Engine code is plain ESM JavaScript in `src/`** — no TypeScript, no framework imports. It is consumed by Node tests, the existing `demo/` pages, and the Angular app alike. `src/export/` never imports Capacitor; it takes `readSource`, `spill` and `createTarget` as arguments.
- **Do not run build commands.** Per project rules, the user builds and verifies. Task 14 hands verification over explicitly.
- **Never route text through `resample()`.** Text is vector; it must be drawn at final size (HANDOFF Failed Approach 5). A self-rendered text layer is rasterised at exactly `rect.width × rect.height`, so `resample()`'s identity early-return (`src/render.js:20`) is the only thing it ever meets — do not "simplify" that by calling `resample` on it deliberately.
- **Invalidate `renderedKey`, never `rendered` alone** — a stale key returns `null` and the layer disappears (HANDOFF Failed Approach 6).
- **Layer geometry stays in document coordinates.** `x/y/w/h` are full-resolution document space; `scale` is what draws the proxy. Export draws at `scale: 1` with the same numbers the preview used at `proxyScale`. That is the entire reason transforms are non-destructive — nothing was ever baked into the proxy pixels. Nothing in this plan changes that.
- **Comparison tolerance is 1**, via `stat.percentReal`, never `stat.percent` (HANDOFF Failed Approach 8). `flattenOnto()` both buffers before comparing (Failed Approach 7).
- **Stage exact files.** Never `git add .` or `git add <dir>`; read `git diff --staged` before every commit.
- **`toLayer()` is edited by two phases.** This plan adds `sourceIndex` to `src/edit.js:toLayer()`. The Phase 2 spec adds `mask`, `clipping` and `groupPath` to the **same function**. Whoever executes second must re-read the current `toLayer()` and add their fields alongside what is already there — not paste a remembered version of the object literal. The same warning applies to `flatten()`'s skip condition (`src/edit.js:136`), which Phase 2 also touches.
- **`app/src/app/harness/harness.page.ts` is edited by two plans.** Plan 1B-1's Tasks 9 and 10 add a capability readout and drag handling to the same file. At the time this plan was written those had not landed. Task 14 must re-read the file and add to it, never overwrite it.
- **`test/shim.mjs` now walks `src/` recursively**, so `src/export/` is inside the guard. Nothing in this plan imports `ag-psd` directly — `src/export/stream.js` goes through `src/reader.js` — so the shim stays green. If that ever changes, add the symbol to `demo/shims/ag-psd.js` in the same commit.
- **A green `npm test` proves the export *walk*.** It says nothing about the GPU target, any Capacitor call, cancellation timing on a device, or the iOS canvas area cap. Do not report a mocked test as if it settled those.
- Test scripts run with `--max-old-space-size=6144` where they load fixtures.
- Branch: `phase-1-engine-gpu-memory`. Do not push without explicit approval.

**Expected baseline before Task 1.** Run `npm test` and confirm these five markers
appear, in this order:

```
shim OK
21 files | parsed 21 | failed 0
21 files  |  <0.5% diff: 12   <10%: 5   >=10%: 4   skipped: 0
21 passed          <- test/edit.mjs
28 passed          <- test/proxy.mjs
53 passed          <- test/gpu.mjs
```

If any of those differs, stop and report it before starting — every "Expected"
below is written against this baseline.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/export/errors.js` | `ExportError` with a machine-readable `code`. Nothing else. |
| `src/export/order.js` | Blend order, layer identity, the fast-path test, and the minimum spill plan. Pure. |
| `src/export/spill.js` | The 16-byte spill header, encode/decode with truncation detection, and an in-memory adapter for tests. |
| `src/export/progress.js` | The phase weight table and `phaseFraction`. Pure arithmetic. |
| `src/export/target-js.js` | `ExportTarget` over `createBuffer` + `drawLayerInto`. The JS fallback tier. |
| `src/export/stream.js` | `exportFullRes` — the walk. Integrity checks, fast/spill, drain, cancellation, cleanup. |
| `src/export/tiles.js` | Tile-edge selection and canvas partition arithmetic. Pure; consumed by 1C-2. |
| `src/export/png.js` | Dependency-free PNG writer using stored deflate blocks, plus the canvas-area cap. |
| `src/export/sweep.js` | Spill directory naming and the launch sweep, over an injected filesystem. |
| `src/export/chunks.js` | Bridge chunk ranges and a portable base64 encoder. |
| `test/export.mjs` | Suite for all of the above. |
| `app/src/app/services/source-store.service.ts` | Copy-at-load and re-read. The only Capacitor code in the phase so far. |

**Modified:**

| File | Change |
|---|---|
| `src/reader.js` | Stamp `layer.sourceIndex`; add `wantLayer` and `patterns` options |
| `src/edit.js` | `toLayer()` carries `sourceIndex` onto the layer |
| `src/render.js` | `drawLayerInto` takes `{ pixels, onMissing }` |
| `src/index.js` | Export the new modules |
| `package.json` | `test:export` script |
| `app/src/app/services/psd-loader.service.ts` | Take a source object instead of a synthetic URI string |
| `app/src/app/harness/harness.page.ts` | Copy at load; report the re-read round trip |

---

### Task 1: Layer identity — `sourceIndex` at decode and on the project layer

**Files:**
- Modify: `src/reader.js`, `src/edit.js`
- Create: `test/export.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: every leaf node streamed by `readDocument` carries `sourceIndex: number`; every project layer carries `sourceIndex: number | null`

`src/reader.js` streams **every** leaf. `src/edit.js:flatten()` additionally drops
any leaf with neither `imageData`, `proxyData` nor `text` (`src/edit.js:136`). The
two walks agree on order but not on membership, so matching arrivals to project
layers by array position misaligns everything after the first gap — every layer
after it would blend with the wrong geometry, opacity and blend mode, and the
result would look like a plausible image. This is the identity that makes the
rest of the phase possible.

- [ ] **Step 1: Write the failing tests**

Create `test/export.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'fs';
import { createProject, loadProjectProxy, readDocument } from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};
/** Async sibling of `test`. Every call site must `await` it, or failures escape. */
const atest = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const bytesOf = (path) => new Uint8Array(fs.readFileSync(path));
const img = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

console.log('\nlayer identity\n');

/**
 * A document shaped like one that has been streamed, with a pixel-less leaf in
 * the MIDDLE. No fixture has one — all 21 were checked, and the three with
 * dropped leaves drop only trailing ones, where positional matching still works
 * by accident. This is the only shape that discriminates.
 */
const gapDoc = () => ({
  width: 40, height: 10,
  children: [
    { name: 'bottom', left: 0,  top: 0, right: 10, bottom: 10, sourceIndex: 0, proxyData: img(2, 2) },
    { name: 'empty',  left: 0,  top: 0, right: 10, bottom: 10, sourceIndex: 1 },
    { name: 'top',    left: 10, top: 0, right: 20, bottom: 10, sourceIndex: 2, proxyData: img(2, 2) },
  ],
});

test('a pixel-less leaf keeps its slot, so the layer above it is index 2, not 1', () => {
  const project = createProject(gapDoc(), 'gap.psd');
  assert.equal(project.layers.length, 2, 'the empty leaf must still be dropped');
  assert.deepEqual(project.layers.map((l) => l.sourceIndex), [0, 2],
    'positional matching would say [0, 1] and blend the top layer with the wrong geometry');
});

test('a layer with no sourceIndex reports null, not undefined or 0', () => {
  const project = createProject({
    width: 10, height: 10,
    children: [{ name: 'eager', left: 0, top: 0, right: 10, bottom: 10, imageData: img(10, 10) }],
  }, 'eager.psd');
  assert.equal(project.layers[0].sourceIndex, null,
    'an eager read never streams, so there is no identity to carry — export must be able to tell');
});

const streamed = [];
await readDocument(bytesOf('fixtures/float-color.src.psd'), {
  pixels: 'stream', metadata: false,
  onLayer: (node) => { streamed.push(node.sourceIndex); if (node.imageData) node.proxyData = node.imageData; },
});

test('the reader stamps every leaf it streams, in order, starting at zero', () => {
  assert.deepEqual(streamed, [0, 1, 2], 'float-color.src.psd has three leaf nodes');
});

const floatColour = await loadProjectProxy(bytesOf('fixtures/float-color.src.psd'), {
  fileName: 'float-color.src.psd', proxyEdge: 128,
});

test('a streamed load carries the stamp all the way onto the project layer', () => {
  assert.equal(floatColour.layers.length, 2, 'one of the three leaves has no pixels and no text');
  for (const layer of floatColour.layers)
    assert.equal(typeof layer.sourceIndex, 'number', `layer "${layer.name}" lost its identity`);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
```

Add to the `scripts` block of `package.json`:

```json
"test:export": "node --max-old-space-size=6144 test/export.mjs",
```

…and append ` && node --max-old-space-size=6144 test/export.mjs` to the existing
`test` script so it runs in the suite.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `positional matching would say [0, 1] …` (`sourceIndex` is `undefined` on both layers, so the deep-equal reports `[undefined, undefined]`).

- [ ] **Step 3: Write the minimal implementation**

In `src/reader.js`, inside the `pixels === 'stream'` branch, add the counter above
the loop and stamp before the decode:

```js
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
      decodeLayerPixels(layer, true);
```

In `src/edit.js:toLayer()`, add the field to the layer literal, immediately after
`proxyH`:

```js
    /**
     * This layer's position among the file's leaf nodes, stamped by reader.js
     * during a streamed read. Full-resolution export matches arriving layers to
     * project layers on this and nothing else -- array position is wrong,
     * because flatten() below drops pixel-less leaves. `null` after an eager
     * read, which never streams and therefore has nothing to match.
     */
    sourceIndex: source.sourceIndex ?? null,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `4 passed`

Run: `npm test`
Expected: the five baseline markers unchanged, plus `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/reader.js src/edit.js test/export.mjs package.json
git diff --staged
git commit -m "Give streamed layers a stable sourceIndex identity"
```

---

### Task 2: `wantLayer` — never decode a layer export will not draw

**Files:**
- Modify: `src/reader.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: Task 1's `sourceIndex`
- Produces: `readDocument` option `wantLayer(layer, sourceIndex) -> boolean`

Hidden and zero-opacity layers are pure waste on the export critical path — a
full decode and, on the spill path, a full disk write for pixels nobody draws.
The trap: **the counter must still advance for a skipped layer**, or every
`sourceIndex` after it shifts and the alignment Task 1 just bought is gone.

- [ ] **Step 1: Write the failing test**

Append to `test/export.mjs`, before the final `console.log`:

```js
console.log('\nselective decode\n');

const wantSeen = [];
const wantDecoded = [];
await readDocument(bytesOf('fixtures/shapes.src.psd'), {
  pixels: 'stream', metadata: false,
  wantLayer: (_layer, index) => index % 2 === 0,
  onLayer: (node) => {
    wantSeen.push(node.sourceIndex);
    wantDecoded.push(Boolean(node.imageData));
  },
});

test('wantLayer keeps onLayer from firing for layers the caller refused', () => {
  assert.deepEqual(wantSeen, [0, 2, 4, 6], 'shapes.src.psd has eight leaves; four were wanted');
});

test('a skipped layer still consumes its index, so nothing after it shifts', () => {
  // If the counter advanced only for decoded layers the indices would read
  // [0, 1, 2, 3] and every later layer would be matched to the wrong file layer.
  assert.equal(Math.max(...wantSeen), 6);
});

test('the layers that did arrive really were decoded', () => {
  assert.deepEqual(wantDecoded, [true, true, true, true]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `shapes.src.psd has eight leaves; four were wanted` (all eight arrive, because `wantLayer` is ignored).

- [ ] **Step 3: Write the minimal implementation**

In `src/reader.js`, add `wantLayer` to the options destructuring (line 88):

```js
  const { pixels = 'none', onLayer, onStart, wantLayer, metadata: wantMetadata = true, embedded = false } = options;
```

Add it to the JSDoc above `readDocument`, after the `onStart` entry:

```js
 * @param {(layer: object, sourceIndex: number) => boolean} [options.wantLayer]
 *   `pixels: 'stream'` only. Return false to skip the decode entirely. The
 *   sourceIndex counter still advances for a skipped layer, so refusing one
 *   does not shift the identity of any layer after it.
```

And in the stream loop, immediately after the stamp:

```js
      layer.sourceIndex = sourceIndex++;
      // Skip the decode for layers the caller will not use. The counter above
      // has already advanced, which is the whole point -- a skipped layer must
      // not renumber the ones after it.
      if (typeof wantLayer === 'function' && !wantLayer(layer, layer.sourceIndex)) continue;
      decodeLayerPixels(layer, true);
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `7 passed`

Run: `npm test`
Expected: baseline unchanged, `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/reader.js test/export.mjs
git diff --staged
git commit -m "Let readDocument skip layers the caller will not use"
```

---

### Task 3: Keep three full byte-scans off the export critical path

**Files:**
- Modify: `src/reader.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `readDocument` option `patterns: boolean` (default `true`)

`containsKey` makes three naive O(n·m) passes over the **whole file** looking for
`Patt`/`Pat2`/`Pat3` (`src/reader.js:153`), and it runs unconditionally — even
under `metadata: false`. On a 303 MB file that is three full passes after decode
has already finished, on the export path, for a warning the user was already
shown at load. Already recorded in `docs/BACKLOG.md` under *Engine*.

Suppression must be its **own** option: `loadProjectProxy` passes
`metadata: false` today and still gets the warning, so folding the scan into the
metadata flag would silently delete it from the load path.

- [ ] **Step 1: Write the failing test**

Append to `test/export.mjs`:

```js
const withPatterns = await readDocument(bytesOf('fixtures/vectors.src.psd'), {
  pixels: 'none', metadata: false,
});
const withoutPatterns = await readDocument(bytesOf('fixtures/vectors.src.psd'), {
  pixels: 'none', metadata: false, patterns: false,
});
const isPatternWarning = (w) => /Pattern definitions/.test(w);

test('the pattern warning still fires by default, even under metadata: false', () => {
  assert.ok(withPatterns.warnings.some(isPatternWarning),
    'load must keep surfacing this -- the export path is the only caller that should opt out');
});

test('patterns: false skips the three whole-file byte scans', () => {
  assert.ok(!withoutPatterns.warnings.some(isPatternWarning));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `patterns: false skips the three whole-file byte scans` (the option is ignored, so the warning is still there).

- [ ] **Step 3: Write the minimal implementation**

In `src/reader.js`, add `patterns` to the options destructuring:

```js
  const { pixels = 'none', onLayer, onStart, wantLayer, metadata: wantMetadata = true, embedded = false, patterns = true } = options;
```

Add to the JSDoc, after the `metadata` entry:

```js
 * @param {boolean} [options.patterns=true]
 *   Scan the whole file three times for pattern definitions. Only drives a
 *   warning. Full-resolution export passes false: the warning was already
 *   surfaced when the document was opened, and three O(n) passes over a
 *   300 MB file is not free on a phone.
```

And guard the scan at line 153:

```js
  if (patterns && PATTERN_KEYS.some((key) => containsKey(bytes, key)))
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `9 passed`

Run: `npm test`
Expected: baseline unchanged — `test/run.mjs` still reports `files with warnings: 21/21`, because nothing else passes `patterns: false`.

- [ ] **Step 5: Commit**

```bash
git add src/reader.js test/export.mjs
git diff --staged
git commit -m "Add a patterns option so export can skip the Patt byte scans"
```

---

### Task 4: Export order, the fast-path test, and the minimum spill plan

**Files:**
- Create: `src/export/errors.js`, `src/export/order.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: Task 1's `layer.sourceIndex`
- Produces:
  - `ExportError extends Error` with `code: string`
  - `isSelfRendering(layer) -> boolean`
  - `buildExportOrder(project) -> object[]` — visible, non-zero-opacity layers, bottom to top
  - `wantedIndices(order) -> Set<number>`
  - `assertIdentifiable(order) -> void` — throws `ExportError('NO_IDENTITY')`
  - `isFastPath(order) -> boolean`
  - `planSpill(order) -> { spill: number[], fastPath: boolean }`

`planSpill` is a pure simulation of the walk Task 8 performs for real. It exists
so the "spill only what you must" rule is asserted as arithmetic before any I/O
is involved, and so Task 9 can prove the runtime walk spilled **exactly** what
the plan predicted — which is what stops the two drifting apart.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\nexport order and spill planning\n');

/** A stand-in project: only the fields buildExportOrder and planSpill read. */
const orderOf = (...specs) => specs.map((s, i) => ({
  id: i + 1,
  name: s.name ?? `layer ${i}`,
  kind: s.kind ?? 'raster',
  visible: s.visible ?? true,
  opacity: s.opacity ?? 1,
  rerendered: s.rerendered ?? false,
  sourceIndex: s.sourceIndex,
}));
const projectOf = (...specs) => ({ width: 10, height: 10, layers: orderOf(...specs) });

test('the order is bottom to top, minus the invisible and the zero-opacity', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 },
    { sourceIndex: 1, visible: false },
    { sourceIndex: 2, opacity: 0 },
    { sourceIndex: 3 },
  ));
  assert.deepEqual(order.map((l) => l.sourceIndex), [0, 3]);
});

test('a hidden layer is not wanted from the stream at all', () => {
  const order = buildExportOrder(projectOf({ sourceIndex: 0 }, { sourceIndex: 1, visible: false }));
  assert.deepEqual([...wantedIndices(order)], [0]);
});

test('a re-rendered text layer draws itself and is never awaited from the file', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 },
    { sourceIndex: 1, kind: 'text', rerendered: true },
  ));
  assert.equal(isSelfRendering(order[1]), true);
  assert.deepEqual([...wantedIndices(order)], [0], 'index 1 must not be requested from the stream');
});

test('an UNTOUCHED Photoshop text layer is a raster and IS awaited from the file', () => {
  // render.js gates the sharp path on `rerendered`, which starts false. At
  // proxy scale that is harmless; at scale 1 it would upscale a 1024-edge
  // raster. Export must stream its full-resolution pixels like any other layer.
  const order = buildExportOrder(projectOf({ sourceIndex: 0, kind: 'text', rerendered: false }));
  assert.equal(isSelfRendering(order[0]), false);
  assert.deepEqual([...wantedIndices(order)], [0]);
});

test('a layer with no identity is refused before a single byte is read', () => {
  const order = buildExportOrder(projectOf({ sourceIndex: null, name: 'orphan' }));
  assert.throws(() => assertIdentifiable(order), (e) => e.code === 'NO_IDENTITY' && /orphan/.test(e.message));
});

test('untouched order is the fast path and spills nothing', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0 }, { sourceIndex: 1 }, { sourceIndex: 2 }, { sourceIndex: 3 },
  ));
  assert.equal(isFastPath(order), true);
  assert.deepEqual(planSpill(order).spill, []);
});

test('moving the BOTTOM layer to the top spills exactly one', () => {
  // order = [1, 2, 3, 0]. Arrival 0 comes first and is needed last, so it parks;
  // 1, 2, 3 then arrive in the order they are needed and never touch disk.
  const order = buildExportOrder(projectOf(
    { sourceIndex: 1 }, { sourceIndex: 2 }, { sourceIndex: 3 }, { sourceIndex: 0 },
  ));
  assert.equal(isFastPath(order), false);
  assert.deepEqual(planSpill(order).spill, [0]);
});

test('moving the TOP layer to the bottom spills all but one', () => {
  // order = [3, 0, 1, 2]. The first thing needed is the LAST thing to arrive,
  // so everything before it parks. The spec's prose has these two cases the
  // wrong way round; the arithmetic here is what the walk actually does.
  const order = buildExportOrder(projectOf(
    { sourceIndex: 3 }, { sourceIndex: 0 }, { sourceIndex: 1 }, { sourceIndex: 2 },
  ));
  assert.deepEqual(planSpill(order).spill, [0, 1, 2]);
});

test('a full reversal is the worst case and still spills only n-1', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 3 }, { sourceIndex: 2 }, { sourceIndex: 1 }, { sourceIndex: 0 },
  ));
  assert.deepEqual(planSpill(order).spill, [0, 1, 2]);
});

test('a self-rendering layer at the bottom is satisfied before the first arrival', () => {
  const order = buildExportOrder(projectOf(
    { sourceIndex: 0, kind: 'text', rerendered: true },
    { sourceIndex: 1 }, { sourceIndex: 2 },
  ));
  assert.deepEqual(planSpill(order).spill, [], 'nothing needs parking -- the text draws itself first');
});

test('isFastPath and planSpill never disagree', () => {
  const cases = [[0, 1, 2], [2, 0, 1], [1, 0, 2], [0, 2, 1], [2, 1, 0], [0, 1, 2, 3], [3, 0, 1, 2]];
  for (const indices of cases) {
    const order = buildExportOrder(projectOf(...indices.map((sourceIndex) => ({ sourceIndex }))));
    assert.equal(isFastPath(order), planSpill(order).spill.length === 0,
      `disagreement on ${JSON.stringify(indices)} -- the walk would take one path and the plan predict the other`);
  }
});
```

Add `buildExportOrder`, `wantedIndices`, `assertIdentifiable`, `isFastPath`,
`planSpill`, `isSelfRendering` and `ExportError` to the existing import at the
top of `test/export.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/index.js' does not provide an export named 'buildExportOrder'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/errors.js`:

```js
/**
 * One error type for the whole export path, carrying a machine-readable code.
 *
 * Export has several distinguishable failure modes -- a changed source file, a
 * truncated spill, a vanished text layer, a cancellation -- and the UI needs to
 * tell them apart to say something useful. A bare Error with a prose message
 * forces the caller to match on strings.
 */
export class ExportError extends Error {
  /**
   * @param {string} message  Shown to the user. Name the layer or the file.
   * @param {string} code     One of: CANCELLED, SOURCE_CHANGED, SOURCE_MISMATCH,
   *   NO_IDENTITY, TEXT_MISSING, SPILL_CORRUPT, SPILL_TRUNCATED, SPILL_MISSING,
   *   INCOMPLETE.
   */
  constructor(message, code) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}
```

Create `src/export/order.js`:

```js
/**
 * Export ordering.
 *
 * Two orders exist and they are not the same one:
 *
 *   arrival order -- the file's leaf nodes, ascending `sourceIndex`
 *   blend order   -- `project.layers`, bottom to top, after any reorder
 *
 * When they agree, export blends each layer as it streams and nothing touches
 * disk. When they do not, some layers arrive before they are needed and have to
 * be parked. This module decides which, and how few.
 */
import { ExportError } from './errors.js';

/**
 * A retyped or restyled text layer draws itself at the final size, so it is
 * never awaited from the file and never spilled -- it is generated in place.
 *
 * An UNTOUCHED Photoshop text layer is deliberately NOT self-rendering:
 * render.js gates the sharp path on `rerendered`, which starts false, so it is
 * a raster and its full-resolution pixels must come from the file like any
 * other layer's.
 */
export function isSelfRendering(layer) {
  return layer.kind === 'text' && layer.rerendered === true;
}

/** The layers export will actually draw, bottom to top. */
export function buildExportOrder(project) {
  return project.layers.filter((layer) => layer.visible && layer.opacity > 0);
}

/** The sourceIndex values the stream has to decode. Hidden layers are absent. */
export function wantedIndices(order) {
  const wanted = new Set();
  for (const layer of order)
    if (!isSelfRendering(layer) && typeof layer.sourceIndex === 'number')
      wanted.add(layer.sourceIndex);
  return wanted;
}

/**
 * Refuse an export that could not possibly finish, before reading the file.
 * A layer with no identity can never be matched to an arrival, so the drain
 * would stall forever waiting for something that will not come.
 */
export function assertIdentifiable(order) {
  for (const layer of order) {
    if (isSelfRendering(layer)) continue;
    if (typeof layer.sourceIndex !== 'number')
      throw new ExportError(
        `Layer "${layer.name}" has no sourceIndex, so export cannot match it back to the file. ` +
        `This project was not opened with a streamed read.`,
        'NO_IDENTITY',
      );
  }
}

/** True when arrival order is already blend order, so nothing needs parking. */
export function isFastPath(order) {
  let last = -1;
  for (const layer of order) {
    if (isSelfRendering(layer)) continue;
    if (layer.sourceIndex <= last) return false;
    last = layer.sourceIndex;
  }
  return true;
}

/**
 * Simulate the walk and report which layers have to go to disk.
 *
 * Deliberately NOT "spill everything when the order changed". Moving the bottom
 * layer to the top parks one layer; moving the top layer to the bottom parks
 * all but one. Both are strictly better than parking the whole stack, and the
 * common reorder is the cheap one.
 *
 * The loop below is the same state machine stream.js runs against real I/O.
 * Task 9 asserts the two produce identical spill sets, which is what keeps them
 * from drifting.
 */
export function planSpill(order) {
  const arrivals = [...wantedIndices(order)].sort((a, b) => a - b);
  const parked = new Set();
  const spill = [];
  let need = 0;

  const drain = () => {
    while (need < order.length) {
      const layer = order[need];
      if (isSelfRendering(layer)) { need++; continue; }
      if (!parked.has(layer.sourceIndex)) break;
      parked.delete(layer.sourceIndex);
      need++;
    }
  };

  drain();
  for (const index of arrivals) {
    const next = order[need];
    if (next && !isSelfRendering(next) && next.sourceIndex === index) { need++; drain(); }
    else { parked.add(index); spill.push(index); }
  }

  return { spill, fastPath: spill.length === 0 };
}
```

Add to `src/index.js`:

```js
export { ExportError } from './export/errors.js';
export {
  isSelfRendering, buildExportOrder, wantedIndices, assertIdentifiable, isFastPath, planSpill,
} from './export/order.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `20 passed`

Run: `npm test`
Expected: baseline unchanged, `20 passed`. `shim OK` still holds — `src/export/` imports no `ag-psd` symbol.

- [ ] **Step 5: Commit**

```bash
git add src/export/errors.js src/export/order.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add export ordering and the minimum spill plan"
```

---

### Task 5: The spill codec and an in-memory adapter

**Files:**
- Create: `src/export/spill.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: `ExportError` (Task 4)
- Produces:
  - `SPILL_MAGIC`, `SPILL_VERSION`, `SPILL_HEADER_BYTES`
  - `spillHeader(width, height) -> Uint8Array` (16 bytes)
  - `encodeSpill(image) -> Uint8Array` — header + pixels, **allocates a copy**
  - `decodeSpill(bytes) -> {width, height, data: Uint8ClampedArray}` — a view, no copy
  - `createMemorySpill() -> SpillAdapter & { files: Map, writes: string[] }`
  - `SpillAdapter = { write(name, chunks), read(name), remove(name), dispose() }`, all async

The header makes a spill file self-describing, so a truncated write — a full
disk, most likely — is **caught** rather than blended as garbage geometry.

`spillHeader` and `encodeSpill` are separate on purpose. `encodeSpill` copies, so
at 66 MB it doubles the resident layer; the native adapter must write
`[spillHeader(w, h), image.data]` as two chunks and never call it.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\nspill codec\n');

const filled = (w, h, seed) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + seed) & 0xff;
  return { width: w, height: h, data };
};

test('a spill round-trips its dimensions and every byte', () => {
  const source = filled(5, 3, 11);
  const out = decodeSpill(encodeSpill(source));
  assert.equal(out.width, 5);
  assert.equal(out.height, 3);
  assert.deepEqual([...out.data], [...source.data]);
});

test('the header is sixteen bytes and starts with PSDX', () => {
  const header = spillHeader(5, 3);
  assert.equal(header.length, SPILL_HEADER_BYTES);
  assert.deepEqual([...header.subarray(0, 4)], [0x50, 0x53, 0x44, 0x58]);
});

test('a truncated spill raises instead of blending', () => {
  const bytes = encodeSpill(filled(5, 3, 2));
  assert.throws(() => decodeSpill(bytes.subarray(0, bytes.length - 4)),
    (e) => e.code === 'SPILL_TRUNCATED' && /truncated/.test(e.message));
});

test('a file that is not a spill raises instead of being read as one', () => {
  const bytes = encodeSpill(filled(2, 2, 0));
  bytes[0] = 0x51;
  assert.throws(() => decodeSpill(bytes), (e) => e.code === 'SPILL_CORRUPT');
});

test('a future spill version raises rather than being misread', () => {
  const bytes = encodeSpill(filled(2, 2, 0));
  bytes[4] = SPILL_VERSION + 1;
  assert.throws(() => decodeSpill(bytes), (e) => e.code === 'SPILL_CORRUPT');
});

test('a header shorter than sixteen bytes raises', () => {
  assert.throws(() => decodeSpill(new Uint8Array(8)), (e) => e.code === 'SPILL_TRUNCATED');
});

test('a zero-sized spill is legal -- a wanted layer can decode to nothing', () => {
  const out = decodeSpill(encodeSpill({ width: 0, height: 0, data: new Uint8ClampedArray(0) }));
  assert.equal(out.width, 0);
  assert.equal(out.data.length, 0);
});

await atest('the memory adapter writes, reads, removes and disposes', async () => {
  const spill = createMemorySpill();
  const source = filled(4, 2, 3);
  await spill.write('7.rgba', [spillHeader(4, 2), source.data]);
  assert.deepEqual(spill.writes, ['7.rgba']);
  const out = decodeSpill(await spill.read('7.rgba'));
  assert.deepEqual([...out.data], [...source.data], 'chunked writes must concatenate in order');
  await spill.remove('7.rgba');
  assert.equal(spill.files.size, 0);
  await spill.dispose();
});

await atest('reading a spill that was never written names the file', async () => {
  const spill = createMemorySpill();
  await assert.rejects(() => spill.read('9.rgba'), (e) => e.code === 'SPILL_MISSING' && /9\.rgba/.test(e.message));
});
```

Add `spillHeader`, `encodeSpill`, `decodeSpill`, `createMemorySpill`,
`SPILL_HEADER_BYTES` and `SPILL_VERSION` to the import at the top of the file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `does not provide an export named 'spillHeader'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/spill.js`:

```js
/**
 * Spill format: a 16-byte header then raw RGBA, no compression.
 *
 * These files live for seconds. Deflating 66 MB in JavaScript costs more than
 * the write it would save, so the format is deliberately dumb. The header is
 * what earns its place: it makes the file self-describing, so a short file --
 * a full disk, most likely -- is CAUGHT rather than blended as a layer with
 * nonsense geometry.
 *
 * Alpha is STRAIGHT (unassociated), because that is what composite.js and
 * render.js use end to end. A premultiplied spill would round-trip through a
 * lossy conversion twice for no benefit.
 *
 *   offset 0   4  magic 'PSDX'
 *   offset 4   4  version
 *   offset 8   4  width
 *   offset 12  4  height
 *   offset 16  width * height * 4  RGBA
 *
 * All header fields are little-endian.
 */
import { ExportError } from './errors.js';

/** 'PSDX' read back as a little-endian uint32. */
export const SPILL_MAGIC = 0x58445350;
export const SPILL_VERSION = 1;
export const SPILL_HEADER_BYTES = 16;

export function spillHeader(width, height) {
  const header = new Uint8Array(SPILL_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, SPILL_MAGIC, true);
  view.setUint32(4, SPILL_VERSION, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  return header;
}

/**
 * Header and pixels in one buffer.
 *
 * ALLOCATES A FULL COPY -- at 66 MB that briefly doubles the resident layer.
 * Use it for tests and in-memory adapters only. A real filesystem adapter
 * writes `[spillHeader(w, h), image.data]` as two chunks and never calls this.
 */
export function encodeSpill(image) {
  const out = new Uint8Array(SPILL_HEADER_BYTES + image.width * image.height * 4);
  out.set(spillHeader(image.width, image.height), 0);
  out.set(image.data, SPILL_HEADER_BYTES);
  return out;
}

/** Returns a VIEW onto `bytes` -- no copy, so do not reuse the input buffer. */
export function decodeSpill(bytes) {
  if (bytes.byteLength < SPILL_HEADER_BYTES)
    throw new ExportError(
      `Spill file is ${bytes.byteLength} bytes, too short to hold a header — the write was truncated.`,
      'SPILL_TRUNCATED',
    );

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPILL_MAGIC)
    throw new ExportError('Spill file has the wrong magic — it was not written by this exporter.', 'SPILL_CORRUPT');

  const version = view.getUint32(4, true);
  if (version !== SPILL_VERSION)
    throw new ExportError(`Spill file is version ${version}; this build writes version ${SPILL_VERSION}.`, 'SPILL_CORRUPT');

  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const expected = SPILL_HEADER_BYTES + width * height * 4;
  if (bytes.byteLength !== expected)
    throw new ExportError(
      `Spill file for a ${width}x${height} layer should be ${expected} bytes but is ${bytes.byteLength} — ` +
      `the write was truncated, most likely because the disk filled up.`,
      'SPILL_TRUNCATED',
    );

  return {
    width,
    height,
    data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + SPILL_HEADER_BYTES, width * height * 4),
  };
}

/**
 * The spill adapter export takes, backed by a Map.
 *
 * This is what makes the whole export walk testable in Node. The device adapter
 * lands in 1C-2 and implements the same four methods over Capacitor Filesystem.
 *
 * `writes` records every name written, in order, so a test can assert that the
 * walk parked exactly what planSpill predicted and nothing more.
 */
export function createMemorySpill() {
  const files = new Map();
  const writes = [];
  return {
    files,
    writes,
    async write(name, chunks) {
      let total = 0;
      for (const chunk of chunks) total += chunk.byteLength;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        // image.data is a Uint8ClampedArray, which `set` accepts, but wrapping
        // keeps one code path for both.
        out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
        offset += chunk.byteLength;
      }
      files.set(name, out);
      writes.push(name);
    },
    async read(name) {
      const bytes = files.get(name);
      if (!bytes) throw new ExportError(`Spill file "${name}" is missing.`, 'SPILL_MISSING');
      return bytes;
    },
    async remove(name) { files.delete(name); },
    async dispose() { files.clear(); },
  };
}
```

Add to `src/index.js`:

```js
export {
  spillHeader, encodeSpill, decodeSpill, createMemorySpill,
  SPILL_MAGIC, SPILL_VERSION, SPILL_HEADER_BYTES,
} from './export/spill.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `29 passed`

Run: `npm test`
Expected: baseline unchanged, `29 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/export/spill.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add the spill codec with truncation detection and a memory adapter"
```

---

### Task 6: Let `drawLayerInto` take injected pixels and report a missing raster

**Files:**
- Modify: `src/render.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `drawLayerInto(dest, layer, scale = 1, options = {})` where
  `options = { pixels?: object|null, onMissing?: (layer, reason: 'text'|'raster') => void }`

Two things export needs that `renderProject` does not:

1. **Pixels from somewhere other than the layer.** Export streams the
   full-resolution raster; the layer is holding a 1024-edge proxy. The key is
   read with `'pixels' in options`, **not** `options.pixels ||`, so passing
   `null` means "there are none" rather than "fall back to the proxy". A fallback
   would blend a thumbnail at scale 1 and produce a correctly-sized blurred
   layer — success-shaped failure.
2. **A hook on the silent `return`.** `rasteriseTextAt` returns `null` with no
   drawing surface (`src/render.js:90`), and `drawLayerInto` then just returns —
   so in a worker without 1B's `OffscreenCanvas` abstraction every edited text
   layer disappears from an export that otherwise succeeds. Export makes that
   fatal. A raster layer with no pixels stays a silent skip, because the preview
   skips it too and export must match the preview.

> Node has no text rasteriser, so `create2dSurface` returns `null` here and the
> `'text'` branch of `onMissing` **is** reachable in `npm test`. That is the one
> piece of the vanishing-text hazard this suite really can prove.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\ndrawLayerInto injection\n');

const solid = (w, h, [r, g, b, a]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a; }
  return { width: w, height: h, data };
};
const rasterLayer = (over) => ({
  id: 1, name: 'raster', kind: 'raster', visible: true, opacity: 1, blendMode: 'normal',
  x: 0, y: 0, w: 4, h: 4, pixels: solid(4, 4, [255, 0, 0, 255]), rerendered: false, rendered: null, text: null,
  ...over,
});

test('injected pixels replace the layer\'s own', () => {
  const dest = createBuffer(4, 4);
  drawLayerInto(dest, rasterLayer(), 1, { pixels: solid(4, 4, [0, 0, 255, 255]) });
  assert.deepEqual([...dest.data.subarray(0, 4)], [0, 0, 255, 255], 'the injected blue must win');
});

test('an explicit null means "no pixels", NOT "use the layer\'s"', () => {
  // This is the whole reason the option is read with `in`. Under a proxy load
  // layer.pixels is a 1024-edge thumbnail; falling back to it at scale 1 would
  // draw a full-size blurred layer, which looks like a working export.
  const dest = createBuffer(4, 4);
  const missed = [];
  drawLayerInto(dest, rasterLayer(), 1, { pixels: null, onMissing: (l, why) => missed.push(why) });
  assert.deepEqual([...dest.data.subarray(0, 4)], [0, 0, 0, 0], 'nothing may be drawn');
  assert.deepEqual(missed, ['raster']);
});

test('omitting the option keeps the existing behaviour exactly', () => {
  const dest = createBuffer(4, 4);
  drawLayerInto(dest, rasterLayer(), 1);
  assert.deepEqual([...dest.data.subarray(0, 4)], [255, 0, 0, 255]);
});

test('a re-rendered text layer with no drawing surface is reported, not skipped', () => {
  // Node has no canvas, so rasteriseTextAt returns null -- the same thing that
  // happens in a worker without 1B's OffscreenCanvas surface. Today that layer
  // silently vanishes from the output.
  const dest = createBuffer(4, 4);
  const missed = [];
  drawLayerInto(dest, {
    id: 2, name: 'headline', kind: 'text', visible: true, opacity: 1, blendMode: 'normal',
    x: 0, y: 0, w: 4, h: 4, pixels: null, rerendered: true, rendered: null,
    text: { content: 'hi', fontFamily: 'sans-serif', fontSize: 12, color: '#000', bold: false, italic: false, align: 'left' },
  }, 1, { pixels: null, onMissing: (l, why) => missed.push(`${l.name}:${why}`) });
  assert.deepEqual(missed, ['headline:text']);
});

test('a layer entirely off the canvas is not a missing layer', () => {
  const dest = createBuffer(4, 4);
  const missed = [];
  drawLayerInto(dest, rasterLayer({ x: 100, y: 100 }), 1, { pixels: null, onMissing: (l, why) => missed.push(why) });
  assert.deepEqual(missed, [], 'off-canvas culling happens before pixels are ever looked for');
});
```

Add `createBuffer` and `drawLayerInto` to the import at the top of `test/export.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `the injected blue must win` (the option is ignored; the layer's red is drawn).

- [ ] **Step 3: Write the minimal implementation**

In `src/render.js`, replace the `drawLayerInto` signature, its JSDoc tail and its
pixel-selection block:

```js
 * @param {{width:number,height:number,data:Uint8ClampedArray}} dest
 * @param {object} layer
 * @param {number} [scale]  1 renders at document resolution.
 * @param {{pixels?: {width:number,height:number,data:Uint8ClampedArray}|null,
 *          onMissing?: (layer: object, reason: 'text'|'raster') => void}} [options]
 *   `pixels` REPLACES `layer.pixels` for raster layers whenever the key is
 *   PRESENT -- including when its value is null. Read with `in`, never with
 *   `||`: full-resolution export streams the real pixels this way, and under a
 *   proxy load `layer.pixels` is a 1024-edge thumbnail. Falling back to it at
 *   scale 1 would draw a correctly-sized, blurred layer, which is the one
 *   failure shape that looks like success.
 *   `onMissing` fires instead of the silent return when a layer yields no
 *   pixels, so export can make a vanished text layer fatal while leaving a
 *   pixel-less raster the same silent skip the preview gives it.
 */
export function drawLayerInto(dest, layer, scale = 1, options = {}) {
```

…and, replacing lines 141–152 (`let pixels;` through `if (!pixels) return;`):

```js
  let pixels = null;
  let reason = 'raster';
  if (layer.kind === 'text' && layer.rerendered) {
    // Draw the glyphs at their final size. Rasterising once and resampling the
    // bitmap is what made scaled text look pixelated.
    reason = 'text';
    pixels = textPixelsAt(layer, rect.width, rect.height);
  } else {
    // Raster layers really are bitmaps — resampling is all there is.
    const source = 'pixels' in options ? options.pixels : layer.pixels;
    if (source && source.width && source.height) pixels = resample(source, rect.width, rect.height);
  }
  if (!pixels) {
    if (options.onMissing) options.onMissing(layer, reason);
    return;
  }
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `34 passed`

Run: `npm test`
Expected: baseline unchanged. `test/gpu.mjs` still reports `53 passed` — the
sandwich cache calls `drawLayerInto` with three arguments and is untouched by a
defaulted fourth.

- [ ] **Step 5: Commit**

```bash
git add src/render.js test/export.mjs
git diff --staged
git commit -m "Let drawLayerInto take injected pixels and report a missing layer"
```

---

### Task 7: Progress phases and the cancellation signal

**Files:**
- Create: `src/export/progress.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `EXPORT_PHASES: Array<{name, from, to, determinate}>` — `from`/`to` are integer percents
  - `phaseFraction(phase, done = 0, total = 0) -> number` in 0…1
  - `isDeterminate(phase) -> boolean`

A 12–20 s mobile export with no feedback reads as a frozen app, so progress is
not polish. `parse` and `encode` are single synchronous calls with no interior
yield; the bar must show an indeterminate state during them rather than a fake
creep. Percents are integers so the span arithmetic is exact — floating spans
make `0.15 + 0.7` land at `0.8500000000000001` and turn every boundary assertion
into an epsilon comparison.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\nprogress phases\n');

test('the phases tile 0 to 100 with no gap and no overlap', () => {
  assert.equal(EXPORT_PHASES[0].from, 0);
  assert.equal(EXPORT_PHASES[EXPORT_PHASES.length - 1].to, 100);
  for (let i = 0; i < EXPORT_PHASES.length - 1; i++)
    assert.equal(EXPORT_PHASES[i].to, EXPORT_PHASES[i + 1].from,
      `${EXPORT_PHASES[i].name} ends at ${EXPORT_PHASES[i].to} but ${EXPORT_PHASES[i + 1].name} starts at ${EXPORT_PHASES[i + 1].from}`);
});

test('decoding layers spans 15% to 85%, exactly', () => {
  assert.equal(phaseFraction('layers', 0, 10), 0.15);
  assert.equal(phaseFraction('layers', 5, 10), 0.5);
  assert.equal(phaseFraction('layers', 10, 10), 0.85);
});

test('progress never runs past the end of its own phase', () => {
  assert.equal(phaseFraction('layers', 40, 10), 0.85);
});

test('a phase with no known total sits at its own start', () => {
  assert.equal(phaseFraction('parse', 0, 0), 0.10);
});

test('an unknown phase throws rather than sending the bar backwards', () => {
  assert.throws(() => phaseFraction('polish', 1, 1), /unknown export phase/i);
});

test('parse and encode are honest about having no interior progress', () => {
  assert.equal(isDeterminate('parse'), false);
  assert.equal(isDeterminate('encode'), false);
  assert.equal(isDeterminate('layers'), true);
  assert.equal(isDeterminate('write'), true);
});
```

Add `EXPORT_PHASES`, `phaseFraction` and `isDeterminate` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `does not provide an export named 'EXPORT_PHASES'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/progress.js`:

```js
/**
 * Export progress weights.
 *
 * `layers` is the only phase with honest interior granularity -- it is n of N
 * real decodes. `parse` and `encode` are single synchronous calls with no yield
 * point inside them, so they are marked indeterminate: the UI must show a
 * spinner-like state there rather than a fake creep, because a bar that
 * pretends to move during a 3 s freeze is worse than one that admits it.
 *
 * Bounds are integer PERCENTS, not fractions, so the arithmetic is exact.
 * Fractional spans put 0.15 + (0.85 - 0.15) at 0.8500000000000001 and turn
 * every boundary into an epsilon comparison.
 */
export const EXPORT_PHASES = [
  { name: 'read',     from: 0,  to: 10,  determinate: true },
  { name: 'parse',    from: 10, to: 15,  determinate: false },
  { name: 'layers',   from: 15, to: 85,  determinate: true },
  { name: 'drain',    from: 85, to: 90,  determinate: true },
  { name: 'readback', from: 90, to: 92,  determinate: true },
  { name: 'encode',   from: 92, to: 98,  determinate: false },
  { name: 'write',    from: 98, to: 100, determinate: true },
];

const phase = (name) => {
  const found = EXPORT_PHASES.find((p) => p.name === name);
  if (!found) throw new Error(`unknown export phase "${name}"`);
  return found;
};

/** @returns {number} overall progress in 0..1. */
export function phaseFraction(name, done = 0, total = 0) {
  const { from, to } = phase(name);
  const through = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (from + (to - from) * through) / 100;
}

export function isDeterminate(name) {
  return phase(name).determinate;
}
```

Add to `src/index.js`:

```js
export { EXPORT_PHASES, phaseFraction, isDeterminate } from './export/progress.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `40 passed`

- [ ] **Step 5: Commit**

```bash
git add src/export/progress.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add export progress phases with honest indeterminate spans"
```

---

### Task 8: The export walk

**Files:**
- Create: `src/export/target-js.js`, `src/export/stream.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: Tasks 1–7
- Produces:
  - `createJsExportTarget(width, height) -> ExportTarget`
  - `ExportTarget = { blend(layer, pixels), finish(): Promise<image>, dispose() }`
  - `exportFullRes({ project, readSource, spill, createTarget?, onProgress?, signal? }) -> Promise<image>`

The walk itself. It takes every side effect as an argument — `readSource` for
bytes, `spill` for disk, `createTarget` for the compositor — so it runs in Node
against `fs` and a `Map`, and 1C-2's GPU target drops into `createTarget`
without this file changing.

Three integrity checks run before anything is blended, because a source file
that has become unreadable or been swapped must produce a **named error**, never
a partial or blurred PNG: byte length against `source.size`, document dimensions
against the project, and every wanted `sourceIndex` actually arriving.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\nthe export walk\n');

const FIXTURE = 'fixtures/vectors.src.psd';
const FIXTURE_SIZE = fs.statSync(FIXTURE).size;

/** A proxy-loaded project with a real, re-readable source handle. */
const openProxy = () => loadProjectProxy(bytesOf(FIXTURE), {
  fileName: 'vectors.src.psd',
  proxyEdge: 256,
  source: { uri: FIXTURE, name: 'vectors.src.psd', size: FIXTURE_SIZE, kind: 'blob' },
});

const runExport = (project, spill, extra = {}) => exportFullRes({
  project,
  readSource: async () => bytesOf(FIXTURE),
  spill,
  createTarget: createJsExportTarget,
  ...extra,
});

await atest('the fast path blends every layer as it streams and never touches disk', async () => {
  const project = await openProxy();
  const spill = createMemorySpill();
  const out = await runExport(project, spill);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1080);
  assert.deepEqual(spill.writes, [], 'an untouched order must not spill');
  assert.equal(spill.files.size, 0);
});

await atest('the spill path parks exactly what planSpill predicted', async () => {
  const project = await openProxy();
  reorderLayer(project, 3, 0);                 // top layer to the bottom
  const spill = createMemorySpill();
  await runExport(project, spill);
  const expected = planSpill(buildExportOrder(project)).spill.map((i) => `${i}.rgba`);
  assert.deepEqual(spill.writes, expected,
    'the walk and the plan must agree, or one of them is wrong and nothing would notice');
  assert.deepEqual(spill.writes, ['0.rgba', '1.rgba', '2.rgba']);
});

await atest('every spill file is gone when the export succeeds', async () => {
  const project = await openProxy();
  reorderLayer(project, 3, 0);
  const spill = createMemorySpill();
  await runExport(project, spill);
  assert.equal(spill.files.size, 0, 'success must leave zero bytes behind');
});

await atest('a hidden layer is never decoded and never spilled', async () => {
  const project = await openProxy();
  project.layers[1].visible = false;
  reorderLayer(project, 3, 0);
  const spill = createMemorySpill();
  await runExport(project, spill);
  assert.ok(!spill.writes.includes('1.rgba'), 'a hidden layer is pure waste on the critical path');
});

await atest('progress reports every phase and ends at 1', async () => {
  const project = await openProxy();
  const seen = [];
  await runExport(project, createMemorySpill(), { onProgress: (p) => seen.push(p) });
  const phases = [...new Set(seen.map((p) => p.phase))];
  assert.deepEqual(phases, ['read', 'parse', 'layers', 'readback']);
  assert.equal(seen[seen.length - 1].fraction, 0.92, 'readback is the last phase this plan owns');
  const layers = seen.filter((p) => p.phase === 'layers');
  assert.equal(layers.length, 4, 'one report per decoded layer, not one per file');
});

await atest('cancelling mid-stream throws CANCELLED and leaves nothing behind', async () => {
  const project = await openProxy();
  reorderLayer(project, 3, 0);
  const spill = createMemorySpill();
  const signal = { cancelled: false };
  await assert.rejects(
    () => runExport(project, spill, {
      signal,
      onProgress: (p) => { if (p.phase === 'layers') signal.cancelled = true; },
    }),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(spill.files.size, 0, 'the finally must clean up on cancel too');
});

await atest('a source file of the wrong size is refused before it is parsed', async () => {
  const project = await openProxy();
  project.source.size = FIXTURE_SIZE + 1;
  await assert.rejects(
    () => runExport(project, createMemorySpill()),
    (e) => e.code === 'SOURCE_CHANGED' && /vectors\.src\.psd/.test(e.message),
  );
});

await atest('a source file of the wrong dimensions is refused before it is blended', async () => {
  const project = await openProxy();
  project.width = 999;
  await assert.rejects(
    () => exportFullRes({
      project,
      readSource: async () => bytesOf(FIXTURE),
      spill: createMemorySpill(),
      createTarget: createJsExportTarget,
    }),
    (e) => e.code === 'SOURCE_MISMATCH' && /999/.test(e.message),
  );
});

await atest('a project whose layers have no identity is refused before the file is read', async () => {
  const doc = await readDocument(bytesOf(FIXTURE), { pixels: 'eager', metadata: false });
  const eager = createProject(doc, 'vectors.src.psd');
  let read = false;
  await assert.rejects(
    () => exportFullRes({
      project: eager,
      readSource: async () => { read = true; return bytesOf(FIXTURE); },
      spill: createMemorySpill(),
      createTarget: createJsExportTarget,
    }),
    (e) => e.code === 'NO_IDENTITY',
  );
  assert.equal(read, false, 'refusing must cost nothing');
});

await atest('a re-rendered text layer that cannot be drawn is fatal, not silently dropped', async () => {
  // Node has no canvas, so this is the worker-without-OffscreenCanvas case.
  const project = await openProxy();
  const layer = project.layers[1];
  layer.kind = 'text';
  layer.rerendered = true;
  layer.text = { content: 'headline', fontFamily: 'sans-serif', fontSize: 24, color: '#000', bold: false, italic: false, align: 'left' };
  layer.name = 'headline';
  await assert.rejects(
    () => runExport(project, createMemorySpill()),
    (e) => e.code === 'TEXT_MISSING' && /headline/.test(e.message),
  );
});
```

Add `exportFullRes`, `createJsExportTarget` and `reorderLayer` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `does not provide an export named 'exportFullRes'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/target-js.js`:

```js
/**
 * The JS fallback compositor, wearing the ExportTarget interface.
 *
 * No tiling: there is no texture limit to respect, so the blend target is one
 * document-sized buffer. Transformed layers go through resample(), which is
 * where the measured 3.1 s -> 4.3 s desktop difference comes from.
 *
 * 1C-2's GPU target implements the same three methods over tiled FBOs, and
 * exportFullRes cannot tell them apart.
 */
import { createBuffer } from '../composite.js';
import { drawLayerInto } from '../render.js';
import { ExportError } from './errors.js';

export function createJsExportTarget(width, height) {
  const dest = createBuffer(width, height);

  return {
    /**
     * @param {object} layer   Geometry in DOCUMENT coordinates, drawn at scale 1.
     * @param {object|null} pixels  Full-resolution pixels, or null for a layer
     *   that draws itself (re-rendered text) or has none at all.
     */
    blend(layer, pixels) {
      drawLayerInto(dest, layer, 1, {
        pixels,
        onMissing: (missing, reason) => {
          if (reason === 'text')
            throw new ExportError(
              `Text layer "${missing.name}" could not be rasterised — there is no drawing surface in this context. ` +
              `Exporting would have dropped it from an image that otherwise looked fine.`,
              'TEXT_MISSING',
            );
          // A raster layer with no pixels draws nothing in the preview either.
          // Export reproduces the preview, so it draws nothing here too.
        },
      });
    },

    async finish() { return dest; },

    dispose() {},
  };
}
```

Create `src/export/stream.js`:

```js
/**
 * Full-resolution streaming export.
 *
 * Editing happens against a proxy, so the pixels the editor is holding are
 * roughly 1/23rd of the document's real pixel count. Compositing them at
 * scale 1 would upscale a 1024-edge bitmap and produce a blurred image at
 * exactly the right dimensions -- the worst failure shape available, because it
 * looks like it worked. So export goes back to the file.
 *
 * Every side effect is injected: `readSource` for bytes, `spill` for disk,
 * `createTarget` for the compositor. Nothing here imports Capacitor or WebGL,
 * which is what lets the whole walk run in Node against fs and a Map.
 *
 * Peak memory is `file bytes + one full-res layer + output buffer` on both the
 * fast and the spill path -- exactly one full-resolution layer is resident at a
 * time, and the file bytes are dropped before the readback.
 */
import { readDocument } from '../reader.js';
import { ExportError } from './errors.js';
import { buildExportOrder, wantedIndices, assertIdentifiable, isSelfRendering } from './order.js';
import { spillHeader, decodeSpill } from './spill.js';
import { phaseFraction } from './progress.js';
import { createJsExportTarget } from './target-js.js';

const EMPTY = { width: 0, height: 0, data: new Uint8ClampedArray(0) };

/**
 * @param {object} options
 * @param {object} options.project        A proxy-loaded project. Geometry is in document space.
 * @param {() => Promise<Uint8Array>} options.readSource
 *   Re-reads the original file. Must NOT retain the result -- export drops its
 *   own reference before the readback, and a second reference would keep
 *   300-odd MB alive through the encode peak.
 * @param {{write(name: string, chunks: Uint8Array[]): Promise<void>,
 *          read(name: string): Promise<Uint8Array>,
 *          remove(name: string): Promise<void>,
 *          dispose(): Promise<void>}} options.spill
 * @param {(width: number, height: number) => object} [options.createTarget]
 *   Defaults to the JS compositor. 1C-2 passes the tiled GPU target here.
 * @param {(p: {phase: string, done: number, total: number, fraction: number}) => void} [options.onProgress]
 * @param {{cancelled: boolean}} [options.signal]
 *   Checked at every layer boundary. Cancel latency is therefore up to one full
 *   layer decode -- an estimated 1-3 s on mobile for a 66 MB layer. Say
 *   "Cancelling…" in the UI and mean it.
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>}
 */
export async function exportFullRes(options) {
  const {
    project,
    readSource,
    spill,
    createTarget = createJsExportTarget,
    onProgress = null,
    signal = null,
  } = options;

  const order = buildExportOrder(project);
  assertIdentifiable(order);
  const wanted = wantedIndices(order);

  const report = (phase, done = 0, total = 0) => {
    if (onProgress) onProgress({ phase, done, total, fraction: phaseFraction(phase, done, total) });
  };
  const stopIfCancelled = () => {
    if (signal && signal.cancelled) throw new ExportError('Export cancelled.', 'CANCELLED');
  };

  const target = createTarget(project.width, project.height);
  const parked = new Set();
  const seen = new Set();
  const nameFor = (index) => `${index}.rgba`;
  let need = 0;
  let drained = 0;

  const blend = (layer, pixels) => { target.blend(layer, pixels); need++; };

  /**
   * Satisfy every layer that can be satisfied right now, in blend order:
   * self-rendering text draws itself, and anything already on disk comes back.
   * Stops at the first layer that still has to arrive from the stream.
   */
  const drain = async (phase) => {
    while (need < order.length) {
      const layer = order[need];
      if (isSelfRendering(layer)) { blend(layer, null); continue; }
      if (!parked.has(layer.sourceIndex)) break;

      const name = nameFor(layer.sourceIndex);
      blend(layer, decodeSpill(await spill.read(name)));
      await spill.remove(name);
      parked.delete(layer.sourceIndex);
      drained++;
      if (phase === 'drain') report('drain', drained, drained + parked.size);
      stopIfCancelled();
    }
  };

  try {
    stopIfCancelled();

    report('read', 0, 1);
    let bytes = await readSource();
    report('read', 1, 1);

    const expectedSize = project.source && project.source.size;
    if (expectedSize && bytes.byteLength !== expectedSize)
      throw new ExportError(
        `"${project.source.name}" is ${bytes.byteLength} bytes but was ${expectedSize} when it was opened — ` +
        `the file changed on disk.`,
        'SOURCE_CHANGED',
      );

    await readDocument(bytes, {
      pixels: 'stream',
      metadata: false,
      // Three naive O(n) scans of the whole file, for a warning already shown
      // at load. Not on this path.
      patterns: false,
      wantLayer: (_layer, index) => wanted.has(index),

      onStart: async ({ width, height }) => {
        if (width !== project.width || height !== project.height)
          throw new ExportError(
            `The source file is ${width}x${height} but this project is ${project.width}x${project.height} — ` +
            `it is not the same document.`,
            'SOURCE_MISMATCH',
          );
        report('parse', 0, 0);
        // A self-rendering text layer at the bottom of the stack has to be
        // drawn before the first arrival, or `need` never points at anything
        // the stream can satisfy and every arrival would be parked.
        await drain('layers');
      },

      onLayer: async (node, image) => {
        stopIfCancelled();
        seen.add(node.sourceIndex);

        const next = order[need];
        if (next && !isSelfRendering(next) && next.sourceIndex === node.sourceIndex) {
          // Arrival order is blend order for this layer. Blend it now, release
          // it, and take anything the drain can now finish.
          blend(next, image || null);
          await drain('layers');
        } else {
          // Needed later. Park it and let the reader release the memory copy.
          // A wanted layer that decoded to nothing is parked as an empty spill
          // so the drain treats it uniformly -- it will draw nothing, which is
          // exactly what the preview does with it.
          const source = image && image.width && image.height ? image : EMPTY;
          const chunks = source === EMPTY
            ? [spillHeader(0, 0)]
            : [spillHeader(source.width, source.height), source.data];
          await spill.write(nameFor(node.sourceIndex), chunks);
          parked.add(node.sourceIndex);
        }

        report('layers', seen.size, wanted.size);
      },
    });

    // The file bytes are 68-78% of peak. Nothing below needs them, and the
    // readback and encode peaks are still to come, so drop the reference here
    // rather than letting it live to the end of the function.
    bytes = null;

    for (const index of wanted)
      if (!seen.has(index))
        throw new ExportError(
          `The source file has no layer at position ${index}, but this project expects one — ` +
          `it is not the file this project was opened from.`,
          'SOURCE_MISMATCH',
        );

    await drain('drain');

    if (need < order.length)
      throw new ExportError(
        `Export finished with ${order.length - need} layer(s) never satisfied. ` +
        `This is a bug in the export walk, not a problem with the file.`,
        'INCOMPLETE',
      );

    report('readback', 0, 1);
    const out = await target.finish();
    report('readback', 1, 1);
    return out;
  } finally {
    // Runs on success, on failure and on cancel. It does NOT run when the OS
    // kills the process -- that is what sweep.js is for.
    target.dispose();
    await spill.dispose();
  }
}
```

Add to `src/index.js`:

```js
export { createJsExportTarget } from './export/target-js.js';
export { exportFullRes } from './export/stream.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `50 passed`

Run: `npm test`
Expected: baseline unchanged, `50 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/export/target-js.js src/export/stream.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add the full-resolution streaming export walk"
```

---

### Task 9: The oracle — a reordered streaming export equals the full-resolution reference

**Files:**
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: everything in Tasks 1–8
- Produces: no new code — this is the definition of done's first bullet, asserted

The spec's first acceptance criterion, verbatim: *"a Node suite asserts that the
streaming export of a proxy-loaded project is pixel-identical to
`renderProject(eagerProject, { scale: 1 })` … for a fixture, **with layers
reordered** so the spill path is the one under test."*

The transform case matters just as much and is the sharper test: if the walk
ever falls back to `layer.pixels`, a 256-edge proxy upscaled to 626 px will
differ from the eager render on essentially every pixel, so this test fails
catastrophically rather than subtly.

- [ ] **Step 1: Write the failing test**

Append to `test/export.mjs`:

```js
console.log('\nthe oracle\n');

/** The same file, read eagerly, with every layer at full resolution. */
const openEager = async () => createProject(
  await readDocument(bytesOf(FIXTURE), { pixels: 'eager', metadata: false }),
  'vectors.src.psd',
);

const matches = (got, want) => {
  const stat = compareBuffers(flattenOnto(got), flattenOnto(want));
  assert.ok(stat.comparable, stat.reason);
  assert.equal(stat.percentReal, 0,
    `${stat.beyondRounding} of ${stat.total} pixels differ by more than 1 (max ${stat.maxDelta})`);
};

await atest('an untouched export matches the full-resolution reference', async () => {
  const proxy = await openProxy();
  const eager = await openEager();
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a reordered export matches — this is the spill path under test', async () => {
  const proxy = await openProxy();
  const eager = await openEager();
  reorderLayer(proxy, 3, 0);
  reorderLayer(eager, 3, 0);

  const spill = createMemorySpill();
  matches(await runExport(proxy, spill), renderProject(eager, { scale: 1 }));
  assert.deepEqual(spill.writes, ['0.rgba', '1.rgba', '2.rgba'], 'the spill path really was exercised');
});

await atest('a transform re-applies to FULL-RESOLUTION pixels, not the proxy', async () => {
  // The proxy is 256-edge; the layer is 417 px and is being scaled to 626.
  // If export ever fell back to layer.pixels this would upscale a thumbnail
  // by 2.4x and differ from the reference on nearly every pixel.
  const proxy = await openProxy();
  const eager = await openEager();
  for (const project of [proxy, eager])
    setLayer(project, project.layers[3].id, { w: 626, h: 626 });
  reorderLayer(proxy, 3, 0);
  reorderLayer(eager, 3, 0);

  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});

await atest('a moved layer exports at its new position', async () => {
  const proxy = await openProxy();
  const eager = await openEager();
  for (const project of [proxy, eager])
    setLayer(project, project.layers[2].id, { x: 40, y: 700 });
  matches(await runExport(proxy, createMemorySpill()), renderProject(eager, { scale: 1 }));
});
```

Add `renderProject`, `setLayer`, `compareBuffers` and `flattenOnto` to the
import at the top of `test/export.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

If Tasks 1–8 are correct these pass on the first run, which is the point of an
oracle. **Prove the test can fail before trusting it.** In
`src/export/target-js.js`, temporarily change the `pixels,` line of the options
bag to `pixels: layer.pixels,` — that is exactly the bug this whole phase exists
to prevent: the compositor reaching for the 256-edge proxy instead of the
streamed full-resolution raster. Run the suite, then revert that one line.

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected with the sabotage in place: FAIL — both `a transform re-applies to FULL-RESOLUTION pixels` and `an untouched export matches the full-resolution reference` report `percentReal` in the tens of percent. If they still pass, the oracle is not testing what its name claims and must be fixed before Task 10.

- [ ] **Step 3: Confirm no implementation change is needed**

Revert the sabotage. If any oracle test still fails, the bug is in Tasks 6–8, not
in the test — fix it there rather than loosening the tolerance. The tolerance is
1 via `percentReal`, and it must stay 1.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `54 passed`

Run: `npm test`
Expected: baseline unchanged, `54 passed`.

- [ ] **Step 5: Commit**

```bash
git add test/export.mjs
git diff --staged
git commit -m "Assert reordered streaming export matches the full-resolution reference"
```

---

### Task 10: Tile partition arithmetic

**Files:**
- Create: `src/export/tiles.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `EXPORT_TILE_CAP = 2048`
  - `tileEdgeFor({maxTextureSize, maxRenderbufferSize, maxViewportDims, cap}) -> number`
  - `partitionTiles(width, height, edge) -> Array<{x, y, width, height}>`
  - `intersectRect(a, b) -> {x, y, width, height} | null`

`MAX_TEXTURE_SIZE` is commonly 4096 on older Android GPUs, and the poster is
4961 px wide, so its canvas cannot be one texture. It is also **not the only
limit** — a renderbuffer or a viewport can be smaller, and a driver that reports
a 4096 texture but a 2048 renderbuffer will fail at framebuffer-complete time
with an error that names neither.

> **Nothing here touches a GPU.** These are the numbers 1C-2's tiled compositor
> will partition by; `npm test` proves the arithmetic and nothing else. Whether
> 2048 is the right cap on real hardware is an open question the spec flags, and
> only a device sweep can close it.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\ntile arithmetic\n');

test('the tile edge is the minimum of every limit, not just the texture size', () => {
  assert.equal(tileEdgeFor({ maxTextureSize: 4096, maxRenderbufferSize: 1024, maxViewportDims: [4096, 4096] }), 1024);
  assert.equal(tileEdgeFor({ maxTextureSize: 4096, maxRenderbufferSize: 4096, maxViewportDims: [4096, 512] }), 512);
});

test('the cap wins when the hardware is generous', () => {
  assert.equal(tileEdgeFor({ maxTextureSize: 16384, maxRenderbufferSize: 16384, maxViewportDims: [16384, 16384] }), EXPORT_TILE_CAP);
  assert.equal(EXPORT_TILE_CAP, 2048);
});

test('an explicit cap overrides the default, for the device sweep', () => {
  assert.equal(tileEdgeFor({ maxTextureSize: 8192, maxRenderbufferSize: 8192, maxViewportDims: [8192, 8192], cap: 4096 }), 4096);
});

test('an unprobed context falls back to the cap rather than to zero', () => {
  assert.equal(tileEdgeFor({}), EXPORT_TILE_CAP);
  assert.equal(tileEdgeFor(), EXPORT_TILE_CAP);
});

test('the poster partitions into six tiles with correct edge remainders', () => {
  const tiles = partitionTiles(4961, 3508, 2048);
  assert.equal(tiles.length, 6, '3 across x 2 down');
  assert.deepEqual(tiles[0], { x: 0, y: 0, width: 2048, height: 2048 });
  assert.deepEqual(tiles[2], { x: 4096, y: 0, width: 865, height: 2048 });
  assert.deepEqual(tiles[5], { x: 4096, y: 2048, width: 865, height: 1460 });
});

test('the tiles cover the canvas exactly once', () => {
  const tiles = partitionTiles(4961, 3508, 2048);
  const area = tiles.reduce((sum, t) => sum + t.width * t.height, 0);
  assert.equal(area, 4961 * 3508);
});

test('a canvas inside the tile edge is one tile', () => {
  assert.deepEqual(partitionTiles(1080, 1080, 2048), [{ x: 0, y: 0, width: 1080, height: 1080 }]);
});

test('intersection clips a layer rect to a tile', () => {
  const tile = { x: 2048, y: 0, width: 2048, height: 2048 };
  assert.deepEqual(intersectRect({ x: 1900, y: 100, width: 400, height: 200 }, tile),
    { x: 2048, y: 100, width: 252, height: 200 });
});

test('a layer that misses a tile returns null, so the tile is skipped entirely', () => {
  const tile = { x: 2048, y: 0, width: 2048, height: 2048 };
  assert.equal(intersectRect({ x: 0, y: 0, width: 100, height: 100 }, tile), null);
  assert.equal(intersectRect({ x: 2048, y: 2048, width: 10, height: 10 }, tile), null,
    'touching an edge is not overlapping it');
});
```

Add `EXPORT_TILE_CAP`, `tileEdgeFor`, `partitionTiles` and `intersectRect` to the
import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `does not provide an export named 'tileEdgeFor'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/tiles.js`:

```js
/**
 * Tile arithmetic for the GPU export target.
 *
 * A 4961 px canvas cannot be one texture on a device whose MAX_TEXTURE_SIZE is
 * 4096, which is common on older Android GPUs. The tile accumulators together
 * ARE the output buffer, partitioned, so the tile edge only trades tile count
 * against the size of the single ping-pong scratch surface -- 2048 keeps that
 * at roughly 17 MB for the poster instead of roughly 67 MB at 4096.
 *
 * Pure arithmetic. Nothing here creates a context or uploads anything.
 */

/**
 * Ships at 2048 as a judgement call from GPU-memory arithmetic, NOT a
 * measurement. A device sweep should settle whether 4096 is safe where the
 * driver reports it; `tileEdgeFor` takes an explicit `cap` so that sweep does
 * not need a code change.
 */
export const EXPORT_TILE_CAP = 2048;

/**
 * MAX_TEXTURE_SIZE is not the binding limit on its own: a renderbuffer or a
 * viewport can be smaller, and a driver that reports 4096 textures with 2048
 * renderbuffers fails at framebuffer-complete time with an error that names
 * neither. Take the minimum of all of them.
 */
export function tileEdgeFor(limits = {}) {
  const {
    maxTextureSize = 0,
    maxRenderbufferSize = 0,
    maxViewportDims = [0, 0],
    cap = EXPORT_TILE_CAP,
  } = limits;

  const candidates = [maxTextureSize, maxRenderbufferSize, maxViewportDims[0], maxViewportDims[1], cap]
    .filter((n) => Number.isFinite(n) && n > 0);

  return candidates.length ? Math.max(1, Math.min(...candidates)) : cap;
}

/** Row-major tiles covering the canvas exactly once. Edge tiles are short. */
export function partitionTiles(width, height, edge) {
  const tiles = [];
  for (let y = 0; y < height; y += edge)
    for (let x = 0; x < width; x += edge)
      tiles.push({ x, y, width: Math.min(edge, width - x), height: Math.min(edge, height - y) });
  return tiles;
}

/** @returns the overlap of two rects, or null when they do not overlap at all. */
export function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
```

Add to `src/index.js`:

```js
export { EXPORT_TILE_CAP, tileEdgeFor, partitionTiles, intersectRect } from './export/tiles.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `63 passed`

- [ ] **Step 5: Commit**

```bash
git add src/export/tiles.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add tile edge selection and canvas partition arithmetic"
```

---

### Task 11: A dependency-free PNG writer

**Files:**
- Create: `src/export/png.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CANVAS_AREA_CAP = 16777216`
  - `canUseCanvasEncoder(width, height) -> boolean`
  - `encodePngStored(image) -> Uint8Array`

4961 × 3508 = **17,403,188 px**, over the 16,777,216 px canvas-area limit older
iOS enforces. So the obvious encode route — `OffscreenCanvas` +
`convertToBlob` — can fail on exactly the document this phase exists for. The
fallback uses stored (uncompressed) deflate blocks: no compression work, no
canvas allocation, output roughly the size of the raw pixels.

> **This is verifiable in Node and worth verifying properly.** The test inflates
> the result with `node:zlib` and recomputes every chunk CRC with `zlib.crc32`,
> so the deflate container, the adler32 and the CRC table are all checked
> against an independent implementation rather than against themselves.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\nPNG writer\n');

/** Independent decoder: node:zlib for inflate and CRC, so nothing checks itself. */
function decodePng(png) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) assert.equal(png[i], signature[i], `signature byte ${i}`);

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idat = [];
  let header = null;
  let p = 8;
  let sawEnd = false;

  while (p < png.length) {
    const length = view.getUint32(p, false);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    assert.equal(view.getUint32(p + 8 + length, false), zlib.crc32(png.subarray(p + 4, p + 8 + length)),
      `CRC32 of the ${type} chunk`);
    if (type === 'IHDR')
      header = {
        width: view.getUint32(p + 8, false), height: view.getUint32(p + 12, false),
        depth: png[p + 16], colour: png[p + 17], interlace: png[p + 20],
      };
    if (type === 'IDAT') idat.push(Buffer.from(png.subarray(p + 8, p + 8 + length)));
    if (type === 'IEND') sawEnd = true;
    p += 12 + length;
  }

  assert.ok(sawEnd, 'the file must end with IEND');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = 1 + header.width * 4;
  const data = new Uint8ClampedArray(header.width * header.height * 4);
  for (let y = 0; y < header.height; y++) {
    assert.equal(raw[y * stride], 0, `scanline ${y} must use filter 0`);
    data.set(raw.subarray(y * stride + 1, y * stride + stride), y * header.width * 4);
  }
  return { ...header, data };
}

test('the poster is over the iOS canvas area cap, which is why this exists', () => {
  assert.equal(CANVAS_AREA_CAP, 16777216);
  assert.equal(4961 * 3508, 17403188);
  assert.equal(canUseCanvasEncoder(4961, 3508), false);
  assert.equal(canUseCanvasEncoder(1080, 1080), true);
});

test('a small image round-trips through zlib byte for byte', () => {
  const source = filled(3, 2, 5);
  const decoded = decodePng(encodePngStored(source));
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.depth, 8);
  assert.equal(decoded.colour, 6, 'colour type 6 is 8-bit RGBA');
  assert.equal(decoded.interlace, 0);
  assert.deepEqual([...decoded.data], [...source.data]);
});

test('an image needing more than one stored block round-trips too', () => {
  // 200x200 raw is 200 * (1 + 800) = 160,200 bytes, so three stored blocks.
  const source = filled(200, 200, 31);
  const decoded = decodePng(encodePngStored(source));
  assert.deepEqual([...decoded.data], [...source.data]);
});

test('a 1x1 image is legal', () => {
  const source = filled(1, 1, 9);
  assert.deepEqual([...decodePng(encodePngStored(source)).data], [...source.data]);
});
```

Add `import zlib from 'node:zlib';` to the top of `test/export.mjs`, and add
`CANVAS_AREA_CAP`, `canUseCanvasEncoder` and `encodePngStored` to the import from
`../src/index.js`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `does not provide an export named 'encodePngStored'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/png.js`:

```js
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
```

Add to `src/index.js`:

```js
export { CANVAS_AREA_CAP, canUseCanvasEncoder, encodePngStored } from './export/png.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `67 passed`

- [ ] **Step 5: Commit**

```bash
git add src/export/png.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add a dependency-free PNG writer for oversized canvases"
```

---

### Task 12: Spill directory identity and the launch sweep

**Files:**
- Create: `src/export/sweep.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SPILL_ROOT = 'psd-export'`
  - `newExportId(now = Date.now(), random = Math.random) -> string`
  - `spillDirFor(exportId) -> string`
  - `sweepSpillDirectories(fs, { keep = [] }) -> Promise<string[]>` where
    `fs = { readdir(path): Promise<string[]>, rmdir(path): Promise<void> }`

`finally` does not run when the OS kills the process, and a backgrounded app
holding around 450 MB is a prime OOM-kill target. A sweep at launch is the only
cleanup that survives a kill, and up to 398 MB of orphaned spill is what it
recovers.

The sweep must be **defensive on both ends**: a missing root is the normal
first-run case and must not throw, and a directory that refuses to delete
(another export owns it, or the OS is holding a handle) must not abort the sweep
of the rest.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\nspill sweep\n');

const fakeFs = (tree) => ({
  removed: [],
  async readdir(path) {
    if (!(path in tree)) throw new Error(`no such directory: ${path}`);
    return tree[path];
  },
  async rmdir(path) {
    if (path.endsWith('locked')) throw new Error('resource busy');
    this.removed.push(path);
  },
});

test('an export id is unique per export and file-name safe', () => {
  const a = newExportId(1756200000000, () => 0.5);
  const b = newExportId(1756200000000, () => 0.75);
  assert.notEqual(a, b, 'two exports started in the same millisecond must not collide');
  assert.match(a, /^[a-z0-9-]+$/);
  assert.equal(spillDirFor(a), `${SPILL_ROOT}/${a}`);
});

await atest('the sweep deletes every orphaned export directory', async () => {
  const fs2 = fakeFs({ [SPILL_ROOT]: ['abc', 'def'] });
  const removed = await sweepSpillDirectories(fs2);
  assert.deepEqual(removed, ['abc', 'def']);
  assert.deepEqual(fs2.removed, [`${SPILL_ROOT}/abc`, `${SPILL_ROOT}/def`]);
});

await atest('the sweep leaves a live export alone', async () => {
  const fs2 = fakeFs({ [SPILL_ROOT]: ['abc', 'live'] });
  assert.deepEqual(await sweepSpillDirectories(fs2, { keep: ['live'] }), ['abc']);
});

await atest('a first run with no spill root is not an error', async () => {
  assert.deepEqual(await sweepSpillDirectories(fakeFs({})), []);
});

await atest('one undeletable directory does not abort the sweep', async () => {
  const fs2 = fakeFs({ [SPILL_ROOT]: ['locked', 'abc'] });
  assert.deepEqual(await sweepSpillDirectories(fs2), ['abc']);
});
```

Add `SPILL_ROOT`, `newExportId`, `spillDirFor` and `sweepSpillDirectories` to the
import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `does not provide an export named 'newExportId'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/sweep.js`:

```js
/**
 * Spill directory naming, and the sweep that recovers what a kill left behind.
 *
 * exportFullRes cleans up in a `finally`, which covers success, failure and
 * cancellation. It does NOT cover the OS killing the process -- and an app
 * backgrounded while holding roughly 450 MB is a prime OOM-kill target. Up to
 * 398 MB of orphaned spill is what this recovers.
 *
 * Filesystem access is injected for the same reason the rest of the export path
 * injects it: this file must run under Node, and Capacitor must stay out of
 * src/.
 */

/** Under Directory.Cache, which the OS may reclaim and which is excluded from backup. */
export const SPILL_ROOT = 'psd-export';

/** Timestamp plus randomness, so two exports in the same millisecond cannot collide. */
export function newExportId(now = Date.now(), random = Math.random) {
  const suffix = Math.floor(random() * 0x100000000).toString(36);
  return `${now.toString(36)}-${suffix}`;
}

export const spillDirFor = (exportId) => `${SPILL_ROOT}/${exportId}`;

/**
 * @param {{readdir(path: string): Promise<string[]>, rmdir(path: string): Promise<void>}} fs
 * @param {{keep?: string[]}} [options]  Export ids NOT to touch -- an export
 *   running right now owns its own directory.
 * @returns {Promise<string[]>} the ids actually removed.
 */
export async function sweepSpillDirectories(fs, options = {}) {
  const keep = new Set(options.keep || []);

  let entries;
  try {
    entries = await fs.readdir(SPILL_ROOT);
  } catch {
    // No root yet. That is the normal first-run case, not a failure.
    return [];
  }

  const removed = [];
  for (const id of entries) {
    if (keep.has(id)) continue;
    try {
      await fs.rmdir(spillDirFor(id));
      removed.push(id);
    } catch {
      // Another export may own it, or the OS may be holding a handle. Sweeping
      // is best effort by definition -- one failure must not abort the rest.
    }
  }
  return removed;
}
```

Add to `src/index.js`:

```js
export { SPILL_ROOT, newExportId, spillDirFor, sweepSpillDirectories } from './export/sweep.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `72 passed`

Run: `npm test`
Expected: baseline unchanged, `72 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/export/sweep.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add spill directory identity and a launch sweep"
```

---

### Task 13: Bridge chunking and a portable base64 encoder

**Files:**
- Create: `src/export/chunks.js`
- Modify: `src/index.js`
- Test: `test/export.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `BRIDGE_CHUNK_BYTES = 4194303`
  - `chunkRanges(total, size = BRIDGE_CHUNK_BYTES) -> Array<[start, end]>`
  - `bytesToBase64(bytes) -> string`

Capacitor's Filesystem takes **base64** on native. Encoding a whole 303 MB file
in one call materialises a roughly 404 MB string on top of the bytes, and a
66 MB PNG becomes a roughly 88.6 MB string — either one raises the ceiling on
its own. Chunking caps the extra at about 5.6 MB per call.

The chunk size is 4,194,303 bytes, not 4 MiB: it is divisible by 3, so no chunk
except the last carries base64 padding. Each `appendFile` call decodes
independently, so padding in the middle would still be *correct* — this just
keeps the encoded stream clean and the arithmetic obvious.

`bytesToBase64` is hand-written because the engine runs in Node, in a browser and
in a worker, and `btoa` exists in only two of those. The test checks it against
`Buffer.from(...).toString('base64')`, which is an independent implementation.

- [ ] **Step 1: Write the failing tests**

Append to `test/export.mjs`:

```js
console.log('\nbridge chunking\n');

test('the chunk size is divisible by three, so only the last chunk pads', () => {
  assert.equal(BRIDGE_CHUNK_BYTES % 3, 0);
  assert.ok(BRIDGE_CHUNK_BYTES <= 4 * 1024 * 1024);
});

test('ranges tile the whole buffer with no gap and no overlap', () => {
  const ranges = chunkRanges(10, 4);
  assert.deepEqual(ranges, [[0, 4], [4, 8], [8, 10]]);
});

test('an exact multiple produces no empty trailing range', () => {
  assert.deepEqual(chunkRanges(8, 4), [[0, 4], [4, 8]]);
});

test('an empty buffer produces no ranges at all', () => {
  assert.deepEqual(chunkRanges(0, 4), []);
});

test('a 303 MB file is 76 bridge calls, and that cost is worth stating', () => {
  const ranges = chunkRanges(303 * 1024 * 1024);
  assert.equal(ranges.length, 76);
});

test('base64 matches Node\'s own encoder for every tail length', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 6, 255, 256, 1000]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${length}`);
  }
});

test('base64 handles the high bytes that a naive shift would sign-extend', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x00]);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});
```

Add `BRIDGE_CHUNK_BYTES`, `chunkRanges` and `bytesToBase64` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: FAIL — `does not provide an export named 'chunkRanges'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/export/chunks.js`:

```js
/**
 * Chunking for the Capacitor bridge.
 *
 * Filesystem.writeFile takes base64 on native. A 303 MB file encoded in one
 * call materialises an approximately 404 MB string on top of the bytes it
 * already holds; a 66 MB PNG becomes approximately 88.6 MB. Either one raises
 * the memory ceiling by itself, so everything crossing the bridge is chunked
 * and the extra is capped at roughly 5.6 MB per call.
 */

/**
 * 4,194,303 bytes -- just under 4 MiB and divisible by 3, so no chunk except
 * the last one carries base64 padding. Each appendFile call decodes on its own,
 * so mid-stream padding would still be correct; this just keeps it clean.
 */
export const BRIDGE_CHUNK_BYTES = 4194303;

/** @returns {Array<[number, number]>} half-open [start, end) ranges. */
export function chunkRanges(total, size = BRIDGE_CHUNK_BYTES) {
  const ranges = [];
  for (let start = 0; start < total; start += size)
    ranges.push([start, Math.min(total, start + size)]);
  return ranges;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Hand-written because this runs in Node, in a browser and in a worker, and
 * `btoa` exists in only two of those -- and `btoa` would need a binary string
 * built first, which is another full-size allocation.
 */
export function bytesToBase64(bytes) {
  let out = '';
  const tail = bytes.length % 3;
  const end = bytes.length - tail;

  for (let i = 0; i < end; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  }

  if (tail === 1) {
    const v = bytes[end] << 16;
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + '==';
  } else if (tail === 2) {
    const v = (bytes[end] << 16) | (bytes[end + 1] << 8);
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + '=';
  }

  return out;
}
```

Add to `src/index.js`:

```js
export { BRIDGE_CHUNK_BYTES, chunkRanges, bytesToBase64 } from './export/chunks.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/export.mjs`
Expected: PASS — `79 passed`

Run: `npm test`
Expected: the five baseline markers unchanged, plus `79 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/export/chunks.js src/index.js test/export.mjs
git diff --staged
git commit -m "Add bridge chunk ranges and a portable base64 encoder"
```

---

### Task 14: A real, re-readable source URI — copy at load

**Files:**
- Create: `app/src/app/services/source-store.service.ts`
- Modify: `app/src/app/services/psd-loader.service.ts`, `app/src/app/harness/harness.page.ts`

**Interfaces:**
- Consumes: `chunkRanges`, `bytesToBase64`, `BRIDGE_CHUNK_BYTES` (Task 13)
- Produces:
  - `ProjectSource = { uri: string; name: string; size: number; kind: 'native' | 'blob' }`
  - `SourceStoreService.keep(file, bytes, onProgress?) -> Promise<ProjectSource>`
  - `SourceStoreService.read(source) -> Promise<Uint8Array>`
  - `PsdLoaderService.load(bytes, fileName, source: ProjectSource)`

> **This task cannot be verified by `npm test`.** It is Capacitor and a device.
> Step 4 hands verification over explicitly, and names what the user must check.

`project.source.uri` is a lie today: `harness.page.ts:62` passes
`` `file://${file.name}` ``, which nothing can re-read. This is the item
`docs/BACKLOG.md` records as blocking the phase, and it is the prerequisite
1C-2's export button depends on.

**Cost, in units, before it ships.** Copying a 303 MB PSD is **76 bridge calls
carrying about 5.6 MB of base64 each**, plus a **303 MB duplicate on disk** under
`Directory.Data`. The spec estimates 1–3 s; that is an estimate and the device
will settle it. This cost belongs in the load progress UI, not hidden — Step 3
puts it there. What it buys is a URI that survives a process restart with no
permission model at all, which an Android SAF `content://` URI does not.

- [ ] **Step 1: Create the source store**

Create `app/src/app/services/source-store.service.ts`:

```ts
import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { chunkRanges, bytesToBase64, BRIDGE_CHUNK_BYTES } from '@engine/export/chunks.js';

/** `kind` is for the app's resolver only. The engine never interprets it. */
export type ProjectSource = {
  uri: string;
  name: string;
  size: number;
  kind: 'native' | 'blob';
};

@Injectable({ providedIn: 'root' })
export class SourceStoreService {
  /** Web only: the picked File, kept so export can re-read it without a copy. */
  private blobs = new Map<string, File>();

  /**
   * Make the picked file re-readable after this session ends.
   *
   * On native this COPIES the bytes into Directory.Data. For a 303 MB PSD that
   * is 76 bridge calls of ~5.6 MB of base64 each plus a 303 MB duplicate on
   * disk — a real cost, deliberately paid, because an Android SAF content://
   * URI is dead after a process restart unless takePersistableUriPermission was
   * called, and copying sidesteps that whole permission model.
   *
   * On web the File object is already a reference to an OS file, not a memory
   * copy, so keeping it costs nothing.
   */
  async keep(file: File, bytes: Uint8Array, onProgress?: (fraction: number) => void): Promise<ProjectSource> {
    if (!Capacitor.isNativePlatform()) {
      const uri = `blob:${Date.now().toString(36)}:${file.name}`;
      this.blobs.set(uri, file);
      return { uri, name: file.name, size: bytes.byteLength, kind: 'blob' };
    }

    const path = `sources/${Date.now().toString(36)}-${file.name}`;
    const ranges = chunkRanges(bytes.byteLength, BRIDGE_CHUNK_BYTES);

    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i];
      const data = bytesToBase64(bytes.subarray(start, end));
      if (i === 0) await Filesystem.writeFile({ path, data, directory: Directory.Data, recursive: true });
      else await Filesystem.appendFile({ path, data, directory: Directory.Data });
      onProgress?.((i + 1) / ranges.length);
    }

    const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
    return { uri, name: file.name, size: bytes.byteLength, kind: 'native' };
  }

  /** Re-read the whole file. This is what exportFullRes's `readSource` calls. */
  async read(source: ProjectSource): Promise<Uint8Array> {
    if (source.kind === 'blob') {
      const file = this.blobs.get(source.uri);
      if (!file) throw new Error(`"${source.name}" is no longer open — reopen it and try again.`);
      // Rejects with NotReadableError if the file moved or was deleted.
      return new Uint8Array(await file.arrayBuffer());
    }

    // NOT Filesystem.readFile: it returns base64, so a 303 MB file arrives as
    // an ~404 MB string. convertFileSrc + fetch streams binary and works inside
    // a worker.
    const response = await fetch(Capacitor.convertFileSrc(source.uri));
    if (!response.ok) throw new Error(`Could not re-open "${source.name}" (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
```

- [ ] **Step 2: Pass the source object through the loader**

In `app/src/app/services/psd-loader.service.ts`, change the `load` signature and
the message it posts. Re-read the file first — Plan 1B-1 may have touched it.

```ts
  load(bytes: Uint8Array, fileName: string, source: ProjectSource): Promise<LoadResult> {
```

…and replace the two lines that built the source inline:

```ts
      // The source object is built by SourceStoreService, which is the only
      // thing that knows whether the URI is a real file path or a session blob.
      // Transfer the file bytes into the worker; the main thread must not keep
      // them, they are 68-78% of peak memory.
      worker.postMessage(
        { bytes: bytes.buffer, fileName, source, proxyEdge: 1024 },
        [bytes.buffer],
      );
```

Add the import:

```ts
import type { ProjectSource } from './source-store.service';
```

- [ ] **Step 3: Copy at load in the harness, and prove the round trip**

In `app/src/app/harness/harness.page.ts` — **re-read the current file first**;
Plan 1B-1's Tasks 9 and 10 add a capability panel and drag handling to it, and
this must be added alongside them, not over them.

Add to the imports:

```ts
import { SourceStoreService } from '../services/source-store.service';
```

Add beside the other injected services and signals:

```ts
  private store = inject(SourceStoreService);

  /** Result of re-reading the source after load — the export prerequisite, proven. */
  reread = signal('');
```

Add to the template, immediately below the `@if (info())` block:

```html
      <!-- Export re-reads the original file; if this line does not say ok,
           full-resolution export cannot work at all on this device. -->
      @if (reread()) { <p class="text-slate-600">source re-read: {{ reread() }}</p> }
```

In `onPick`, replace the `loader.load(...)` call and the two lines around it:

```ts
      const bytes = new Uint8Array(await file.arrayBuffer());

      // Copy the file somewhere export can re-read it, BEFORE load() transfers
      // `bytes` into the worker and detaches the buffer. On native this is a
      // full copy: ~76 bridge calls of ~5.6 MB each for a 303 MB PSD.
      this.status.set(`storing ${file.name}…`);
      const source = await this.store.keep(file, bytes, (f) =>
        this.status.set(`storing ${file.name}… ${Math.round(f * 100)}%`));

      this.status.set(`reading ${file.name}…`);
      const t0 = performance.now();
      result = await this.loader.load(bytes, file.name, source);
      ms = Math.round(performance.now() - t0);

      // Prove the prerequisite rather than assuming it. Reading the whole file
      // back costs the same memory the export will, which is the point.
      try {
        const again = await this.store.read(source);
        this.reread.set(again.byteLength === source.size
          ? `ok — ${again.byteLength} bytes from ${source.kind} uri`
          : `WRONG SIZE — got ${again.byteLength}, expected ${source.size}`);
      } catch (e: any) {
        this.reread.set(`FAILED — ${e?.message ?? e}`);
      }
```

- [ ] **Step 4: Hand verification to the user**

Do **not** run the build. Ask the user to run:

```bash
cd a:/test-rnd/app && npm start
```

…open `/harness`, pick a PSD, and report the `source re-read:` line verbatim —
from a desktop browser **and** from the Android device. Then ask them to:

1. **Force-stop the app on the device, relaunch it, and confirm it opens.** The
   copy under `Directory.Data` should still be there. (Re-reading it after a
   restart needs the export UI, which is 1C-2; for now the check is that the
   app starts clean and storage has not been corrupted.)
2. **Report how long the "storing …" phase took** on the largest PSD they have.
   The spec's 1–3 s figure for a 303 MB file is an estimate, and this is the
   first real number. If it is far worse, OPFS — the spec's open question —
   moves from "candidate" to "needed", and that decision belongs before 1C-2's
   spill adapter is written.
3. **Confirm the free-space failure is survivable**, if they can contrive it:
   a device near full should produce a named error from `keep`, not a blank
   screen.

Record the answers in the spec's *Open questions* section before 1C-2 is written.

> Nothing in this task is proven by `npm test`. `chunkRanges` and
> `bytesToBase64` are (Task 13); whether `Filesystem.appendFile` accepts 76
> consecutive 5.6 MB base64 payloads without the bridge choking is a device
> question and nothing else can answer it.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/services/source-store.service.ts \
        app/src/app/services/psd-loader.service.ts \
        app/src/app/harness/harness.page.ts
git diff --staged
git commit -m "Copy the picked PSD at load so export can re-read it"
```

---

## What this plan does not cover

Deferred to **Plan 1C-2** (device export), which depends on every interface
above:

| Spec section | What 1C-2 owns |
|---|---|
| *Tiled compositing — GPU tier* | `createGpuExportTarget(width, height)`, wearing the same `{ blend, finish, dispose }` shape `createJsExportTarget` already has. Layer-major, tile-minor; `tileEdgeFor` from a real `getParameter` sweep; `texSubImage2D` with `UNPACK_ROW_LENGTH` / `UNPACK_SKIP_PIXELS` / `UNPACK_SKIP_ROWS`, so no CPU-side slice buffer is ever allocated. |
| *Readback* | Per-tile `readPixels` into one tile-sized scratch, row-flipped into the output buffer (the framebuffer origin is bottom-left; `ImageData` rows run top-down). `premultipliedAlpha: false`, straight-alpha shader math, or the GPU diverges from the JS oracle at exactly the partially-transparent pixels the fixtures test. |
| *Spill format and lifecycle* | The Capacitor spill adapter: `Directory.Cache / psd-export / <exportId> /`, chunked base64 appends via Task 13's `chunkRanges`, `rmdir({ recursive: true })` on dispose. Plus the **open question**: OPFS `createSyncAccessHandle` is worker-only, synchronous and binary, and would remove the largest estimated cost in this phase — a measured decision, not a silent substitution. |
| *Spill lifecycle* → process killed | `sweepSpillDirectories` wired to app launch with the live `exportId` in `keep`, plus the main thread's best-effort `rmdir` after `worker.terminate()`. |
| *Progress and cancellation* | The export worker, the `cancel` message and its `cancelled` acknowledgement, the terminate-after-timeout fallback, and a progress UI driven by `EXPORT_PHASES` — indeterminate during `parse` and `encode`, "Cancelling…" during the up-to-one-layer cancel latency. |
| *Backgrounding* | `App.appStateChange`: no auto-cancel on Android, a persisted "export in progress" marker, and *"Export was interrupted"* with a retry after a kill. Never a restored stale progress bar. |
| *Encoding and delivery* | `OffscreenCanvas` + `convertToBlob` guarded by `canUseCanvasEncoder`, falling back to `encodePngStored`; chunked `Filesystem.writeFile` + `appendFile` for the PNG; `Share.share({ files: [uri] })`; the project JSON alongside it via the existing `toProjectJson`. |
| *Testing* | The conformance route's **export column** — the same 21 fixtures checked through the export path on a real device driver. |
| *Risks* → largest layer | Wiring `estimatePeakBytes` to budget the composite window against the largest **layer**, not the canvas — a layer's bounds can exceed the document, so the "one full-res layer" term is not capped at 66 MB. |

Not in either plan, and already in `docs/BACKLOG.md`: **layer masks and
clipping**, which `renderProject` implements for neither. Export reproduces the
preview faithfully, including that gap. Fixing it is Phase 2-sized work.

---

## Noticed, not doing in 1C-1

Findings from writing this plan. None are 1C-1 work. **Append them to
`docs/BACKLOG.md` when executing** — a list that lives only in a plan document is
the same as not reporting it.

- **The spec's spill-direction examples are inverted.** Recorded here as
  Deviation 1 and asserted in Task 4. The spec text should be corrected so the
  next reader is not misled.
- **`applyProjectJson` matches saved layers by array index** (`src/edit.js:322`)
  — the exact class of bug `sourceIndex` was added to fix. Its layer-count guard
  catches the easy case, but a document whose layer *count* is unchanged and
  whose *membership* is not would reapply every saved transform to the wrong
  layer. It should match on `sourceIndex` now that one exists.
- **Off-canvas layers are still streamed and, on the spill path, still written to
  disk.** `drawLayerInto` culls them at draw time, after the decode and the
  write. `buildExportOrder` could cull them against `project.width/height` and
  drop them from `wanted` entirely. Not done: it changes the spill plan and the
  oracle for a case no fixture exercises, and correctness came first.
- **A contiguous run of reordered layers could be flattened into a second
  accumulator instead of spilled**, which would collapse the worst case (top
  layer to the bottom, n-1 spills) to zero spills. It is only exact when every
  mode in the run is source-over, and it inherits the sandwich cache's
  documented ≤2 LSB quantisation cost. Not done, and it would need its own
  tolerance argument before it could be.
- **`estimatePeakBytes` still has no production caller** (`src/budget.js`, already
  in the backlog). Export is the natural one, and the spec says so — it can
  budget the composite window before starting instead of discovering the ceiling
  by being killed. Deferred to 1C-2, where the largest-layer number is available.
- **`rerendered` has two owners and two policies.** `applyCommand` sets it only
  for the `text` key (`src/edit.js:190`); `demo/editor.js:331` sets it for `w`/`h`.
  `render.js:142` branches on it, and now so does export. It should have one
  owner. Export is safe either way — `true` re-draws sharp, `false` upscales the
  full-resolution raster — but "safe either way" is not the same as "defined".
- **`app/` still has no automated coverage**, and this plan adds a service to it.
  `SourceStoreService` is deliberately thin — chunking and base64 both live in
  `src/export/chunks.js` where Node tests reach them — but the division is worth
  re-checking when 1C-2 adds the export worker and the spill adapter, not after.
- **No fixture has a mid-stack pixel-less leaf.** All 21 were checked. If a
  future fixture is authored, one with a dropped leaf *between* two drawn layers
  would let Task 1's synthetic test be replaced by a real-file one.
