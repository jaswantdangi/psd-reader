# Phase 2A — The Engine Behind the Layers Panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the editor's biggest correctness gap — layer masks, end to end, from `decodeLayerPixels` to `blendInto` — and build every piece of logic the Phase 2 screen needs that a machine with no DOM, no touch and no build can prove correct: mask reprojection and single-channel resampling, the new layer fields (`mask`, `clipping`, `groupPath`), the document warnings the reader has been dropping, gesture-scoped undo coalescing, pointer↔document mapping, gesture arbitration and transform arithmetic, the frame-budget ladder's decision function, and the layers panel's derived list.

**Architecture:** `src/composite.js` already applies masks correctly and is the pixel-validated oracle (`12/5/4` across 21 fixtures). Its `maskFor` is **moved** — not rewritten — into a new `src/mask.js` as `projectMask`, so there is exactly one implementation and the oracle exercises it on every run. `loadProjectProxy` then calls `projectMask` inside `onLayer`, while the full-resolution mask raster is still in scope, reprojects the mask into the layer's own pixel grid at full resolution, downscales it to dimensions **read from `node.proxyData`**, and lets the reader release the original. Because the mask's dimensions are taken from the proxy pixels rather than recomputed, mask and pixels are the same grid *by construction*; `drawLayerInto` then resamples both to the same `rect.width × rect.height` from the same source dimensions, so they cannot drift apart under any transform at any scale. Four new pure modules — `src/mask.js`, `src/view.js`, `src/gesture.js`, `src/panel.js` — hold everything the Angular screen would otherwise hide in a component, which is the division `docs/BACKLOG.md` warns is one service away from collapsing.

**Tech Stack:** Node 24 (ESM, `node:assert/strict`), `ag-psd` 31, Ionic 8 + Angular standalone + Capacitor 8, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-08-26-phase-2-layers-canvas-design.md`](../specs/2026-08-26-phase-2-layers-canvas-design.md)

---

## This is part 1 of 2

Phase 2's spec is larger than one executable plan. As in 1B and 1C, it is split
at the line where verification changes hands:

| Plan | Covers | Verified by |
|---|---|---|
| **2A — this document** | Masks end to end in the JS path; `clipping` and `groupPath` as data; the clipping / vector-mask / reader warnings; skipped-leaf counting; gesture-scoped coalescing and the mutation counter; the `rerendered` owner; persistence of the new fields; `src/view.js`, `src/gesture.js`, `src/panel.js` | `npm test` (Tasks 1–14) and the user's build + device (Task 15) |
| 2B — *not yet written* | The Angular editor screen: rail, layers sheet, rows and thumbnails, expanded row, blend-mode sub-sheet, selection HUD, top bar, warnings sheet, every state in *States*, pointer plumbing over `src/gesture.js`, the one-composite-in-flight rule, the Ghost overlay — plus the mask in 1B's GPU shader and in its conformance route | a real device, only |

The split is not a scope cut. Every requirement in the spec lands in one of the
two plans, and 2A leaves 2B **named, typed functions** to call rather than gaps:
`panelRows`, `viewToDoc`, `arbitrate`, `resizeFrom`, `chooseRenderMode`. 2B
writes components; it writes no arithmetic.

2A ships something real on its own. **A masked PSD renders wrong in the editor
today, in preview and in export both** — `src/composite.js` has 17 mask
references, `src/edit.js` and `src/render.js` have zero. After Task 6 a masked
fixture renders **byte-identically** through `renderProject` and
`compositeDocument`, asserted inside `npm test` on three real fixtures. That is
the first bullet of the spec's definition of done, and it is the assertion the
whole mask ruling stands on.

---

## Deviations from the spec, and why

Seven, all found by reading the code and the fixtures the spec describes. Each
is implemented the corrected way; the spec's text is otherwise binding.

1. **`revision` already exists, and the spec's finding 3 is out of date.** The
   spec says *"`applyCommand` bumps no revision counter, and it is the only
   place that can"*, and that `undo`/`redo` miss the bump. Read the code:
   commit 696d45c (Plan 1B-1) added `project.revision`, and `commit`
   (`src/edit.js:218`), `undo` (`:263`), `redo` (`:272`) and `applyProjectJson`
   (`:346`) each bump it explicitly. The **only** path that does not is
   `setLayer`'s coalescing early-return — and that omission is deliberate and
   load-bearing: `src/sandwich.js:103–107` keys its drag cache on
   `project.revision`, and the cache survives a gesture *precisely because* the
   coalesced frames leave it alone. Moving the bump into `applyCommand` as the
   spec asks would rebuild the sandwich on every drag frame and delete 1B's
   entire reason for existing.

   So 2A adds a **second** counter, `project.mutation`, bumped inside
   `applyCommand` — which every path reaches, including the coalesced frames and
   both directions of undo. `revision` keeps its 1B meaning (structural changes;
   sandwich and thumbnail cache keys); `mutation` is the redraw counter Angular
   signals read. Two counters, two clearly different questions, neither one
   lying. Task 8 pins both, including an assertion that `revision` does **not**
   move on the coalesced path — so nobody "fixes" this back.

2. **`rerendered` is settled in `setLayer`, not `applyCommand`.** The spec's
   decision names `applyCommand`. But `applyCommand` also replays inverted
   commands during undo, and a flag set there is never captured in the command's
   `from` — so undoing a text resize would leave the layer stuck on the live
   renderer. `setLayer` is the funnel where `from` is snapshotted, so setting it
   there makes it **invertible**, which is what `test/edit.mjs:229` already
   expects. Same single owner, correct semantics.

3. **The unlinked-mask warning is not implemented.** The spec asks for one from
   `mask.positionRelativeToLayer`. ag-psd sets that field straight from
   `flags & 1` (`node_modules/ag-psd/dist/psdReader.js:472`) and documents
   nothing about its polarity; **no fixture discriminates it**. A user-facing
   warning whose direction is a guess is worse than none — it would tell half of
   all users their masks are wrong when they are not. Recorded in
   *Noticed, not doing* with what would settle it.

4. **One test file, not four.** The spec's definition of done lists *"new suites
   for `src/view.js`, `src/mask.js`, `src/gesture.js` and `src/panel.js`"*. They
   land as four labelled sections of one `test/layers.mjs`, matching
   `test/proxy.mjs`, which already covers `proxy.js`, `budget.js`, `load.js` and
   the `edit.js` proxy changes in one file with one `npm` script. Four scripts
   and four baseline markers for four small pure modules is ceremony.

5. **No fixture has a clipped layer, so the clipping tests are synthetic.** All
   21 fixtures were checked with a tree walk: `clipping` is `false` on every leaf
   in every one. Do not spend time hunting. Task 7 builds the clipped document by
   hand, exactly as `test/proxy.mjs` already builds `streamedDoc()`.

6. **The masked-render oracle runs on three fixtures, and only one of them
   discriminates.** Measured before the change:

   | Fixture | Layer bounds | Mask bounds | `beyondRounding` / total today |
   |---|---|---|---|
   | `vector-and-mask.src.psd` | `[-1,-1,75,76]` | `[0,0,101,98]` | **855 / 9898 (8.64%)**, max delta 255 |
   | `boolean.src.psd` | `[23,85,275,213]` | same | **166 / 90000**, max delta 57 |
   | `gradient.src.psd` | `[15,54,179,151]` | same | 0 / 40000 |

   All three go to **0** with the mask applied (simulated end to end before this
   plan was written). `vector-and-mask` is the one that carries the alignment
   case — its mask has a different origin from its layer, which is exactly the
   reprojection the spec says the design turns on. `gradient` is a regression
   guard only: its mask is fully opaque inside the layer, so it can prove the
   mask work did no *harm* and nothing else. **Say that when reporting; a green
   `gradient` assertion is not evidence masks work.**

7. **`masks.src.psd` is useless as a mask oracle**, despite its name. Its masked
   node is an *adjustment* layer with bounds `[0,0,0,0]` and no `imageData`, so
   `flatten()` drops it and neither renderer ever sees the mask. It also carries
   `userMaskDensity: 0` and `userMaskFeather: 2.8`, which `composite.js` ignores.
   Do not reach for it.

---

## Global Constraints

- **Engine code is plain ESM JavaScript in `src/`** — no TypeScript, no framework imports. It is consumed by Node tests, the existing `demo/` pages, and the Angular app alike.
- **Do not run build commands.** Per project rules, the user builds and verifies. Task 15 hands verification over explicitly and names what the output must say.
- **`toLayer()` is edited by three phases.** Plan 1C-1 added `sourceIndex`; this plan adds `mask`, `clipping`, `groupPath`, `groupWarned` to the **same object literal**. Task 4 must **re-read the current `toLayer()`** and add fields alongside what is there — never paste a remembered version. The same warning applies to `flatten()`'s skip condition (`src/edit.js:144`), whose signature this plan changes.
- **`app/src/app/harness/harness.page.ts` is edited by three plans.** Plan 1B-1's Tasks 9–10 add a capability readout and drag handling; Plan 1C-1's Task 14 adds copy-at-load and a re-read line. **At the time this plan was written, neither had landed** — `git log` ends at 1C-1's Task 13, and `app/src/app/services/` contains only `psd-loader.service.ts`. Task 15 must re-read the file and add to it, never overwrite it. **Phase 2B replaces this page with a real editor at `/editor` and keeps `/harness` as the debug route** — it is where the spec's debug-only readouts (`proxyW/H`, `proxyScale`, the tier indicator, the active ladder rung) live, and where 1C-1's Task 14 still has to land.
- **Move `maskFor`, do not rewrite it.** It is exercised by the 21-fixture composite oracle on every `npm test` run. Task 1 asserts byte-for-byte equality against an inlined copy of the original, and the oracle line must stay `<0.5% diff: 12   <10%: 5   >=10%: 4`.
- **Masks are a `Uint8Array`, one byte per pixel, never RGBA.** Sixty proxy layers at 1024² would waste ~189 MB on three channels holding the same value. This is why `resample()` from `render.js` cannot be reused and `resampleMask` exists.
- **Never route text through `resample()`.** Text is vector; it must be drawn at final size (HANDOFF Failed Approach 5).
- **Invalidate `renderedKey`, never `rendered` alone** — a stale key returns `null` and the layer disappears (HANDOFF Failed Approach 6).
- **Comparison tolerance is 1**, via `stat.percentReal` / `stat.beyondRounding`, never `stat.percent` (HANDOFF Failed Approach 8). `flattenOnto()` both buffers before comparing (Failed Approach 7).
- **Layer geometry stays in document coordinates**, and the view transform never enters `renderProject`. `src/view.js` produces a `renderScale` for the renderer and a separate CSS zoom for the presentation; nothing in `src/` ever sees a pan offset.
- **`test/shim.mjs` walks `src/` recursively.** None of the four new modules imports `ag-psd`, so the guard stays green. If that ever changes, add the symbol to `demo/shims/ag-psd.js` in the same commit.
- **Stage exact files.** Never `git add .` or `git add <dir>`; read `git diff --staged` before every commit.
- **A green `npm test` proves the JS render path.** It says nothing about the GPU shader, a finger, a sheet, a thumbnail, or a frame budget on a phone. Do not report a green suite as if it settled those.
- Test scripts run with `--max-old-space-size=6144` where they load fixtures.
- Branch: `phase-1-engine-gpu-memory`. Do not push without explicit approval.

**Expected baseline before Task 1.** Run `npm test` and confirm these seven
markers appear, in this order:

```
shim OK
21 files | parsed 21 | failed 0
21 files  |  <0.5% diff: 12   <10%: 5   >=10%: 4   skipped: 0
21 passed          <- test/edit.mjs
28 passed          <- test/proxy.mjs
53 passed          <- test/gpu.mjs
79 passed          <- test/export.mjs
```

If any of those differs, stop and report it before starting — every "Expected"
below is written against this baseline.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/mask.js` | `layerRect`, `pixelRect`, `projectMask` (moved out of `composite.js`), `downscaleMask`, `resampleMask`. Single-channel, no canvas, no I/O. |
| `src/view.js` | The `{docScale, panX, panY}` view model. `viewToDoc`, `docToView`, `fitView`, `zoomAbout`, `clampView`, `renderScaleFor`, `cssZoomFor`, `isPreviewQuality`. Pure. |
| `src/gesture.js` | Gesture arbitration, handle hit-testing, transform arithmetic with the no-flip clamp, the per-gesture coalesce key, and the frame-budget ladder's decision function. Pure. |
| `src/panel.js` | The layers panel's derived list: filter + search + duplicate-name disambiguation + badges + clip base + the empty/filtered-to-zero distinction. Pure over a project. |
| `test/layers.mjs` | Suite for all of the above, plus the `edit.js`, `render.js` and `load.js` changes. |

**Modified:**

| File | Change |
|---|---|
| `src/composite.js` | Import `projectMask` and `layerRect` from `src/mask.js`; delete the local `maskFor` and `rectOf` |
| `src/edit.js` | `toLayer` gains `mask`, `clipping`, `groupPath`, `groupWarned`; `flatten` records the group path, the warned flag and the skipped-leaf count; `createProject` merges `doc.warnings` and raises the clipping and vector-mask warnings; `setLayer` owns `rerendered`; `applyCommand` bumps `mutation`; persistence carries the new fields |
| `src/render.js` | `drawLayerInto` sets `rect.mask` from `layer.mask` |
| `src/load.js` | Build the proxy mask inside `onLayer`; report the layer total through `onStart` and `onProgress` |
| `src/reader.js` | `onStart` payload gains `layers`, the leaf count |
| `src/index.js` | Export the new modules |
| `package.json` | `test:layers` script |
| `demo/editor.js` | Drop the demo's second claim on `rerendered` |
| `app/src/app/workers/psd-decode.worker.ts`, `app/src/app/services/psd-loader.service.ts`, `app/src/app/harness/harness.page.ts` | Task 15: determinate progress, and a readout that makes the mask and clipping work visible |

---

### Task 1: Move `maskFor` out of the compositor, intact

**Files:**
- Create: `src/mask.js`, `test/layers.mjs`
- Modify: `src/composite.js`, `src/index.js`, `package.json`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `layerRect(node) -> {left, top, width, height}` — a node's rect from its own bounds
  - `pixelRect(node, pixels) -> {left, top, width, height}` — a node's rect at its pixel buffer's dimensions
  - `projectMask(node, rect) -> Uint8Array | null` — the mask reprojected into `rect`'s grid, `defaultColor` outside the mask's own bounds

`src/composite.js` is the pixel-validated oracle: `12` fixtures under 0.5%, `5`
under 10%, `4` beyond. Its `maskFor` is the only correct mask implementation in
the codebase and the editor has none. Copying it would create a second one that
can drift; moving it leaves one, still exercised by the oracle on every run.

- [ ] **Step 1: Write the failing tests**

Create `test/layers.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  layerRect, pixelRect, projectMask,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const bytesOf = (path) => new Uint8Array(fs.readFileSync(path));

/**
 * The mask implementation EXACTLY as it stood in composite.js before the move,
 * inlined here on purpose. Task 1 is a move, not a rewrite, and this is the
 * only thing that can prove it: if projectMask ever stops agreeing with this
 * byte for byte, the 21-fixture composite oracle has quietly changed meaning.
 */
function maskForOriginal(layer, rect) {
  const mask = layer.mask;
  if (!mask || !mask.imageData) return null;
  const mw = (mask.right ?? 0) - (mask.left ?? 0);
  const mh = (mask.bottom ?? 0) - (mask.top ?? 0);
  if (mw <= 0 || mh <= 0) return null;
  const fallback = mask.defaultColor ?? 0;
  const out = new Uint8Array(rect.width * rect.height).fill(fallback);
  const src = mask.imageData.data;
  for (let y = 0; y < rect.height; y++) {
    const my = rect.top + y - mask.top;
    if (my < 0 || my >= mh) continue;
    for (let x = 0; x < rect.width; x++) {
      const mx = rect.left + x - mask.left;
      if (mx < 0 || mx >= mw) continue;
      out[y * rect.width + x] = src[(my * mw + mx) * 4];
    }
  }
  return out;
}

/** A layer node carrying a 4x4 mask offset one pixel from its own bounds. */
const maskedNode = () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data[i * 4] = i * 16;   // masks are greyscale — red channel
  return {
    left: 1, top: 1, right: 5, bottom: 5,
    mask: { left: 0, top: 0, right: 4, bottom: 4, defaultColor: 200,
            imageData: { width: 4, height: 4, data } },
  };
};

console.log('\nmask projection\n');

test('layerRect derives width and height from the node bounds', () => {
  const r = layerRect({ left: -1, top: -1, right: 75, bottom: 76 });
  assert.deepEqual(r, { left: -1, top: -1, width: 76, height: 77 });
});

test('pixelRect keeps the origin but takes dimensions from the pixel buffer', () => {
  const r = pixelRect({ left: 10, top: 20 }, { width: 3, height: 7 });
  assert.deepEqual(r, { left: 10, top: 20, width: 3, height: 7 });
});

test('projectMask reproduces the compositor implementation byte for byte', () => {
  const node = maskedNode();
  const rect = layerRect(node);
  assert.deepEqual([...projectMask(node, rect)], [...maskForOriginal(node, rect)]);
});

test('projectMask fills outside the mask bounds with defaultColor', () => {
  const node = maskedNode();
  const out = projectMask(node, layerRect(node));
  // The layer starts at (1,1) and the mask ends at (4,4), so the layer's last
  // row and column fall outside the mask entirely and take defaultColor.
  assert.equal(out[3 * 4 + 3], 200, 'bottom-right corner is outside the mask');
  assert.equal(out[0], 16 * 5, 'top-left samples mask pixel (1,1)');
});

test('projectMask returns null when there is no mask raster', () => {
  assert.equal(
    projectMask({ left: 0, top: 0, right: 4, bottom: 4 }, { left: 0, top: 0, width: 4, height: 4 }),
    null,
  );
  assert.equal(
    projectMask(
      { mask: { left: 0, top: 0, right: 0, bottom: 0, imageData: { width: 0, height: 0, data: new Uint8ClampedArray(0) } } },
      { left: 0, top: 0, width: 4, height: 4 },
    ),
    null,
  );
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/index.js' does not provide an export named 'layerRect'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/mask.js`:

```js
/**
 * Layer masks, as a single-channel coverage plane.
 *
 * A mask is a per-layer alpha multiplier and nothing else -- `blendInto` has
 * always taken one (`if (rect.mask) as *= rect.mask[...] / 255`). What was
 * missing is everything that gets a mask from the file to that line, which is
 * this file.
 *
 * Stored one byte per pixel, never RGBA. Sixty proxy layers at 1024x1024 would
 * waste ~189 MB on three channels holding the same value, which is also why
 * `resample()` from render.js cannot be reused for the resize below.
 *
 * `projectMask` was `maskFor` in composite.js and was MOVED here, not rewritten:
 * composite.js is the 21-fixture pixel oracle and is the only place a mask was
 * ever applied correctly. It still imports this function, so the oracle keeps
 * exercising the one implementation on every test run.
 */

/** A layer node's rect in document space, taken from its own bounds. */
export const layerRect = (node) => ({
  left: node.left ?? 0,
  top: node.top ?? 0,
  width: (node.right ?? 0) - (node.left ?? 0),
  height: (node.bottom ?? 0) - (node.top ?? 0),
});

/**
 * A layer node's rect at the dimensions of a specific pixel buffer.
 *
 * The editor projects masks onto THIS rather than `layerRect` so the mask lands
 * on exactly the grid the pixels occupy, even in the rare file where a layer's
 * decoded buffer does not match its declared bounds. Alignment then holds by
 * construction rather than by two expressions happening to agree.
 */
export const pixelRect = (node, pixels) => ({
  left: node.left ?? 0,
  top: node.top ?? 0,
  width: pixels.width,
  height: pixels.height,
});

/**
 * Reproject a layer's mask into `rect`'s own grid as 0..255 coverage.
 *
 * `mask.left/top/right/bottom` can differ from the layer's bounds, and
 * `defaultColor` fills everything outside them -- so this resolves both, once,
 * and the result has NO independent geometry left to keep in sync.
 *
 * @returns {Uint8Array | null} `rect.width * rect.height` bytes, or null when
 *   the layer has no usable mask raster.
 */
export function projectMask(node, rect) {
  const mask = node.mask;
  if (!mask || !mask.imageData) return null;

  const mw = (mask.right ?? 0) - (mask.left ?? 0);
  const mh = (mask.bottom ?? 0) - (mask.top ?? 0);
  if (mw <= 0 || mh <= 0) return null;

  const fallback = mask.defaultColor ?? 0;
  const out = new Uint8Array(rect.width * rect.height).fill(fallback);
  const src = mask.imageData.data;

  for (let y = 0; y < rect.height; y++) {
    const my = rect.top + y - mask.top;
    if (my < 0 || my >= mh) continue;
    for (let x = 0; x < rect.width; x++) {
      const mx = rect.left + x - mask.left;
      if (mx < 0 || mx >= mw) continue;
      out[y * rect.width + x] = src[(my * mw + mx) * 4]; // masks are greyscale — red channel
    }
  }
  return out;
}
```

In `src/composite.js`, add the import immediately below the file's opening
comment block, above `// ---- blend modes`:

```js
import { projectMask, layerRect } from './mask.js';
```

Then **delete** the local `maskFor` function (currently lines 171–194) and the
local `rectOf` arrow (currently lines 196–201), and point their three call sites
at the moved implementations. In `renderList`:

```js
      } else if (layer.imageData) {
        const rect = layerRect(layer);
        if (rect.width > 0 && rect.height > 0) {
          rect.mask = projectMask(layer, rect);
```

…and inside the clipped branch:

```js
              const cr = layerRect(c);
              if (cr.width <= 0 || cr.height <= 0) continue;
              cr.mask = projectMask(c, cr);
```

Add to `src/index.js`:

```js
export { layerRect, pixelRect, projectMask } from './mask.js';
```

Add to the `scripts` block of `package.json`:

```json
"test:layers": "node --max-old-space-size=6144 test/layers.mjs",
```

…and append `&& node --max-old-space-size=6144 test/layers.mjs` to the existing
`test` script so it runs in the suite.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `5 passed`

Run: `npm test`
Expected: `shim OK` → `21 files | parsed 21 | failed 0` → **`<0.5% diff: 12   <10%: 5   >=10%: 4`** → `21 passed` → `28 passed` → `53 passed` → `79 passed` → `5 passed`

The oracle line is the one that matters here. If it moved, the move was not a
move — diff `projectMask` against the deleted `maskFor` before doing anything
else.

- [ ] **Step 5: Commit**

```bash
git add src/mask.js src/composite.js src/index.js test/layers.mjs package.json
git diff --staged
git commit -m "Move the mask projection out of the compositor into src/mask.js"
```

---

### Task 2: Downscale a mask to dimensions read from the proxy buffer

**Files:**
- Modify: `src/mask.js`, `src/index.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: Task 1
- Produces: `downscaleMask(data, source, target) -> {width, height, data} | null`, where `source = {width, height}` describes `data` and **`target` supplies the output dimensions** — it is the proxy pixel buffer itself, not a scale factor

This is the whole alignment argument in one signature. `downscaleImage` computes
`Math.round(img.width * scale)`; if `downscaleMask` computed the same expression
independently, the two would agree today and be free to disagree after any
future change to either. Taking the dimensions **from the buffer the mask has to
line up with** makes disagreement unrepresentable.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`, before the final `console.log`:

```js
test('downscaleMask takes its dimensions from the target buffer, not from a scale', () => {
  // A 10x10 mask against a target of 3x2. Any implementation that recomputed
  // round(10 * scale) would produce 3x3 and shear the mask against its layer
  // by a whole row. This is the assertion the alignment claim rests on.
  const data = new Uint8Array(100).fill(255);
  const out = downscaleMask(data, { width: 10, height: 10 }, { width: 3, height: 2 });
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.equal(out.data.length, 6);
});

test('downscaleMask box-averages rather than point-sampling', () => {
  // 2x1: fully covered beside fully clear. A point sample returns 255 or 0;
  // the average is the honest answer for a coverage plane.
  const out = downscaleMask(new Uint8Array([255, 0]), { width: 2, height: 1 }, { width: 1, height: 1 });
  assert.equal(out.data[0], 128);
});

test('downscaleMask keeps a fully covered mask fully covered', () => {
  const out = downscaleMask(new Uint8Array(64).fill(255), { width: 8, height: 8 }, { width: 3, height: 3 });
  assert.deepEqual([...out.data], new Array(9).fill(255));
});

test('downscaleMask returns the source array untouched when nothing shrinks', () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const out = downscaleMask(data, { width: 2, height: 2 }, { width: 2, height: 2 });
  assert.equal(out.data, data, 'a same-size "downscale" must not allocate');
});
```

Add `downscaleMask` to the existing import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `does not provide an export named 'downscaleMask'`

- [ ] **Step 3: Write the minimal implementation**

Append to `src/mask.js`:

```js
/**
 * Box-average a projected mask down to the dimensions of a proxy pixel buffer.
 *
 * `target` is the BUFFER, not a scale. Passing `node.proxyData` here means the
 * mask reads the very dimensions its pixels ended up with, rather than
 * evaluating `Math.round(w * scale)` a second time. The two expressions agree
 * today; making one READ the other means they cannot disagree tomorrow, at any
 * rounding, at any scale, under any future change to downscaleImage.
 *
 * Box-average for the same reason downscaleImage uses one: bilinear reads four
 * neighbours and aliases badly below about half scale, which is exactly where a
 * proxy lives. No alpha weighting -- there is only one channel, and it IS the
 * coverage.
 *
 * @param {Uint8Array} data
 * @param {{width:number,height:number}} source  dimensions of `data`
 * @param {{width:number,height:number}} target  the proxy pixel buffer
 * @returns {{width:number,height:number,data:Uint8Array}|null}
 *   `data` is returned by reference when no resizing is needed.
 */
export function downscaleMask(data, source, target) {
  if (!data || !source || !target || !target.width || !target.height) return null;

  const w = target.width;
  const h = target.height;
  if (w === source.width && h === source.height) return { width: w, height: h, data };

  const out = new Uint8Array(w * h);
  const xRatio = source.width / w;
  const yRatio = source.height / h;

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(source.height, Math.max(sy0 + 1, Math.ceil((y + 1) * yRatio)));

    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(source.width, Math.max(sx0 + 1, Math.ceil((x + 1) * xRatio)));

      let sum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) { sum += data[sy * source.width + sx]; n++; }

      out[y * w + x] = n ? Math.round(sum / n) : 0;
    }
  }

  return { width: w, height: h, data: out };
}
```

Extend the `src/index.js` line added in Task 1:

```js
export { layerRect, pixelRect, projectMask, downscaleMask } from './mask.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `9 passed`

- [ ] **Step 5: Commit**

```bash
git add src/mask.js src/index.js test/layers.mjs
git diff --staged
git commit -m "Downscale masks to dimensions read from the proxy pixel buffer"
```

---

### Task 3: Single-channel bilinear resampling at render time

**Files:**
- Modify: `src/mask.js`, `src/index.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: Task 1
- Produces: `resampleMask(mask, width, height) -> Uint8Array`, where `mask = {width, height, data}`

`drawLayerInto` resamples a layer's pixels to `rect.width × rect.height`. The
mask has to arrive at the same dimensions, from the same source dimensions, or
`blendInto`'s `rect.mask[sy * rect.width + …]` indexes the wrong byte. This is
the mask's half of that pairing. It gets the same identity early-return
`resample()` has, so the default preview path — where `rect` already equals the
proxy dimensions — does no work and allocates nothing.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
test('resampleMask returns the source array itself when nothing changes size', () => {
  // The common case by a wide margin: a preview renders at proxyScale, where
  // rect.width/height already equal the proxy buffer's. Allocating a copy of
  // every mask on every frame would be pure waste.
  const mask = { width: 3, height: 2, data: new Uint8Array([0, 1, 2, 3, 4, 5]) };
  assert.equal(resampleMask(mask, 3, 2), mask.data);
});

test('resampleMask halves a mask without producing NaN or overflow', () => {
  const mask = { width: 4, height: 4, data: new Uint8Array(16).fill(120) };
  const out = resampleMask(mask, 2, 2);
  assert.equal(out.length, 4);
  for (const v of out) assert.equal(v, 120);
});

test('resampleMask upscales without leaving the 0..255 range', () => {
  const mask = { width: 2, height: 2, data: new Uint8Array([0, 255, 255, 0]) };
  const out = resampleMask(mask, 8, 8);
  assert.equal(out.length, 64);
  for (const v of out) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255, `out of range: ${v}`);
});
```

Add `resampleMask` to the import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `does not provide an export named 'resampleMask'`

- [ ] **Step 3: Write the minimal implementation**

Append to `src/mask.js`:

```js
/**
 * Bilinear resize of a coverage plane, to the exact dimensions the layer's
 * pixels are being resampled to.
 *
 * Deliberately not `resample()` from render.js: that is RGBA and would cost 4x
 * the memory and 4x the arithmetic for three channels holding the same value.
 * The identity early-return matches resample()'s (render.js:20) so the default
 * preview path -- rect already at proxy dimensions -- does no work.
 *
 * @returns {Uint8Array} `mask.data` itself when the dimensions already match.
 */
export function resampleMask(mask, width, height) {
  if (mask.width === width && mask.height === height) return mask.data;

  const out = new Uint8Array(width * height);
  const xRatio = mask.width / width;
  const yRatio = mask.height / height;

  for (let y = 0; y < height; y++) {
    const sy = Math.min(mask.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(mask.height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < width; x++) {
      const sx = Math.min(mask.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(mask.width - 1, x0 + 1);
      const fx = sx - x0;

      const a = mask.data[y0 * mask.width + x0];
      const b = mask.data[y0 * mask.width + x1];
      const c = mask.data[y1 * mask.width + x0];
      const d = mask.data[y1 * mask.width + x1];

      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      out[y * width + x] = Math.round(top + (bottom - top) * fy);
    }
  }
  return out;
}
```

Extend the `src/index.js` line:

```js
export { layerRect, pixelRect, projectMask, downscaleMask, resampleMask } from './mask.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `12 passed`

- [ ] **Step 5: Commit**

```bash
git add src/mask.js src/index.js test/layers.mjs
git diff --staged
git commit -m "Add single-channel bilinear mask resampling with an identity early-return"
```

---
### Task 4: Carry `mask`, `clipping` and `groupPath` onto the layer

**Files:**
- Modify: `src/edit.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: `projectMask`, `pixelRect` (Task 1)
- Produces, on every layer:
  - `mask: {data: Uint8Array, width: number, height: number, disabled: boolean} | null` — `width`/`height` always equal `pixels.width`/`pixels.height`
  - `clipping: boolean`
  - `groupPath: string` — `' / '`-joined group names, `''` at the top level
  - `groupWarned: boolean`
- Produces, on the project: `skippedLeaves: number`

> **Re-read `toLayer()` before editing it.** Plan 1C-1 added `sourceIndex` to the
> same object literal. Add these fields alongside what is there; do not paste a
> remembered version of the literal. The same applies to `flatten()`, whose
> signature this task changes.

Flattening destroys the only structure the file had. The group name is free at
that moment and is the difference between a panel that can describe what was
lost and one that cannot. The skipped-leaf count is what makes the
*empty document* state explicable rather than merely blank.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\nlayer model\n');

/** An eager read of the one fixture whose mask has a different origin from its layer. */
const maskedDoc = await readDocument(bytesOf('fixtures/vector-and-mask.src.psd'), { pixels: 'eager', metadata: false });
const maskedProject = createProject(maskedDoc, 'vector-and-mask.src.psd');

/** A hand-built document: one group with two leaves, one of which has no pixels. */
const grouped = () => ({
  width: 20, height: 10,
  children: [{
    name: 'Backgrounds', opacity: 0.5,
    children: [
      { name: 'Sky', left: 0, top: 0, right: 10, bottom: 10,
        proxyData: { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4) } },
      { name: 'empty', left: 0, top: 0, right: 0, bottom: 0 },
      { name: 'Clipped to sky', clipping: true, left: 0, top: 0, right: 10, bottom: 10,
        proxyData: { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4) } },
    ],
  }],
});

test('a masked layer carries its mask on the same grid as its pixels', () => {
  const layer = maskedProject.layers[0];
  assert.ok(layer.mask, 'vector-and-mask.src.psd must produce a masked layer');
  assert.equal(layer.mask.width, layer.pixels.width);
  assert.equal(layer.mask.height, layer.pixels.height);
  assert.equal(layer.mask.data.length, layer.pixels.width * layer.pixels.height);
});

test('mask.disabled is read from the file rather than assumed', () => {
  assert.equal(maskedProject.layers[0].mask.disabled, false);
});

test('clipping is carried onto the layer', () => {
  const layers = createProject(grouped(), 'grouped.psd').layers;
  assert.deepEqual(layers.map((l) => l.clipping), [false, true]);
});

test('groupPath records the groups a layer was flattened out of', () => {
  const layers = createProject(grouped(), 'grouped.psd').layers;
  assert.equal(layers[0].groupPath, 'Backgrounds');
  assert.equal(maskedProject.layers[0].groupPath, '', 'a top-level layer has no group path');
});

test('layers from a group that raised a warning are individually marked', () => {
  // The group blends at 50%, which flatten() already warns about. Without this
  // flag the warning says "somewhere in this document" and the panel cannot
  // point at the rows it is about.
  const project = createProject(grouped(), 'grouped.psd');
  assert.ok(project.warnings.some((w) => /Backgrounds/.test(w)));
  assert.deepEqual(project.layers.map((l) => l.groupWarned), [true, true]);
});

test('createProject counts the leaves flatten() dropped', () => {
  // Without this the "empty document" state is blank and inexplicable: every
  // leaf was pixel-less, and the screen can say so only if it knows how many.
  assert.equal(createProject(grouped(), 'grouped.psd').skippedLeaves, 1);
});
```

Add `readDocument` and `createProject` to the import at the top of
`test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `vector-and-mask.src.psd must produce a masked layer` (`layer.mask` is `undefined`)

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, add the import at the top of the file, below the opening
comment block:

```js
import { projectMask, pixelRect } from './mask.js';
```

Add this helper immediately above `toLayer`:

```js
/**
 * The layer's mask, on the pixel buffer's own grid.
 *
 * A streamed load has already done the expensive half inside loadProjectProxy --
 * projecting at full resolution, then shrinking to the proxy -- and left the
 * result on `proxyMask`, because reader.js releases `mask.imageData` the moment
 * onLayer returns. An eager load has no proxy step, so the projection happens
 * here against the full-resolution buffer that is still attached.
 *
 * Either way the result has NO independent geometry: it is `pixels.width` by
 * `pixels.height`, so render time resamples mask and pixels to the same target
 * from the same source and they cannot drift apart.
 */
function maskOf(source, pixelSource) {
  if (!pixelSource) return null;
  const data = source.proxyMask
    ?? (source.mask?.imageData ? projectMask(source, pixelRect(source, pixelSource)) : null);
  if (!data) return null;
  return {
    data,
    width: pixelSource.width,
    height: pixelSource.height,
    // Photoshop saves masks that are switched off. Reading the flag is not
    // optional -- honouring a disabled mask renders the file wrong in the
    // opposite direction from ignoring an enabled one.
    disabled: source.mask?.disabled === true,
  };
}
```

Add these fields to `toLayer`'s object literal, **after the existing
`sourceIndex` field and before `rerendered`**:

```js
    /**
     * Layer mask as a 0..255 coverage plane on exactly the `pixels` grid, or
     * null. blendInto has always accepted one; nothing ever supplied it, which
     * is why masked documents rendered correctly in the inspector and wrong in
     * the editor -- in preview AND in export.
     */
    mask: maskOf(source, pixelSource),
    /**
     * The file clips this layer to the one below it. NOT APPLIED: clipping is a
     * nested composite, not an alpha multiply, and it collides with the free
     * reorder this panel exists to offer. The field exists so the UI can say so
     * -- a per-row chip, a filter, and a document warning -- rather than
     * rendering the layer in full and saying nothing.
     */
    clipping: source.clipping === true,
    /** ' / '-joined names of the groups this layer was flattened out of. Assigned by flatten(). */
    groupPath: '',
    /** One of the groups this layer came from raised a flattening warning. Assigned by flatten(). */
    groupWarned: false,
```

Replace `flatten()` entirely:

```js
/**
 * Flatten the layer tree into an ordered list, bottom to top.
 *
 * Groups become pure containers: their children are spliced inline. That keeps
 * every layer individually editable, which is the point of the editor. It is
 * only lossless when a group had default opacity and blending — otherwise the
 * render changes, so we say so.
 *
 * @param {string[]} path      group names above this level, outermost first
 * @param {{skipped:number}} stats  mutated: leaves dropped for having nothing to draw
 * @param {boolean} inWarnedGroup   a group above this level raised a warning
 */
function flatten(children, out, warnings, path = [], stats = { skipped: 0 }, inWarnedGroup = false) {
  for (const node of children || []) {
    if (node.children) {
      const opacity = node.opacity ?? 1;
      const mode = node.blendMode || 'pass through';
      let raised = false;
      if (opacity !== 1 || (mode !== 'pass through' && mode !== 'normal')) {
        warnings.add(
          `Group "${node.name || 'unnamed'}" had ${mode} blending at ${Math.round(opacity * 100)}% ` +
          `opacity. Groups are flattened for editing, so this layer stack will render differently than in Photoshop.`,
        );
        raised = true;
      }
      if (node.hidden === true) {
        warnings.add(`Group "${node.name || 'unnamed'}" was hidden; its layers are individually hidden instead.`);
        raised = true;
      }

      const before = out.length;
      flatten(node.children, out, warnings, [...path, node.name || 'unnamed'], stats, inWarnedGroup || raised);
      // A hidden group hides its contents — but only its own, not everything
      // flattened so far.
      if (node.hidden === true) for (let i = before; i < out.length; i++) out[i].visible = false;
      continue;
    }
    if (!node.imageData && !node.proxyData && !node.text) {
      // Counted, not silently dropped: a document where EVERY leaf lands here
      // produces an empty panel, and "this PSD has no editable layers, N layers
      // had no pixels or text" is the only copy that explains it.
      stats.skipped++;
      continue;
    }
    const layer = toLayer(node);
    layer.groupPath = path.join(' / ');
    layer.groupWarned = inWarnedGroup;
    out.push(layer);
  }
  return out;
}
```

In `createProject`, thread the stats through and publish the count:

```js
  const warnings = new Set();
  const stats = { skipped: 0 };
  const layers = flatten(doc.children, [], warnings, [], stats);
```

…and add to the returned object, beside `warnings`:

```js
    /** Leaves flatten() dropped for carrying neither pixels nor text. Drives the empty-document copy. */
    skippedLeaves: stats.skipped,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `18 passed`

Run: `npm test`
Expected: all previous markers unchanged — `21 passed` / `28 passed` / `53 passed` / `79 passed`, oracle still `12/5/4`. Nothing reads `mask` yet, so this task adds a field and changes no pixel.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js test/layers.mjs
git diff --staged
git commit -m "Carry mask, clipping and group path onto the editable layer"
```

---

### Task 5: Build the proxy mask during a streamed load

**Files:**
- Modify: `src/load.js`, `src/reader.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: `projectMask`, `pixelRect`, `downscaleMask` (Tasks 1–2)
- Produces:
  - `readDocument`'s `onStart` payload gains `layers: number` — the leaf count, known before any decode
  - `loadProjectProxy`'s `onProgress` becomes `(decoded: number, total: number) => void`
  - every streamed node with a mask gains `node.proxyMask: Uint8Array`, sized `proxyData.width * proxyData.height`

Two things have to happen inside `onLayer` and nowhere else. `reader.js` releases
`layer.mask.imageData` the moment `onLayer` returns (`src/reader.js:164–166`), so
that is the only moment the full-resolution mask exists — the same rule proxy
pixels already follow. And the projection must run **at full resolution, before
the downscale**: resolving a sub-pixel offset between the mask's origin and the
layer's at proxy resolution quantises it into several document pixels of
misalignment. Order is load-bearing.

The leaf count rides along because it is free here and nowhere else:
`src/reader.js` computes `flattenLayers` before `onStart` fires, so a 12–20 second
decode can show a determinate bar instead of a spinner.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\nproxy masks\n');

let startInfo = null;
const progressTotals = [];
const proxyMasked = await loadProjectProxy(bytesOf('fixtures/vector-and-mask.src.psd'), {
  fileName: 'vector-and-mask.src.psd',
  proxyEdge: 48,                       // 101x98 document, so this really downscales
  onStart: (info) => { startInfo = info; },
  onProgress: (decoded, total) => { progressTotals.push([decoded, total]); },
});

test('a streamed masked load keeps the mask on the proxy pixel grid', () => {
  const layer = proxyMasked.layers[0];
  assert.ok(layer.mask, 'the mask was dropped by the streamed path');
  assert.equal(layer.mask.width, layer.pixels.width);
  assert.equal(layer.mask.height, layer.pixels.height);
  assert.ok(layer.pixels.width < layer.sourceW, 'proxyEdge 48 must actually downscale');
});

test('the proxy mask is one byte per pixel, not four', () => {
  // The whole memory argument. Sixty full-canvas masked layers at RGBA would
  // be ~189 MB of channels holding the same value.
  const layer = proxyMasked.layers[0];
  assert.ok(layer.mask.data instanceof Uint8Array);
  assert.equal(layer.mask.data.length, layer.mask.width * layer.mask.height);
});

test('onStart reports the leaf count before any layer is decoded', () => {
  assert.ok(startInfo, 'onStart never fired');
  assert.equal(startInfo.layers, 1, 'vector-and-mask.src.psd has one leaf');
  assert.equal(startInfo.width, 101);
});

test('onProgress reports the total alongside the running count', () => {
  // A determinate bar needs both numbers. Reporting only `decoded` is what
  // makes a 20-second wait indistinguishable from a hang.
  assert.deepEqual(progressTotals, [[1, 1]]);
});
```

Add `loadProjectProxy` to the import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `the mask was dropped by the streamed path` (`layer.mask` is `null`; the reader released the raster before `toLayer` could see it)

- [ ] **Step 3: Write the minimal implementation**

In `src/reader.js`, compute the leaf count and pass it to `onStart`. Replace the
`onStart` call inside the `pixels === 'stream'` branch:

```js
    // Fires after the structure parse, before any layer is decoded, so a
    // caller can size its proxies without parsing the file a second time. The
    // leaf count rides along because it is already computed here and nowhere
    // cheaper -- it is what turns a 12-20 second decode from a spinner into a
    // determinate bar.
    if (typeof onStart === 'function')
      await onStart({
        width: psd.width,
        height: psd.height,
        layers: layers.reduce((n, l) => (l.children ? n : n + 1), 0),
      });
```

Update the `onStart` JSDoc a few lines above:

```js
 * @param {(info: {width: number, height: number, layers: number}) => any} [options.onStart]
 *   `pixels: 'stream'` only. Fires once, after the structure parse and before
 *   any layer is decoded, so a caller can size proxies without a second parse.
 *   `layers` is the number of leaf nodes that will be streamed.
```

In `src/load.js`, add the import:

```js
import { projectMask, pixelRect, downscaleMask } from './mask.js';
```

…update the `onProgress` JSDoc:

```js
 * @param {{fileName?: string, source?: object|null, proxyEdge?: number,
 *          onProgress?: (decoded: number, total: number) => void}} [options]
```

…and replace the body's decode section:

```js
  let scale = 1;
  let decoded = 0;
  let total = 0;

  const doc = await readDocument(bytes, {
    pixels: 'stream',
    metadata: false,
    onStart: ({ width, height, layers }) => {
      scale = proxyScaleFor(width, height, proxyEdge);
      total = layers;
    },
    onLayer: (node) => {
      // Stash the proxy on the node itself: `doc.children` holds these same
      // object references, so createProject sees it. The full raster is
      // released by the reader as soon as this returns.
      if (node.imageData) node.proxyData = downscaleImage(node.imageData, scale);

      // The mask has to be reprojected and shrunk HERE, for two reasons.
      //
      // 1. reader.js clears `node.mask.imageData` the moment this returns, so
      //    this is the only moment the full-resolution mask exists. Do not
      //    change that release -- it is the fix for a measured leak. Work with
      //    it, exactly as proxy pixels already do.
      // 2. Order matters. Projecting at FULL resolution and shrinking second
      //    resolves any sub-pixel offset between the mask's origin and the
      //    layer's while there is still sub-pixel precision to resolve it with.
      //    Shrinking first would quantise that offset into a half-proxy-pixel
      //    error, which is several document pixels on a large document.
      //
      // The proxy's dimensions are READ FROM node.proxyData rather than
      // recomputed, so mask and pixels are the same grid by construction.
      if (node.mask?.imageData && node.imageData && node.proxyData) {
        const rect = pixelRect(node, node.imageData);
        const full = projectMask(node, rect);
        const small = full && downscaleMask(full, rect, node.proxyData);
        if (small) node.proxyMask = small.data;
      }

      decoded++;
      if (onProgress) onProgress(decoded, total);
    },
  });
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `22 passed`

Run: `npm test`
Expected: all previous markers unchanged. `test/proxy.mjs` passes `onProgress: () => { progressCalls++; }`, which ignores the new second argument, so `28 passed` is unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/load.js src/reader.js test/layers.mjs
git diff --staged
git commit -m "Build the proxy mask during the streamed load, at full resolution first"
```

---

### Task 6: Apply the mask in the renderer — the assertion the ruling stands on

**Files:**
- Modify: `src/render.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: `resampleMask` (Task 3), `layer.mask` (Tasks 4–5)
- Produces: `drawLayerInto` sets `rect.mask` when `layer.mask && !layer.mask.disabled`; `renderProject` and `renderSandwiched` inherit it, since both go through `drawLayerInto`

One branch, beside the existing resample. `rect.width/height` is the same target
the pixels are resampled to, so mask and pixels arrive at identical dimensions
from identical source dimensions, and `blendInto` indexes
`rect.mask[sy * rect.width + …]` exactly as `renderList` has always done.

**Read the deviations table before writing the assertions.** Only
`vector-and-mask.src.psd` (855 of 9898 pixels wrong today) and
`boolean.src.psd` (166 of 90000) discriminate. `gradient.src.psd` is at 0 before
and after — it is a regression guard and proves nothing about masks working.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\nmasked rendering\n');

/** renderProject against the compositor, which is the pixel-validated oracle. */
const oracle = async (file) => {
  const doc = await readDocument(bytesOf('fixtures/' + file), { pixels: 'eager', metadata: false });
  const ours = renderProject(createProject(doc, file), { scale: 1 });
  const theirs = compositeDocument(doc);
  return compareBuffers(flattenOnto(ours), flattenOnto(theirs));
};

const vectorAndMask = await oracle('vector-and-mask.src.psd');
const booleanOp = await oracle('boolean.src.psd');
const gradient = await oracle('gradient.src.psd');

test('a mask whose origin differs from its layer renders exactly as the inspector does', () => {
  // THE assertion the whole mask ruling stands on. Before this task the fixture
  // differed on 855 of 9898 pixels beyond rounding (8.64%) with a max channel
  // delta of 255 -- the mask simply was not applied. The layer sits at [-1,-1]
  // and its mask at [0,0], so this is also the alignment case: get the
  // reprojection offset wrong and a one-pixel shear survives here.
  assert.equal(vectorAndMask.beyondRounding, 0,
    `expected an exact match, got ${vectorAndMask.beyondRounding} of ${vectorAndMask.total}`);
  assert.equal(vectorAndMask.maxDelta, 0);
});

test('a rasterised vector mask renders exactly as the inspector does', () => {
  // 166 of 90000 pixels wrong before this task, max channel delta 57.
  assert.equal(booleanOp.beyondRounding, 0,
    `expected an exact match, got ${booleanOp.beyondRounding} of ${booleanOp.total}`);
});

test('a fully opaque mask still renders exactly (regression guard only)', () => {
  // gradient.src.psd was already at 0 before the mask work, because its mask is
  // fully opaque inside the layer bounds. This can prove the change did no
  // HARM. It is not evidence that masks work -- do not quote it as such.
  assert.equal(gradient.beyondRounding, 0);
});

test('a disabled mask is not applied', () => {
  // Photoshop saves masks that are switched off. Applying one is wrong in the
  // opposite direction from ignoring an enabled one, and just as invisible.
  const node = (disabled) => ({
    width: 4, height: 4,
    children: [{
      name: 'masked', left: 0, top: 0, right: 4, bottom: 4,
      proxyData: { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) },
      proxyMask: new Uint8Array(16),          // fully masked out
      mask: { disabled },
    }],
  });
  const off = renderProject(createProject(node(true), 'x.psd'), { scale: 1 });
  const on = renderProject(createProject(node(false), 'x.psd'), { scale: 1 });
  assert.equal(off.data[3], 255, 'a disabled mask must leave the layer fully drawn');
  assert.equal(on.data[3], 0, 'an enabled all-zero mask must erase the layer');
});

test('at proxyScale the mask needs no resampling at all', () => {
  // Documents the fast path rather than correctness: when the render scale IS
  // the proxy scale, rect dimensions equal the proxy grid, so resampleMask's
  // identity early-return fires and no mask is copied per frame. If this ever
  // fails, resampleMask still renders correctly -- it just costs an allocation.
  const layer = proxyMasked.layers[0];
  const rectWidth = Math.max(1, Math.round(layer.w * proxyMasked.proxyScale));
  assert.equal(rectWidth, layer.pixels.width);
  assert.equal(resampleMask(layer.mask, rectWidth, layer.pixels.height), layer.mask.data);
});
```

Add `renderProject`, `compositeDocument`, `compareBuffers` and `flattenOnto` to
the import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `expected an exact match, got 855 of 9898`

- [ ] **Step 3: Write the minimal implementation**

In `src/render.js`, add the import:

```js
import { resampleMask } from './mask.js';
```

…and in `drawLayerInto`, immediately after the two off-canvas culling returns
and before the pixel selection:

```js
  // A layer mask is a per-layer alpha multiplier and nothing else -- blendInto
  // multiplies `as` by it. It lives on exactly the same grid as `pixels`, so it
  // resamples to the same target from the same source dimensions and cannot
  // drift out of alignment under any transform at any scale.
  //
  // `disabled` is honoured: Photoshop saves switched-off masks, and applying
  // one is as wrong as ignoring an enabled one.
  if (layer.mask && !layer.mask.disabled)
    rect.mask = resampleMask(layer.mask, rect.width, rect.height);
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `27 passed`

Run: `npm test`
Expected: `21 passed` / `28 passed` / `53 passed` / `79 passed` / `27 passed`, oracle
still `12/5/4`.

`test/gpu.mjs` and `test/export.mjs` build layers with no `mask` field, and the
one fixture `test/export.mjs` uses end to end (`vectors.src.psd`) has vector
masks with no raster — so no mask is produced for it and the export oracle is
untouched. If `79 passed` moves, stop: it means the export path is now applying
a mask on one side of a comparison and not the other.

**What this task does not prove.** Masks on tiers 1–2. 1B's GPU compositor is
not written, and when it is, a masked layer needs one extra sampler and one
extra multiply on the line that already computes `as`. Until that lands and the
conformance route renders a masked fixture through both paths, **masks are
correct on the JS tier only** — which is a device-dependent wrongness, and
strictly worse than today's uniform wrongness because it cannot be reproduced on
a developer's machine. Say so when reporting. It is 2B's first obligation.

- [ ] **Step 5: Commit**

```bash
git add src/render.js test/layers.mjs
git diff --staged
git commit -m "Apply layer masks in the renderer; masked files now match the inspector"
```

---

### Task 7: The warnings the editor has been swallowing

**Files:**
- Modify: `src/edit.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: Task 4's `clipping` field
- Produces: `project.warnings` additionally contains every entry of `doc.warnings`, plus a clipping warning and a vector-mask warning when either applies

Three separate holes, one funnel. `createProject` takes a `doc` and ignores
`doc.warnings` entirely, so the `Patt` pattern warning and ag-psd's whole
`Unhandled` feature list are dropped on the floor — the editor cannot tell a user
their file uses features it ignores. Clipping is carried but silent. Vector masks
are invisible to the entire codebase: `layer.vectorMask` is never consulted, so a
vector-masked layer renders unmasked everywhere, with no warning.

The clipping copy is one of the spec's three required disclosure surfaces; the
other two (the per-row chip and the `Clipped` filter) are Task 14's `panelRows`
and 2B's chrome.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\ndocument warnings\n');

/** Four leaves, three of them vector-masked with no mask raster at all. */
const vectorsDoc = await readDocument(bytesOf('fixtures/vectors.src.psd'), { pixels: 'eager', metadata: false });

test('the reader\'s own warnings reach the project', () => {
  // createProject took a doc and ignored a field on it. Every fixture carries
  // the Patt pattern warning, and until now the editor could not surface it.
  const project = createProject(maskedDoc, 'vector-and-mask.src.psd');
  assert.ok(maskedDoc.warnings.length > 0, 'fixture must carry reader warnings');
  for (const w of maskedDoc.warnings) assert.ok(project.warnings.includes(w), `dropped: ${w}`);
});

test('clipped layers raise a warning that says clipping is not applied', () => {
  const project = createProject(grouped(), 'grouped.psd');
  const w = project.warnings.find((x) => /clipped/i.test(x));
  assert.ok(w, 'a clipped layer must raise a document warning');
  assert.match(w, /1 layer/);
  assert.match(w, /not applied/i);
});

test('a document with nothing clipped raises no clipping warning', () => {
  const project = createProject(maskedDoc, 'vector-and-mask.src.psd');
  assert.equal(project.warnings.some((x) => /clipped/i.test(x)), false);
});

test('vector masks with no raster are counted and warned about', () => {
  // Those three layers render UNMASKED, everywhere, silently — until now.
  const w = createProject(vectorsDoc, 'vectors.src.psd').warnings.find((x) => /vector mask/i.test(x));
  assert.ok(w, 'a vector-masked layer must raise a document warning');
  assert.match(w, /3 layers/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `dropped: Pattern definitions (Patt) present but not readable…`

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, add this helper above `createProject`:

```js
/**
 * Leaves carrying a vector mask that nothing in this codebase rasterises.
 *
 * ag-psd exposes `layer.vectorMask` and `mask.fromVectorData`; neither is ever
 * consulted by composite.js or render.js. A layer whose ONLY mask is vector
 * data therefore renders completely unmasked, in the inspector and the editor
 * alike. Photoshop sometimes also writes a rasterised copy into `mask.imageData`
 * -- when it has, the layer renders correctly and must not be warned about.
 */
function countUnrasterisedVectorMasks(children) {
  let n = 0;
  for (const node of children || []) {
    if (node.children) { n += countUnrasterisedVectorMasks(node.children); continue; }
    if (node.vectorMask && !node.mask?.imageData && !node.proxyMask) n++;
  }
  return n;
}
```

…and extend `createProject`, between the `flatten` call and the `return`:

```js
  // The reader's own findings -- the Patt pattern warning and ag-psd's whole
  // Unhandled feature list -- were being dropped on the floor here. The shape
  // is the real bug: createProject takes a doc and ignores a field on it.
  for (const warning of doc.warnings || []) warnings.add(warning);

  // Clipping is CARRIED but NOT APPLIED. This is one of three disclosure
  // surfaces the spec requires; the per-row chip and the Clipped filter are the
  // other two. None of them is dismissible, because the file's clip runs are a
  // permanent property of the document and reordering silently destroys them.
  const clipped = layers.filter((l) => l.clipping).length;
  if (clipped)
    warnings.add(
      `${clipped} layer${clipped === 1 ? ' is' : 's are'} clipped to the layer below. ` +
      `Clipping is not applied — ${clipped === 1 ? 'it is' : 'they are'} drawn in full and will ` +
      `differ from Photoshop. Reordering will not restore the relationship.`,
    );

  const vectorMasked = countUnrasterisedVectorMasks(doc.children);
  if (vectorMasked)
    warnings.add(
      `${vectorMasked} layer${vectorMasked === 1 ? ' has' : 's have'} a vector mask. Vector masks are ` +
      `not rasterised — ${vectorMasked === 1 ? 'that layer is' : 'those layers are'} drawn unmasked.`,
    );
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `31 passed`

Run: `npm test`
Expected: unchanged. No existing test asserts the contents or length of
`project.warnings`; `test/run.mjs` counts `doc.warnings`, which is untouched.

> The `demo/` editor and the harness both render `project.warnings` verbatim, so
> after this task every document shows the pattern warning. That is the point —
> it was always true and never said.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js test/layers.mjs
git diff --staged
git commit -m "Surface the reader's warnings, clipped layers and unrasterised vector masks"
```

---
### Task 8: Gesture-scoped coalescing and a counter that sees every frame

**Files:**
- Modify: `src/edit.js`, `src/index.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `nextGestureKey(prefix: string) -> string` — a coalesce key carrying a per-gesture nonce, e.g. `'xform#7'`
  - `project.mutation: number` — bumped inside `applyCommand`, so it advances on `commit`, on `setLayer`'s coalescing early-return, on `undo`, on `redo` and on `applyProjectJson`

Two problems, one funnel.

**The coalesce key is not gesture-scoped.** `setLayer` merges when
`previous.coalesceKey === coalesceKey && previous.id === id`. A literal key like
`'move'` — or `demo/editor.js`'s `'drag-' + layer.id` — merges two *separate*
drags of the same layer, minutes apart, into one undo entry. The key must carry
a nonce, and minting it belongs beside the code that reads it.

**Nothing observes a coalesced frame.** `project.revision` deliberately does not
move on that path, because `src/sandwich.js:107` keys its drag cache on it and
the cache surviving a gesture is 1B's whole reason for existing. But an Angular
signal, a thumbnail cache and the panel's badge row all need to know that
*something changed* on every applied command, undo included. So: a second
counter, in `applyCommand`, which is the one function every path reaches.

> **Do not "simplify" these into one counter.** Test 6 below exists to stop it.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\ncommands and counters\n');

const draggable = () => createProject(grouped(), 'grouped.psd');

test('nextGestureKey mints a distinct key on every call', () => {
  const a = nextGestureKey('xform');
  const b = nextGestureKey('xform');
  assert.notEqual(a, b);
  assert.match(a, /^xform#\d+$/);
});

test('one gesture key collapses a whole drag into one undo entry', () => {
  const project = draggable();
  const id = project.layers[0].id;
  const key = nextGestureKey('xform');
  for (let x = 1; x <= 20; x++) setLayer(project, id, { x }, key);
  assert.equal(project.history.length, 1);
  assert.equal(project.layers[0].x, 20);
  undo(project);
  assert.equal(project.layers[0].x, 0, 'one drag must undo in one step');
});

test('two gestures are two undo entries, even on the same layer and field', () => {
  // The bug a literal coalesce key produces: two drags minutes apart merge into
  // one entry, and the first one becomes unreachable.
  const project = draggable();
  const id = project.layers[0].id;
  setLayer(project, id, { x: 10 }, nextGestureKey('xform'));
  setLayer(project, id, { x: 20 }, nextGestureKey('xform'));
  assert.equal(project.history.length, 2);
});

test('mutation advances on the coalesced frames of a drag', () => {
  const project = draggable();
  const id = project.layers[0].id;
  const key = nextGestureKey('xform');
  setLayer(project, id, { x: 1 }, key);
  const after = project.mutation;
  setLayer(project, id, { x: 2 }, key);
  assert.equal(project.mutation, after + 1, 'a coalesced frame still changed pixels');
});

test('revision does NOT advance on the coalesced frames of a drag', () => {
  // Load-bearing, and the reason there are two counters. sandwich.js:107 keys
  // its drag cache on `revision`; bumping it here would rebuild `below` and
  // `above` on every frame and delete the cache's entire purpose.
  const project = draggable();
  const id = project.layers[0].id;
  const key = nextGestureKey('xform');
  setLayer(project, id, { x: 1 }, key);
  const after = project.revision;
  setLayer(project, id, { x: 2 }, key);
  assert.equal(project.revision, after, 'the sandwich cache must survive a gesture');
});

test('mutation advances on undo and on redo', () => {
  const project = draggable();
  setLayer(project, project.layers[0].id, { x: 5 });
  const afterCommit = project.mutation;
  undo(project);
  assert.equal(project.mutation, afterCommit + 1);
  redo(project);
  assert.equal(project.mutation, afterCommit + 2);
});
```

Add `setLayer`, `undo`, `redo` and `nextGestureKey` to the import at the top of
`test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `does not provide an export named 'nextGestureKey'`

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, add above `commit`:

```js
/**
 * A coalesce key scoped to ONE gesture.
 *
 * setLayer merges a command into the previous one when the keys match, which is
 * what turns four hundred pointer moves into a single undo step. A literal key
 * would also merge two SEPARATE drags of the same layer, minutes apart, and the
 * earlier one would become unreachable. The nonce is what stops that, and it
 * lives here rather than in the UI so no caller can forget it.
 *
 * Mint one at pointer-down and reuse it for the whole gesture.
 */
let gestureSerial = 0;
export const nextGestureKey = (prefix) => `${prefix}#${++gestureSerial}`;
```

Add the bump at the end of `applyCommand`, after the `reorder` branch:

```js
  /**
   * Every path reaches here: commit, setLayer's coalescing early-return, undo
   * and redo. `revision` deliberately does NOT move on the coalesced frames of
   * a drag -- that asymmetry is what lets the sandwich cache survive a gesture
   * (src/sandwich.js:103-107). Anything that must react to EVERY applied
   * change -- an Angular signal, a thumbnail, the panel's badge row -- reads
   * this counter instead. Two counters, two different questions.
   */
  project.mutation = (project.mutation ?? 0) + 1;
```

Add the field to `createProject`'s returned object, beside `revision`:

```js
    /** Bumped by every APPLIED command, coalesced drag frames and undo included. */
    mutation: 0,
```

And in `applyProjectJson`, beside the existing `revision` bump:

```js
  project.mutation = (project.mutation ?? 0) + 1;
```

Add to `src/index.js`, inside the existing `./edit.js` export block:

```js
  hitTest, toProjectJson, applyProjectJson, nextGestureKey, BLEND_MODES, FONT_STACKS,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `37 passed`

Run: `npm test`
Expected: unchanged. `test/gpu.mjs` asserts sandwich cache rebuild counts across
drag frames — if `53 passed` moves, the `revision` bump was added in the wrong
place.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js src/index.js test/layers.mjs
git diff --staged
git commit -m "Add per-gesture coalesce keys and a mutation counter every path reaches"
```

---

### Task 9: Give `rerendered` exactly one owner

**Files:**
- Modify: `src/edit.js`, `demo/editor.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `setLayer` sets `rerendered: true` itself when a **text** layer's `w`, `h` or `text` changes and the caller did not say otherwise. `applyCommand` no longer writes the field.

`rerendered` decides whether a text layer re-rasterises at its target size (sharp)
or goes through `resample()` (pixelated) — `src/render.js:154`, and HANDOFF Failed
Approach 5. It currently has **two owners with two policies**: `applyCommand`
sets it for the `text` key, `demo/editor.js` sets it for `w`/`h` in two separate
places. Phase 2 replaces the demo's claim, so Phase 2 has to settle it.

It goes in `setLayer`, not `applyCommand`, for a reason the spec did not have in
view: `applyCommand` also replays *inverted* commands during undo, and a flag
written there is never captured in the command's `from`, so undoing a text resize
would leave the layer stuck on the live renderer. `setLayer` is where `from` is
snapshotted, so deciding it there makes it invertible — which
`test/edit.mjs:229` already expects.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
const textDoc = await readDocument(bytesOf('fixtures/text.src.psd'), { pixels: 'eager', metadata: false });

test('resizing a text layer switches it to live rendering without the caller saying so', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  assert.ok(layer, 'text.src.psd must contain a text layer');
  assert.equal(layer.rerendered, false, 'should start on Photoshop pixels');
  setLayer(project, layer.id, { w: layer.w * 3, h: layer.h * 3 }, nextGestureKey('xform'));
  assert.equal(layer.rerendered, true, 'upscaling a text bitmap can only blur it');
});

test('resizing a raster layer leaves it on its own pixels', () => {
  const project = draggable();
  const layer = project.layers[0];
  setLayer(project, layer.id, { w: 40, h: 40 }, nextGestureKey('xform'));
  assert.equal(layer.rerendered, false);
});

test('undo restores the previous rerendered state', () => {
  const project = createProject(textDoc, 'text.src.psd');
  const layer = project.layers.find((l) => l.kind === 'text');
  setLayer(project, layer.id, { w: layer.w * 3 }, nextGestureKey('xform'));
  undo(project);
  assert.equal(layer.rerendered, false, 'undo must return the layer to Photoshop pixels');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `upscaling a text bitmap can only blur it` (`rerendered` is still `false`)

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, **remove** the `rerendered` assignment from `applyCommand`'s
`text` branch, leaving the two cache lines exactly as they are:

```js
      if (key === 'text') {
        Object.assign(layer.text, value);
        // Drop the cache KEY, not just the pixels — clearing only `rendered`
        // would let the next lookup hit a matching key and return null.
        layer.renderedKey = null;
        layer.rendered = null;
      } else layer[key] = value;
```

At the top of `setLayer`, immediately after the `findLayer` guard and **before**
the `from` snapshot:

```js
  // ONE owner for `rerendered`, and it has to be here rather than in
  // applyCommand: render.js:154 branches on this flag to decide whether a text
  // layer re-rasterises at its target size (sharp) or goes through resample()
  // (pixelated), and applyCommand also replays INVERTED commands. A flag set
  // there is never captured in `from`, so undoing a text resize would leave the
  // layer stuck on the live renderer. Deciding it here makes it invertible.
  //
  // Photoshop's text pixels are a bitmap; upscaling them can only blur. Raster
  // layers really are bitmaps, so resampling is all there is and the flag stays
  // false for them.
  if (layer.kind === 'text' && !('rerendered' in changes)
      && ('w' in changes || 'h' in changes || 'text' in changes))
    changes = { ...changes, rerendered: true };
```

In `demo/editor.js`, delete the two lines that made the demo a second owner.
Around line 187:

```js
    const changes = {
      x: Math.round(nx), y: Math.round(ny),
      w: Math.max(1, Math.round(nw)), h: Math.max(1, Math.round(nh)),
    };
    setLayer(project, layer.id, changes, 'drag-' + layer.id);
```

…and around line 331, where the assignment also fed a repaint condition:

```js
      const changes = { [key]: key === 'w' || key === 'h' ? Math.max(1, value) : value };
      setLayer(project, layer.id, changes,
        input.type === 'range' ? 'slider-' + layer.id + '-' + key : undefined);
      // setLayer now owns `rerendered`, so ask the layer rather than the change set.
      if (layer.kind === 'text' && (key === 'w' || key === 'h')) renderLayerPanel();
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `40 passed`

Run: `npm test`
Expected: unchanged. `test/edit.mjs:226` still passes `rerendered: true`
explicitly — the `'rerendered' in changes` guard leaves an explicit caller in
charge, so `21 passed` holds.

> **Not covered by any test:** whether the demo pages still behave. They are
> opened by hand. `test/shim.mjs` only guards `ag-psd` symbol usage, and no
> import changed, so it stays green either way.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js demo/editor.js test/layers.mjs
git diff --staged
git commit -m "Give rerendered one owner in setLayer, where undo can restore it"
```

---

### Task 10: Persist the disclosure fields

**Files:**
- Modify: `src/edit.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: Task 4's fields
- Produces: `toProjectJson` layer entries gain `clipping`, `groupPath` and `maskDisabled`; `applyProjectJson` restores all three

A saved session that loses `clipping` loses the chip, the filter and the warning
with it — the user reopens their work and the disclosure has silently vanished.
The mask **raster** is deliberately not persisted: it is rebuilt from the file on
every load, and writing a megabyte of coverage plane into a session file is
storing a second copy of the PSD.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
test('toProjectJson carries the disclosure fields and the mask toggle', () => {
  const project = createProject(grouped(), 'grouped.psd');
  project.layers[0].mask = { data: new Uint8Array(4), width: 2, height: 2, disabled: true };
  const json = toProjectJson(project);
  assert.equal(json.layers[1].clipping, true);
  assert.equal(json.layers[0].groupPath, 'Backgrounds');
  assert.equal(json.layers[0].maskDisabled, true);
  assert.equal(json.layers[1].maskDisabled, null, 'a layer with no mask has no toggle to save');
});

test('the mask raster itself is never written into the session file', () => {
  // It is rebuilt from the PSD on every load. Persisting it would put a second
  // copy of the document inside the project file.
  const project = createProject(grouped(), 'grouped.psd');
  project.layers[0].mask = { data: new Uint8Array(4), width: 2, height: 2, disabled: false };
  assert.equal(JSON.stringify(toProjectJson(project)).includes('"data"'), false);
});

test('applyProjectJson restores the mask toggle without touching the raster', () => {
  const project = createProject(grouped(), 'grouped.psd');
  const data = new Uint8Array([1, 2, 3, 4]);
  project.layers[0].mask = { data, width: 2, height: 2, disabled: false };
  const json = toProjectJson(project);
  json.layers[0].maskDisabled = true;
  applyProjectJson(project, json);
  assert.equal(project.layers[0].mask.disabled, true);
  assert.equal(project.layers[0].mask.data, data, 'the raster must survive untouched');
});
```

Add `toProjectJson` and `applyProjectJson` to the import at the top of
`test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `json.layers[1].clipping` is `undefined`

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, extend the `toProjectJson` layer mapping:

```js
    layers: project.layers.map((l) => ({
      id: l.id, name: l.name, kind: l.kind,
      visible: l.visible, opacity: l.opacity, blendMode: l.blendMode,
      x: l.x, y: l.y, w: l.w, h: l.h,
      rerendered: l.rerendered,
      // Carried so a reopened session does not silently lose the clipping
      // disclosure -- the chip, the filter and the document warning all read
      // these, and a saved project that drops them is a saved project that
      // stops telling the truth.
      clipping: l.clipping,
      groupPath: l.groupPath,
      /**
       * ONLY the toggle. The mask raster is rebuilt from the PSD on every load;
       * writing it here would store a second copy of the document.
       */
      maskDisabled: l.mask ? l.mask.disabled : null,
      text: l.text ? { ...l.text } : null,
    })),
```

…and extend `applyProjectJson`'s per-layer block, after the existing
`Object.assign`:

```js
    if (typeof saved.clipping === 'boolean') layer.clipping = saved.clipping;
    if (typeof saved.groupPath === 'string') layer.groupPath = saved.groupPath;
    // The raster is whatever this load produced; only the toggle is restored.
    if (layer.mask && typeof saved.maskDisabled === 'boolean') layer.mask.disabled = saved.maskDisabled;
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `43 passed`

Run: `npm test`
Expected: unchanged. `test/edit.mjs`'s round-trip asserts named fields, and
additive keys do not disturb it.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js test/layers.mjs
git diff --staged
git commit -m "Persist clipping, group path and the mask toggle across a session"
```

---

### Task 11: The view transform, as pure arithmetic

**Files:**
- Create: `src/view.js`
- Modify: `src/index.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createView({docScale, panX, panY}) -> View` — `docScale` maps **one document pixel to CSS pixels**; `panX/panY` are CSS px from the viewport's top-left to the document origin
  - `viewToDoc(view, clientX, clientY, viewport) -> {x, y}` and `docToView(view, docX, docY, viewport) -> {x, y}`
  - `fitView(project, viewport, {margin}) -> View`
  - `zoomAbout(view, factor, clientX, clientY, viewport, {min, max}) -> View`
  - `clampView(view, project, viewport, {minVisible}) -> View`
  - `renderScaleFor(view, proxyScale) -> number` — the ONLY scale `renderProject` is ever given
  - `cssZoomFor(view, renderScale) -> number` — the rest of the magnification, as a CSS transform
  - `maxDocScale(proxyScale) -> number`, `isPreviewQuality(view, proxyScale) -> boolean`
  - `ZOOM_MAX_FACTOR = 4`, `MIN_DOC_SCALE = 0.02`, `MIN_VISIBLE_PX = 48`

`viewport` is `{left, top, width, height}` in CSS pixels.

This is the single place a coordinate bug turns every gesture into a wrong
**edit** rather than merely a wrong picture, so it gets the strongest
verification Node can give: a swept round-trip property. `getBoundingClientRect`
arithmetic scattered through a component is untestable and silently absorbs
layout it should not.

The view never enters `renderProject`. `renderScaleFor` caps the renderer at the
proxy scale — beyond that there is no information left to reveal — and
`cssZoomFor` supplies the remaining magnification as presentation, which is why
zooming past proxy 1:1 shows proxy pixels and the UI has to say so.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\nview transform\n');

const VIEWPORTS = [
  { left: 0, top: 0, width: 390, height: 700 },
  { left: 24, top: 56, width: 360, height: 520 },
];

test('viewToDoc and docToView are exact inverses across the whole range', () => {
  // A bug here mis-EDITS the document rather than merely mis-drawing it, so it
  // gets a swept property rather than a couple of examples.
  for (const viewport of VIEWPORTS)
    for (const docScale of [0.05, 0.37, 1, 2.5, 8])
      for (const panX of [-940, -13, 0, 211])
        for (const panY of [-500, 0, 77]) {
          const view = createView({ docScale, panX, panY });
          for (const [dx, dy] of [[0, 0], [1, 1], [4961, 3508], [-30, 12]]) {
            const screen = docToView(view, dx, dy, viewport);
            const back = viewToDoc(view, screen.x, screen.y, viewport);
            assert.ok(Math.abs(back.x - dx) < 1e-9 && Math.abs(back.y - dy) < 1e-9,
              `round trip failed at ${docScale}/${panX}/${panY} for ${dx},${dy}`);
          }
        }
});

test('fitView centres the document inside the viewport with a margin', () => {
  const view = fitView({ width: 200, height: 100 }, { left: 0, top: 0, width: 400, height: 400 }, { margin: 20 });
  assert.ok(Math.abs(view.docScale - 360 / 200) < 1e-9, 'the long edge fits the usable width');
  assert.ok(Math.abs(view.panX - (400 - 200 * view.docScale) / 2) < 1e-9);
  assert.ok(Math.abs(view.panY - (400 - 100 * view.docScale) / 2) < 1e-9);
});

test('zoomAbout leaves the document point under the pointer exactly where it was', () => {
  const viewport = VIEWPORTS[1];
  const view = createView({ docScale: 1, panX: 40, panY: -12 });
  const before = viewToDoc(view, 200, 300, viewport);
  const after = viewToDoc(zoomAbout(view, 2.5, 200, 300, viewport), 200, 300, viewport);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('zoomAbout clamps to the supplied bounds', () => {
  const viewport = VIEWPORTS[0];
  const view = createView({ docScale: 1 });
  assert.equal(zoomAbout(view, 100, 0, 0, viewport, { max: 4 }).docScale, 4);
  assert.equal(zoomAbout(view, 0.0001, 0, 0, viewport, { min: 0.1 }).docScale, 0.1);
});

test('the zoom cap is 4x proxy 1:1, and anything above 1:1 is preview quality', () => {
  // Past the cap there is no information left to reveal -- layer.pixels IS the
  // proxy -- and the blur is merely larger.
  assert.equal(maxDocScale(0.25), 1);
  assert.equal(isPreviewQuality(createView({ docScale: 0.25 }), 0.25), false);
  assert.equal(isPreviewQuality(createView({ docScale: 0.26 }), 0.25), true);
});

test('the renderer is never asked for more scale than the proxy holds', () => {
  const view = createView({ docScale: 2 });
  const renderScale = renderScaleFor(view, 0.25);
  assert.equal(renderScale, 0.25, 'renderProject gets the proxy scale, never the zoom');
  assert.equal(cssZoomFor(view, renderScale), 8, 'the rest is a CSS transform');
  // Zooming OUT still asks for less work, not more.
  assert.equal(renderScaleFor(createView({ docScale: 0.1 }), 0.25), 0.1);
});

test('clampView keeps a corner of the document reachable', () => {
  const viewport = { left: 0, top: 0, width: 400, height: 400 };
  const project = { width: 1000, height: 1000 };
  const far = clampView(createView({ docScale: 1, panX: 99999, panY: -99999 }), project, viewport, { minVisible: 48 });
  assert.equal(far.panX, 400 - 48, 'panned right until only a sliver is left');
  assert.equal(far.panY, 48 - 1000, 'panned up until only a sliver is left');
});
```

Add the `src/view.js` names to the import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `does not provide an export named 'createView'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/view.js`:

```js
/**
 * The view transform: how the composited buffer is PRESENTED, never how the
 * document is stored.
 *
 * Three coordinate spaces, exactly one conversion between each pair:
 *
 *     document px --(renderScale)--> composite buffer px
 *     composite px --(cssZoom, panX/panY)--> CSS px in the viewport
 *
 * `renderProject` receives renderScale and nothing else. It never sees a pan and
 * never sees the user's zoom, so the document model cannot observe that zoom
 * exists -- which is what keeps geometry resolution-independent for export.
 *
 * The view model is explicit and is the source of truth. getBoundingClientRect
 * is a dev-time cross-check only, never the mapping: it silently absorbs layout
 * it should not.
 *
 * `viewport` throughout is {left, top, width, height} in CSS pixels.
 */

/** Zoom stops at 4x proxy 1:1. A chosen limit, not a measurement. */
export const ZOOM_MAX_FACTOR = 4;
/** Below this the document is a dot and panning stops meaning anything. */
export const MIN_DOC_SCALE = 0.02;
/** CSS px of the document that must stay inside the viewport after a pan. */
export const MIN_VISIBLE_PX = 48;

/**
 * @typedef {{docScale:number, panX:number, panY:number}} View
 *   `docScale` maps ONE DOCUMENT PIXEL to CSS pixels. `panX`/`panY` are CSS px
 *   from the viewport's top-left corner to the document's origin.
 */
export const createView = ({ docScale = 1, panX = 0, panY = 0 } = {}) => ({ docScale, panX, panY });

export const viewToDoc = (view, clientX, clientY, viewport) => ({
  x: (clientX - viewport.left - view.panX) / view.docScale,
  y: (clientY - viewport.top - view.panY) / view.docScale,
});

export const docToView = (view, docX, docY, viewport) => ({
  x: docX * view.docScale + view.panX + viewport.left,
  y: docY * view.docScale + view.panY + viewport.top,
});

/**
 * The scale renderProject is given -- and the only one it ever is.
 *
 * Capped at proxyScale because there is no full-resolution data resident to
 * zoom into: layer.pixels IS the proxy. Asking for more would upscale a
 * 1024-edge raster inside the compositor, which costs real time to produce the
 * same blur a CSS transform gives for free.
 */
export const renderScaleFor = (view, proxyScale) => Math.min(proxyScale, view.docScale);

/** Whatever magnification renderScaleFor could not supply, as a CSS transform. */
export const cssZoomFor = (view, renderScale) => view.docScale / renderScale;

/** Hard ceiling on docScale for a given proxy. */
export const maxDocScale = (proxyScale) => ZOOM_MAX_FACTOR * proxyScale;

/**
 * Above proxy 1:1 the canvas is showing proxy pixels enlarged. The UI must say
 * so -- a persistent chip -- because the alternative is a user judging an
 * export from a preview that cannot represent it.
 */
export const isPreviewQuality = (view, proxyScale) => view.docScale > proxyScale;

/** Scale the whole document into the viewport with a margin, centred. */
export function fitView(project, viewport, options = {}) {
  const { margin = 16 } = options;
  const usableW = Math.max(1, viewport.width - margin * 2);
  const usableH = Math.max(1, viewport.height - margin * 2);
  const docScale = Math.min(usableW / project.width, usableH / project.height);
  return {
    docScale,
    panX: (viewport.width - project.width * docScale) / 2,
    panY: (viewport.height - project.height * docScale) / 2,
  };
}

/**
 * Zoom by `factor`, keeping the document point under (clientX, clientY) fixed.
 *
 * Anchoring on the pointer is what makes a pinch feel like the image is being
 * stretched rather than replaced.
 */
export function zoomAbout(view, factor, clientX, clientY, viewport, options = {}) {
  const { min = MIN_DOC_SCALE, max = Infinity } = options;
  const docScale = Math.min(max, Math.max(min, view.docScale * factor));
  const anchor = viewToDoc(view, clientX, clientY, viewport);
  return {
    docScale,
    panX: clientX - viewport.left - anchor.x * docScale,
    panY: clientY - viewport.top - anchor.y * docScale,
  };
}

/**
 * Stop a pan from throwing the document off screen.
 *
 * Deliberately loose: at least `minVisible` CSS px of the document stays inside
 * the viewport on each axis. Clamping to full containment instead would fight
 * the user at every zoom level above fit.
 */
export function clampView(view, project, viewport, options = {}) {
  const { minVisible = MIN_VISIBLE_PX } = options;
  const w = project.width * view.docScale;
  const h = project.height * view.docScale;
  const keepX = Math.min(minVisible, w);
  const keepY = Math.min(minVisible, h);
  return {
    docScale: view.docScale,
    panX: Math.min(viewport.width - keepX, Math.max(keepX - w, view.panX)),
    panY: Math.min(viewport.height - keepY, Math.max(keepY - h, view.panY)),
  };
}
```

Add to `src/index.js`:

```js
export {
  createView, viewToDoc, docToView, fitView, zoomAbout, clampView,
  renderScaleFor, cssZoomFor, maxDocScale, isPreviewQuality,
  ZOOM_MAX_FACTOR, MIN_DOC_SCALE, MIN_VISIBLE_PX,
} from './view.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `50 passed`

Run: `npm test`
Expected: unchanged; nothing else imports this module yet.

- [ ] **Step 5: Commit**

```bash
git add src/view.js src/index.js test/layers.mjs
git diff --staged
git commit -m "Add the pan/zoom view model as pure, round-trip-tested arithmetic"
```

---
### Task 12: Gesture arbitration and transform arithmetic

**Files:**
- Create: `src/gesture.js`
- Modify: `src/index.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `HANDLES = ['nw', 'ne', 'se', 'sw']`, `HANDLE_HIT_CSS_PX = 22`, `TAP_SLOP_CSS_PX = 8`, `MIN_LAYER_SIZE = 1`
  - `handleAt(rect, docX, docY, radiusDoc) -> 'nw'|'ne'|'se'|'sw'|null`
  - `arbitrate({pointerCount, selection, docPoint, handleRadius}) -> {kind: 'view-pinch'|'view-pan'|'move'|'scale', handle: string|null}`
  - `anchorFor(handle, rect) -> {x, y}`
  - `resizeFrom(rect, handle, docX, docY, {min}) -> {x, y, w, h}`
  - `moveBy(rect, dx, dy) -> {x, y, w, h}`
  - `isTap(dx, dy, slop) -> boolean`

`rect` is a layer's `{x, y, w, h}` in **document** coordinates. `radiusDoc` and
`handleRadius` are also document units — the caller converts a CSS-pixel touch
target by dividing by `view.docScale`, which is why `src/view.js` exists and why
this module never sees a viewport.

The arbitration table has no ambiguous case and no mode: two fingers is always
the view, one finger inside the selection is the layer, one finger anywhere else
is the view. The cost is explicit — **the first move of any layer is
tap-then-drag** — and it buys a pan that works one-handed, a pinch that never
fights a transform, and no accidental canvas drag that mutates the document.

There is **no rotation and no flip**. The project model is `x/y/w/h` with no
sign; `renderProject` does `Math.max(1, round(w * scale))` and `resample()` would
not survive a negative dimension. A flip is a state the model cannot express, so
allowing the gesture would preview one thing and export another.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\ngestures\n');

const SEL = { x: 100, y: 100, w: 200, h: 100 };   // document coords
const inside = { x: 150, y: 150 };
const outside = { x: 900, y: 900 };
const corner = { x: 300, y: 200 };                // the SE handle

test('two pointers are always the view, even starting inside the selection', () => {
  // No ambiguous case: a pinch can never fight a transform, and a second finger
  // never turns into an accidental edit.
  const g = arbitrate({ pointerCount: 2, selection: SEL, docPoint: inside, handleRadius: 20 });
  assert.equal(g.kind, 'view-pinch');
});

test('one pointer on a corner handle scales the selection', () => {
  const g = arbitrate({ pointerCount: 1, selection: SEL, docPoint: corner, handleRadius: 20 });
  assert.equal(g.kind, 'scale');
  assert.equal(g.handle, 'se');
});

test('one pointer inside the selection moves it', () => {
  const g = arbitrate({ pointerCount: 1, selection: SEL, docPoint: inside, handleRadius: 20 });
  assert.equal(g.kind, 'move');
  assert.equal(g.handle, null);
});

test('one pointer anywhere else pans the view', () => {
  const g = arbitrate({ pointerCount: 1, selection: SEL, docPoint: outside, handleRadius: 20 });
  assert.equal(g.kind, 'view-pan');
});

test('with nothing selected, one pointer always pans', () => {
  // The whole reason the first move of a layer is tap-then-drag.
  const g = arbitrate({ pointerCount: 1, selection: null, docPoint: inside, handleRadius: 20 });
  assert.equal(g.kind, 'view-pan');
});

test('handleAt picks the nearest corner inside the radius and nothing outside it', () => {
  assert.equal(handleAt(SEL, 102, 103, 20), 'nw');
  assert.equal(handleAt(SEL, 298, 199, 20), 'se');
  assert.equal(handleAt(SEL, 200, 150, 20), null, 'the middle is not a handle');
  assert.equal(handleAt(SEL, 130, 100, 20), null, 'just past the radius is not a handle');
});

test('resizeFrom anchors the opposite corner', () => {
  assert.deepEqual(anchorFor('se', SEL), { x: 100, y: 100 });
  assert.deepEqual(resizeFrom(SEL, 'se', 400, 500), { x: 100, y: 100, w: 300, h: 400 });
  assert.deepEqual(resizeFrom(SEL, 'nw', 50, 60), { x: 50, y: 60, w: 250, h: 140 });
});

test('resizeFrom clamps at the minimum size instead of flipping, on every handle', () => {
  // A flip is a state the project model cannot express: w/h have no sign, and
  // renderProject does Math.max(1, round(w * scale)). Allowing the gesture
  // would preview a flipped layer and export an unflipped one.
  for (const handle of HANDLES) {
    const anchor = anchorFor(handle, SEL);
    const out = resizeFrom(SEL, handle, anchor.x, anchor.y);
    assert.equal(out.w, MIN_LAYER_SIZE, `${handle} produced w=${out.w}`);
    assert.equal(out.h, MIN_LAYER_SIZE, `${handle} produced h=${out.h}`);
  }
  // Dragging far PAST the anchor must not mirror the layer to the other side.
  const past = resizeFrom(SEL, 'se', -5000, -5000);
  assert.equal(past.w, MIN_LAYER_SIZE);
  assert.equal(past.x, 100, 'the anchored corner must not move');
});

test('moveBy rounds to whole document pixels and never changes size', () => {
  const out = moveBy(SEL, 12.4, -3.6);
  assert.deepEqual(out, { x: 112, y: 96, w: 200, h: 100 });
});

test('isTap is true only below the slop', () => {
  assert.equal(isTap(2, 2, TAP_SLOP_CSS_PX), true);
  assert.equal(isTap(0, 9, TAP_SLOP_CSS_PX), false);
});
```

Add the `src/gesture.js` names to the import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `does not provide an export named 'arbitrate'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/gesture.js`:

```js
/**
 * Gesture rules and transform arithmetic, as pure functions.
 *
 * The pointer EVENTS belong to the component; the decisions do not. Putting
 * "which gesture is this" and "what rect does this drag produce" in a directive
 * is how a coordinate bug becomes untestable -- and a bug here mis-EDITS the
 * document rather than merely mis-drawing it.
 *
 * Every rect below is a layer's {x, y, w, h} in DOCUMENT coordinates, and every
 * radius is in document units. A caller converts a CSS-pixel touch target by
 * dividing by view.docScale; nothing in this file knows a viewport exists.
 */

/** Four corners. No rotation handle: the model has no field for an angle. */
export const HANDLES = ['nw', 'ne', 'se', 'sw'];

/** Half of a 44px touch target, in CSS px. Divide by docScale before use. */
export const HANDLE_HIT_CSS_PX = 22;

/** Movement below this, in CSS px, is a tap rather than a drag. */
export const TAP_SLOP_CSS_PX = 8;

/** A layer may not be shrunk below one document pixel, and may not cross zero. */
export const MIN_LAYER_SIZE = 1;

const cornersOf = (rect) => ({
  nw: { x: rect.x, y: rect.y },
  ne: { x: rect.x + rect.w, y: rect.y },
  se: { x: rect.x + rect.w, y: rect.y + rect.h },
  sw: { x: rect.x, y: rect.y + rect.h },
});

/** The nearest corner handle within `radiusDoc`, or null. First-wins on ties. */
export function handleAt(rect, docX, docY, radiusDoc) {
  const corners = cornersOf(rect);
  let best = null;
  let bestDistance = Infinity;
  for (const id of HANDLES) {
    const c = corners[id];
    const d = Math.hypot(docX - c.x, docY - c.y);
    if (d <= radiusDoc && d < bestDistance) { bestDistance = d; best = id; }
  }
  return best;
}

/**
 * Which gesture a pointer-down begins.
 *
 * The only arbitration with no ambiguous case and no mode:
 *
 *   2 pointers            -> the VIEW, always. Never a layer edit.
 *   1 on a handle         -> scale the selection from the opposite corner
 *   1 inside the selection-> move the selection
 *   1 anywhere else       -> pan the VIEW
 *
 * The cost is explicit and was chosen: the first move of any layer is
 * tap-then-drag. The alternative -- one finger always moves the selection --
 * makes two-finger gestures ambiguous between pan and pinch, makes one-handed
 * panning impossible, and turns every accidental drag across the canvas into an
 * undoable document mutation.
 *
 * @param {{pointerCount:number, selection:{x,y,w,h}|null,
 *          docPoint:{x:number,y:number}, handleRadius:number}} input
 */
export function arbitrate(input) {
  const { pointerCount, selection, docPoint, handleRadius = HANDLE_HIT_CSS_PX } = input;

  if (pointerCount >= 2) return { kind: 'view-pinch', handle: null };

  if (selection) {
    const handle = handleAt(selection, docPoint.x, docPoint.y, handleRadius);
    if (handle) return { kind: 'scale', handle };
    if (docPoint.x >= selection.x && docPoint.y >= selection.y &&
        docPoint.x < selection.x + selection.w && docPoint.y < selection.y + selection.h)
      return { kind: 'move', handle: null };
  }

  return { kind: 'view-pan', handle: null };
}

/** The corner a scale gesture holds still. */
export function anchorFor(handle, rect) {
  const corners = cornersOf(rect);
  return corners[{ nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' }[handle]];
}

/**
 * The rect produced by dragging `handle` to a document point.
 *
 * Aspect ratio is NOT locked: there is no second finger free to unlock it, and
 * the model supports non-uniform w/h (as does rasteriseTextAt, deliberately --
 * sx and sy are independent there).
 *
 * NO FLIPS. Dragging past the anchor clamps at `min` rather than mirroring the
 * layer to the other side. w/h have no sign in the project model, renderProject
 * does Math.max(1, round(w * scale)), and resample() would not survive a
 * negative dimension -- so a flip would preview one thing and export another.
 */
export function resizeFrom(rect, handle, docX, docY, options = {}) {
  const { min = MIN_LAYER_SIZE } = options;
  const anchor = anchorFor(handle, rect);
  const growsRight = handle === 'ne' || handle === 'se';
  const growsDown = handle === 'sw' || handle === 'se';

  const w = Math.max(min, Math.round(growsRight ? docX - anchor.x : anchor.x - docX));
  const h = Math.max(min, Math.round(growsDown ? docY - anchor.y : anchor.y - docY));

  return {
    x: growsRight ? anchor.x : anchor.x - w,
    y: growsDown ? anchor.y : anchor.y - h,
    w,
    h,
  };
}

/** Translate a rect by a document-space delta, snapped to whole pixels. */
export const moveBy = (rect, dx, dy) => ({
  x: Math.round(rect.x + dx),
  y: Math.round(rect.y + dy),
  w: rect.w,
  h: rect.h,
});

/** Movement under the slop is a tap -- select, or deselect on a miss. */
export const isTap = (dx, dy, slop = TAP_SLOP_CSS_PX) => Math.hypot(dx, dy) < slop;
```

Add to `src/index.js`:

```js
export {
  HANDLES, HANDLE_HIT_CSS_PX, TAP_SLOP_CSS_PX, MIN_LAYER_SIZE,
  handleAt, arbitrate, anchorFor, resizeFrom, moveBy, isTap,
} from './gesture.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `60 passed`

Run: `npm test`
Expected: unchanged.

> **What these tests cannot prove.** That the arbitration is the right one for a
> thumb. Tap-then-drag is the spec's own listed open question and the first thing
> to put in front of a real user; reversing it is one branch in `arbitrate`.
> Browser-automated gesture testing is excluded by project rules, so this is
> checked against the spec's *Definition of done* list by hand, in 2B.

- [ ] **Step 5: Commit**

```bash
git add src/gesture.js src/index.js test/layers.mjs
git diff --staged
git commit -m "Add gesture arbitration and no-flip transform arithmetic"
```

---

### Task 13: The frame-budget ladder's decision function

**Files:**
- Modify: `src/gesture.js`, `src/index.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `FRAME_BUDGET_MS = 100`, `REDUCED_INTERACTION_SCALE = 0.5`
  - `chooseRenderMode(measured, context) -> {mode: 'live'|'sandwich'|'ghost'|'reduced', scale: number, pill: null|'ghost'|'preview'}`
  - `measured = {liveMs?, sandwichMs?, ghostMs?, budgetMs?}` — each `null`/absent when never measured
  - `context = {aboveAllNormal?: boolean, liveModeIsNormal?: boolean}`

The budget differs by tier, so the UI measures rather than assumes. The rung is
chosen **once, at pointer-down, from the last completed frame, and held for the
whole gesture** — escalating mid-drag makes the image jump at the worst possible
moment.

**Every number in this ladder is a chosen threshold, not a measurement.** 100 ms
is roughly where a drag stops reading as direct manipulation; the sandwich's cost
is 1B's own stated arithmetic; the 2–3 s tier-3 figure is the parent spec's
extrapolation from desktop. Nothing here has run on a phone. They are constants
so a device report can move them, and `pill` exists so the user is told when
fidelity is reduced.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
test('a gesture that fits the budget renders live and exactly', () => {
  const r = chooseRenderMode({ liveMs: 40 });
  assert.equal(r.mode, 'live');
  assert.equal(r.scale, 1);
  assert.equal(r.pill, null);
});

test('over budget, the gesture drops to the sandwich cache', () => {
  assert.equal(chooseRenderMode({ liveMs: 400, sandwichMs: 60 }).mode, 'sandwich');
});

test('a sandwich that is also over budget drops to ghost', () => {
  assert.equal(chooseRenderMode({ liveMs: 900, sandwichMs: 300, ghostMs: 20 }).mode, 'ghost');
});

test('a ghost that is still over budget drops to a reduced interaction scale', () => {
  // The bottom rung. There is nothing below it: refusing to let the user drag
  // would be worse than a blurry drag.
  const r = chooseRenderMode({ liveMs: 3000, sandwichMs: 2000, ghostMs: 400 });
  assert.equal(r.mode, 'reduced');
  assert.equal(r.scale, REDUCED_INTERACTION_SCALE);
  assert.equal(r.pill, 'preview');
});

test('ghost is a position preview unless the stack lets it be exact', () => {
  const exact = chooseRenderMode({ liveMs: 900, sandwichMs: 300, ghostMs: 20 },
    { aboveAllNormal: true, liveModeIsNormal: true });
  const approximate = chooseRenderMode({ liveMs: 900, sandwichMs: 300, ghostMs: 20 },
    { aboveAllNormal: false, liveModeIsNormal: true });
  assert.equal(exact.pill, 'ghost', 'fidelity is reduced but the composite is right');
  assert.equal(approximate.pill, 'preview', 'this one only shows where the layer WILL be');
});

test('a rung that has never been measured is tried once rather than skipped', () => {
  // Self-tuning: the first gesture on a device measures the rung it lands on,
  // and the next one uses that number. Skipping unmeasured rungs would pin
  // every device to the bottom of the ladder forever.
  assert.equal(chooseRenderMode({}).mode, 'live');
  assert.equal(chooseRenderMode({ liveMs: 400 }).mode, 'sandwich');
});
```

Add `chooseRenderMode`, `FRAME_BUDGET_MS` and `REDUCED_INTERACTION_SCALE` to the
import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `does not provide an export named 'chooseRenderMode'`

- [ ] **Step 3: Write the minimal implementation**

Append to `src/gesture.js`:

```js
/**
 * Frame budget for one drag frame, in ms.
 *
 * A CHOSEN threshold, not a measurement: roughly where a drag stops reading as
 * direct manipulation and starts reading as a sequence of jumps. It is a
 * constant so a device report can move it.
 */
export const FRAME_BUDGET_MS = 100;

/** Composite at proxyScale * this during gestures on the bottom rung only. */
export const REDUCED_INTERACTION_SCALE = 0.5;

/**
 * Pick a rung of the degradation ladder, ONCE, at pointer-down.
 *
 *   Live     full recomposite per frame                          exact
 *   Sandwich 1B's cache: below + live layer + above              see sandwichStateFor
 *   Ghost    freeze below/above at pointer-down, overlay the layer
 *   Reduced  as Ghost, composited at REDUCED_INTERACTION_SCALE
 *
 * Held for the whole gesture: escalating mid-drag makes the image jump at the
 * worst possible moment. A rung with no measurement yet (`null`) is TRIED, not
 * skipped -- otherwise the first gesture on any device would fall to the bottom
 * and stay there.
 *
 * `pill` is what the selection HUD must show. `null` means nothing to disclose;
 * `'ghost'` means fidelity is reduced but the composite is right; `'preview'`
 * means the canvas is showing where the layer WILL be, not what it will look
 * like. The sandwich's own <=2 LSB quantisation is disclosed separately, by
 * 1B's `sandwichStateFor` -- it is not this function's to report.
 *
 * NOTHING IN THIS LADDER HAS BEEN MEASURED ON A PHONE.
 */
export function chooseRenderMode(measured = {}, context = {}) {
  const { liveMs = null, sandwichMs = null, ghostMs = null, budgetMs = FRAME_BUDGET_MS } = measured;
  const { aboveAllNormal = true, liveModeIsNormal = true } = context;

  const over = (ms) => ms !== null && ms > budgetMs;

  if (!over(liveMs)) return { mode: 'live', scale: 1, pill: null };
  if (!over(sandwichMs)) return { mode: 'sandwich', scale: 1, pill: null };
  if (!over(ghostMs))
    return {
      mode: 'ghost',
      scale: 1,
      // Ghost composites the live layer over frozen halves. That is exact only
      // when the layer blends `normal` AND nothing non-`normal` sits above it;
      // otherwise it is a position preview and has to say so.
      pill: aboveAllNormal && liveModeIsNormal ? 'ghost' : 'preview',
    };

  return { mode: 'reduced', scale: REDUCED_INTERACTION_SCALE, pill: 'preview' };
}
```

Extend the `src/gesture.js` export line in `src/index.js`:

```js
export {
  HANDLES, HANDLE_HIT_CSS_PX, TAP_SLOP_CSS_PX, MIN_LAYER_SIZE,
  handleAt, arbitrate, anchorFor, resizeFrom, moveBy, isTap,
  chooseRenderMode, FRAME_BUDGET_MS, REDUCED_INTERACTION_SCALE,
} from './gesture.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `66 passed`

Run: `npm test`
Expected: unchanged.

> **These tests prove the decision, not the ladder.** They assert that a given
> set of measurements selects a given rung. Whether the rungs themselves are
> fast enough — whether a 20-layer document on tier 3 is draggable in Ghost at
> all — is a device question, and the spec carries it as an open one. 2B's debug
> readout names the active rung for exactly this reason.

- [ ] **Step 5: Commit**

```bash
git add src/gesture.js src/index.js test/layers.mjs
git diff --staged
git commit -m "Add the frame-budget ladder's decision function with honest pills"
```

---

### Task 14: The layers panel's derived list

**Files:**
- Create: `src/panel.js`
- Modify: `src/index.js`
- Test: `test/layers.mjs`

**Interfaces:**
- Consumes: Task 4's `mask`, `clipping`, `groupPath`, `groupWarned`; Task 4's `project.skippedLeaves`
- Produces:
  - `PANEL_FILTERS = ['hidden', 'text', 'masked', 'clipped', 'blended', 'faded', 'warned']`
  - `badgesFor(layer) -> {text, mask, maskOff, clipped, hidden, opacity: number|null, blendMode: string|null, groupPath: string|null, warned}`
  - `clipBaseFor(project, index) -> layer | null`
  - `panelRows(project, {search, filters, selectedId}) -> {rows, total, shown, state, skippedLeaves, selectionHidden}`
  - each row: `{layer, index, name, discriminator, secondary, badges, clipBase, selected}`

Rows come back **top of the stack first**, because the list order *is* the
z-order and the top layer is what the user sees first. The model stores index 0
at the bottom, so this is the one place the two orders are reconciled.

Three things this settles that a component would get wrong. **Duplicate names are
the norm** in real PSDs — a dozen `Layer 1` — so the discriminator is the z-index,
computed only over names that actually collide, and it is **display-only**:
nothing writes `layer.name`, because a fake rename in the undo history would be
worse than an ambiguous list. **Badges appear only when they differ from the
default**, or a 60-row list is 60 rows of `raster · normal · 100%`. And
**filtered-to-zero is a different state from an empty document** — the two have
opposite remedies, and showing the onboarding copy to someone who typed a bad
search is the classic version of this bug.

Search is a client-side substring over an in-memory array. There is no server and
no pagination anywhere in this app, so the server-paginate/client-sort trap
cannot arise here — stated so nobody introduces pagination later and creates it.
There is **no sort control**: the list order is the z-order, and a sort would
either lie about the stack or silently reorder the document.

- [ ] **Step 1: Write the failing tests**

Append to `test/layers.mjs`:

```js
console.log('\nlayers panel\n');

const px = () => ({ proxyData: { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) } });
const box = { left: 0, top: 0, right: 4, bottom: 2 };

/** Bottom to top: Layer 1, Layer 1 (grouped), Sky (hidden), SALE (text), Sticker (clipped). */
const panelDoc = () => ({
  width: 40, height: 20,
  children: [
    { name: 'Layer 1', ...box, ...px() },
    { name: 'Backgrounds', children: [
      { name: 'Layer 1', ...box, ...px(), opacity: 0.62, blendMode: 'screen' },
      { name: 'Sky', ...box, ...px(), hidden: true },
    ] },
    { name: 'SALE', ...box, ...px(), text: { text: 'SUMMER SALE', style: {} } },
    { name: 'Sticker', ...box, ...px(), clipping: true },
  ],
});
const panelProject = () => createProject(panelDoc(), 'panel.psd');

test('rows come back top of the stack first', () => {
  // The model stores index 0 at the bottom; the panel shows the top layer at
  // the top. This is the one place those two orders are reconciled.
  const { rows } = panelRows(panelProject());
  assert.deepEqual(rows.map((r) => r.name), ['Sticker', 'SALE', 'Sky', 'Layer 1', 'Layer 1']);
  assert.deepEqual(rows.map((r) => r.index), [4, 3, 2, 1, 0]);
});

test('search matches the name, the group path and a text layer\'s content', () => {
  const project = panelProject();
  assert.deepEqual(panelRows(project, { search: 'sticker' }).rows.map((r) => r.name), ['Sticker']);
  assert.deepEqual(panelRows(project, { search: 'backgrounds' }).rows.map((r) => r.name), ['Sky', 'Layer 1']);
  // A layer called "SALE" holding "SUMMER SALE" is found by what it says.
  assert.deepEqual(panelRows(project, { search: 'summer' }).rows.map((r) => r.name), ['SALE']);
});

test('filters combine with AND', () => {
  const project = panelProject();
  assert.deepEqual(panelRows(project, { filters: ['hidden'] }).rows.map((r) => r.name), ['Sky']);
  assert.deepEqual(panelRows(project, { filters: ['blended'] }).rows.map((r) => r.name), ['Layer 1']);
  assert.equal(panelRows(project, { filters: ['hidden', 'text'] }).rows.length, 0);
});

test('only colliding names get a z-index discriminator', () => {
  // Display only. Nothing writes layer.name -- a fake rename in the undo
  // history would be worse than an ambiguous list.
  const { rows } = panelRows(panelProject());
  const byName = Object.fromEntries(rows.map((r) => [r.name + ':' + r.index, r.discriminator]));
  assert.equal(byName['Layer 1:0'], '#0');
  assert.equal(byName['Layer 1:1'], '#1');
  assert.equal(byName['Sticker:4'], null, 'a unique name needs no discriminator');
});

test('an all-unnamed document discriminates every row', () => {
  // toLayer already substitutes '(unnamed)', so they all collide.
  const doc = { width: 8, height: 4, children: [{ ...box, ...px() }, { ...box, ...px() }] };
  const { rows } = panelRows(createProject(doc, 'x.psd'));
  assert.deepEqual(rows.map((r) => r.name), ['(unnamed)', '(unnamed)']);
  assert.deepEqual(rows.map((r) => r.discriminator), ['#1', '#0']);
});

test('badges are suppressed at their defaults', () => {
  // A 60-row list where every row reads "raster · normal · 100%" is 60 rows of
  // noise, and the one row that differs stops standing out.
  const { rows } = panelRows(panelProject());
  const plain = rows.find((r) => r.index === 0).badges;
  assert.deepEqual(plain, {
    text: false, mask: false, maskOff: false, clipped: false, hidden: false,
    opacity: null, blendMode: null, groupPath: null, warned: false,
  });
  const blended = rows.find((r) => r.index === 1).badges;
  assert.equal(blended.opacity, 62);
  assert.equal(blended.blendMode, 'screen');
  assert.equal(blended.groupPath, 'Backgrounds');
});

test('filtered-to-zero is a different state from an empty document', () => {
  // Opposite remedies: one needs the filters cleared, the other needs a
  // different file. Showing the onboarding copy to someone who mistyped a
  // search is the classic version of this bug.
  assert.equal(panelRows(panelProject(), { search: 'zzzz' }).state, 'filtered-to-zero');
  const empty = createProject({ width: 4, height: 4, children: [{ name: 'no pixels' }] }, 'e.psd');
  const result = panelRows(empty);
  assert.equal(result.state, 'empty-document');
  assert.equal(result.skippedLeaves, 1, 'the copy has to say how many leaves were dropped');
});

test('a selection hidden by the filter is reported, never silently dropped', () => {
  const project = panelProject();
  const sky = project.layers[2];
  const result = panelRows(project, { search: 'zzzz', selectedId: sky.id });
  assert.equal(result.selectionHidden, true, 'the panel must offer to clear, not deselect');
  assert.equal(panelRows(project, { selectedId: sky.id }).selectionHidden, false);
});

test('the clip chip names the nearest unclipped layer below', () => {
  const project = panelProject();
  const { rows } = panelRows(project);
  assert.equal(rows.find((r) => r.index === 4).clipBase, 'SALE');
  assert.equal(rows.find((r) => r.index === 3).clipBase, null, 'an unclipped layer has no base');
  // Photoshop permits a clipped layer at the bottom of the stack, and renders
  // it unclipped. The chip has to say there is nothing to clip to.
  const orphan = createProject({ width: 4, height: 4, children: [{ name: 'c', ...box, ...px(), clipping: true }] }, 'o.psd');
  assert.equal(panelRows(orphan).rows[0].clipBase, null);
  assert.equal(panelRows(orphan).rows[0].badges.clipped, true);
});
```

Add `panelRows` to the import at the top of `test/layers.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: FAIL — `does not provide an export named 'panelRows'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/panel.js`:

```js
/**
 * The layers panel's derived list.
 *
 * Pure over a project: filtering, searching, duplicate-name disambiguation,
 * badge computation and the empty-versus-filtered distinction. The component
 * renders what this returns and decides nothing.
 *
 * Rows come back TOP OF THE STACK FIRST. project.layers stores index 0 at the
 * bottom, matching the file; the panel shows the top layer at the top, matching
 * every other editor. This is the one place those orders are reconciled.
 *
 * There is deliberately NO SORT. The list order IS the z-order, so a sort would
 * either lie about the stack or silently reorder the document.
 *
 * Search is a client-side substring over an in-memory array. There is no server
 * and no pagination anywhere in this app, so the server-paginate/client-sort
 * trap cannot arise -- said out loud so nobody introduces pagination later and
 * creates it.
 */

/**
 * Every filter is an axis the model already carries. Derived from the field
 * list rather than invented, which is also how its completeness is checked.
 */
export const PANEL_FILTERS = ['hidden', 'text', 'masked', 'clipped', 'blended', 'faded', 'warned'];

/**
 * Badges, each null/false at its default value.
 *
 * A row that reads `raster · normal · 100%` is what every row would read, so it
 * says nothing and drowns the one row that differs.
 */
export const badgesFor = (layer) => ({
  text: layer.kind === 'text',
  mask: !!layer.mask,
  maskOff: !!layer.mask && layer.mask.disabled === true,
  clipped: layer.clipping === true,
  hidden: layer.visible === false,
  opacity: layer.opacity < 1 ? Math.round(layer.opacity * 100) : null,
  blendMode: layer.blendMode !== 'normal' ? layer.blendMode : null,
  groupPath: layer.groupPath || null,
  warned: layer.groupWarned === true,
});

const matchesFilter = (layer, filter) => {
  switch (filter) {
    case 'hidden': return layer.visible === false;
    case 'text': return layer.kind === 'text';
    case 'masked': return !!layer.mask;
    case 'clipped': return layer.clipping === true;
    case 'blended': return layer.blendMode !== 'normal';
    case 'faded': return layer.opacity < 1;
    case 'warned': return layer.groupWarned === true;
    default: return true;
  }
};

/**
 * The layer a clipped layer would clip to: the nearest one below that is not
 * itself clipped.
 *
 * Derived, never stored -- a reorder changes the answer, and a stored base
 * would go stale the moment the user dragged a row. Null when there is none,
 * which Photoshop permits and also renders unclipped.
 */
export function clipBaseFor(project, index) {
  for (let i = index - 1; i >= 0; i--)
    if (project.layers[i].clipping !== true) return project.layers[i];
  return null;
}

/**
 * @param {object} project
 * @param {{search?: string, filters?: string[], selectedId?: number|null}} [options]
 *   Filters combine with AND: each chip is a different axis, so "Hidden + Text"
 *   means hidden text layers.
 */
export function panelRows(project, options = {}) {
  const { search = '', filters = [], selectedId = null } = options;
  const needle = search.trim().toLowerCase();

  // Duplicate names are the norm in real PSDs -- a dozen `Layer 1`. Count first,
  // so only names that ACTUALLY collide get a discriminator.
  const counts = new Map();
  for (const layer of project.layers) counts.set(layer.name, (counts.get(layer.name) ?? 0) + 1);

  const rows = [];
  for (let i = project.layers.length - 1; i >= 0; i--) {
    const layer = project.layers[i];

    const haystack = [layer.name, layer.groupPath, layer.text?.content]
      .filter(Boolean).join(' ').toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    if (filters.length && !filters.every((f) => matchesFilter(layer, f))) continue;

    rows.push({
      layer,
      index: i,
      name: layer.name,
      /** Display only. Nothing writes layer.name -- a fake rename would enter the undo history. */
      discriminator: counts.get(layer.name) > 1 ? '#' + i : null,
      /**
       * A text layer is identified by what it SAYS. A layer named `Layer 7`
       * holding `SUMMER SALE` is unfindable by its name and obvious by its
       * content.
       */
      secondary: layer.kind === 'text' ? (layer.text?.content ?? '') : (layer.groupPath || ''),
      badges: badgesFor(layer),
      clipBase: layer.clipping ? (clipBaseFor(project, i)?.name ?? null) : null,
      selected: selectedId !== null && layer.id === selectedId,
    });
  }

  return {
    rows,
    total: project.layers.length,
    shown: rows.length,
    /**
     * Two states with OPPOSITE remedies: an empty document needs a different
     * file, a filtered-to-zero list needs the filters cleared. Showing the
     * onboarding copy to someone who mistyped a search is the classic bug here.
     */
    state: project.layers.length === 0 ? 'empty-document'
      : rows.length === 0 ? 'filtered-to-zero' : 'ok',
    /** How many leaves flatten() dropped, so the empty copy can explain itself. */
    skippedLeaves: project.skippedLeaves ?? 0,
    /**
     * The selection SURVIVES filtering -- it stays selected and stays outlined
     * on the canvas. The panel offers a "clear the filter" affordance instead
     * of silently deselecting, which would lose the user's place.
     */
    selectionHidden: selectedId !== null && !rows.some((r) => r.layer.id === selectedId),
  };
}
```

Add to `src/index.js`:

```js
export { PANEL_FILTERS, badgesFor, clipBaseFor, panelRows } from './panel.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/layers.mjs`
Expected: PASS — `75 passed`

Run: `npm test`
Expected: `shim OK` → `21 files | parsed 21 | failed 0` → `<0.5% diff: 12   <10%: 5   >=10%: 4` → `21 passed` → `28 passed` → `53 passed` → `79 passed` → `75 passed`

- [ ] **Step 5: Commit**

```bash
git add src/panel.js src/index.js test/layers.mjs
git diff --staged
git commit -m "Add the layers panel's derived list, badges and empty-state distinction"
```

---

### Task 15: Make the mask and clipping work visible in the harness

**Files:**
- Modify: `app/src/app/workers/psd-decode.worker.ts`, `app/src/app/services/psd-loader.service.ts`, `app/src/app/harness/harness.page.ts`

**Interfaces:**
- Consumes: `panelRows` (Task 14), `project.skippedLeaves` (Task 4), `onProgress(decoded, total)` (Task 5)
- Produces: a determinate load progress line, and a readout naming masked, clipped and text layers plus every document warning

> **This task cannot be verified by `npm test`.** It is a build and a device.
> Step 4 hands verification over explicitly and names what the output must say.

> **Re-read all three files before editing.** Plan 1B-1's Tasks 9–10 and Plan
> 1C-1's Task 14 both modify `harness.page.ts`, and at the time of writing
> neither had landed. Add alongside whatever is there.

Fourteen tasks of engine work are invisible until something renders them. This is
the smallest thing that makes the mask fix observable on a real file, on a real
device, and it doubles as the first real use of `panelRows` — which is how 2B
finds out whether the Angular layer really can stay as thin as it is specified to
be.

- [ ] **Step 1: Forward the layer total from the worker**

In `app/src/app/workers/psd-decode.worker.ts`, widen the progress callback:

```ts
      onProgress: (decoded: number, total: number) => postMessage({ type: 'progress', decoded, total }),
```

- [ ] **Step 2: Publish it from the service**

In `app/src/app/services/psd-loader.service.ts`, add a signal beside `progress`:

```ts
  readonly progress = signal(0);
  /** Total layers the file will stream, known from onStart before any decode. */
  readonly progressTotal = signal(0);
```

…reset it beside the existing reset:

```ts
      this.progress.set(0);
      this.progressTotal.set(0);
```

…and set it in the message handler:

```ts
        if (data.type === 'progress') {
          this.progress.set(data.decoded);
          this.progressTotal.set(data.total ?? 0);
          return;
        }
```

- [ ] **Step 3: Show what the engine now knows**

In `app/src/app/harness/harness.page.ts`, add the import:

```ts
import { panelRows } from '@engine/panel.js';
```

Add beside the other signals:

```ts
  progressTotal = this.loader.progressTotal;
```

Replace the progress line in the template with a determinate one:

```html
      @if (busy()) {
        <p class="text-slate-500">
          decoded {{ progress() }}@if (progressTotal()) { of {{ progressTotal() }} } layer(s)…
        </p>
      }
```

Extend the `info.set(...)` payload in `onPick` — **add to the object, do not
replace it**:

```ts
    // The panel's own derived list, used here for the first time. Every number
    // below is a field the editor was silently ignoring until Phase 2A.
    const panel = panelRows(project);
    this.info.set(JSON.stringify({
      canvas: `${project.width}x${project.height}`,
      layers: project.layers.length,
      proxyScale: +project.proxyScale.toFixed(4),
      skippedLeaves: project.skippedLeaves,
      masked: project.layers.filter((l: any) => l.mask).length,
      clipped: project.layers.filter((l: any) => l.clipping).length,
      text: project.layers.filter((l: any) => l.kind === 'text').length,
      panelState: panel.state,
      warnings: project.warnings,
    }, null, 1));
```

- [ ] **Step 4: Hand verification to the user**

Do **not** run the build. Ask the user to run:

```bash
cd a:/test-rnd/app && npm start
```

…open `/harness`, and report the following, from a desktop browser **and** from
the Android device:

1. **Pick `fixtures/vector-and-mask.src.psd`.** The readout must say
   `"masked": 1`, and the rendered image must show the layer **cut off by its
   mask** rather than drawn as a full rectangle. This is the whole phase in one
   picture: before Task 6 that layer rendered as a complete opaque block.
   Compare against the same file opened in the existing `demo/` inspector — they
   must now agree.
2. **Pick `fixtures/vectors.src.psd`.** The `warnings` array must contain the
   pattern warning **and** `3 layers have a vector mask`. Before Task 7 the
   reader's warnings never reached the project at all, so the array was shorter.
3. **Pick their own largest PSD** and report the `decoded N of M layer(s)` line.
   If `M` is `0`, `onStart` is not delivering the leaf count and the loading
   state is still a spinner pretending to be a bar.
4. **Report `skippedLeaves`** for each file they try. Any non-zero value is a set
   of layers the editor is silently dropping, and the number is what makes the
   *empty document* copy in 2B possible.

Record the answers in the spec's *Open questions* before 2B is written —
particularly whether any real file produces a non-zero `skippedLeaves`, which
nothing in the fixture set does except by construction.

> Nothing in this task is proven by `npm test`. That masks are applied is
> (Task 6); that Angular renders them, that the worker's progress message
> survives structured cloning with a second field, and that the mask survives the
> `postMessage` transfer list — which transfers `pixels.data.buffer` but **not**
> `mask.data.buffer`, so the mask is **copied** rather than transferred — are
> device questions. If a large masked document is noticeably slower to hand back
> from the worker than before, that copy is why, and adding
> `l.mask?.data?.buffer` to the transfer list in the worker is the fix. It is
> deliberately not done here: transferring a buffer the engine may still be
> holding a second reference to is how a layer's mask silently becomes a
> zero-length array.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/workers/psd-decode.worker.ts \
        app/src/app/services/psd-loader.service.ts \
        app/src/app/harness/harness.page.ts
git diff --staged
git commit -m "Show masks, clipping and determinate progress in the harness"
```

---

## What this plan does not cover

Deferred to **Plan 2B** (the Phase 2 screen), which depends on every interface
above:

| Spec section | What 2B owns |
|---|---|
| *Screen anatomy* | The `/editor` route replacing `/harness` as the default, the 56px top bar (back / undo / redo / warning chip / export), the horizontally scrollable 80px rail carrying only tools that work, and the two-detent bottom sheet with its `close / TITLE / search` header. `/harness` survives as the debug route — it is where `proxyW/H`, `proxyScale`, the tier indicator and the active ladder rung live, and where Plan 1C-1's Task 14 still has to land. |
| *The layers panel* | 56px rows, 40×40 masked thumbnails at 2× DPR cached by `(id, revision)`, the visibility toggle, the 32px reorder grip, the expanded selected row (opacity slider, blend mode, mask toggle, geometry readout, clip disclosure) and the grouped 26-mode blend sub-sheet — including its *current value not in the list* case for a file carrying `dissolve`. |
| *Pan and zoom* | Pointer plumbing over `src/view.js`, the CSS `transform: translate(px,px) scale(z)` presentation, fit-on-open, double-tap fit↔1:1, and the persistent `2.4× · preview quality` chip that `isPreviewQuality` decides. |
| *Gesture arbitration* | `pointerdown/move/up` wiring into `arbitrate`, the second-pointer-ends-the-drag rule, the four corner handles drawn in the view layer, and hiding them while a gesture is in flight. |
| *Frame budget* | The one-composite-in-flight rule, cancellation, the >300 ms activity indicator, `lastFrameMs` measurement per rung, the Ghost overlay with its marching-ants box, and the reduced-interaction-scale composite. `chooseRenderMode` decides; 2B measures and draws. |
| *Warnings* | The top-bar chip with its count, the warnings sheet, and the per-row `⚠` badge that `badges.warned` already computes. |
| *States* | Every row of the spec's *States* table as real screens: loading (now determinate), error, guard refusal, empty document, filtered-to-zero, export-source-unreadable, over budget, context lost. |
| *Risks* → first row | **The mask in 1B's GPU shader** — one extra sampler and one extra multiply on the line that already computes `as` — plus a masked fixture in the conformance route. Until this lands, masks are correct on tier 3 and wrong on tiers 1–2: a device-dependent wrongness that cannot be reproduced on a developer's machine. **2B's first obligation.** |
| *Undo* | Undo restoring selection context — scrolling the panel to a layer changed by an undo and selecting it, so undo never looks like it did nothing. |

Not in either plan, and going to `docs/BACKLOG.md`: **clipping**, ruled out by the
spec and disclosed three ways instead (per-row chip, `Clipped` filter, document
warning). It is a nested composite, not an alpha multiply; it needs a second FBO
pair in 1B's flat ping-pong walk, it collides with the free reorder this panel
exists to offer, and a clip run straddling the selection is not splittable by the
sandwich cache. It becomes a precondition on any future phase that wants free
reorder *and* Photoshop-faithful rendering of clipped files.

---

## Noticed, not doing in 2A

Findings from writing this plan. None are 2A work. **Append them to
`docs/BACKLOG.md` when executing** — a list that lives only in a plan document is
the same as not reporting it.

- **Export upscales the proxy mask.** `drawLayerInto` now sets `rect.mask` from
  `layer.mask`, which under a proxy load is a 1024-edge coverage plane. At export
  `rect.width` is full resolution, so `resampleMask` **enlarges** it — the mask's
  edges are softer in the export than Photoshop's. Strictly better than today
  (no mask at all), and it is the same fidelity the preview shows. The real fix
  is for `src/export/stream.js` to reproject the mask at full resolution inside
  its own `onLayer`, exactly as `loadProjectProxy` does — the reader already
  streams `layer.mask.imageData` there. It needs its own oracle, so it belongs
  in 1C-2 or later, not smuggled in here.
- **`projectMask` ignores `mask.disabled`, and `composite.js` therefore still
  applies disabled masks.** The editor now honours the flag; the inspector — the
  21-fixture oracle — does not. **Task 6's end-to-end assertion only holds
  because no fixture has `disabled: true`** (all 21 were checked). The day one
  does, the oracle will disagree with the editor and it will look like the mask
  work regressed. The spec lists this under *Noticed, not doing*, so it is left
  alone deliberately — but it is a live wrong-pixels bug in the oracle and it
  should be fixed with a fixture that proves it.
- **`userMaskDensity` and `userMaskFeather` are read by ag-psd and applied by
  nobody.** `masks.src.psd` carries `density: 0, feather: 2.8`. A 50%-density
  mask renders at full strength in the inspector and, after this plan, in the
  editor too.
- **`mask.positionRelativeToLayer`'s polarity is unverified**, which is why the
  unlinked-mask warning is not implemented (Deviation 3). ag-psd sets it from
  `flags & 1` and documents nothing. Settling it needs one PSD saved twice —
  once with the mask linked, once unlinked — and a diff of the flag. Until then
  a warning would be a coin flip shown to the user as a fact.
- **Vector masks are invisible to the whole codebase.** `layer.vectorMask` and
  `mask.fromVectorData` are never consulted, so a vector-masked layer with no
  rasterised copy renders unmasked everywhere. 2A warns about it; nothing fixes
  it, and rasterising a vector mask is a real piece of geometry work.
- **`toLayer` passes `blendMode` through unfiltered.** A layer can hold a mode
  `BLEND_MODES` does not list and `blendInto` does not implement (`dissolve` is
  the known one) and it renders as `normal` with no warning. `renderList` warns
  about `dissolve`; the project path does not. 2B's blend picker has to handle
  *current value not in the list* because of this — the warning would be cheaper.
- **`'(unnamed)'` is stored in `layer.name`**, so a layer genuinely named
  `(unnamed)` is indistinguishable from an empty one, and `toProjectJson`
  persists the substitution as if it were the file's own name. `panelRows` now
  discriminates them by z-index, which papers over it without fixing it.
- **`applyProjectJson` matches saved layers by array index** (`src/edit.js:330`)
  — the exact class of bug `sourceIndex` was added to fix, and this plan just
  added three more fields it restores positionally. It should match on
  `sourceIndex` now that one exists.
- **`hitTest` uses `layer.rendered || layer.pixels` and ignores `layer.mask`.**
  After 2A a masked-out region of a layer is invisible but still selectable, so
  tapping a hole in a masked layer selects it rather than what is behind it. One
  extra lookup beside the existing alpha test would fix it; it is not done
  because selection semantics under a *disabled* mask deserve a decision, not a
  guess.
- **The sandwich cache does not know masks exist** — it does not need to, since
  every path goes through `drawLayerInto`. But `sandwichStateFor` still decides
  exactness from blend modes alone, and a masked layer is no less exact, so
  nothing changes. Recorded because it looks like an omission and is not.
- **`estimatePeakBytes` still has no production caller** (already backlogged),
  and the peak formula it encodes is now known to be **unvalidated for masked
  documents** — the two synthetic fixtures it was measured against carry no
  masks. 2A makes mask memory strictly *better* (the full-resolution raster is
  released instead of retained), so the direction is safe, but the guard's
  calibration is untested for a whole class of file.
- **Nothing under `app/` has automated coverage**, and Task 15 adds to it. The
  mitigation is the `view.js` / `gesture.js` / `panel.js` split — but that only
  holds if 2B's Angular layer stays as thin as it is specified to be.
  **Re-check when 2B is written, not after.**
