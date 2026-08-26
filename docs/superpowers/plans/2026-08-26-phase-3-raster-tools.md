# Phase 3A — Adjustments as Per-Layer Properties, in the Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an adjustment a *stored property of a layer* that is evaluated at
render time — never baked, never aliased into the layer's own pixels, identical
at proxy resolution and at full-resolution export, and cheap enough that four
stacked adjustments cost what one costs. Everything a machine with no GPU, no
DOM and no build can prove: the adjustment maths, the LUT collapse, HSL, the
procedural overlay, the authored presets, the frozen data model on the layer,
undo and coalescing behaviour, cache invalidation, export parity, and the
generated shader's *coverage* (never its correctness).

**Architecture:** One hook, in one function. `drawLayerInto` (`src/render.js`)
is the single point every render path already shares — `renderProject`,
`renderSandwiched` and `createJsExportTarget` all call it — so the adjustment
pass goes in there, **after** `resample()` / `textPixelsAt()` and **before**
`blendInto()`, and preview, drag cache and full-resolution export inherit it
with no second implementation. Every class-A (per-channel) operation collapses
into a single 3 × 256 lookup table built once per parameter change, so stack
depth stops costing anything; exactly one cross-channel operation (`hsl`) and
one positional operation (`overlay`) are evaluated per pixel, and both are
skipped when neutral. Nothing has a pixel radius, so nothing needs a
`proxyScale` term anywhere.

**Tech Stack:** Node 24 (ESM, `node:assert/strict`), `ag-psd` 31, Ionic 8 +
Angular standalone + Capacitor 8, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-08-26-phase-3-raster-tools-design.md`](../specs/2026-08-26-phase-3-raster-tools-design.md)

---

## This is part 1 of 2

Phase 3's spec is larger than one executable plan. As in 1B, 1C and 2, it is
split at the line where verification changes hands:

| Plan | Covers | Verified by |
|---|---|---|
| **3A — this document** | `src/adjust/*` (ops, LUT, scratch, apply, presets, GLSL assembly); the `adjust` field on the layer; `setAdjust`, `discardTo` and persistence; the `drawLayerInto` hook and the two cost counters; export parity; sandwich-cache invalidation; the `Adjusted` badge and filter; the generated shader's coverage assertion; conformance Table D's generator | `npm test` (Tasks 1–16) and the user's build + device (Task 17) |
| 3B — *not yet written* | The four Angular tool sheets (Filter, Adjust, HSL, Overlay) with PixelPerfect's `✕ / TITLE / ✓` header; the preset strip with per-layer live thumbnails; slider→`setAdjust` plumbing and gesture keys; the sheet-session `discardTo` bookkeeping; the `◑ adjusted` row badge and `Adjusted` chip rendered in the Phase 2 panel; the `lut: N / hsl: M` debug readout; **uploading the 768 LUT bytes as a 256 × 1 texture and wiring the shader stage's uniforms**; Table D run against a real GPU | a real device, only |

The split is not a scope cut. Every requirement in the spec lands in one of the
two plans, and 3A leaves 3B **named, typed functions** to call rather than gaps:
`createAdjust`, `presetAdjust`, `setAdjust`, `discardTo`, `buildLut`,
`adjustCostOf`, `createRenderStats`, `CONFORMANCE_ADJUSTMENTS`. 3B writes
components and one texture upload; it writes no arithmetic.

3A ships something real on its own. After Task 11 a layer can carry a filter, a
tone adjustment, an HSL shift and a gradient overlay, and they render correctly
in preview, in the drag cache and in a full-resolution export — asserted inside
`npm test`, including the assertion the whole cost design stands on (Task 2) and
the assertion the whole *non-destructive* claim stands on (Task 11).

---

## Deviations from the spec, and why

Ten, all found by reading the code the spec describes. Each is implemented the
corrected way; the spec's text is otherwise binding.

1. **Op evaluators take their own parameter, not the whole `adjust` object.**
   The spec's illustrative `buildLut` calls `OPS[op].eval(x, c, adjust)`. The
   signature here is `OPS[id].evaluate(x, channel, value)`. Handing an op the
   whole object invites one op to read another's parameter, and the moment one
   does it is no longer a function of a single channel value — which is exactly
   the property that makes the LUT collapse legal. Narrowing the signature makes
   the collapse's precondition structural instead of remembered.

2. **Class-A ops carry NO GLSL body, deliberately.** The spec's decision table
   says every op declares a JS body *and* a GLSL body, and a Node test asserts
   the key sets match. But the spec's own parity argument says class A reaches
   the GPU as the **768 LUT bytes**, sampled with `texelFetch`, with no shader
   arithmetic at all. Emitting a GLSL body for `contrast` as well would create
   a second implementation of a thing that has no second implementation — the
   precise divergence the LUT design exists to make impossible. So class-A
   entries declare `lut: true, glsl: null`, and the coverage test asserts a
   **three-way exhaustiveness** instead: every op is LUT-carried, or has a
   non-empty GLSL body, or carries a named `gpuDeferred` reason. No op may be
   silently absent from all three. That is a stronger assertion than the spec's,
   and it is what makes deviation 3 declared rather than forgotten.

3. **The overlay's shader is deferred, and the deferral is declared in the op
   table.** An overlay carries its *own* blend mode, chosen from the same 26.
   The fragment program already specialises on the *layer's* blend mode
   (`programNameFor`, one program per mode, deliberately never a switch on a
   uniform). Supporting an overlay mode too makes the program key a
   26 × 26 matrix, which `programNameFor` cannot express and which nothing in
   the 1B design anticipated. Rather than invent that here — untestable, in a
   phase with no GPU — `overlay` declares
   `gpuDeferred: 'a per-layer overlay blend mode multiplied by the layer's own is a 26x26 program matrix; see 1B-2'`,
   the coverage test asserts the reason is present and non-empty, and the
   consequence is stated plainly: **a layer carrying an overlay cannot run on a
   GPU tier until 1B-2 resolves the program key.** Today that costs nothing —
   `selectTier` returns `TIER_JS` for every layer anyway.

4. **`digest` is `lutDigest`, and covers class A only.** The spec names one
   `digest(adjust)` and uses it as the LUT cache key. The LUT does not depend on
   `hsl` or `overlay`, so including them would rebuild 768 entries every time a
   hue band moved — pure waste, once per frame, for the whole of an HSL drag.
   `lutDigest` is the class-A slice and nothing else, which makes the cache key
   *complete* by construction: it needs no source-pixel identity and no
   destination dimensions, so the `lut` / `lutKey` pair cannot go stale the way
   `rendered` / `renderedKey` can.

5. **HSL skips pixels whose alpha is 0.** Two colour-space conversions per
   pixel is the expensive pass; a pixel with zero alpha is never read by
   `blendInto` (`as <= 0` → `continue`) and is normalised away by `flattenOnto`
   before any comparison. Skipping it is invisible to every consumer and is
   free. Stated because it is a deliberate JS/GPU behavioural difference in a
   region no consumer can observe, and someone will notice it in a diff.

6. **The overlay carries `cx`, `cy` and `radius`.** The spec's prose specifies
   "radial (centre, radius)"; its data-model block lists only
   `kind / angle / stops / mode / opacity`. The three fields are added, all in
   **normalised layer coordinates**, so the scale-invariance argument is
   unaffected.

7. **The overlay reuses `blendInto`, one row at a time, and restores the alpha
   column afterwards.** Reimplementing 26 blend modes inside the overlay would
   be a second compositor that can drift from the oracle. Instead the gradient
   is generated into a one-row buffer and handed to `blendInto` with
   `rect.height = 1` — one `w × 4` allocation rather than a second full-size
   scratch, and the arithmetic is the oracle's own. **But `blendInto` is a
   general compositor: `ao = as + ab(1 - as)` raises alpha on any partially
   transparent pixel.** An overlay tints; it does not add coverage. So the
   destination's alpha column is captured before the call and written back
   after, which is what keeps invariant A true rather than nearly true.

8. **`applyAdjustments` takes a fourth parameter.** The spec's signature is
   `applyAdjustments(pixels, adjust, out)`. It is
   `applyAdjustments(pixels, adjust, out, lut)` here, so the caller can pass the
   layer's cached table instead of rebuilding 768 entries per layer per frame.
   `lut` is optional and defaults to `buildLut(adjust)`.

9. **One test file, `test/adjust.mjs`, not five.** The spec's definition of done
   lists new suites for `lut.js`, `ops.js`, `apply.js` and the GLSL assertion.
   They land as labelled sections of one file, matching `test/proxy.mjs` and
   `test/layers.mjs`, which each cover four modules in one file with one `npm`
   script. The three `src/panel.js` assertions (Task 14) live there too, beside
   the model they describe.

10. **No text-layer adjustment assertion runs in Node.** `create2dSurface`
    returns `null` outside a browser, so `textPixelsAt` returns `null` and a
    text layer never produces pixels here. That the adjustment applies to a
    re-rendered text layer **is not proven by `npm test`** — it follows from the
    hook sitting below both branches of `drawLayerInto`, and it is on Task 17's
    device checklist. Say so when reporting; do not let a green suite imply it.

---

## Global Constraints

- **THE ADJUSTMENT PASS MUST NEVER WRITE INTO ITS INPUT.** This is the single
  most dangerous defect available in this phase and it is not theoretical — it
  was confirmed by running it, not by reading. On the **default preview path**
  `resample()` identity-returns its argument (`src/render.js:20`): an
  untransformed layer rendered at `proxyScale` asks for exactly the dimensions
  the proxy already has, so `out === layer.pixels` — measured, 256×256 in,
  256×256 out, **the same object**. `textPixelsAt` does the same with
  `layer.rendered`, and export passes `options.pixels` straight through. An
  adjustment applied in place therefore **permanently overwrites the layer's
  original pixels**, and because the next frame reads the same buffer it
  **compounds on every frame of a drag** — a held brightness slider runs away to
  white and a held saturation slider drifts, with nothing on screen announcing
  it. It destroys the non-destructive guarantee the whole editor is built on,
  and it looks like a working feature for exactly one frame.

  **Every task that touches pixel output allocates; none mutates in place.**
  Three defences, all mandatory:
  1. `applyAdjustments` throws when its output aliases its input — including
     overlapping views of the *same* `ArrayBuffer`, not just the same typed
     array (Task 4).
  2. Task 11 asserts it directly against a real render: `out !== layer.pixels`,
     `layer.pixels.data` byte-identical to a copy taken before the render, and
     two consecutive renders byte-identical to each other.
  3. Task 11 also pins the *precondition* — that `resample()` really does
     identity-return — so nobody "fixes" the early return away and quietly
     removes the reason the guard exists.

- **No operation modifies alpha (invariant A).** `blendInto` reads
  `src[si + 3]` for `as`, `rect.mask` multiplies it, `hitTest` thresholds it at
  `> 8`, and `composite.js`'s `alphaMap` builds clipping from it. One invariant
  keeps four consumers correct and it is silent in three of them. Every pass in
  this plan copies alpha through untouched, and Tasks 4, 5 and 6 each assert it
  across every alpha band.

- **No operation has a pixel radius.** Ruled by the spec on three independent
  grounds. Every op here is pointwise and carries no length parameter, so
  proxy and full resolution agree by construction and no `proxyScale` term
  appears anywhere in `src/adjust/`. If a task ever needs one, the task is
  wrong.

- **`layer.adjust` is replaced wholesale, never mutated.** `setLayer` captures
  `from[key] = layer[key]` **by reference** for object-valued fields, so a
  caller that mutates the object and passes the same one has destroyed the undo
  entry before it was written. `createAdjust` deep-freezes every object it
  builds so an in-place mutation throws in strict mode instead of silently
  corrupting history, and Task 8 mutates through a stale reference and asserts
  undo still restores.

- **Engine code is plain ESM JavaScript in `src/`** — no TypeScript, no
  framework imports. Consumed by Node tests, the `demo/` pages and the Angular
  app alike.

- **Do not run build commands.** Per project rules, the user builds and
  verifies. Task 17 hands verification over explicitly and names what the output
  must say.

- **`toLayer()` is edited by four phases now.** 1C-1 added `sourceIndex`; 2A
  added `mask`, `clipping`, `groupPath`, `groupWarned`; this plan adds `adjust`
  to the **same object literal**. Task 8 must **re-read the current
  `toLayer()`** and add alongside what is there — never paste a remembered
  version. The same warning applies to `toProjectJson` and `applyProjectJson`,
  which Task 10 extends.

- **`app/src/app/harness/harness.page.ts` is edited by four plans.** 1B-1's
  Tasks 9–10, 1C-1's Task 14 and **2A's Task 15** all modify it. At the time
  this plan was written, **none of the three had landed** — `git log` ends at
  2A's Task 14 (`327a90f`), and the file is still 99 lines with a
  `decoded {{ progress() }} layer(s)` line and no `panelRows` import. Task 17
  must re-read the file and add to it, never overwrite it.

- **`test/shim.mjs` walks `src/` recursively.** None of the six new
  `src/adjust/` modules imports `ag-psd`, so the guard stays green. If that ever
  changes, add the symbol to `demo/shims/ag-psd.js` in the same commit.

- **Comparison tolerance is 1**, via `stat.percentReal` / `stat.beyondRounding`,
  never `stat.percent`. `flattenOnto()` both buffers before comparing.

- **The scratch is live for exactly one statement.** `drawLayerInto` acquires
  it, `applyAdjustments` fills it, `blendInto` consumes it on the next line, all
  synchronously. Nothing may retain a reference to it across a call — the next
  layer overwrites it.

- **Stage exact files.** Never `git add .` or `git add <dir>`; read
  `git diff --staged` before every commit.

- **A green `npm test` proves the JS render path.** It says nothing about a
  compiled shader, a finger, a sheet, a thumbnail, or a frame budget on a phone.
  Do not report a green suite as if it settled those.

- Test scripts run with `--max-old-space-size=6144` where they load fixtures.

- Branch: `phase-1-engine-gpu-memory`. Do not push without explicit approval.

**Expected baseline before Task 1.** Run `npm test` and confirm these seven
markers appear, in this order (verified while writing this plan):

```
shim OK
21 files | parsed 21 | failed 0
21 files  |  <0.5% diff: 12   <10%: 5   >=10%: 4   skipped: 0
21 passed          <- test/edit.mjs
28 passed          <- test/proxy.mjs
53 passed          <- test/gpu.mjs
79 passed          <- test/export.mjs
75 passed          <- test/layers.mjs
```

If any of those differs, stop and report it before starting — every "Expected"
below is written against this baseline. The oracle line (`12/5/4`) must not move
at any point in this plan: nothing here touches `composite.js`'s arithmetic.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/adjust/ops.js` | The op table. Per op: class, parameter range, neutral value, JS evaluator, and either a GLSL body or a declared GPU deferral. Plus the data-model constructor `createAdjust` (deep-freezing), the HSL band table, and the HSL/overlay normalisers and neutral predicates. Pure data + pure functions + strings. |
| `src/adjust/lut.js` | `buildLut` — the class-A collapse. `lutDigest`, `lutFor`, `isNeutralAdjust`, `adjustCostOf`. |
| `src/adjust/scratch.js` | One monotonically-growing buffer per render context. `createScratch`, `acquireScratch`, `releaseScratch`, `DEFAULT_SCRATCH`. |
| `src/adjust/apply.js` | `applyAdjustments` — the per-pixel pass, with the aliasing guard. The HSL and overlay stages. |
| `src/adjust/presets.js` | The 14 named filters, authored here as parameter bundles. `PRESETS`, `PRESET_IDS`, `presetAdjust`. |
| `src/adjust/glsl.js` | Assembles the adjustment stage of the fragment shader from `ops.js`. Pure strings. |
| `test/adjust.mjs` | Suite for all of the above, plus the `edit.js`, `render.js`, `sandwich.js`, `panel.js`, `export/target-js.js` and `conformance.js` changes. |

**Modified:**

| File | Change |
|---|---|
| `src/render.js` | One hook in `drawLayerInto`; `stats` and `scratch` options; `createRenderStats` |
| `src/sandwich.js` | Thread `stats` through to `renderProject` and `drawLayerInto` |
| `src/edit.js` | `adjust` on the layer; `setAdjust`; `discardTo`; `adjust` through `toProjectJson` / `applyProjectJson` |
| `src/panel.js` | The `adjusted` badge and the `Adjusted` filter |
| `src/export/target-js.js` | The target owns and releases its own scratch |
| `src/gpu/glsl.js` | Splice the adjustment stage between `texture(uSource, uv)` and the `as` computation |
| `src/conformance.js` | Table D: `CONFORMANCE_ADJUSTMENTS`, `conformanceAdjustProject`, `CONFORMANCE_TABLE_D_NOTE` |
| `src/index.js` | Export the new modules |
| `package.json` | `test:adjust` script |
| `test/layers.mjs` | One existing `deepEqual` on the badge object gains the new key (Task 14) |
| `app/src/app/harness/harness.page.ts` | Task 17: make the adjustment work visible on a device |

---

### Task 1: The op table, the parameter schema and the frozen constructor

**Files:**
- Create: `src/adjust/ops.js`, `test/adjust.mjs`
- Modify: `src/index.js`, `package.json`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CLASS_A_ORDER: string[]` — the five per-channel op ids, in the order `buildLut` composes them
  - `OPS: Record<string, {class, lut, glsl, gpuDeferred, range, neutral, label, evaluate}>` where `evaluate(x: number, channel: 0|1|2, value: number) -> number` in 0..255 space, **unclamped**
  - `NEUTRAL_ADJUST` — the frozen all-neutral object
  - `createAdjust(partial) -> object` — complete, range-clamped, **deeply frozen**

Every class-A op is a function of one channel value and one parameter, and
nothing else. That is not a style choice: it is the precondition that makes the
LUT collapse in Task 2 legal. Narrowing `evaluate`'s signature so an op
*cannot* read a neighbour's parameter makes the precondition structural.

Clamping happens **once**, in `buildLut`, at the end of the whole composition.
Each `evaluate` returns an unclamped float, so composing five ops does not
clip five times and lose the highlights an exposure lift could have recovered.

- [ ] **Step 1: Write the failing tests**

Create `test/adjust.mjs`:

```js
import assert from 'node:assert/strict';
import {
  CLASS_A_ORDER, OPS, NEUTRAL_ADJUST, createAdjust,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('\nthe op table\n');

test('every class-A op\'s declared neutral IS the identity, on every channel, for all 256 values', () => {
  // The whole LUT design rests on this. buildLut runs EVERY op at EVERY entry,
  // including the ones sitting at neutral -- so if one op's neutral is not
  // exactly the identity, a document with no adjustments at all would render
  // through a LUT that is not the identity table, and every image in the app
  // would shift by a greylevel with nothing to blame it on.
  for (const id of CLASS_A_ORDER) {
    const op = OPS[id];
    for (let c = 0; c < 3; c++)
      for (let v = 0; v < 256; v++)
        assert.equal(op.evaluate(v, c, op.neutral), v, `${id} at neutral, channel ${c}, value ${v}`);
  }
});

test('every evaluator stays finite at both extremes of its range', () => {
  // A NaN here would be stored as 0 by Uint8Array without a word of complaint,
  // so it has to be caught at the evaluator rather than at the table.
  for (const id of CLASS_A_ORDER) {
    const op = OPS[id];
    for (const value of op.range)
      for (let c = 0; c < 3; c++)
        for (let v = 0; v < 256; v++) {
          const out = op.evaluate(v, c, value);
          assert.ok(Number.isFinite(out), `${id} at ${value}, channel ${c}, value ${v} -> ${out}`);
        }
  }
});

test('CLASS_A_ORDER lists exactly the class-A ops, and nothing else does', () => {
  const declared = Object.keys(OPS).filter((id) => OPS[id].class === 'A');
  assert.deepEqual([...CLASS_A_ORDER].sort(), declared.sort());
  for (const id of CLASS_A_ORDER) assert.equal(OPS[id].lut, true, `${id} must be LUT-carried`);
});

test('createAdjust clamps an out-of-range parameter into its declared range', () => {
  const a = createAdjust({ brightness: 5000, contrast: -5000, exposure: 'nonsense' });
  assert.equal(a.brightness, 100);
  assert.equal(a.contrast, -100);
  assert.equal(a.exposure, 0, 'an unparseable value falls back to neutral, never to NaN');
});

test('createAdjust returns a DEEPLY frozen object', () => {
  // setLayer captures object-valued `from` BY REFERENCE. A caller that mutates
  // the object it passes has destroyed the undo entry before it was written --
  // and the failure is invisible until someone presses undo. Freezing turns
  // that into a throw at the point of the mistake.
  const a = createAdjust({ brightness: 10, hsl: { saturation: -20, bands: [] } });
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.hsl));
  assert.throws(() => { 'use strict'; a.brightness = 0; }, TypeError);
});

test('createAdjust fills every missing parameter and drops unknown keys', () => {
  const a = createAdjust({ brightness: 4, nonsense: 12 });
  for (const id of CLASS_A_ORDER) assert.equal(typeof a[id], 'number', `${id} missing`);
  assert.equal(a.nonsense, undefined);
  assert.equal(a.preset, 'none');
  assert.deepEqual(createAdjust(), { ...NEUTRAL_ADJUST });
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/index.js' does not provide an export named 'CLASS_A_ORDER'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/adjust/ops.js`:

```js
/**
 * The adjustment op table.
 *
 * Pure data, pure functions and strings -- no DOM, no WebGL -- so `npm test`
 * imports it directly. Same construction as src/gpu/modes.js, and for the same
 * reason: a table that both the renderer and the shader generator read cannot
 * grow an entry on one side only.
 *
 * THREE CLASSES, and the class is what decides the cost:
 *
 *   'A'  per-channel pointwise. Composes into ONE 3x256 lookup table, so any
 *        number of stacked class-A ops costs three array indexes per pixel.
 *        Reaches the GPU as the LUT's 768 BYTES -- never as shader arithmetic --
 *        which is why these entries carry `glsl: null` and contribute exactly
 *        zero GPU/JS divergence risk.
 *   'B'  cross-channel pointwise. Cannot be a per-channel table; evaluated per
 *        pixel, in two implementations that have to agree. There is exactly one
 *        of these (`hsl`) and it stays one.
 *   'P'  positional -- pointwise in the pixel's NORMALISED position in the
 *        layer rect, so it is scale-invariant and tiles with no halo.
 *
 * Every evaluator works in the 0..255 non-linear space composite.js blends in.
 * Photometrically that is wrong -- "exposure" in gamma space is not exposure --
 * but it is CONSISTENT WITH THE ORACLE, which is what conformance measures
 * against. Adopting linear light would make the JS compositor a systematically
 * worse reference, and it cannot be done in the same phase as validating a new
 * feature. The UI never labels a control in photometric units.
 *
 * Evaluators return UNCLAMPED floats. buildLut clamps once, at the end of the
 * whole composition, so five stacked ops do not clip five times.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The class-A ops, in the order buildLut composes them.
 *
 * Pointwise operations DO NOT COMMUTE, so this order is a decision, not an
 * implementation detail: gains first, then the additive offset, then contrast
 * last so it pivots on the tone-mapped result rather than on the original.
 * An undeclared order is a bug the user finds by getting a different result
 * than the same sliders gave yesterday.
 */
export const CLASS_A_ORDER = ['exposure', 'temperature', 'tint', 'brightness', 'contrast'];

export const OPS = {
  exposure: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Exposure', range: [-100, 100], neutral: 0,
    // A pure gain: +100 doubles, -100 halves. Labelled Brightness+ in the UI,
    // never "Exposure (EV)" -- see the gamma-space note above.
    evaluate: (x, _c, v) => x * Math.pow(2, v / 100),
  },
  temperature: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Temperature', range: [-100, 100], neutral: 0,
    // Warm/cool as a per-channel GAIN -- it reads one channel and writes it,
    // with a different constant per channel, so it is still class A.
    evaluate: (x, c, v) => x * (c === 0 ? 1 + 0.30 * (v / 100) : c === 2 ? 1 - 0.30 * (v / 100) : 1),
  },
  tint: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Tint', range: [-100, 100], neutral: 0,
    // Green/magenta, same shape: positive pulls magenta, negative pulls green.
    evaluate: (x, c, v) => x * (c === 1 ? 1 - 0.30 * (v / 100) : 1 + 0.15 * (v / 100)),
  },
  brightness: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Brightness', range: [-100, 100], neutral: 0,
    // Additive, +/-128 at the extremes -- half the range, which is as far as a
    // single slider should be able to push before the clamp eats everything.
    evaluate: (x, _c, v) => x + 1.28 * v,
  },
  contrast: {
    class: 'A', lut: true, glsl: null, gpuDeferred: null,
    label: 'Contrast', range: [-100, 100], neutral: 0,
    // Pivoted on mid-grey. The positive branch is a reciprocal so the gain
    // grows smoothly to 10x rather than jumping; the negative branch collapses
    // linearly to a flat grey at -100. Both give exactly 1 at v = 0, and
    // 127.5 + (x - 127.5) is exact for every integer x in 0..255, so the
    // neutral case is bit-exact rather than nearly so.
    evaluate: (x, _c, v) => {
      const k = v / 100;
      const gain = k >= 0 ? 1 / (1 - 0.9 * k) : 1 + k;
      return 127.5 + (x - 127.5) * gain;
    },
  },
};

/**
 * Freeze an object and everything reachable from it.
 *
 * Not decoration. `setLayer` does `from[key] = layer[key]`, so an object-valued
 * field's undo entry holds THE SAME OBJECT as the new value. A caller that
 * mutates in place has destroyed the undo entry before it was written, and
 * nothing complains until someone presses undo. Freezing makes that a TypeError
 * at the point of the mistake instead of a silent loss later.
 */
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};

/** The neutral value of the whole object. `null` on a layer means this. */
export const NEUTRAL_ADJUST = deepFreeze({
  preset: 'none',
  exposure: 0, temperature: 0, tint: 0, brightness: 0, contrast: 0,
  hsl: null, overlay: null,
});

/**
 * Build a complete, range-clamped, deeply frozen adjustment object.
 *
 * The ONLY sanctioned way to make one. Everything else -- presets, sliders,
 * a reopened project file -- goes through here, so an out-of-range number from
 * a hand-edited save cannot reach an evaluator, and no caller can hand a
 * mutable object to setLayer.
 *
 * @param {object} [partial]  Any subset. Unknown keys are dropped.
 * @returns {Readonly<object>}
 */
export function createAdjust(partial = {}) {
  const out = { preset: typeof partial.preset === 'string' ? partial.preset : 'none' };

  for (const id of CLASS_A_ORDER) {
    const op = OPS[id];
    const raw = Number(partial[id] ?? op.neutral);
    out[id] = Number.isFinite(raw) ? clamp(raw, op.range[0], op.range[1]) : op.neutral;
  }

  // Structural pass-through for now: Task 5 and Task 6 replace these two lines
  // with normaliseHsl() and normaliseOverlay(), which clamp and complete them.
  out.hsl = partial.hsl ? structuredClone(partial.hsl) : null;
  out.overlay = partial.overlay ? structuredClone(partial.overlay) : null;

  return deepFreeze(out);
}
```

Add to `src/index.js`, after the `panel.js` line:

```js
export { CLASS_A_ORDER, OPS, NEUTRAL_ADJUST, createAdjust } from './adjust/ops.js';
```

Add to the `scripts` block of `package.json`:

```json
"test:adjust": "node --max-old-space-size=6144 test/adjust.mjs",
```

…and append `&& node --max-old-space-size=6144 test/adjust.mjs` to the existing
`test` script so it runs in the suite.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `6 passed`

Run: `npm test`
Expected: every baseline marker unchanged, plus `6 passed` at the end. Nothing
imports the new module yet, so no pixel moved.

- [ ] **Step 5: Commit**

```bash
git add src/adjust/ops.js src/index.js test/adjust.mjs package.json
git diff --staged
git commit -m "Add the adjustment op table with a frozen, range-clamped constructor"
```

---

### Task 2: The LUT collapse — the assertion the whole cost design stands on

**Files:**
- Create: `src/adjust/lut.js`
- Modify: `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Task 1
- Produces:
  - `buildLut(adjust) -> Uint8Array` — 768 bytes, `[r 0..255][g 0..255][b 0..255]`
  - `lutDigest(adjust) -> string` — the class-A slice, and nothing else
  - `lutFor(layer) -> Uint8Array` — cached on the layer as `layer.lut` / `layer.lutKey`
  - `isNeutralAdjust(adjust) -> boolean`
  - `adjustCostOf(adjust) -> {lut: boolean, hsl: boolean, overlay: boolean}`

This is the phase's central claim: **four stacked adjustments cost what one
costs.** Every class-A op is a function `channel value -> channel value`, and a
composition of such functions is itself such a function — so the whole stack
collapses into one 3 × 256 table, built once per parameter change, and the
per-pixel cost becomes three array indexes regardless of stack depth.

The test that matters is Step 1's second one: it applies the ops **in
sequence, by hand**, at all 768 entries, and asserts the composed table agrees.
Without it the collapse is an assertion in a comment.

`buildLut` runs **every** op at **every** entry, including ops sitting at their
neutral value. Skipping them would be a micro-optimisation that also makes the
identity-LUT assertion trivially true instead of a real proof that each op's
declared neutral *is* the identity. 768 × 5 evaluations is nothing.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`, before the final `console.log`:

```js
console.log('\nthe LUT collapse\n');

test('a neutral adjust yields the IDENTITY table, byte for byte', () => {
  const lut = buildLut(null);
  assert.equal(lut.length, 768);
  for (let c = 0; c < 3; c++)
    for (let v = 0; v < 256; v++)
      assert.equal(lut[c * 256 + v], v, `channel ${c}, value ${v}`);
  assert.deepEqual([...buildLut(createAdjust())], [...lut], 'an all-neutral object must match null');
});

test('the composed table equals applying the ops IN SEQUENCE, at all 768 entries', () => {
  // THE assertion the whole cost design stands on. If this ever disagrees, the
  // LUT is not "four adjustments for the price of one" -- it is four
  // adjustments producing a fifth, different result, and the user is tuning
  // sliders against a preview that does not show what they do.
  const adjust = createAdjust({
    exposure: 37, temperature: -44, tint: 19, brightness: -23, contrast: 61,
  });
  const lut = buildLut(adjust);

  for (let c = 0; c < 3; c++)
    for (let v = 0; v < 256; v++) {
      let x = v;
      for (const id of CLASS_A_ORDER) x = OPS[id].evaluate(x, c, adjust[id]);
      const expected = x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x);
      assert.equal(lut[c * 256 + v], expected, `channel ${c}, value ${v}`);
    }
});

test('the collapse is order-sensitive, and the declared order is the one used', () => {
  // Pointwise ops do not commute. This pins CLASS_A_ORDER: reversing it changes
  // the table, so a silent reorder cannot slip through as a refactor.
  const forward = buildLut(createAdjust({ brightness: 60, contrast: 60 }));
  let differs = 0;
  for (let v = 0; v < 256; v++) {
    let x = v;
    for (const id of [...CLASS_A_ORDER].reverse()) x = OPS[id].evaluate(x, 0, 60);
    const reversed = x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x);
    if (reversed !== forward[v]) differs++;
  }
  assert.ok(differs > 0, 'brightness-then-contrast must differ from contrast-then-brightness');
});

test('every parameter at both extremes yields a table of bytes in 0..255', () => {
  for (const id of CLASS_A_ORDER)
    for (const value of OPS[id].range) {
      const lut = buildLut(createAdjust({ [id]: value }));
      assert.equal(lut.length, 768);
      for (let i = 0; i < 768; i++)
        assert.ok(Number.isInteger(lut[i]) && lut[i] >= 0 && lut[i] <= 255,
          `${id} at ${value}, entry ${i} -> ${lut[i]}`);
    }
});

test('lutDigest changes if and only if a class-A parameter changes', () => {
  const base = createAdjust({ brightness: 10 });
  assert.equal(lutDigest(base), lutDigest(createAdjust({ brightness: 10 })));
  assert.notEqual(lutDigest(base), lutDigest(createAdjust({ brightness: 11 })));
  assert.notEqual(lutDigest(base), lutDigest(null));
});

test('lutDigest IGNORES hsl and overlay, because the table does not depend on them', () => {
  // Rebuilding 768 entries because a hue band moved is pure waste, once per
  // frame, for the whole of an HSL drag. It also makes the lut/lutKey pair safe
  // by construction: the key is derived from exactly the inputs the value
  // depends on, so it can never go stale the way rendered/renderedKey can.
  const plain = createAdjust({ contrast: 20 });
  const withHsl = createAdjust({ contrast: 20, hsl: { saturation: -50, bands: [] } });
  assert.equal(lutDigest(plain), lutDigest(withHsl));
  assert.deepEqual([...buildLut(plain)], [...buildLut(withHsl)]);
});

test('lutFor caches on the layer and rebuilds only when the digest moves', () => {
  const layer = { adjust: createAdjust({ brightness: 12 }) };
  const first = lutFor(layer);
  assert.equal(lutFor(layer), first, 'an unchanged digest must not reallocate');
  layer.adjust = createAdjust({ brightness: 13 });
  const second = lutFor(layer);
  assert.notEqual(second, first);
  assert.notDeepEqual([...second], [...first]);
});

test('isNeutralAdjust is true for null and for an all-neutral object', () => {
  assert.equal(isNeutralAdjust(null), true);
  assert.equal(isNeutralAdjust(createAdjust()), true);
  assert.equal(isNeutralAdjust(createAdjust({ brightness: 1 })), false);
});

test('adjustCostOf reports the three cost terms separately', () => {
  // The debug readout shows `lut: N / hsl: M`, and it can only do that if the
  // terms are separable here. A cost the user cannot see is a bug.
  assert.deepEqual(adjustCostOf(null), { lut: false, hsl: false, overlay: false });
  assert.deepEqual(adjustCostOf(createAdjust({ contrast: 5 })),
    { lut: true, hsl: false, overlay: false });
});

```

Add `buildLut`, `lutDigest`, `lutFor`, `isNeutralAdjust`, `adjustCostOf` to the
import at the top of `test/adjust.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'buildLut'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/adjust/lut.js`:

```js
/**
 * The class-A collapse.
 *
 * Every class-A op is a function `channel value -> channel value` that depends
 * on nothing but that channel's own value. A composition of such functions is
 * itself such a function -- so the ENTIRE class-A stack, however deep,
 * evaluates into one 3x256 lookup table, and the per-pixel cost becomes three
 * array indexes and three stores.
 *
 * That is the answer to the brief's cost question. Four adjustments on a layer
 * cost what one costs. 768 evaluations of the whole stack, once per parameter
 * change -- not per pixel, not per layer, not per frame.
 *
 * It is also the answer to the GPU/JS parity question for the majority of the
 * operation surface: the GPU uploads THESE EXACT 768 BYTES as a 256x1 RGBA
 * texture and reads them with texelFetch, so there is no shader arithmetic to
 * diverge. Divergence is not reduced there, it is structurally impossible.
 */
import { CLASS_A_ORDER, OPS } from './ops.js';

/**
 * Compose the whole class-A stack into one table.
 *
 * @param {object|null} adjust
 * @returns {Uint8Array} 768 bytes: [r 0..255][g 0..255][b 0..255]
 */
export function buildLut(adjust) {
  const lut = new Uint8Array(768);

  for (let c = 0; c < 3; c++) {
    for (let v = 0; v < 256; v++) {
      let x = v;
      // EVERY op runs at EVERY entry, including the ones at their neutral
      // value. Skipping them would be a micro-optimisation that also makes the
      // identity-LUT assertion trivially true, instead of a real proof that
      // each op's declared neutral IS the identity. 3840 evaluations is nothing.
      for (const id of CLASS_A_ORDER) x = OPS[id].evaluate(x, c, adjust?.[id] ?? OPS[id].neutral);
      // Clamped ONCE, at the end of the composition -- not after each op, which
      // would clip five times and throw away highlights an exposure lift could
      // still have pulled back.
      lut[c * 256 + v] = x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x);
    }
  }

  return lut;
}

/**
 * The cache key for a table.
 *
 * Class A and nothing else, because the table depends on class A and nothing
 * else. That makes the key COMPLETE by construction: it needs no source-pixel
 * identity and no destination dimensions, so the lut/lutKey pair cannot go
 * stale the way rendered/renderedKey can.
 */
export const lutDigest = (adjust) =>
  adjust ? CLASS_A_ORDER.map((id) => adjust[id] ?? OPS[id].neutral).join(',') : 'neutral';

/**
 * The layer's table, built on demand and cached.
 *
 * DERIVED, not part of the model: never persisted, never in a command, never in
 * undo. It is rebuilt from parameters whenever the digest changes -- an
 * estimated tens of microseconds, once per frame during a slider drag.
 */
export function lutFor(layer) {
  const key = lutDigest(layer.adjust);
  if (layer.lutKey !== key) {
    layer.lut = buildLut(layer.adjust);
    layer.lutKey = key;
  }
  return layer.lut;
}

/**
 * Whether the whole object is neutral, so the entire pass can be skipped.
 *
 * A layer with no adjustments must cost exactly what it costs today: one branch.
 *
 * Task 5 and Task 6 refine the hsl and overlay tests here from "is present" to
 * "is present AND not neutral".
 */
export function isNeutralAdjust(adjust) {
  if (!adjust) return true;
  for (const id of CLASS_A_ORDER)
    if ((adjust[id] ?? OPS[id].neutral) !== OPS[id].neutral) return false;
  return !adjust.hsl && !adjust.overlay;
}

/**
 * The three cost terms, separately.
 *
 * Phase 1B and Phase 2 both established that a cost the user cannot see is a
 * bug. The debug readout's `lut: N / hsl: M` counters read this, so the terms
 * have to be separable at the source rather than summed into a total.
 *
 * Task 5 and Task 6 refine the hsl and overlay flags the same way.
 */
export const adjustCostOf = (adjust) => ({
  lut: !!adjust && CLASS_A_ORDER.some((id) => (adjust[id] ?? OPS[id].neutral) !== OPS[id].neutral),
  hsl: !!adjust?.hsl,
  overlay: !!adjust?.overlay,
});
```

Add to `src/index.js`:

```js
export { buildLut, lutDigest, lutFor, isNeutralAdjust, adjustCostOf } from './adjust/lut.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `15 passed`

- [ ] **Step 5: Commit**

```bash
git add src/adjust/lut.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Collapse the whole class-A stack into one 3x256 table, asserted against sequential application"
```

---

### Task 3: One shared scratch buffer per render context

**Files:**
- Create: `src/adjust/scratch.js`
- Modify: `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createScratch() -> {data: Uint8ClampedArray|null, bytes: number, allocations: number}`
  - `acquireScratch(scratch, width, height) -> {width, height, data: Uint8ClampedArray}`
  - `releaseScratch(scratch) -> void`
  - `DEFAULT_SCRATCH` — the module-level one the preview path uses

Finding 1 forbids in-place adjustment, so a destination buffer is **mandatory**,
not an optimisation. One buffer shared across every layer of a frame and grown
monotonically is O(1) allocations per frame instead of O(layers).

`acquireScratch` returns a **view** sized exactly to the requested rect
(`subarray`), never the whole buffer. That is what makes leftover bytes from a
previously-larger layer unreachable rather than merely unread: `applyAdjustments`
writes every pixel of its output and `blendInto` indexes within `rect`, and the
view's length pins both.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nthe shared scratch\n');

test('acquireScratch returns a view of exactly the requested size', () => {
  const s = createScratch();
  const view = acquireScratch(s, 3, 2);
  assert.equal(view.width, 3);
  assert.equal(view.height, 2);
  assert.equal(view.data.length, 3 * 2 * 4);
  assert.ok(view.data instanceof Uint8ClampedArray);
});

test('a smaller request reuses the buffer without allocating', () => {
  const s = createScratch();
  acquireScratch(s, 64, 64);
  const after = s.allocations;
  acquireScratch(s, 8, 8);
  acquireScratch(s, 1, 1);
  assert.equal(s.allocations, after, 'a shrink must never allocate');
});

test('a larger request grows the buffer exactly once', () => {
  const s = createScratch();
  acquireScratch(s, 8, 8);
  assert.equal(s.allocations, 1);
  acquireScratch(s, 64, 64);
  assert.equal(s.allocations, 2);
  acquireScratch(s, 64, 64);
  assert.equal(s.allocations, 2);
});

test('the view is rect-sized, so a previous larger layer\'s bytes are unreachable', () => {
  // Not "unread" -- unreachable. A big adjusted layer followed by a small one
  // must not be able to leak a single pixel of the first into the second, and
  // a length is a stronger guarantee than a loop bound someone can edit.
  const s = createScratch();
  acquireScratch(s, 4, 4).data.fill(255);
  const small = acquireScratch(s, 2, 2);
  assert.equal(small.data.length, 16);
});

test('releaseScratch drops the buffer so it can be collected before an encode peak', () => {
  const s = createScratch();
  acquireScratch(s, 32, 32);
  releaseScratch(s);
  assert.equal(s.data, null);
  assert.equal(s.bytes, 0);
  assert.equal(acquireScratch(s, 4, 4).data.length, 64, 'it must still work afterwards');
});
```

Add `createScratch`, `acquireScratch`, `releaseScratch` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'createScratch'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/adjust/scratch.js`:

```js
/**
 * One destination buffer per render context, grown monotonically.
 *
 * MANDATORY, not an optimisation. resample() returns its INPUT OBJECT when the
 * dimensions already match (src/render.js:20) -- and that is the DEFAULT
 * preview path, because an untransformed layer at proxyScale asks for exactly
 * the dimensions the proxy already has. textPixelsAt does the same with
 * layer.rendered, and export hands its streamed full-resolution buffer through
 * `options.pixels`. So an adjustment applied in place would overwrite the
 * layer's ORIGINAL pixels permanently, and -- because the next frame reads the
 * same buffer -- compound frame over frame until a held brightness slider ran
 * away to white. Non-destructive editing would become destructive with nothing
 * on screen to say so.
 *
 * One buffer for the whole frame rather than one per layer: O(1) allocations
 * instead of O(layers), at the cost of one buffer sized to the largest
 * destination rect. It only ever grows, because a frame that needed 4 MB once
 * will need it again next frame and shrinking would just re-allocate.
 *
 * LIFETIME: acquired by drawLayerInto, filled by applyAdjustments, consumed by
 * blendInto on the next line -- all synchronously, within one statement's
 * reach. NOTHING may retain a reference across a call. The next layer
 * overwrites it.
 */

export const createScratch = () => ({ data: null, bytes: 0, allocations: 0 });

/**
 * A destination view of exactly `width x height`.
 *
 * The subarray is the point: it is rect-sized, so bytes left over from a
 * previously larger layer are unreachable rather than merely unread.
 *
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function acquireScratch(scratch, width, height) {
  const need = width * height * 4;
  if (!scratch.data || scratch.bytes < need) {
    scratch.data = new Uint8ClampedArray(need);
    scratch.bytes = need;
    scratch.allocations++;
  }
  return { width, height, data: scratch.data.subarray(0, need) };
}

/**
 * Drop the buffer.
 *
 * Export calls this before the PNG encode peak -- the same place 1C already
 * drops the file bytes -- because at scale 1 the scratch has grown to the
 * largest layer in the document, which for the measured 4961x3508 poster is
 * ~66.4 MB that must not be resident while the encoder allocates.
 */
export function releaseScratch(scratch) {
  scratch.data = null;
  scratch.bytes = 0;
}

/**
 * The preview path's scratch.
 *
 * Module-level rather than per-render-call, because a per-call one would
 * allocate every frame -- exactly what this file exists to avoid. Export does
 * NOT use it: createJsExportTarget owns its own, so a full-resolution buffer
 * cannot be left alive by the editor after an export finishes.
 */
export const DEFAULT_SCRATCH = createScratch();
```

Add to `src/index.js`:

```js
export { createScratch, acquireScratch, releaseScratch, DEFAULT_SCRATCH } from './adjust/scratch.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `20 passed`

- [ ] **Step 5: Commit**

```bash
git add src/adjust/scratch.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Add one monotonically-growing scratch buffer per render context"
```

---

### Task 4: The per-pixel pass, and the guard that makes in-place adjustment impossible

**Files:**
- Create: `src/adjust/apply.js`
- Modify: `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Tasks 1–3
- Produces: `applyAdjustments(pixels, adjust, out, lut = null) -> out`, where
  `pixels` and `out` are both `{width, height, data: Uint8ClampedArray}` and
  `lut` is the caller's cached table

The class-A stage: three table lookups and an alpha copy, per pixel, for any
stack depth. Everything interesting here is the guard.

**The aliasing check compares buffers, not references.** `out.data === pixels.data`
catches the obvious case; two *overlapping views of the same `ArrayBuffer`*
would slip past it and corrupt half the image, which is exactly the shape
`acquireScratch`'s `subarray` makes possible if someone ever passes the scratch
back in as input. So it compares `.buffer` identity and byte ranges as well.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nthe per-pixel pass\n');

/** A buffer sweeping all four channels, so alpha assertions have every band. */
const sweep = (w = 16, h = 16) => {
  const data = new Uint8ClampedArray(w * h * 4);
  const bands = [0, 1, 64, 127, 128, 200, 254, 255];
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = i & 255;
    data[i * 4 + 1] = (i * 7 + 33) & 255;
    data[i * 4 + 2] = (i * 13 + 91) & 255;
    data[i * 4 + 3] = bands[i & 7];
  }
  return { width: w, height: h, data };
};

const blank = (src) => ({ width: src.width, height: src.height,
  data: new Uint8ClampedArray(src.data.length) });

test('a neutral adjust produces a buffer bit-identical to its input', () => {
  const src = sweep();
  const out = applyAdjustments(src, null, blank(src));
  assert.deepEqual([...out.data], [...src.data]);
});

test('applying into the input buffer THROWS', () => {
  // Finding 1. On the default preview path resample() identity-returns, so the
  // buffer drawLayerInto is holding IS layer.pixels -- and an in-place
  // adjustment would overwrite the layer's originals permanently and compound
  // every frame of a drag. This is a defect that survives review by looking
  // correct; a runtime assertion in the one function that can commit it is
  // cheaper than remembering.
  const src = sweep(4, 4);
  assert.throws(
    () => applyAdjustments(src, createAdjust({ brightness: 20 }), src),
    /write into its own input/,
  );
});

test('OVERLAPPING views of one ArrayBuffer also throw', () => {
  // acquireScratch hands out subarrays, so `out.data !== pixels.data` is not
  // enough on its own -- two views of the same buffer would corrupt half the
  // image and pass a reference check.
  const buf = new Uint8ClampedArray(16);
  const a = { width: 2, height: 1, data: buf.subarray(0, 8) };
  const b = { width: 2, height: 1, data: buf.subarray(4, 12) };
  assert.throws(() => applyAdjustments(a, createAdjust({ brightness: 5 }), b),
    /write into its own input/);
});

test('NON-overlapping views of one ArrayBuffer are allowed', () => {
  // The guard must not be so blunt that the shared scratch becomes unusable.
  const buf = new Uint8ClampedArray(16);
  const a = { width: 2, height: 1, data: buf.subarray(0, 8) };
  const c = { width: 2, height: 1, data: buf.subarray(8, 16) };
  applyAdjustments(a, createAdjust({ brightness: 5 }), c);
  assert.ok(c.data[0] > 0);
});

test('mismatched dimensions throw rather than writing a sheared image', () => {
  const src = sweep(4, 4);
  assert.throws(
    () => applyAdjustments(src, null, { width: 3, height: 4, data: new Uint8ClampedArray(48) }),
    /4x4/,
  );
});

test('alpha is UNCHANGED for every class-A op at both extremes (invariant A)', () => {
  // blendInto reads alpha for `as`, rect.mask multiplies it, hitTest thresholds
  // it, and composite.js's alphaMap builds clipping from it. One invariant
  // keeps four consumers correct, and it is SILENT in three of them.
  const src = sweep();
  for (const id of CLASS_A_ORDER)
    for (const value of OPS[id].range) {
      const out = applyAdjustments(src, createAdjust({ [id]: value }), blank(src));
      for (let i = 0; i < src.width * src.height; i++)
        assert.equal(out.data[i * 4 + 3], src.data[i * 4 + 3], `${id} at ${value}, pixel ${i}`);
    }
});

test('the pass uses the table it is handed rather than rebuilding one', () => {
  // The whole point of caching a LUT on the layer is that the per-frame cost is
  // three indexes, not 768 evaluations plus three indexes.
  const src = sweep(4, 4);
  const identity = buildLut(null);
  const out = applyAdjustments(src, createAdjust({ brightness: 100 }), blank(src), identity);
  assert.deepEqual([...out.data], [...src.data], 'the passed table won, not the parameters');
});
```

Add `applyAdjustments` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'applyAdjustments'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/adjust/apply.js`:

```js
/**
 * The per-pixel adjustment pass.
 *
 * Reads `pixels`, writes `out`, and NEVER aliases the two. Applied in a fixed,
 * declared order -- LUT, then HSL, then overlay -- because pointwise operations
 * do not commute and an undeclared order is a bug the user discovers by getting
 * a different result than the same sliders gave yesterday.
 *
 * Alpha is copied through untouched by every stage. See invariant A in the
 * spec: four consumers depend on it and three of them fail silently.
 */
import { buildLut } from './lut.js';

/**
 * Do two typed-array views share bytes?
 *
 * Reference equality is not enough. acquireScratch hands out `subarray` views
 * of one buffer, so two DIFFERENT arrays can address the same memory -- and an
 * adjustment written through one while reading the other would corrupt the
 * image from the middle outwards, which reads as a decode bug rather than as
 * what it is.
 */
const sharesBytes = (a, b) =>
  a === b || (a.buffer === b.buffer
    && a.byteOffset < b.byteOffset + b.byteLength
    && b.byteOffset < a.byteOffset + a.byteLength);

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} pixels  the source
 * @param {object|null} adjust
 * @param {{width:number,height:number,data:Uint8ClampedArray}} out  MUST NOT alias `pixels`
 * @param {Uint8Array|null} [lut]  the caller's cached table; built here when absent
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} `out`
 */
export function applyAdjustments(pixels, adjust, out, lut = null) {
  if (out.width !== pixels.width || out.height !== pixels.height)
    throw new Error(
      `applyAdjustments: destination is ${out.width}x${out.height}, ` +
      `source is ${pixels.width}x${pixels.height}`);

  if (sharesBytes(out.data, pixels.data))
    throw new Error(
      'applyAdjustments would write into its own input. resample() and textPixelsAt() BOTH ' +
      'return their input object when the dimensions already match -- which is the default ' +
      'preview path -- so an in-place adjustment overwrites the layer\'s original pixels ' +
      'permanently and compounds on every frame of a drag. Acquire a scratch destination.');

  const table = lut || buildLut(adjust);
  const src = pixels.data;
  const dst = out.data;
  const count = pixels.width * pixels.height;

  // Three array indexes and three stores, for ANY number of stacked class-A
  // operations. That is the whole cost design.
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    dst[o] = table[src[o]];
    dst[o + 1] = table[256 + src[o + 1]];
    dst[o + 2] = table[512 + src[o + 2]];
    dst[o + 3] = src[o + 3];        // invariant A: alpha is never touched
  }

  return out;
}
```

Add to `src/index.js`:

```js
export { applyAdjustments } from './adjust/apply.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `27 passed`

- [ ] **Step 5: Commit**

```bash
git add src/adjust/apply.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Add the class-A per-pixel pass with a guard against adjusting in place"
```

---

### Task 5: HSL — the one cross-channel operation

**Files:**
- Modify: `src/adjust/ops.js`, `src/adjust/apply.js`, `src/adjust/lut.js`, `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Tasks 1–4
- Produces:
  - `HSL_BANDS: {id, centre}[]` — eight bands, `centre` in degrees
  - `HSL_HUE_DEGREES = 30` — what ±100 on a band's hue slider means
  - `NEUTRAL_HSL` — frozen; eight all-zero bands and `saturation: 0`
  - `normaliseHsl(hsl) -> {bands: {h,s,l}[8], saturation}` — always eight bands, all clamped
  - `isNeutralHsl(hsl) -> boolean`
  - `bandWeights(hue, out: Float64Array) -> void` — exported for testing; a partition of unity
  - `applyHsl(dst: Uint8ClampedArray, count: number, hsl) -> void` — in place
  - `applyAdjustments` gains its second stage; `createAdjust` routes `hsl` through `normaliseHsl`; `isNeutralAdjust` and `adjustCostOf` refine their `hsl` test from "is present" to "is present and not neutral"

This is the expensive pass and the design does not pretend otherwise: two
colour-space conversions and a divide per pixel, estimated at **1.5–3× the cost
of the `blendInto` pass it precedes** — against a class-A LUT pass's estimated
0.15–0.25×. Three things bound it, and only three: it is skipped entirely when
neutral (decided once per layer per frame, never per pixel); **there is exactly
one of it and the count stays one**; and the Phase 2 ladder measures rather than
predicts, so an HSL-heavy document demotes on its own.

**The band weighting is a linear interpolation between the two adjacent band
centres**, which is a triangular falloff that sums to exactly 1 for every hue.
That matters: a weighting that did not sum to 1 would change a pixel's colour
at a *neutral* setting, at hues that happen to fall between bands.

**A neutral HSL block never enters the conversion at all.** The bit-identity
assertion below proves the *skip*, not a bit-exact RGB→HSL→RGB round trip — the
round trip is separately measured at ≤ 1 LSB and that is all it is claimed to
be. Say so when reporting.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nHSL\n');

const NEUTRAL_BANDS = () => Array.from({ length: 8 }, () => ({ h: 0, s: 0, l: 0 }));

test('band weights are a partition of unity for every integer hue', () => {
  // A weighting that did not sum to 1 would shift a pixel's colour at a
  // NEUTRAL setting, at exactly the hues that fall between two bands -- which
  // is most of them.
  const w = new Float64Array(8);
  for (let hue = 0; hue < 360; hue++) {
    bandWeights(hue, w);
    let sum = 0, nonZero = 0;
    for (const v of w) { sum += v; if (v !== 0) nonZero++; }
    assert.ok(Math.abs(sum - 1) < 1e-12, `hue ${hue} sums to ${sum}`);
    assert.ok(nonZero <= 2, `hue ${hue} touches ${nonZero} bands`);
  }
});

test('a hue exactly on a band centre gives that band all of the weight', () => {
  const w = new Float64Array(8);
  HSL_BANDS.forEach((band, i) => {
    bandWeights(band.centre, w);
    assert.equal(w[i], 1, `${band.id} at ${band.centre}`);
  });
});

test('rgb -> hsl -> rgb round-trips within 1 LSB across the sweep', () => {
  // Measured, not assumed. This is the FLOOR on how exact any HSL edit can be,
  // and it is why the neutral case is handled by SKIPPING the pass rather than
  // by trusting the round trip. Report the worst delta you actually observe.
  const src = sweep(32, 32);
  const hsl = normaliseHsl({ bands: NEUTRAL_BANDS(), saturation: 0 });
  const out = blank(src);
  out.data.set(src.data);
  applyHsl(out.data, out.width * out.height, hsl);   // forced: applyAdjustments would skip it
  for (let i = 0; i < src.data.length; i++)
    if (i % 4 !== 3 && src.data[(i >> 2) * 4 + 3] !== 0)
      assert.ok(Math.abs(out.data[i] - src.data[i]) <= 1,
        `byte ${i}: ${src.data[i]} -> ${out.data[i]}`);
});

test('a neutral hsl block is SKIPPED, so the output is bit-identical to class A alone', () => {
  const src = sweep();
  const plain = applyAdjustments(src, createAdjust({ contrast: 30 }), blank(src));
  const withHsl = applyAdjustments(
    src, createAdjust({ contrast: 30, hsl: { bands: NEUTRAL_BANDS(), saturation: 0 } }), blank(src));
  assert.deepEqual([...withHsl.data], [...plain.data]);
});

test('a global saturation of -100 produces a grey everywhere', () => {
  const src = sweep();
  const out = applyAdjustments(
    src, createAdjust({ hsl: { bands: NEUTRAL_BANDS(), saturation: -100 } }), blank(src));
  for (let i = 0; i < src.width * src.height; i++) {
    if (src.data[i * 4 + 3] === 0) continue;      // transparent pixels are skipped
    const o = i * 4;
    assert.equal(out.data[o], out.data[o + 1], `pixel ${i} r/g`);
    assert.equal(out.data[o + 1], out.data[o + 2], `pixel ${i} g/b`);
  }
});

test('a band saturation moves pixels near that band and leaves the opposite band alone', () => {
  // Two pure hues, 180 degrees apart. Killing the reds must not touch the aqua.
  const src = { width: 2, height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 255, 255]) };
  const bands = NEUTRAL_BANDS();
  bands[0].s = -100;                              // the red band
  const out = applyAdjustments(src, createAdjust({ hsl: { bands, saturation: 0 } }), blank(src));
  assert.equal(out.data[0], out.data[1], 'the red pixel is now grey');
  assert.deepEqual([...out.data.slice(4, 8)], [0, 255, 255, 255], 'the aqua pixel is untouched');
});

test('alpha is unchanged by HSL at every alpha band (invariant A)', () => {
  const src = sweep();
  const bands = NEUTRAL_BANDS();
  bands[3].h = 100; bands[3].s = -80; bands[3].l = 60;
  const out = applyAdjustments(src, createAdjust({ hsl: { bands, saturation: 90 } }), blank(src));
  for (let i = 0; i < src.width * src.height; i++)
    assert.equal(out.data[i * 4 + 3], src.data[i * 4 + 3], `pixel ${i}`);
});

test('normaliseHsl always returns eight clamped bands, and isNeutralHsl agrees', () => {
  const n = normaliseHsl({ bands: [{ h: 5000 }], saturation: -5000 });
  assert.equal(n.bands.length, 8);
  assert.equal(n.bands[0].h, 100);
  assert.equal(n.bands[0].s, 0);
  assert.equal(n.saturation, -100);
  assert.equal(isNeutralHsl(NEUTRAL_HSL), true);
  assert.equal(isNeutralHsl(n), false);
  // A present-but-neutral block must not make the whole object non-neutral, or
  // opening the HSL sheet and touching nothing would cost the expensive pass.
  const opened = createAdjust({ hsl: { bands: NEUTRAL_BANDS(), saturation: 0 } });
  assert.equal(isNeutralAdjust(opened), true);
  assert.equal(adjustCostOf(opened).hsl, false);
});
```

Add `HSL_BANDS`, `NEUTRAL_HSL`, `normaliseHsl`, `isNeutralHsl`, `bandWeights`,
`applyHsl` to the import at the top of `test/adjust.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'HSL_BANDS'`

- [ ] **Step 3: Write the minimal implementation**

Append to `src/adjust/ops.js`. **The GLSL string is declared before the table
entry that references it** — writing `glsl: HSL_GLSL` above a `const HSL_GLSL`
further down is a temporal dead zone error, not a hoisting convenience.

```js
/**
 * The HSL stage, as GLSL ES 3.00.
 *
 * A transcription of applyHsl in apply.js. NOTHING IN THIS REPOSITORY COMPILES
 * IT. Task 15's coverage test proves this string exists and is non-empty; it
 * cannot prove it is right, and conformance Table D on a real device is the
 * only thing that can. That is 1B's accepted gap, restated for a new surface.
 *
 * GLSL's `mod(x, 6.0)` returns a non-negative result where JS's `%` can return
 * a negative one -- but the JS side immediately adds 360 to a negative hue, so
 * the two agree. Checked by hand; it is exactly the kind of difference that
 * produces a hue rotated by 60 degrees on one tier only.
 */
const HSL_GLSL = `
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  float h = 0.0;
  float s = 0.0;
  if (d > 0.0) {
    s = (l > 0.5) ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else                h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, s, l);
}

vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y <= 0.0) return vec3(hsl.z);
  float c  = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float hp = mod(mod(hsl.x, 360.0) + 360.0, 360.0) / 60.0;
  float x  = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb = (hp < 1.0) ? vec3(c, x, 0.0)
           : (hp < 2.0) ? vec3(x, c, 0.0)
           : (hp < 3.0) ? vec3(0.0, c, x)
           : (hp < 4.0) ? vec3(0.0, x, c)
           : (hp < 5.0) ? vec3(x, 0.0, c)
                        : vec3(c, 0.0, x);
  return rgb + (hsl.z - c * 0.5);
}

vec3 adjustHsl(vec3 rgb) {
  vec3 hsl = rgb2hsl(rgb);
  float dh = 0.0;
  float ds = 0.0;
  float dl = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = uHslCentres[i];
    // (i + 1) % 8 keeps the index in range even in the wrap case, where the
    // upper bound is 360 rather than a centre. Reading one past the end of a
    // uniform array is undefined, not merely wrong.
    int   j = (i + 1) % 8;
    float b = (i == 7) ? 360.0 : uHslCentres[j];
    if (hsl.x >= a && hsl.x < b) {
      float t = (hsl.x - a) / (b - a);
      dh = (1.0 - t) * uHslBands[i * 3]     + t * uHslBands[j * 3];
      ds = (1.0 - t) * uHslBands[i * 3 + 1] + t * uHslBands[j * 3 + 1];
      dl = (1.0 - t) * uHslBands[i * 3 + 2] + t * uHslBands[j * 3 + 2];
    }
  }
  float h = hsl.x + dh * 0.3;
  float s = clamp(hsl.y * (1.0 + ds * 0.01) * (1.0 + uHslSaturation * 0.01), 0.0, 1.0);
  float t = dl * 0.01;
  float l = clamp(hsl.z + ((t >= 0.0) ? t * (1.0 - hsl.z) : t * hsl.z), 0.0, 1.0);
  return hsl2rgb(vec3(h, s, l));
}
`;

/**
 * The eight hue bands, at Photoshop's own centres.
 *
 * Not evenly spaced -- perceptual hue is not linear in degrees, and the gap
 * from blue to purple really is narrower than the one from yellow to green.
 * bandWeights interpolates between ADJACENT centres, so uneven spacing costs
 * nothing and the weights still sum to exactly 1.
 */
export const HSL_BANDS = Object.freeze([
  { id: 'red', centre: 0 }, { id: 'orange', centre: 30 }, { id: 'yellow', centre: 60 },
  { id: 'green', centre: 120 }, { id: 'aqua', centre: 180 }, { id: 'blue', centre: 240 },
  { id: 'purple', centre: 285 }, { id: 'magenta', centre: 315 },
].map(Object.freeze));

/**
 * +/-100 on a band's hue slider is +/-30 degrees. Conservative on purpose: a
 * wider range wraps a band's pixels past its neighbours and reads as noise
 * rather than as a hue shift.
 */
export const HSL_HUE_DEGREES = 30;

const clampBand = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? clamp(n, -100, 100) : 0;
};

/**
 * Always eight bands, always clamped. A short or ragged array from a
 * hand-edited save cannot reach the per-pixel loop.
 */
export function normaliseHsl(hsl) {
  return {
    bands: HSL_BANDS.map((_, i) => {
      const b = hsl?.bands?.[i] ?? {};
      return { h: clampBand(b.h), s: clampBand(b.s), l: clampBand(b.l) };
    }),
    saturation: clampBand(hsl?.saturation),
  };
}

export const NEUTRAL_HSL = deepFreeze(normaliseHsl(null));

export const isNeutralHsl = (hsl) =>
  !hsl || (hsl.saturation === 0
    && (hsl.bands ?? []).every((b) => b.h === 0 && b.s === 0 && b.l === 0));

/**
 * The eight band weights for one hue: a linear interpolation between the two
 * adjacent centres, written into `out`.
 *
 * At most two are non-zero and they sum to EXACTLY 1, which is what makes a
 * neutral setting a true no-op at every hue rather than only at the centres.
 *
 * @param {number} hue  degrees, 0 <= hue < 360
 * @param {Float64Array} out  length 8; overwritten
 */
export function bandWeights(hue, out) {
  out.fill(0);
  const n = HSL_BANDS.length;
  for (let i = 0; i < n; i++) {
    const a = HSL_BANDS[i].centre;
    // The last band wraps to the first, at 360 rather than back at 0.
    const b = i === n - 1 ? HSL_BANDS[0].centre + 360 : HSL_BANDS[i + 1].centre;
    if (hue >= a && hue < b) {
      const t = (hue - a) / (b - a);
      out[i] = 1 - t;
      out[(i + 1) % n] = t;
      return;
    }
  }
  out[0] = 1;   // hue is exactly 360 or NaN; rgbToHsl produces neither
}

/**
 * The one cross-channel op.
 *
 * Declared in the table so the table stays the complete inventory of what an
 * adjustment can do -- and so Task 15's coverage test can prove this one has a
 * shader body, which class A does not need and overlay does not yet have.
 */
OPS.hsl = {
  class: 'B', lut: false, glsl: HSL_GLSL, gpuDeferred: null,
  label: 'HSL', range: null, neutral: null,
  evaluate: null,          // cross-channel: it cannot be a per-channel function
};
```

Change the `hsl` line in `createAdjust`:

```js
  out.hsl = partial.hsl ? normaliseHsl(partial.hsl) : null;
```

Extend `src/adjust/apply.js`'s imports and append the stage:

```js
import { HSL_BANDS, HSL_HUE_DEGREES, bandWeights, isNeutralHsl } from './ops.js';
```

```js
function rgbToHsl(r, g, b, out) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn);
  const mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0, s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === rn) h = ((gn - bn) / d) % 6;
    else if (mx === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  out[0] = h; out[1] = s; out[2] = l;
}

function hslToRgb(h, s, l, out) {
  if (s <= 0) { const v = l * 255; out[0] = v; out[1] = v; out[2] = v; return; }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  out[0] = (r + m) * 255; out[1] = (g + m) * 255; out[2] = (b + m) * 255;
}

/**
 * The HSL stage, in place on an already-class-A-adjusted buffer.
 *
 * Exported so a test can force it to run on a NEUTRAL block and measure the
 * round-trip error, which applyAdjustments would otherwise skip -- and the skip
 * is precisely what makes the neutral case bit-exact, so the two facts have to
 * be measurable separately.
 *
 * @param {Uint8ClampedArray} dst
 * @param {number} count  pixels, not bytes
 * @param {{bands: {h:number,s:number,l:number}[], saturation: number}} hsl  already normalised
 */
export function applyHsl(dst, count, hsl) {
  const w = new Float64Array(HSL_BANDS.length);
  const c = new Float64Array(3);
  const bands = hsl.bands;
  const global = 1 + hsl.saturation / 100;

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    // A pixel with no alpha is never read by blendInto (`as <= 0` -> continue)
    // and is normalised away by flattenOnto before any comparison. Two colour
    // conversions for a pixel nothing can observe is the expensive pass's
    // easiest saving, and it is invisible to every consumer.
    if (dst[o + 3] === 0) continue;

    rgbToHsl(dst[o], dst[o + 1], dst[o + 2], c);
    bandWeights(c[0], w);

    let dh = 0, ds = 0, dl = 0;
    for (let k = 0; k < w.length; k++) {
      if (w[k] === 0) continue;
      dh += w[k] * bands[k].h;
      ds += w[k] * bands[k].s;
      dl += w[k] * bands[k].l;
    }

    const h = c[0] + dh * (HSL_HUE_DEGREES / 100);
    const s = Math.min(1, Math.max(0, c[1] * (1 + ds / 100) * global));
    // Lightness moves TOWARDS white or black rather than by a fixed amount, so
    // it cannot leave 0..1 no matter how the band is set.
    const t = dl / 100;
    const l = Math.min(1, Math.max(0, c[2] + (t >= 0 ? t * (1 - c[2]) : t * c[2])));

    hslToRgb(h, s, l, c);
    dst[o] = c[0]; dst[o + 1] = c[1]; dst[o + 2] = c[2];
    // dst[o + 3] deliberately untouched -- invariant A
  }
}
```

…and add the stage to `applyAdjustments`, immediately before `return out;`:

```js
  // Stage 2. Skipped entirely when neutral, decided ONCE per layer per frame
  // from the parameters, never per pixel.
  if (adjust?.hsl && !isNeutralHsl(adjust.hsl)) applyHsl(dst, count, adjust.hsl);
```

Refine the two predicates in `src/adjust/lut.js`. Change its import to
`import { CLASS_A_ORDER, OPS, isNeutralHsl } from './ops.js';`, replace the last
line of `isNeutralAdjust`:

```js
  if (adjust.hsl && !isNeutralHsl(adjust.hsl)) return false;
  return !adjust.overlay;
```

…and the `hsl` line of `adjustCostOf`:

```js
  hsl: !!adjust?.hsl && !isNeutralHsl(adjust.hsl),
```

Add to `src/index.js`:

```js
export {
  HSL_BANDS, HSL_HUE_DEGREES, NEUTRAL_HSL, normaliseHsl, isNeutralHsl, bandWeights,
} from './adjust/ops.js';
export { applyHsl } from './adjust/apply.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `35 passed`

**Report the round-trip test's actual worst byte difference.** The assertion is
`<= 1`; if it is `0`, say so — that is better than the spec claims and belongs
in the spec's open questions.

- [ ] **Step 5: Commit**

```bash
git add src/adjust/ops.js src/adjust/apply.js src/adjust/lut.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Add the eight-band HSL stage, skipped whenever it is neutral"
```

---

### Task 6: The procedural gradient overlay

**Files:**
- Modify: `src/adjust/ops.js`, `src/adjust/apply.js`, `src/adjust/lut.js`, `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Tasks 1–5
- Produces:
  - `OVERLAY_KINDS = ['linear', 'radial']`
  - `normaliseOverlay(overlay) -> {kind, angle, cx, cy, radius, stops, mode, opacity}` — stops sorted by `t`, mode validated against `SUPPORTED_BLEND_MODES`
  - `isNeutralOverlay(overlay) -> boolean`
  - `applyOverlay(out, overlay) -> void` — in place on the scratch, row by row
  - `applyAdjustments` gains its third stage; `isNeutralAdjust` / `adjustCostOf` refine their `overlay` test

**No bitmap textures.** PixelPerfect ships 30 overlay PNGs; **its repository has
no LICENSE file**, so under default copyright they are all-rights-reserved and
cannot be assumed shippable — and neither can its filter parameters, which are
as much the author's work as the images. "Ask for a licence later" is not a
design. So Overlay is specified to not need them: procedural gradients **in
normalised layer coordinates**, scale-invariant by construction, pointwise in
position so they tile with no halo, generated from about ten numbers so they add
nothing to the export peak and nothing to the APK. **No task in this plan may
depend on shipping a third-party asset.**

That is a genuine subset of what PixelPerfect's Overlay does, and it is honest
about it: light leaks, duotone washes and colour grades are reachable; bokeh,
dust, scratches, lens flare and paper textures are not.

**The gradient reuses `blendInto`, one row at a time.** Reimplementing 26 blend
modes inside the overlay would be a second compositor that can drift from the
oracle; a one-row buffer is `width × 4` bytes rather than a second full-size
scratch, which the export peak cannot afford. And **the destination's alpha
column is restored after every row**, because `blendInto` is a general
compositor whose `ao = as + ab(1 - as)` raises alpha on partially transparent
pixels. An overlay tints; it does not add coverage.

**The overlay is clipped to the layer's own alpha.** Without it a gradient
paints into the transparent region and turns a cut-out into a rectangle — which
is exactly what a *document* overlay does, and exactly not what a per-layer one
should.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nthe gradient overlay\n');

const RAMP = [{ t: 0, r: 0, g: 0, b: 0, a: 1 }, { t: 1, r: 255, g: 255, b: 255, a: 1 }];

/** An opaque black row, `w` wide. */
const blackRow = (w) => {
  const data = new Uint8ClampedArray(w * 4);
  for (let i = 0; i < w; i++) data[i * 4 + 3] = 255;
  return { width: w, height: 1, data };
};

test('a linear gradient samples at NORMALISED positions, identically at two resolutions', () => {
  // The scale-invariance claim, made checkable. Every Phase 3 operation is
  // pointwise and carries no length parameter, so preview and export apply the
  // same function -- there is no proxyScale term to get wrong and nowhere for a
  // preview/export mismatch to hide. That is what the radius exclusion buys.
  const overlay = createAdjust({
    overlay: { kind: 'linear', angle: 0, stops: RAMP, mode: 'normal', opacity: 1 },
  });
  for (const width of [4, 8, 64]) {
    const src = blackRow(width);
    const out = applyAdjustments(src, overlay, blank(src));
    for (let x = 0; x < width; x++)
      assert.equal(out.data[x * 4], Math.round(255 * ((x + 0.5) / width)),
        `width ${width}, x ${x}`);
  }
});

test('a radial gradient is centred and rises away from the centre', () => {
  const overlay = createAdjust({
    overlay: { kind: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: RAMP,
               mode: 'normal', opacity: 1 },
  });
  const src = blackRow(4);
  const out = applyAdjustments(src, overlay, blank(src));
  assert.equal(out.data[0], out.data[12], 'symmetric about the centre');
  assert.ok(out.data[4] < out.data[0], 'the centre is nearer the near stop');
});

test('a transparent pixel is untouched in all four channels', () => {
  // Without the alpha clip a gradient paints into the transparent region and
  // turns a cut-out into a rectangle.
  const src = { width: 2, height: 1, data: new Uint8ClampedArray([9, 9, 9, 0, 9, 9, 9, 255]) };
  const overlay = createAdjust({
    overlay: { kind: 'linear', angle: 0, mode: 'normal', opacity: 1,
               stops: [{ t: 0, r: 255, g: 0, b: 0, a: 1 }, { t: 1, r: 255, g: 0, b: 0, a: 1 }] },
  });
  const out = applyAdjustments(src, overlay, blank(src));
  assert.deepEqual([...out.data.slice(0, 4)], [9, 9, 9, 0], 'the transparent pixel is untouched');
  assert.equal(out.data[4], 255, 'the opaque pixel took the overlay');
});

test('alpha is byte-identical before and after, at every alpha band (invariant A)', () => {
  // blendInto raises alpha (ao = as + ab(1 - as)) on every partially transparent
  // pixel. An overlay TINTS; it does not add coverage. Restoring the column is
  // what keeps this true rather than nearly true -- and hitTest, rect.mask and
  // composite.js's alphaMap all depend on it.
  const src = sweep();
  const overlay = createAdjust({
    overlay: { kind: 'radial', mode: 'overlay', opacity: 0.8,
               stops: [{ t: 0, r: 200, g: 40, b: 90, a: 1 },
                       { t: 1, r: 10, g: 220, b: 30, a: 0.6 }] },
  });
  const out = applyAdjustments(src, overlay, blank(src));
  for (let i = 0; i < src.width * src.height; i++)
    assert.equal(out.data[i * 4 + 3], src.data[i * 4 + 3], `pixel ${i}`);
});

test('a zero-opacity or fully transparent overlay is neutral and is skipped', () => {
  const src = sweep();
  const plain = applyAdjustments(src, createAdjust({ contrast: 12 }), blank(src));
  for (const overlay of [
    { kind: 'linear', stops: RAMP, mode: 'normal', opacity: 0 },
    { kind: 'linear', mode: 'normal', opacity: 1,
      stops: [{ t: 0, r: 255, g: 0, b: 0, a: 0 }, { t: 1, r: 0, g: 0, b: 255, a: 0 }] },
  ]) {
    const a = createAdjust({ contrast: 12, overlay });
    assert.equal(isNeutralOverlay(a.overlay), true);
    assert.equal(adjustCostOf(a).overlay, false);
    assert.deepEqual([...applyAdjustments(src, a, blank(src)).data], [...plain.data]);
  }
});

test('the overlay goes through blendInto, so all 26 modes are available to it', () => {
  // Reuse, not reimplementation: a second copy of 26 blend modes inside the
  // overlay is a second thing that can drift from the pixel-validated oracle.
  const src = blackRow(4);
  const seen = new Set();
  for (const mode of SUPPORTED_BLEND_MODES) {
    const a = createAdjust({
      overlay: { kind: 'linear', angle: 0, stops: RAMP, mode, opacity: 1 },
    });
    assert.equal(a.overlay.mode, mode, `${mode} survived normalisation`);
    seen.add(applyAdjustments(src, a, blank(src)).data.join(','));
  }
  assert.ok(seen.size > 1, 'different modes must produce different results');
});

test('normaliseOverlay sorts stops, completes defaults and rejects an unknown mode', () => {
  const o = normaliseOverlay({
    kind: 'nonsense', mode: 'dissolve', opacity: 5,
    stops: [{ t: 1, r: 300, g: -5, b: 10, a: 2 }, { t: 0, r: 0, g: 0, b: 0, a: 1 }],
  });
  assert.equal(o.kind, 'linear');
  assert.equal(o.mode, 'normal', 'dissolve is the one mode the compositor does not implement');
  assert.equal(o.opacity, 1);
  assert.deepEqual(o.stops.map((s) => s.t), [0, 1], 'sorted by position');
  assert.equal(o.stops[1].r, 255);
  assert.equal(o.stops[1].g, 0);
  assert.equal(o.stops[1].a, 1);
  assert.equal(normaliseOverlay({ stops: [] }).stops.length, 2, 'a gradient needs two stops');
  assert.ok(normaliseOverlay({ radius: 0 }).radius > 0, 'a zero radius divides by zero');
});
```

Add `normaliseOverlay`, `isNeutralOverlay` and `SUPPORTED_BLEND_MODES` to the
import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'normaliseOverlay'`

- [ ] **Step 3: Write the minimal implementation**

Add the import at the top of `src/adjust/ops.js`:

```js
import { SUPPORTED_BLEND_MODES } from '../composite.js';
```

Append to `src/adjust/ops.js`:

```js
export const OVERLAY_KINDS = ['linear', 'radial'];

/** A gradient needs two stops. This is what a missing or ragged one becomes. */
const DEFAULT_STOPS = () => ([
  { t: 0, r: 0, g: 0, b: 0, a: 0 },
  { t: 1, r: 0, g: 0, b: 0, a: 0 },
]);

/**
 * Complete, clamp and sort an overlay.
 *
 * Everything here is in NORMALISED layer coordinates -- cx, cy and radius are
 * fractions of the layer rect, never pixels -- which is what makes the overlay
 * scale-invariant and is why no proxyScale term appears anywhere in this file.
 */
export function normaliseOverlay(overlay) {
  const stops = (Array.isArray(overlay?.stops) ? overlay.stops : [])
    .map((s) => ({
      t: clamp(Number(s?.t) || 0, 0, 1),
      r: clamp(Math.round(Number(s?.r) || 0), 0, 255),
      g: clamp(Math.round(Number(s?.g) || 0), 0, 255),
      b: clamp(Math.round(Number(s?.b) || 0), 0, 255),
      a: clamp(Number(s?.a ?? 1), 0, 1),
    }))
    .sort((p, q) => p.t - q.t);

  const angle = Number(overlay?.angle);
  const radius = Number(overlay?.radius ?? 0.7071);

  return {
    kind: OVERLAY_KINDS.includes(overlay?.kind) ? overlay.kind : 'linear',
    angle: Number.isFinite(angle) ? angle : 0,
    cx: clamp(Number(overlay?.cx ?? 0.5) || 0, -1, 2),
    cy: clamp(Number(overlay?.cy ?? 0.5) || 0, -1, 2),
    // A zero radius divides by zero and paints the far stop everywhere.
    radius: Number.isFinite(radius) && radius > 0 ? radius : 0.7071,
    stops: stops.length >= 2 ? stops : DEFAULT_STOPS(),
    // Chosen from OUR list, not the file's -- so Phase 2's "current value not in
    // the picker" case cannot arise for an overlay, and does not need
    // duplicating here for no reason.
    mode: SUPPORTED_BLEND_MODES.includes(overlay?.mode) ? overlay.mode : 'normal',
    opacity: clamp(Number(overlay?.opacity ?? 1), 0, 1),
  };
}

/** Nothing to paint: no opacity, or every stop fully transparent. */
export const isNeutralOverlay = (overlay) =>
  !overlay || overlay.opacity <= 0 || (overlay.stops ?? []).every((s) => s.a <= 0);

/**
 * The one positional op.
 *
 * `gpuDeferred` is not a to-do, it is a DESIGN CONSTRAINT that has to be
 * resolved before an overlay can run on a GPU tier: the fragment program
 * already specialises on the LAYER's blend mode (programNameFor -- one program
 * per mode, deliberately never a switch on a uniform), and an overlay carries
 * its OWN mode from the same 26. Supporting both makes the program key a 26x26
 * matrix, which nothing in 1B anticipated. Until 1B-2 resolves it, a layer
 * carrying an overlay must stay on the JS tier -- which costs nothing today,
 * because selectTier returns TIER_JS for everything with the verdict
 * 'shader probe not run'.
 */
OPS.overlay = {
  class: 'P', lut: false, glsl: null,
  gpuDeferred: 'a per-layer overlay blend mode multiplied by the layer\'s own is a 26x26 ' +
               'program matrix that programNameFor cannot express; resolve in 1B-2',
  label: 'Overlay', range: null, neutral: null,
  evaluate: null,
};
```

Change the `overlay` line in `createAdjust`:

```js
  out.overlay = partial.overlay ? normaliseOverlay(partial.overlay) : null;
```

Extend `src/adjust/apply.js`'s imports and append the stage:

```js
import { blendInto } from '../composite.js';
import {
  HSL_BANDS, HSL_HUE_DEGREES, bandWeights, isNeutralHsl, isNeutralOverlay,
} from './ops.js';
```

```js
/** The gradient colour at `t`, written into `out` as r, g, b, a(0..1). */
function sampleStops(stops, t, out) {
  const first = stops[0];
  if (t <= first.t) { out[0] = first.r; out[1] = first.g; out[2] = first.b; out[3] = first.a; return; }
  const last = stops[stops.length - 1];
  if (t >= last.t) { out[0] = last.r; out[1] = last.g; out[2] = last.b; out[3] = last.a; return; }

  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (t > b.t) continue;
    const a = stops[i - 1];
    const span = b.t - a.t;
    const f = span > 0 ? (t - a.t) / span : 0;
    out[0] = a.r + (b.r - a.r) * f;
    out[1] = a.g + (b.g - a.g) * f;
    out[2] = a.b + (b.b - a.b) * f;
    out[3] = a.a + (b.a - a.a) * f;
    return;
  }
}

/**
 * Paint a procedural gradient over the adjusted buffer, in place.
 *
 * Row by row, through blendInto. Two reasons, both about not building a second
 * compositor: the 26 blend modes stay in ONE implementation -- the
 * pixel-validated oracle -- and the gradient needs only a `width * 4` row
 * buffer rather than a second full-size scratch, which the export peak cannot
 * afford.
 *
 * The gradient position is normalised: (x + 0.5) / width, never a pixel offset.
 * That is the whole scale-invariance argument, and it is one line.
 */
export function applyOverlay(out, overlay) {
  const { width, height } = out;
  const row = new Uint8ClampedArray(width * 4);
  const alphas = new Uint8ClampedArray(width);
  const sample = new Float64Array(4);
  const radians = (overlay.angle * Math.PI) / 180;
  const ca = Math.cos(radians);
  const sa = Math.sin(radians);
  const radial = overlay.kind === 'radial';
  const rect = { left: 0, top: 0, width, height: 1 };

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const base = y * width * 4;

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const t = radial
        ? Math.min(1, Math.hypot(u - overlay.cx, v - overlay.cy) / overlay.radius)
        : Math.min(1, Math.max(0, 0.5 + (u - 0.5) * ca + (v - 0.5) * sa));

      sampleStops(overlay.stops, t, sample);

      const dstAlpha = out.data[base + x * 4 + 3];
      alphas[x] = dstAlpha;
      row[x * 4] = sample[0];
      row[x * 4 + 1] = sample[1];
      row[x * 4 + 2] = sample[2];
      // Clipped to the layer's OWN alpha. Without this a gradient paints into
      // the transparent region and turns a cut-out into a rectangle.
      row[x * 4 + 3] = sample[3] * 255 * (dstAlpha / 255);
    }

    rect.top = y;
    blendInto(out, row, rect, overlay.opacity, overlay.mode);

    // blendInto is a GENERAL compositor: ao = as + ab(1 - as) raises alpha on
    // every partially transparent pixel. An overlay tints; it does not add
    // coverage. Restoring the column is what keeps invariant A true rather than
    // nearly true.
    for (let x = 0; x < width; x++) out.data[base + x * 4 + 3] = alphas[x];
  }
}
```

…and add the third stage to `applyAdjustments`, after the HSL stage:

```js
  // Stage 3. Pointwise in the pixel's NORMALISED position, so it is
  // scale-invariant and tiles with no halo.
  if (adjust?.overlay && !isNeutralOverlay(adjust.overlay)) applyOverlay(out, adjust.overlay);
```

Refine the two predicates in `src/adjust/lut.js`. Extend its import to
`import { CLASS_A_ORDER, OPS, isNeutralHsl, isNeutralOverlay } from './ops.js';`,
change the last line of `isNeutralAdjust`:

```js
  return !adjust.overlay || isNeutralOverlay(adjust.overlay);
```

…and the `overlay` line of `adjustCostOf`:

```js
  overlay: !!adjust?.overlay && !isNeutralOverlay(adjust.overlay),
```

Add to `src/index.js`:

```js
export { OVERLAY_KINDS, normaliseOverlay, isNeutralOverlay } from './adjust/ops.js';
export { applyOverlay } from './adjust/apply.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `42 passed`

- [ ] **Step 5: Commit**

```bash
git add src/adjust/ops.js src/adjust/apply.js src/adjust/lut.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Add the procedural gradient overlay, clipped to the layer's own alpha"
```

---

### Task 7: The presets — filters as data we author

**Files:**
- Create: `src/adjust/presets.js`
- Modify: `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Tasks 1, 5
- Produces:
  - `PRESETS: {id, label, exposure, temperature, tint, brightness, contrast, hsl?}[]` — 14 of them
  - `PRESET_IDS: string[]`
  - `presetAdjust(id, intensity = 1) -> Readonly<object>` — a frozen `adjust` carrying `preset: id`

**A preset is a named bundle of the parameters Adjust and HSL already expose,
not a separate mechanism.** Four consequences, all free: **zero** extra render
cost (it folds into the same composed LUT); presets stay editable after applying,
which PixelPerfect cannot do; intensity is one multiply toward neutral, so a
strength slider needs no new op; and undoing a preset is a single `setLayer`
restoring the *previous* parameters rather than neutral — which is the obvious
wrong implementation and is on the definition-of-done checklist for that reason.

**Every number here is authored from scratch.** PixelPerfect's filter parameters
are as much its author's work as its 30 overlay PNGs, and its repository has no
LICENSE file. Copying numbers out of a GLSL shader and calling them data would
be copying. What the reference contributes is the *idea* that a filter strip
exists — layout, not content.

**The set contains no look built on blur or grain**, because no Phase 3
operation has a pixel radius. That limitation is real and worth naming to the
user: some PixelPerfect looks cannot be reproduced. The compensation is also
real — ours are editable after applying, and theirs are not.

**Cost, in units:** nine of the fourteen are class-A only and cost a table
lookup. **Five carry an HSL block and therefore cost the expensive per-pixel
pass** — `sepia`, `noir`, `harbor`, `meadow`, `peach`. 3B's Filter sheet should
mark which, because a user tapping through a strip is otherwise choosing a
per-frame cost without being told.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\npresets\n');

test('every preset has a unique id and a label, and there are at least twelve', () => {
  assert.ok(PRESETS.length >= 12, `only ${PRESETS.length} presets`);
  assert.equal(new Set(PRESET_IDS).size, PRESETS.length, 'duplicate preset id');
  for (const p of PRESETS) assert.ok(p.label && p.label.length, `${p.id} has no label`);
});

test('every preset parameter is inside its op\'s declared range', () => {
  // A preset is authored by hand, so this is the only thing standing between a
  // typo and a table built from a clamped-at-the-boundary parameter that looks
  // deliberate.
  for (const p of PRESETS)
    for (const id of CLASS_A_ORDER) {
      const v = p[id] ?? 0;
      const [lo, hi] = OPS[id].range;
      assert.ok(v >= lo && v <= hi, `${p.id}.${id} = ${v}`);
    }
});

test('no preset is neutral, and every one builds a usable table', () => {
  for (const p of PRESETS) {
    const a = presetAdjust(p.id);
    assert.equal(isNeutralAdjust(a), false, `${p.id} does nothing`);
    const lut = buildLut(a);
    for (let i = 0; i < 768; i++)
      assert.ok(Number.isInteger(lut[i]) && lut[i] >= 0 && lut[i] <= 255, `${p.id} entry ${i}`);
  }
});

test('presetAdjust returns a frozen object carrying the preset id', () => {
  const a = presetAdjust('ember');
  assert.equal(a.preset, 'ember');
  assert.ok(Object.isFrozen(a));
  assert.equal(presetAdjust('no-such-preset').preset, 'none');
});

test('intensity scales every parameter toward neutral, and 0 IS neutral', () => {
  // One multiply on ten numbers, before the table is built. That is the whole
  // strength slider -- no new op, and nothing per pixel.
  const full = presetAdjust('ember', 1);
  const half = presetAdjust('ember', 0.5);
  for (const id of CLASS_A_ORDER)
    assert.ok(Math.abs(half[id] - full[id] / 2) < 1e-9, `${id}: ${half[id]} vs ${full[id] / 2}`);
  assert.equal(isNeutralAdjust(presetAdjust('ember', 0)), true);
});

test('intensity scales the hsl block too, not just the sliders', () => {
  const p = PRESETS.find((x) => x.hsl);
  const full = presetAdjust(p.id, 1);
  const half = presetAdjust(p.id, 0.5);
  assert.ok(Math.abs(half.hsl.saturation - full.hsl.saturation / 2) < 1e-9);
  full.hsl.bands.forEach((band, i) => {
    for (const k of ['h', 's', 'l'])
      assert.ok(Math.abs(half.hsl.bands[i][k] - band[k] / 2) < 1e-9, `band ${i}.${k}`);
  });
});
```

Add `PRESETS`, `PRESET_IDS`, `presetAdjust` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'PRESETS'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/adjust/presets.js`:

```js
/**
 * The named filters, as data.
 *
 * A preset is a BUNDLE OF THE SAME PARAMETERS Adjust and HSL already expose --
 * not a separate mechanism, not a shader, not an asset. Four consequences:
 *
 *   - Zero render cost. A preset folds into the same composed LUT (and, when it
 *     uses one, the same single HSL evaluation). A filter is not an extra pass.
 *   - Presets stay editable after applying. Tap Ember, then open Adjust and
 *     pull the contrast back. PixelPerfect cannot do that; here it falls out.
 *   - Intensity is one multiply toward neutral. No new op.
 *   - Undo is a single setLayer restoring the PREVIOUS parameters rather than
 *     neutral, which is the obvious wrong implementation.
 *
 * EVERY NUMBER HERE IS AUTHORED FROM SCRATCH. PixelPerfect's repository has no
 * LICENSE file, so its assets are all-rights-reserved -- and so are its filter
 * parameters, which are as much its author's work as its PNGs. Copying numbers
 * out of a GLSL shader and calling them data would be copying.
 *
 * NO LOOK HERE IS BUILT ON BLUR OR GRAIN, because no Phase 3 operation has a
 * pixel radius. Light leaks, duotone washes and colour grades are reachable;
 * bokeh, dust, scratches, lens flare and film grain are not, and saying so is
 * better than shipping a near-miss under a familiar name.
 *
 * COST: nine of these are class-A only and cost a table lookup. FIVE carry an
 * HSL block and cost the expensive per-pixel pass -- sepia, noir, harbor,
 * meadow, peach. The Filter sheet should say which.
 */
import { CLASS_A_ORDER, createAdjust, normaliseHsl } from './ops.js';

const band = (index, h, s, l) => ({ index, h, s, l });

/** Sparse band edits, expanded to the full eight by normaliseHsl. */
const bands = (...edits) => {
  const out = Array.from({ length: 8 }, () => ({ h: 0, s: 0, l: 0 }));
  for (const e of edits) out[e.index] = { h: e.h, s: e.s, l: e.l };
  return out;
};

export const PRESETS = [
  { id: 'ember',     label: 'Ember',     exposure: 2,  temperature: 22,  tint: -6,  brightness: 4,  contrast: 18 },
  { id: 'dusk',      label: 'Dusk',      exposure: -4, temperature: -18, tint: 6,   brightness: -6, contrast: 12 },
  { id: 'frost',     label: 'Frost',     exposure: 6,  temperature: -26, tint: -4,  brightness: 10, contrast: -6 },
  { id: 'clay',      label: 'Clay',      exposure: 2,  temperature: 14,  tint: 4,   brightness: 0,  contrast: -12 },
  { id: 'linen',     label: 'Linen',     exposure: 4,  temperature: 6,   tint: 0,   brightness: 12, contrast: -14 },
  { id: 'oxide',     label: 'Oxide',     exposure: -3, temperature: 18,  tint: -10, brightness: 0,  contrast: 26 },
  { id: 'ash',       label: 'Ash',       exposure: -2, temperature: 0,   tint: 0,   brightness: 2,  contrast: -20 },
  { id: 'ink',       label: 'Ink',       exposure: -8, temperature: -10, tint: 0,   brightness: 0,  contrast: 30 },
  { id: 'sunbleach', label: 'Sunbleach', exposure: 8,  temperature: 10,  tint: 2,   brightness: 14, contrast: -18 },

  // ---- the five that also cost the expensive per-pixel pass ----
  { id: 'sepia',  label: 'Sepia',  exposure: 0, temperature: 30,  tint: 4,   brightness: 4,  contrast: 8,
    hsl: { saturation: -80, bands: bands() } },
  { id: 'noir',   label: 'Noir',   exposure: 0, temperature: 0,   tint: 0,   brightness: -4, contrast: 34,
    hsl: { saturation: -100, bands: bands() } },
  { id: 'harbor', label: 'Harbor', exposure: 0, temperature: -22, tint: -12, brightness: 0,  contrast: 10,
    hsl: { saturation: 0, bands: bands(band(4, 0, 18, 4), band(5, -6, 14, 0)) } },
  { id: 'meadow', label: 'Meadow', exposure: 0, temperature: -6,  tint: -16, brightness: 0,  contrast: 6,
    hsl: { saturation: 0, bands: bands(band(3, -8, 24, 8)) } },
  { id: 'peach',  label: 'Peach',  exposure: 0, temperature: 16,  tint: 6,   brightness: 8,  contrast: -4,
    hsl: { saturation: 0, bands: bands(band(0, 2, 8, 4), band(1, 4, 12, 6)) } },
];

export const PRESET_IDS = PRESETS.map((p) => p.id);

/**
 * A preset's parameters as a frozen adjustment object.
 *
 * `intensity` scales every parameter toward neutral. That is all a strength
 * slider is -- one multiply on ten numbers, before the LUT is built, so it
 * costs nothing per pixel and needs no operation of its own.
 *
 * At intensity 0 the result is neutral, which setAdjust stores as `null`:
 * 0% of a filter is no filter, and the preset id going with it is correct.
 *
 * @param {string} id
 * @param {number} [intensity]  0..1
 */
export function presetAdjust(id, intensity = 1) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return createAdjust();

  const k = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1;
  const partial = { preset: id };
  for (const op of CLASS_A_ORDER) partial[op] = (preset[op] ?? 0) * k;

  if (preset.hsl) {
    const full = normaliseHsl(preset.hsl);
    partial.hsl = {
      saturation: full.saturation * k,
      bands: full.bands.map((b) => ({ h: b.h * k, s: b.s * k, l: b.l * k })),
    };
  }

  return createAdjust(partial);
}
```

Add to `src/index.js`:

```js
export { PRESETS, PRESET_IDS, presetAdjust } from './adjust/presets.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `48 passed`

- [ ] **Step 5: Commit**

```bash
git add src/adjust/presets.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Author fourteen tone-and-colour presets as parameter bundles"
```

---

### Task 8: `adjust` on the layer — frozen, replaced wholesale, coalesced

**Files:**
- Modify: `src/edit.js`, `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: `createAdjust` (Task 1), `isNeutralAdjust` (Task 2)
- Produces:
  - every layer carries `adjust: Readonly<object> | null` — `null` is the neutral value
  - `setAdjust(project, layerId, changes, coalesceKey) -> project` — merges `changes` into the layer's current adjustment, rebuilds a **new frozen object**, and routes it through `setLayer`

> **Re-read `toLayer()` before editing it.** 1C-1 added `sourceIndex`; 2A added
> `mask`, `clipping`, `groupPath`, `groupWarned`. Add `adjust` alongside what is
> there; do not paste a remembered version of the literal.

This is where finding 3 bites. `setLayer` captures `from[key] = layer[key]`
**by reference**, so an object-valued field's undo entry holds *the same object*
as the new value. A caller that mutates `layer.adjust` in place and passes the
same object has destroyed the undo entry before it was written, and nothing
complains until somebody presses undo. Two defences, both cheap and both here:
`createAdjust` deep-freezes, so an in-place mutation throws at the point of the
mistake; and the test below mutates through a **stale reference** and asserts
undo still restores — real coverage for a class of bug that is invisible by
inspection.

The other half is the drag. `setLayer`'s coalescing early-return bumps
`mutation` but **not** `revision`, and the sandwich cache keys on `revision` —
so an adjustment drag that reuses one gesture key reuses one sandwich build,
**with no new machinery whatsoever**. Task 13 proves the cache half; this task
proves the history half.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nthe layer model\n');

/** Two full-canvas raster layers, built the way conformance.js builds its own. */
const twoLayerProject = () => createProject({
  width: 8, height: 8,
  children: [
    { name: 'bottom', left: 0, top: 0, right: 8, bottom: 8,
      proxyData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(160) } },
    { name: 'top', left: 0, top: 0, right: 8, bottom: 8,
      proxyData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(90) } },
  ],
}, 'two.psd');

test('a fresh layer carries adjust === null', () => {
  // null is the neutral value of the WHOLE object, and it is what makes a
  // document with no adjustments cost exactly what it costs today: one branch.
  for (const layer of twoLayerProject().layers) assert.equal(layer.adjust, null);
});

test('setAdjust replaces the object wholesale and freezes it', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 20 });
  assert.equal(p.layers[0].adjust.brightness, 20);
  assert.ok(Object.isFrozen(p.layers[0].adjust));
  const first = p.layers[0].adjust;
  setAdjust(p, id, { contrast: 10 });
  assert.notEqual(p.layers[0].adjust, first, 'a new object, never the same one mutated');
  assert.equal(p.layers[0].adjust.brightness, 20, 'the merge kept the earlier parameter');
});

test('mutating a STALE layer.adjust reference does not corrupt undo', () => {
  // setLayer does `from[key] = layer[key]`, so an object-valued field's undo
  // entry holds THE SAME OBJECT as the new value. If a caller could mutate it,
  // undo would restore the mutated version -- a no-op that looks like undo is
  // broken rather than like the mutation was wrong. Freezing makes the attempt
  // throw; this asserts the outcome that matters either way.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 20 });
  const stale = p.layers[0].adjust;
  setAdjust(p, id, { brightness: 80 });
  assert.throws(() => { 'use strict'; stale.brightness = 999; }, TypeError);
  undo(p);
  assert.equal(p.layers[0].adjust.brightness, 20, 'undo restored the real earlier value');
});

test('one gesture key is ONE history entry, and revision does not move during the drag', () => {
  // The whole reason the sandwich cache survives a slider drag. revision is
  // bumped by commit/undo/redo/applyProjectJson but NOT by setLayer's
  // coalescing early-return, and sandwich.js keys on revision. Move this bump
  // and the drag cache is worthless.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  const key = nextGestureKey('adjust');
  setAdjust(p, id, { brightness: 10 }, key);
  const afterFirst = p.revision;
  const historyAfterFirst = p.history.length;
  for (let v = 11; v <= 40; v++) setAdjust(p, id, { brightness: v }, key);
  assert.equal(p.history.length, historyAfterFirst, 'thirty frames, one undo step');
  assert.equal(p.revision, afterFirst, 'revision must NOT move on a coalesced frame');
  assert.ok(p.mutation > afterFirst, 'mutation must move on every applied frame');
  assert.equal(p.layers[0].adjust.brightness, 40);
  undo(p);
  assert.equal(p.layers[0].adjust, null, 'one undo returns to where the drag started');
});

test('two separate drags are two undo steps', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 10 }, nextGestureKey('adjust'));
  setAdjust(p, id, { brightness: 40 }, nextGestureKey('adjust'));
  assert.equal(p.history.length, 2);
  undo(p);
  assert.equal(p.layers[0].adjust.brightness, 10, 'undo restores the PREVIOUS value, not neutral');
});

test('touching a slider marks the preset custom; applying one does not', () => {
  // Silently keeping the highlight would claim a look the numbers no longer are.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, presetAdjust('ember'));
  assert.equal(p.layers[0].adjust.preset, 'ember');
  setAdjust(p, id, { contrast: 60 });
  assert.equal(p.layers[0].adjust.preset, 'custom');
});

test('an adjustment pulled back to neutral is stored as null', () => {
  // Not an empty object. isNeutralAdjust short-cuts the entire pass on null,
  // and a layer that has been reset must cost what an untouched one costs.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, { brightness: 30 });
  setAdjust(p, id, { brightness: 0 });
  assert.equal(p.layers[0].adjust, null);
});
```

Add `createProject`, `setAdjust`, `undo`, `nextGestureKey` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'setAdjust'`

- [ ] **Step 3: Write the minimal implementation**

In `src/edit.js`, extend the existing import block at the top of the file:

```js
import { createAdjust } from './adjust/ops.js';
import { isNeutralAdjust } from './adjust/lut.js';
```

Add this field to `toLayer`'s object literal, **after the existing
`groupWarned` field and before `rerendered`**:

```js
    /**
     * Non-destructive raster adjustments: one FROZEN object, or null when
     * neutral. Evaluated at render time inside drawLayerInto, after resampling
     * and before blending -- never baked into `pixels`, never written to a
     * saved project as pixels, and never seen by a neighbouring layer.
     *
     * REPLACED WHOLESALE, NEVER MUTATED. setLayer captures object-valued `from`
     * by reference, so mutating this in place destroys the undo entry before it
     * is written. createAdjust deep-freezes every object it builds, which turns
     * that mistake into a TypeError where it happens instead of a silent loss
     * later. Go through setAdjust().
     */
    adjust: null,
```

Add `setAdjust` immediately after `setLayer`:

```js
/**
 * Merge a change into a layer's adjustment.
 *
 * The ONLY sanctioned way to change one. It rebuilds a complete, clamped,
 * deeply frozen object from the current parameters plus `changes` and hands
 * that to setLayer, so:
 *
 *   - `from` and `to` are always DIFFERENT objects, and undo works;
 *   - an out-of-range number can never reach an evaluator;
 *   - a neutral result is stored as `null` rather than as an empty-looking
 *     object, so isNeutralAdjust short-cuts the whole pass and a reset layer
 *     costs what an untouched one costs.
 *
 * Pass a gesture key from nextGestureKey('adjust') for a slider drag: setLayer
 * then coalesces the frames into ONE history entry and leaves `revision`
 * alone, which is what lets the sandwich cache survive the gesture.
 *
 * @param {object} project
 * @param {number} id
 * @param {object} changes  any subset of the adjust schema
 * @param {string} [coalesceKey]
 */
export function setAdjust(project, id, changes, coalesceKey) {
  const layer = findLayer(project, id);
  if (!layer) return project;

  // Touching a parameter without naming a preset means the numbers are no
  // longer the preset's. Keeping the highlight would claim a look they are not.
  const touchesParameters = Object.keys(changes).some((k) => k !== 'preset');
  const preset = 'preset' in changes ? changes.preset
    : touchesParameters && layer.adjust && layer.adjust.preset !== 'none' ? 'custom'
    : layer.adjust?.preset;

  const next = createAdjust({ ...(layer.adjust ?? {}), ...changes, preset });
  return setLayer(project, id, { adjust: isNeutralAdjust(next) ? null : next }, coalesceKey);
}
```

Add to `src/index.js`, extending the existing `edit.js` export block:

```js
  createProject, findLayer, commit, setLayer, setAdjust, reorderLayer, undo, redo,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `55 passed`

Run: `npm test`
Expected: every baseline marker unchanged. `adjust` is a field nothing reads
yet, so no pixel moved and the oracle line is still `12/5/4`.

- [ ] **Step 5: Commit**

```bash
git add src/edit.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Carry a frozen, wholesale-replaced adjust object on every layer"
```

---

### Task 9: `discardTo` — what `✕` on a tool sheet actually does

**Files:**
- Modify: `src/edit.js`, `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Task 8
- Produces: `discardTo(project, historyLength) -> number` — the number of commands popped

PixelPerfect's `✕` and `✓` mean cancel and apply because it *bakes*. Nothing
bakes here, so `✓` is just "close" and needs no code at all. `✕` has to mean
"discard the whole sheet session, however many sliders were touched, in one
action" — which is a roll back to the history length recorded when the sheet
opened.

It pops **without pushing to `future`**, deliberately. Leaving a discarded
experiment on the redo stack is how a user finds it again by accident three
actions later and cannot explain where it came from.

`revision` bumps **once** for the whole rollback, not once per pop: the sandwich
cache only needs to know that something structural changed, and bumping it eight
times to describe one user action is eight cache keys nobody reads.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
test('discardTo returns the layer to its pre-sheet state in one call', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  setAdjust(p, id, presetAdjust('ember'));
  const mark = p.history.length;                 // the sheet opens here
  setAdjust(p, id, { brightness: 40 }, nextGestureKey('adjust'));
  setAdjust(p, id, { contrast: -30 }, nextGestureKey('adjust'));
  setAdjust(p, id, { temperature: 90 }, nextGestureKey('adjust'));
  assert.equal(discardTo(p, mark), 3);
  assert.equal(p.layers[0].adjust.preset, 'ember');
  assert.equal(p.layers[0].adjust.brightness, presetAdjust('ember').brightness);
  assert.equal(p.history.length, mark);
});

test('discardTo leaves `future` empty rather than stashing the experiment on redo', () => {
  // A discarded experiment sitting on the redo stack is something the user
  // finds again by accident and cannot explain.
  const p = twoLayerProject();
  const id = p.layers[0].id;
  const mark = p.history.length;
  setAdjust(p, id, { brightness: 40 });
  discardTo(p, mark);
  assert.equal(p.future.length, 0);
});

test('discardTo bumps revision once, not once per pop', () => {
  const p = twoLayerProject();
  const id = p.layers[0].id;
  const mark = p.history.length;
  for (const v of [10, 20, 30, 40]) setAdjust(p, id, { brightness: v }, nextGestureKey('adjust'));
  const before = p.revision;
  discardTo(p, mark);
  assert.equal(p.revision, before + 1, 'one user action, one structural change');
});

test('discardTo past the current length, or below zero, is a no-op', () => {
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 12 });
  const before = p.revision;
  assert.equal(discardTo(p, 99), 0);
  assert.equal(discardTo(p, -5), 1, 'a negative target clamps to zero and empties the history');
  assert.equal(p.layers[0].adjust, null);
  assert.equal(p.revision, before + 1);
});
```

Add `discardTo` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'discardTo'`

- [ ] **Step 3: Write the minimal implementation**

Add to `src/edit.js`, immediately after `redo`:

```js
/**
 * Roll the history back to a recorded length, discarding what was popped.
 *
 * What `X` on a tool sheet does. PixelPerfect's X/tick mean cancel/apply
 * because it BAKES; nothing bakes here, so the tick is just "close" and needs
 * no code, and the X has to mean "discard this whole session, however many
 * sliders were touched, in one action".
 *
 * Pops WITHOUT pushing to `future`, deliberately: a discarded experiment left
 * on the redo stack is something the user finds again by accident three actions
 * later and cannot explain.
 *
 * `revision` bumps ONCE for the whole rollback rather than once per pop. The
 * caches keyed on it only need to know that something structural changed, and
 * describing one user action with eight keys is eight keys nobody reads.
 *
 * @param {object} project
 * @param {number} historyLength  project.history.length as it was when the sheet opened
 * @returns {number} commands popped
 */
export function discardTo(project, historyLength) {
  const target = Math.max(0, Number(historyLength) || 0);
  let popped = 0;

  while (project.history.length > target) {
    const command = project.history.pop();
    if (!command) break;
    applyCommand(project, invert(command));
    popped++;
  }

  if (popped) {
    project.future.length = 0;
    project.revision = (project.revision ?? 0) + 1;
  }
  return popped;
}
```

Add `discardTo` to the `edit.js` export block in `src/index.js`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `59 passed`

- [ ] **Step 5: Commit**

```bash
git add src/edit.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Add discardTo so a tool sheet's X discards its whole session at once"
```

---

### Task 10: Persist every adjustment parameter across a session

**Files:**
- Modify: `src/edit.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Tasks 1, 6, 8
- Produces: `toProjectJson` carries `adjust`; `applyProjectJson` restores it through `createAdjust`, re-frozen and re-clamped

> **Re-read `toProjectJson` and `applyProjectJson` before editing them.** 2A
> added `clipping`, `groupPath` and `maskDisabled` to both. Add alongside.

Saving and reopening a project must restore every parameter — a definition-of-
done bullet, and the one place a silent data loss would be invisible until a
user reopened work they had spent time on.

**The derived LUT is not persisted.** It is rebuilt from the parameters, keyed
on `lutDigest`, which reads exactly the parameters it depends on — so writing it
to the file would be storing a cache that can only ever disagree with its
inputs.

**Restoration goes through `createAdjust`, not `Object.assign`.** A hand-edited
save file carrying `contrast: 9e9` must clamp into range before it can reach an
evaluator, and the restored object must be frozen for the same reason every
other one is.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
test('toProjectJson carries every parameter, including hsl bands and overlay stops', () => {
  const p = twoLayerProject();
  const bands = NEUTRAL_BANDS();
  bands[5] = { h: -40, s: 55, l: -12 };
  setAdjust(p, p.layers[0].id, {
    brightness: 14, contrast: -22, exposure: 9, temperature: 31, tint: -7,
    hsl: { bands, saturation: 18 },
    overlay: { kind: 'radial', cx: 0.3, cy: 0.7, radius: 0.42, mode: 'soft light', opacity: 0.65,
               stops: [{ t: 0, r: 12, g: 34, b: 56, a: 0.9 }, { t: 1, r: 200, g: 10, b: 5, a: 0.2 }] },
  });

  const json = toProjectJson(p);
  const saved = json.layers[0].adjust;
  assert.equal(saved.brightness, 14);
  assert.equal(saved.hsl.bands[5].s, 55);
  assert.equal(saved.overlay.stops[1].r, 200);
  assert.equal(json.layers[1].adjust, null, 'an unadjusted layer saves null, not an object');
});

test('applyProjectJson restores every parameter, re-frozen', () => {
  const source = twoLayerProject();
  setAdjust(source, source.layers[0].id, {
    brightness: 14, hsl: { bands: NEUTRAL_BANDS(), saturation: 18 },
    overlay: { kind: 'radial', mode: 'soft light', opacity: 0.65,
               stops: [{ t: 0, r: 12, g: 34, b: 56, a: 0.9 }, { t: 1, r: 200, g: 10, b: 5, a: 0.2 }] },
  });
  const json = JSON.parse(JSON.stringify(toProjectJson(source)));   // a real round trip through text

  const target = twoLayerProject();
  applyProjectJson(target, json);
  const a = target.layers[0].adjust;
  assert.equal(a.brightness, 14);
  assert.equal(a.hsl.saturation, 18);
  assert.equal(a.overlay.kind, 'radial');
  assert.equal(a.overlay.mode, 'soft light');
  assert.equal(a.overlay.stops[1].r, 200);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.hsl) && Object.isFrozen(a.overlay));
  assert.equal(target.layers[1].adjust, null);
});

test('applyProjectJson clamps a hand-edited out-of-range parameter', () => {
  // The save file is text on a device. It reaches an evaluator only through
  // createAdjust, so an absurd number becomes the boundary rather than a table
  // full of clipped values that looks deliberate.
  const target = twoLayerProject();
  const json = toProjectJson(twoLayerProject());
  json.layers[0].adjust = { brightness: 9e9, contrast: -9e9 };
  applyProjectJson(target, json);
  assert.equal(target.layers[0].adjust.brightness, 100);
  assert.equal(target.layers[0].adjust.contrast, -100);
});

test('the derived LUT is not persisted and is rebuilt from parameters', () => {
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { contrast: 44 });
  lutFor(p.layers[0]);                                   // populate the cache
  assert.equal(toProjectJson(p).layers[0].lut, undefined);
  assert.equal(toProjectJson(p).layers[0].lutKey, undefined);

  const target = twoLayerProject();
  applyProjectJson(target, JSON.parse(JSON.stringify(toProjectJson(p))));
  assert.deepEqual([...lutFor(target.layers[0])], [...lutFor(p.layers[0])]);
});
```

Add `toProjectJson`, `applyProjectJson` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `assert.equal(saved.brightness, 14)` — `saved` is `undefined`

- [ ] **Step 3: Write the minimal implementation**

In `toProjectJson`'s per-layer object, add beside `maskDisabled`:

```js
      /**
       * The adjustment PARAMETERS. Not the table they build: lutFor rebuilds
       * that from these, keyed on exactly the values it reads, so writing it
       * here would be storing a cache that can only ever disagree with its
       * input. The object is already frozen and JSON-shaped.
       */
      adjust: l.adjust ?? null,
```

In `applyProjectJson`'s per-layer loop, add after the `maskDisabled` line:

```js
    // Through createAdjust rather than Object.assign: the save file is text on
    // a device, so an out-of-range or half-built object has to be clamped and
    // completed before it can reach an evaluator -- and the result has to be
    // frozen for the same reason every other one is.
    layer.adjust = saved.adjust ? createAdjust(saved.adjust) : null;
    // The derived table is keyed on the parameters, so it re-derives itself on
    // the next lutFor. Dropping the key anyway keeps the pair honest.
    layer.lutKey = null;
    layer.lut = null;
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `63 passed`

Run: `npm test`
Expected: every baseline marker unchanged. `test/edit.mjs` round-trips a project
and asserts on named fields, not on a whole-object `deepEqual`, so adding a key
does not disturb its `21 passed`. **If it does, stop and read the assertion
before changing it.**

- [ ] **Step 5: Commit**

```bash
git add src/edit.js test/adjust.mjs
git diff --staged
git commit -m "Persist adjustment parameters, restored through the clamping constructor"
```

---

### Task 11: The render hook — and the assertion the non-destructive claim stands on

**Files:**
- Modify: `src/render.js`, `src/sandwich.js`, `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: `isNeutralAdjust`, `lutFor`, `adjustCostOf` (Task 2); `acquireScratch`, `DEFAULT_SCRATCH` (Task 3); `applyAdjustments` (Tasks 4–6)
- Produces:
  - `drawLayerInto(dest, layer, scale, options)` — `options` gains `scratch` and `stats`
  - `renderProject(project, {scale, stats, scratch})`
  - `renderSandwiched(cache, project, selectionIndex, {scale, stats})`
  - `createRenderStats() -> {layers: 0, lut: 0, hsl: 0, overlay: 0}`

One hook, in the one function all three render paths already share. That fact
is what makes the whole ruling cheap: preview, drag cache and full-resolution
export inherit the adjustment with no second implementation, and there is no
place for the two to disagree.

**This is the task the trap lives in.** On the default preview path
`resample()` identity-returns its argument, so the buffer `drawLayerInto` is
holding *is `layer.pixels` itself* — verified by running it: 256×256 in,
256×256 out, the same object. Adjusting in place would overwrite the layer's
originals permanently and compound on every frame of a drag. Step 1 asserts all
three halves of that: that the identity return really happens (so nobody
"fixes" it away and removes the reason the guard exists), that a render leaves
`layer.pixels` byte-identical, and that two consecutive renders agree.

**The cost counters ship with the pass, not after it.** Phase 1B and Phase 2
both established that a cost the user cannot see is a bug; `lut: N / hsl: M` is
the Phase 3 instance. On a *cached* sandwich frame the counters report only the
live layer, because a cached frame genuinely did not run the other layers'
passes — reporting what a frame would have cost rather than what it did cost is
the same lie the ladder exists to replace.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nthe render hook\n');

test('resample() identity-returns its input when the dimensions already match', () => {
  // The PRECONDITION of the whole aliasing hazard, pinned so nobody removes the
  // early return and quietly deletes the reason applyAdjustments guards itself.
  // 1B's finding 4: this is the DEFAULT preview path, not an edge case --
  // downscaleImage produces round(w * proxyScale) and renderProject at
  // scale = proxyScale asks for the same expression.
  const src = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  assert.equal(resample(src, 8, 8), src, 'same object, not a copy');
});

test('a render NEVER writes into layer.pixels', () => {
  // THE assertion the non-destructive claim stands on. Applied in place, a
  // brightness adjustment would overwrite the layer's originals permanently --
  // and because the next frame reads the same buffer it would compound, so a
  // held slider runs away to white with nothing on screen to say so.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 90, contrast: 60 });
  const before = new Uint8ClampedArray(p.layers[0].pixels.data);
  renderProject(p, { scale: 1 });
  assert.deepEqual([...p.layers[0].pixels.data], [...before], 'the source was mutated');
});

test('rendering the same project twice produces identical frames', () => {
  // The compounding half. One frame proves the buffer was not aliased; two
  // prove it cannot accumulate, which is what a drag actually does.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 90, contrast: 60 });
  const first = renderProject(p, { scale: 1 });
  const second = renderProject(p, { scale: 1 });
  assert.deepEqual([...first.data], [...second.data]);
});

test('an adjustment changes the layer it is on and nothing else', () => {
  const p = twoLayerProject();
  p.layers[1].visible = false;                          // isolate the bottom layer
  const plain = renderProject(p, { scale: 1 });
  setAdjust(p, p.layers[1].id, { brightness: 100 });    // adjust the HIDDEN one
  assert.deepEqual([...renderProject(p, { scale: 1 }).data], [...plain.data],
    'an adjustment on a hidden layer must change nothing');
  setAdjust(p, p.layers[0].id, { brightness: 100 });
  assert.notDeepEqual([...renderProject(p, { scale: 1 }).data], [...plain.data]);
});

test('a layer with no adjustment renders byte-identically to before this phase', () => {
  // The one-branch guarantee. A document with no adjustments must cost exactly
  // what it cost yesterday, and produce exactly the same pixels.
  const p = twoLayerProject();
  const plain = renderProject(p, { scale: 1 });
  setAdjust(p, p.layers[0].id, { brightness: 0 });      // neutral -> stored as null
  assert.equal(p.layers[0].adjust, null);
  assert.deepEqual([...renderProject(p, { scale: 1 }).data], [...plain.data]);
});

test('the two cost terms are counted separately, per frame', () => {
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { contrast: 20 });
  setAdjust(p, p.layers[1].id, {
    hsl: { bands: NEUTRAL_BANDS(), saturation: -50 },
  });
  const stats = createRenderStats();
  renderProject(p, { scale: 1, stats });
  assert.equal(stats.layers, 2);
  assert.equal(stats.lut, 1, 'one layer carried a class-A table');
  assert.equal(stats.hsl, 1, 'one layer carried the expensive pass');
  assert.equal(stats.overlay, 0);
});

test('a cached sandwich frame counts only the live layer, because only it ran', () => {
  // Reporting what a frame WOULD have cost rather than what it DID cost is the
  // same lie the measured ladder exists to replace. During a drag, `below` and
  // `above` are cached composites that already contain their layers'
  // adjustments, computed once at cache build.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { contrast: 20 });
  setAdjust(p, p.layers[1].id, { contrast: 20 });
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });          // build
  const stats = createRenderStats();
  renderSandwiched(cache, p, 1, { scale: 1, stats });   // cached
  assert.equal(stats.lut, 1, 'only the live layer re-adjusted');
});
```

Add `resample`, `renderProject`, `createRenderStats`, `createSandwichCache`,
`renderSandwiched` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'createRenderStats'`

- [ ] **Step 3: Write the minimal implementation**

In `src/render.js`, add the imports below the existing ones:

```js
import { isNeutralAdjust, lutFor, adjustCostOf } from './adjust/lut.js';
import { applyAdjustments } from './adjust/apply.js';
import { acquireScratch, DEFAULT_SCRATCH } from './adjust/scratch.js';
```

Add above `drawLayerInto`:

```js
/**
 * Per-frame cost counters.
 *
 * Phase 1B and Phase 2 both established that an approximation or a cost the
 * user cannot see is a bug. These are the Phase 3 instance: the debug readout
 * shows `lut: N / hsl: M`, the two terms separately, because they differ by an
 * estimated order of magnitude per layer and a single total would hide which
 * one a slow frame is made of.
 */
export const createRenderStats = () => ({ layers: 0, lut: 0, hsl: 0, overlay: 0 });
```

Extend `drawLayerInto`'s JSDoc `options` paragraph with:

```
 *   `scratch` is the destination buffer the adjustment pass writes into --
 *   defaults to the shared preview one. Export passes its own, so a
 *   full-resolution buffer is not left alive by the editor afterwards.
 *   `stats` is a createRenderStats() object; when present, the counters are
 *   incremented for the passes THIS call actually ran.
```

…and insert the hook between the `if (!pixels)` guard and the `blendInto` call:

```js
  if (options.stats) options.stats.layers++;

  // Adjustments are a property of THIS layer, evaluated on its own pixels,
  // after resampling and before blending. They never see the backdrop, never
  // see a neighbour, and never produce a new entry in the layer stack -- which
  // is what lets the one-layer-at-a-time export walk serve them with no second
  // implementation, and what keeps every operation tile-independent.
  //
  // AFTER resample, not before. Pointwise operations do not commute with
  // bilinear interpolation, so the order is a decision: the GPU forces it (a
  // fragment shader samples uSource and only THEN has a value to adjust), it
  // makes the pass cost proportional to the DESTINATION rect, and on the
  // default preview path the two orders coincide anyway because resample()
  // identity-returns and there is no interpolation to commute with.
  if (layer.adjust && !isNeutralAdjust(layer.adjust)) {
    // NEVER IN PLACE. resample() above returns its INPUT OBJECT when the
    // dimensions already match -- the default preview path -- and
    // textPixelsAt() returns layer.rendered itself. Adjusting in place would
    // overwrite the layer's original pixels permanently and compound on every
    // frame of a drag. applyAdjustments throws if this ever aliases; the
    // scratch is what stops it having to.
    const out = acquireScratch(options.scratch || DEFAULT_SCRATCH, rect.width, rect.height);
    applyAdjustments(pixels, layer.adjust, out, lutFor(layer));
    pixels = out;

    if (options.stats) {
      const cost = adjustCostOf(layer.adjust);
      if (cost.lut) options.stats.lut++;
      if (cost.hsl) options.stats.hsl++;
      if (cost.overlay) options.stats.overlay++;
    }
  }

  blendInto(dest, pixels.data, rect, layer.opacity, layer.blendMode);
```

Replace `renderProject`'s body signature and loop:

```js
export function renderProject(project, options = {}) {
  const { scale = 1, stats = null, scratch = null } = options;
  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));
  const dest = createBuffer(width, height);

  // bottom to top. `pixels` is deliberately ABSENT from the options object --
  // drawLayerInto reads it with `in`, so passing it as undefined would replace
  // every layer's pixels with nothing.
  for (const layer of project.layers) drawLayerInto(dest, layer, scale, { stats, scratch });

  return dest;
}
```

…and update its JSDoc:

```js
/**
 * @param {object} project
 * @param {{scale?: number, stats?: object|null, scratch?: object|null}} [options]
 *   `scale` 1 renders at document resolution; lower values are for interactive preview.
 *   `stats` counts the adjustment passes this frame actually ran.
 *   `scratch` overrides the shared adjustment destination buffer.
 */
```

In `src/sandwich.js`, thread `stats` through. `renderSandwiched`'s destructure
becomes:

```js
  const { scale = 1, stats = null } = options;
```

…the out-of-range fallback becomes `return renderProject(project, { scale, stats });`,
`rebuild` takes no stats (a cache build is not a frame the user is waiting on
per se, and counting it would double-count on the build frame — the counters
describe the LIVE work), and the three draw calls become:

```js
  drawLayerInto(frame, project.layers[selectionIndex], scale, { stats });
```

```js
    for (let i = selectionIndex + 1; i < project.layers.length; i++)
      drawLayerInto(frame, project.layers[i], scale, { stats });
```

Add to `src/index.js`, extending the `render.js` export line:

```js
export {
  renderProject, resample, rasteriseTextAt, measureText, drawLayerInto, createRenderStats,
} from './render.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/adjust.mjs`
Expected: PASS — `70 passed`

Run: `npm test`
Expected: **every baseline marker unchanged**, including the oracle line
`12/5/4`. No fixture carries an adjustment, so `layer.adjust` is `null`
everywhere and the hook is one branch that never fires. **If the oracle line
moved, the hook is running when it should not — read `isNeutralAdjust` before
touching anything else.**

> **What this task does NOT prove.** That the adjustment applies to a
> re-rendered **text** layer. `create2dSurface` returns `null` in Node, so
> `textPixelsAt` returns `null` and a text layer never reaches the hook here.
> It follows from the hook sitting below both branches of `drawLayerInto`, and
> it is on Task 17's device checklist. Do not report it as tested.

- [ ] **Step 5: Commit**

```bash
git add src/render.js src/sandwich.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Apply adjustments in drawLayerInto, into a scratch, never in place"
```

---

### Task 12: Export parity — the same adjustment at full resolution

**Files:**
- Modify: `src/export/target-js.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Tasks 3, 11
- Produces: `createJsExportTarget(width, height)` owns a scratch, passes it through `drawLayerInto`, and releases it in both `finish()` and `dispose()`. It also exposes `scratch` as a diagnostic seam.

**`src/export/stream.js` needs no change, and this task must not make one.**
The walk hands `target.blend(layer, pixels)` one layer at a time and
`createJsExportTarget` already calls `drawLayerInto(dest, layer, 1, { pixels })`
— so the hook from Task 11 is already on the export path, at full resolution,
with the same parameters and the same LUT bytes the preview used. That is the
whole reason adjustments are per-layer rather than a stack entry: an adjustment
that is a pure function of *that layer's own pixels and its own parameters*
needs nothing else in scope, so the arrival-order/blend-order problem and the
spill path are entirely unaffected, and a layer read back from a spill file goes
through the identical `blend` call.

What *does* change is who owns the destination buffer. **Cost, in units:** at
`scale: 1` the scratch grows to the largest layer in the document — for the
measured 4961 × 3508 poster that is **+66.4 MB** *(derived from 1C's arithmetic,
not measured)*, and it is one term, not N, because every layer reuses it. It has
to be droppable **before the PNG encode peak**, which is why the target owns it
rather than sharing the editor's module-level one.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nexport parity\n');

test('the JS export target and renderProject produce the identical buffer', () => {
  // Both go through drawLayerInto, so this is the assertion that the hook has
  // exactly one implementation rather than two that happen to agree today.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 40, contrast: -25 });
  setAdjust(p, p.layers[1].id, {
    overlay: { kind: 'linear', angle: 45, mode: 'multiply', opacity: 0.7,
               stops: [{ t: 0, r: 255, g: 200, b: 0, a: 1 }, { t: 1, r: 0, g: 30, b: 120, a: 1 }] },
  });

  const target = createJsExportTarget(p.width, p.height);
  for (const layer of p.layers) target.blend(layer, layer.pixels);
  const exported = await target.finish();

  assert.deepEqual([...exported.data], [...renderProject(p, { scale: 1 }).data]);
});

test('a full-resolution streamed export carries the adjustment', async () => {
  // End to end, through the real walk on a real fixture -- the file is re-read
  // and re-decoded, so these are the FULL-RESOLUTION pixels, not the proxy the
  // editor is holding.
  const plainProject = await openProxy();
  const plain = await runExport(plainProject, createMemorySpill());

  const adjusted = await openProxy();
  setAdjust(adjusted, adjusted.layers[0].id, { brightness: 60 });
  const out = await runExport(adjusted, createMemorySpill());

  assert.equal(out.width, plain.width);
  assert.notDeepEqual([...out.data], [...plain.data], 'the adjustment never reached the export');
});

test('for a single opaque layer the export equals the LUT applied to the plain export', async () => {
  // The exact parity claim, not an approximation of it. With one visible layer
  // blending `normal` onto a transparent backdrop, blendInto reduces to
  // dest = src, so the exported byte IS the adjusted source byte -- and the
  // adjusted source byte is, by construction, lut[plain byte].
  const plainProject = await openProxy();
  for (let i = 1; i < plainProject.layers.length; i++) plainProject.layers[i].visible = false;
  const plain = await runExport(plainProject, createMemorySpill());

  const adjustedProject = await openProxy();
  for (let i = 1; i < adjustedProject.layers.length; i++) adjustedProject.layers[i].visible = false;
  setAdjust(adjustedProject, adjustedProject.layers[0].id, { contrast: 45, temperature: -20 });
  const out = await runExport(adjustedProject, createMemorySpill());

  const lut = buildLut(adjustedProject.layers[0].adjust);
  let checked = 0;
  for (let i = 0; i < plain.data.length; i += 4) {
    if (plain.data[i + 3] === 0) continue;               // blendInto skipped it in both
    assert.equal(out.data[i], lut[plain.data[i]], `pixel ${i / 4} red`);
    assert.equal(out.data[i + 1], lut[256 + plain.data[i + 1]], `pixel ${i / 4} green`);
    assert.equal(out.data[i + 2], lut[512 + plain.data[i + 2]], `pixel ${i / 4} blue`);
    checked++;
  }
  assert.ok(checked > 1000, `only ${checked} opaque pixels checked`);
});

test('the export target owns its scratch and releases it before the encode peak', async () => {
  // At scale 1 the scratch has grown to the largest layer in the document --
  // +66.4 MB for the measured poster. It must not still be resident while the
  // PNG encoder allocates, which is the same place 1C already drops the file
  // bytes.
  const p = twoLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 40 });
  const target = createJsExportTarget(p.width, p.height);
  for (const layer of p.layers) target.blend(layer, layer.pixels);
  assert.ok(target.scratch.data, 'the scratch was never acquired');
  await target.finish();
  assert.equal(target.scratch.data, null, 'finish() must drop it');

  const second = createJsExportTarget(p.width, p.height);
  second.blend(p.layers[0], p.layers[0].pixels);
  second.dispose();
  assert.equal(second.scratch.data, null, 'dispose() must drop it too');
});
```

**All four of these use `await`**, so all four run through an async test helper.
Add one beside `test`, matching `test/export.mjs`'s `atest`:

```js
const atest = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};
```

…and the fixture helpers, matching `test/export.mjs` exactly:

```js
import fs from 'fs';
const bytesOf = (path) => new Uint8Array(fs.readFileSync(path));
const FIXTURE = 'fixtures/vectors.src.psd';
const FIXTURE_SIZE = fs.statSync(FIXTURE).size;

const openProxy = () => loadProjectProxy(bytesOf(FIXTURE), {
  fileName: 'vectors.src.psd',
  proxyEdge: 256,
  source: { uri: FIXTURE, name: 'vectors.src.psd', size: FIXTURE_SIZE, kind: 'blob' },
});

const runExport = (project, spill) => exportFullRes({
  project, readSource: async () => bytesOf(FIXTURE), spill, createTarget: createJsExportTarget,
});
```

Write all four as `await atest('...', async () => { ... })`. Add
`loadProjectProxy`, `exportFullRes`, `createJsExportTarget`, `createMemorySpill`
to the import.

> **Change the `test:adjust` script to `--max-old-space-size=6144`** if you have
> not already — this task loads a real fixture. It is already written that way
> in Task 1.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: FAIL — `the scratch was never acquired` (`target.scratch` is `undefined`)

- [ ] **Step 3: Write the minimal implementation**

In `src/export/target-js.js`, add the import and the scratch:

```js
import { createScratch, releaseScratch } from '../adjust/scratch.js';
```

```js
export function createJsExportTarget(width, height) {
  const dest = createBuffer(width, height);

  /**
   * Export owns its OWN adjustment scratch rather than sharing the editor's
   * module-level one, for a memory reason. At scale 1 the buffer grows to the
   * largest DESTINATION RECT in the document -- +66.4 MB for the measured
   * 4961x3508 poster, derived from 1C's peak arithmetic -- and it has to be
   * droppable before the PNG encode peak, which is the same place 1C already
   * drops the file bytes. Sharing the editor's would leave a full-resolution
   * buffer alive for the rest of the session.
   *
   * ONE term, not N: every layer reuses it, and it is only ever allocated when
   * some layer actually carries a non-neutral adjustment.
   */
  const scratch = createScratch();

  return {
    /**
     * @param {object} layer   Geometry in DOCUMENT coordinates, drawn at scale 1.
     * @param {object|null} pixels  Full-resolution pixels, or null for a layer
     *   that draws itself (re-rendered text) or has none at all.
     */
    blend(layer, pixels) {
      drawLayerInto(dest, layer, 1, {
        pixels,
        scratch,
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

    async finish() { releaseScratch(scratch); return dest; },

    dispose() { releaseScratch(scratch); },

    /** Diagnostic seam. exportFullRes never reads it; the memory test does. */
    scratch,
  };
}
```

> **Do not touch `src/export/stream.js`.** Constraint (4) is verified by the
> walk needing no change: `git diff --staged` for this commit must not list it.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: PASS — `74 passed`

Run: `npm test`
Expected: every baseline marker unchanged, `79 passed` from `test/export.mjs`
included. The target gained a property and a constructor call; no fixture
carries an adjustment, so no exported byte moved.

- [ ] **Step 5: Commit**

```bash
git add src/export/target-js.js test/adjust.mjs
git diff --staged
git commit -m "Give the JS export target its own adjustment scratch, released before the encode peak"
```

---

### Task 13: Cache invalidation — a slider drag must not rebuild the sandwich

**Files:**
- Test: `test/adjust.mjs` **only**

**Interfaces:**
- Consumes: Tasks 8, 11
- Produces: no source change. **The deliverable is the assertion.**

This task writes no implementation, and that is the point: the existing
`revision` / `mutation` split already answers cache invalidation, and what is
missing is anything that *pins* it. Get this wrong and the drag cache — the
entire reason `src/sandwich.js` exists — is worthless, and it fails silently by
being slow rather than by being wrong.

The spec's table, made executable:

| Event | `mutation` | `revision` | Sandwich cache |
|---|---|---|---|
| Slider frame *n* of a drag (coalesced) | bumps | **does not bump** | **survives** — key unchanged |
| First frame of the drag (`commit`) | bumps | bumps | rebuilt once |
| Adjustment on a layer **below** the selection | bumps | bumps | rebuilt |

An adjustment drag is therefore **structurally identical in cost to a move
drag** — `below` and `above` are cached composites that already contain their
own layers' adjustments, computed once at cache build, and only the live layer
re-adjusts per frame. That is the single most important consequence of putting
adjustments on the layer rather than in the stack.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\ncache invalidation\n');

/** Three full-canvas layers, so there is something above AND below a selection. */
const threeLayerProject = () => createProject({
  width: 8, height: 8,
  children: [0, 1, 2].map((i) => ({
    name: `L${i}`, left: 0, top: 0, right: 8, bottom: 8,
    proxyData: { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(60 + i * 60) },
  })),
}, 'three.psd');

test('a coalesced adjustment drag reuses ONE cache build while the frame keeps changing', () => {
  // The whole reason src/sandwich.js exists. If revision moved on a coalesced
  // frame, every drag frame would rebuild TWO full composites of the rest of
  // the stack -- and it would fail silently, by being slow.
  const p = threeLayerProject();
  const cache = createSandwichCache();
  const id = p.layers[1].id;
  const key = nextGestureKey('adjust');

  setAdjust(p, id, { brightness: 5 }, key);          // first frame: commit, revision moves
  const firstFrame = renderSandwiched(cache, p, 1, { scale: 1 });
  const builds = cache.builds;
  assert.equal(builds, 1);

  let lastFrame = firstFrame;
  for (let v = 10; v <= 90; v += 10) {
    setAdjust(p, id, { brightness: v }, key);
    lastFrame = renderSandwiched(cache, p, 1, { scale: 1 });
    assert.equal(cache.builds, builds, `frame at brightness ${v} rebuilt the cache`);
  }
  assert.notDeepEqual([...lastFrame.data], [...firstFrame.data],
    'the cache held but the frame never changed -- the live layer is not re-adjusting');
});

test('the first frame of a drag rebuilds exactly once', () => {
  const p = threeLayerProject();
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });
  assert.equal(cache.builds, 1);
  setAdjust(p, p.layers[1].id, { brightness: 20 }, nextGestureKey('adjust'));
  renderSandwiched(cache, p, 1, { scale: 1 });
  assert.equal(cache.builds, 2, 'a commit must invalidate; `below` and `above` are stale');
});

test('an adjustment on a layer BELOW the selection rebuilds the cache', () => {
  // `below` is a real composite of those layers, so it has to be redone. Same
  // for above. Getting this wrong in the other direction is the failure that
  // shows a stale backdrop for the rest of a gesture.
  const p = threeLayerProject();
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });
  const builds = cache.builds;
  setAdjust(p, p.layers[0].id, { brightness: 70 });
  const after = renderSandwiched(cache, p, 1, { scale: 1 });
  assert.equal(cache.builds, builds + 1);
  assert.ok(after.data.some((v, i) => v !== 0 || i % 4 === 3));
});

test('a discarded sheet session invalidates the cache once', () => {
  const p = threeLayerProject();
  const cache = createSandwichCache();
  renderSandwiched(cache, p, 1, { scale: 1 });
  const mark = p.history.length;
  const builds = cache.builds;
  for (const v of [20, 40, 60]) setAdjust(p, p.layers[1].id, { brightness: v }, nextGestureKey('adjust'));
  discardTo(p, mark);
  renderSandwiched(cache, p, 1, { scale: 1 });
  assert.ok(cache.builds > builds, 'the cache must not survive a rollback');
  assert.equal(p.layers[1].adjust, null);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: **These may pass immediately.** That is the correct outcome for a
pinning task, and it is not a reason to skip Step 2 — run it and see. If any of
them *fails*, the `revision`/`mutation` split has already been broken by an
earlier task and that is what must be fixed, not the assertion.

To confirm the first assertion is real rather than vacuous, temporarily change
`applyCommand` in `src/edit.js` to bump `project.revision` as well as
`project.mutation`, re-run, and watch `a coalesced adjustment drag reuses ONE
cache build` fail with `frame at brightness 10 rebuilt the cache`. **Revert that
change before Step 4.** This is the only way to know the pin has teeth.

- [ ] **Step 3: No implementation**

Nothing to write. If something had to be written here, the `revision` /
`mutation` split would not be doing the job Plan 2A built it for.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: PASS — `78 passed`

Run: `npm test`
Expected: every baseline marker unchanged.

- [ ] **Step 5: Commit**

```bash
git add test/adjust.mjs
git diff --staged
git commit -m "Pin that a coalesced adjustment drag reuses one sandwich cache build"
```

---

### Task 14: The `Adjusted` badge and filter chip

**Files:**
- Modify: `src/panel.js`
- Test: `test/adjust.mjs`, and **one existing assertion in `test/layers.mjs`**

**Interfaces:**
- Consumes: `isNeutralAdjust` (Task 2), `layer.adjust` (Task 8)
- Produces: `badgesFor(layer)` gains `adjusted: boolean`; `PANEL_FILTERS` gains `'adjusted'`; `matchesFilter` handles it

A layer carrying an adjustment looks exactly like one that does not. That is
the disclosure gap Phase 2's badge rule exists to close, and it applies
unchanged here: shown only when it differs from the default, never dismissible,
and paired with a filter chip so a user can answer "which layers have I
touched?" without opening four sheets on twenty rows.

> **This task edits an existing assertion.** `test/layers.mjs`'s
> `badges are suppressed at their defaults` does a whole-object `deepEqual` on
> the badge record, so adding a key breaks it. Add `adjusted: false` to that
> literal — **do not** loosen the assertion to a subset match. The whole-object
> comparison is what makes "a new badge appeared and nobody decided its default"
> impossible.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nthe panel\n');

test('an adjusted layer gets the badge and a neutral one does not', () => {
  const p = threeLayerProject();
  setAdjust(p, p.layers[2].id, { contrast: 25 });
  const rows = panelRows(p).rows;
  assert.equal(rows.find((r) => r.index === 2).badges.adjusted, true);
  assert.equal(rows.find((r) => r.index === 0).badges.adjusted, false);
});

test('a present-but-neutral adjustment does not earn a badge', () => {
  // A badge that appears when the user opened a sheet and touched nothing is a
  // badge that stops meaning anything.
  const p = threeLayerProject();
  p.layers[1].adjust = createAdjust();          // neutral, but not null
  assert.equal(panelRows(p).rows.find((r) => r.index === 1).badges.adjusted, false);
});

test('the Adjusted filter chip selects exactly the adjusted layers', () => {
  const p = threeLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 10 });
  setAdjust(p, p.layers[2].id, { brightness: 10 });
  const { rows, shown } = panelRows(p, { filters: ['adjusted'] });
  assert.equal(shown, 2);
  assert.deepEqual(rows.map((r) => r.index), [2, 0], 'top of the stack first');
});

test('PANEL_FILTERS and matchesFilter stay in step', () => {
  // A chip the panel offers but the matcher ignores shows every row and reads
  // as a broken filter.
  const p = threeLayerProject();
  setAdjust(p, p.layers[0].id, { brightness: 10 });
  assert.ok(PANEL_FILTERS.includes('adjusted'));
  for (const filter of PANEL_FILTERS)
    assert.ok(panelRows(p, { filters: [filter] }).shown <= p.layers.length, filter);
  assert.notEqual(panelRows(p, { filters: ['adjusted'] }).shown, p.layers.length,
    'the chip must actually narrow the list');
});
```

Add `panelRows`, `PANEL_FILTERS` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: FAIL — `expected true, got undefined` on the badge

- [ ] **Step 3: Write the minimal implementation**

In `src/panel.js`, add the import at the top:

```js
import { isNeutralAdjust } from './adjust/lut.js';
```

Add to `PANEL_FILTERS`:

```js
export const PANEL_FILTERS = ['hidden', 'text', 'masked', 'clipped', 'blended', 'faded', 'warned', 'adjusted'];
```

Add to `badgesFor`, after `warned`:

```js
  /**
   * Any non-neutral raster adjustment. Non-dismissible, like the clip chip:
   * a layer carrying a filter looks exactly like one that does not, and
   * "which layers have I touched?" is otherwise four sheets on twenty rows.
   *
   * A PRESENT-but-neutral object earns nothing -- opening a sheet and touching
   * nothing must not light a badge, or the badge stops meaning anything.
   */
  adjusted: !isNeutralAdjust(layer.adjust),
```

Add to `matchesFilter`:

```js
    case 'adjusted': return !isNeutralAdjust(layer.adjust);
```

In `test/layers.mjs`, add `adjusted: false` to the `deepEqual` literal in
`badges are suppressed at their defaults`:

```js
  assert.deepEqual(plain, {
    text: false, mask: false, maskOff: false, clipped: false, hidden: false,
    opacity: null, blendMode: null, groupPath: null, warned: false, adjusted: false,
  });
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: PASS — `82 passed`

Run: `npm test`
Expected: every baseline marker unchanged, `75 passed` from `test/layers.mjs`
included — the count does not move, only that one literal.

- [ ] **Step 5: Commit**

```bash
git add src/panel.js test/adjust.mjs test/layers.mjs
git diff --staged
git commit -m "Disclose adjusted layers with a panel badge and a filter chip"
```

---

### Task 15: The shader stage — generated, covered, and honestly unverified

**Files:**
- Create: `src/adjust/glsl.js`
- Modify: `src/gpu/glsl.js`, `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: `OPS` (Tasks 1, 5, 6)
- Produces:
  - `ADJUST_GLSL: Record<string, string>` — the op ids that carry a shader body, and their bodies
  - `ADJUST_UNIFORMS: string` — spliced into the fragment header
  - `ADJUST_STAGE: string` — the LUT fetch, the HSL function, and `applyAdjust`
  - `src/gpu/glsl.js`'s `fragmentShaderFor(mode)` emits the stage in all 26 programs, applied to `texture(uSource, uv)` before `as` is computed

**Read this before writing the assertions.** Generation prevents *omission*.
It does not and cannot prevent *divergence*: nothing in this repository compiles
GLSL, so the test below proves the shader **has an entry for every op** and can
never prove the entry is **right**. That is 1B's accepted gap, restated for a
larger surface, and it must be reported that way — a green suite here means the
generator is complete, not that the shader is correct.

What genuinely reduces risk is the LUT. Class A reaches the GPU as **the same
768 bytes** `buildLut` produced, uploaded as a 256 × 1 RGBA texture and read
with `texelFetch` — integer index, no filtering, no interpolation. Both tiers
read the same table, so brightness, contrast, exposure, temperature, tint and
every preset built from them contribute **zero** new conformance risk. The index
conversion is exact for a `NEAREST` sample of an unorm8 texture:
`floor(c * 255 + 0.5)` recovers `n` for all `n` in 0..255, with a round-trip
error of ~1.2e-7, far inside the half-LSB margin.

**The residual risk, named rather than papered over:** on a *transformed* layer
the GPU samples through `LINEAR`, whose weights mobile GPUs compute at ~8
subtexel bits — 1B's documented 1–2 LSB deltas. A LUT is a step function, and a
*steep* one maps a 1-LSB index difference to an arbitrarily large output
difference. **The adjustment stage amplifies a divergence 1B measured and
accepted.** Task 16 reports `adjusted + transformed` as its own row so it is
attributed correctly rather than blamed on the blend maths. The tolerance is
not raised.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nthe shader stage\n');

test('every op declares exactly one of: LUT-carried, a shader body, or a named deferral', () => {
  // A stronger assertion than "the key sets match", and the reason the overlay's
  // absence from the shader is DECLARED rather than forgotten. An op that is
  // none of the three is an op the GPU silently does nothing for.
  for (const [id, op] of Object.entries(OPS)) {
    const ways = [op.lut === true, typeof op.glsl === 'string' && op.glsl.length > 0,
                  typeof op.gpuDeferred === 'string' && op.gpuDeferred.length > 0];
    assert.equal(ways.filter(Boolean).length, 1,
      `${id} declares ${ways.filter(Boolean).length} GPU strategies, must be exactly 1`);
  }
});

test('ADJUST_GLSL is exactly the ops carrying a body, in both directions', () => {
  const withBodies = Object.keys(OPS).filter((id) => typeof OPS[id].glsl === 'string' && OPS[id].glsl);
  assert.deepEqual(Object.keys(ADJUST_GLSL).sort(), withBodies.sort());
  for (const [id, body] of Object.entries(ADJUST_GLSL))
    assert.ok(body.trim().length > 0, `${id} has an empty body`);
});

test('the overlay is deferred with a reason, not silently missing', () => {
  assert.equal(OPS.overlay.glsl, null);
  assert.match(OPS.overlay.gpuDeferred, /26x26|program/,
    'the deferral has to say WHY, or it reads as an oversight');
});

test('all 26 fragment programs carry the adjustment stage exactly once', () => {
  for (const mode of GPU_BLEND_MODES) {
    const src = fragmentShaderFor(mode);
    assert.equal(src.split('vec4 applyAdjust(').length - 1, 1, `${mode}: definition count`);
    assert.equal(src.split('applyAdjust(texture(uSource, uv))').length - 1, 1, `${mode}: call count`);
    assert.ok(src.includes('uniform sampler2D uLut;'), `${mode}: no LUT sampler`);
  }
});

test('the LUT is read with texelFetch, at the exact index expression', () => {
  // The bit-exactness argument, pinned as a string. floor(c * 255 + 0.5)
  // recovers n for all n in 0..255 on a NEAREST unorm8 sample; anything else --
  // a multiply without the half, a texture() lookup with filtering -- silently
  // reintroduces the divergence the shared table exists to remove.
  const src = fragmentShaderFor('normal');
  assert.ok(src.includes('texelFetch(uLut'), 'texelFetch, never texture()');
  assert.ok(src.includes('* 255.0 + 0.5'), 'the exact index conversion');
});

test('the stage returns the source untouched when no flag is set', () => {
  // A neutral adjustment must be BIT-IDENTICAL to no adjustment on both tiers.
  // The early return is what makes that true rather than "quantised twice and
  // usually the same".
  assert.ok(fragmentShaderFor('normal').includes('if (uAdjustFlags == 0) return src;'));
});

test('the stage never writes alpha', () => {
  // Invariant A, in the shader. The four consumers that depend on it are all on
  // the JS side, so a shader that raised alpha would show up as a conformance
  // failure nobody could attribute.
  assert.ok(fragmentShaderFor('normal').includes('return vec4(c, src.a);'));
});
```

Add `ADJUST_GLSL`, `GPU_BLEND_MODES`, `fragmentShaderFor` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'ADJUST_GLSL'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/adjust/glsl.js`:

```js
/**
 * Assembles the adjustment stage of the fragment shader from ops.js.
 *
 * Generated rather than hand-written, for the reason src/gpu/glsl.js gives for
 * blend modes: the likeliest regression is adding an op and forgetting the
 * shader. Generation makes that impossible by construction, and the coverage
 * test makes it assertable inside `npm test`.
 *
 * WHAT THAT TEST PROVES, AND WHAT IT DOES NOT. It proves the shader has an
 * entry for every op. It cannot prove the entry is RIGHT, because nothing in
 * this repository compiles GLSL. 1B's accepted gap, restated for a larger
 * surface. Conformance Table D on a real device is the only thing that closes
 * it, and until 1B-2 exists there is no GPU to run it against.
 *
 * Class A contributes NOTHING here on purpose: it reaches the GPU as the 768
 * bytes buildLut produced, uploaded as a 256x1 RGBA texture and read with
 * texelFetch. Both tiers read the same table, so divergence there is not
 * reduced -- it is structurally impossible.
 *
 * Nothing here touches WebGL, so it imports and runs in Node.
 */
import { OPS } from './ops.js';

/** The ops that carry a shader body, and their bodies. */
export const ADJUST_GLSL = Object.fromEntries(
  Object.entries(OPS)
    .filter(([, op]) => typeof op.glsl === 'string' && op.glsl.length > 0)
    .map(([id, op]) => [id, op.glsl]),
);

/**
 * Uniforms the stage needs, spliced into the fragment header.
 *
 * uLut is the ONLY one class A uses, and it carries the whole class: texel i
 * holds (lut[i], lut[256 + i], lut[512 + i], 255), so .r indexed by red,
 * .g by green and .b by blue is the composed table, verbatim.
 */
export const ADJUST_UNIFORMS = `
uniform sampler2D uLut;          // 256x1 RGBA8: EXACTLY the 768 bytes buildLut produced
uniform int   uAdjustFlags;      // bit 0 = class-A LUT, bit 1 = HSL
uniform float uHslCentres[8];    // HSL_BANDS centres, in degrees
uniform float uHslBands[24];     // 8 bands x (h, s, l), each -100..100
uniform float uHslSaturation;
`;

/**
 * The class-A fetch.
 *
 * texelFetch, never texture(): an integer index with no filtering and no
 * interpolation. floor(c * 255 + 0.5) recovers n for all n in 0..255 on a
 * NEAREST unorm8 sample -- the round-trip error is ~1.2e-7, far inside the
 * half-LSB margin. This is 1B's argument for NEAREST at 1:1 being bit-exact,
 * applied one stage later.
 */
const LUT_FETCH = `
vec3 adjustLut(vec3 c) {
  return vec3(
    texelFetch(uLut, ivec2(int(floor(c.r * 255.0 + 0.5)), 0), 0).r,
    texelFetch(uLut, ivec2(int(floor(c.g * 255.0 + 0.5)), 0), 0).g,
    texelFetch(uLut, ivec2(int(floor(c.b * 255.0 + 0.5)), 0), 0).b);
}
`;

/**
 * The whole stage: the LUT fetch, every op body, and the entry point.
 *
 * `uAdjustFlags == 0` returns the source untouched. Not an optimisation: a
 * neutral adjustment must be BIT-IDENTICAL to no adjustment, and running the
 * stage anyway would quantise twice and be usually-but-not-always the same --
 * which is the whole class of bug conformance Table D's first row exists to
 * catch.
 *
 * `vec4(c, src.a)` is invariant A in the shader.
 */
export const ADJUST_STAGE =
  LUT_FETCH +
  Object.values(ADJUST_GLSL).join('\n') + `
vec4 applyAdjust(vec4 src) {
  if (uAdjustFlags == 0) return src;
  vec3 c = src.rgb;
  if ((uAdjustFlags & 1) != 0) c = adjustLut(c);
  if ((uAdjustFlags & 2) != 0) c = adjustHsl(c);
  return vec4(c, src.a);
}
`;
```

In `src/gpu/glsl.js`, add the import:

```js
import { ADJUST_UNIFORMS, ADJUST_STAGE } from '../adjust/glsl.js';
```

…append `ADJUST_UNIFORMS` to `FRAGMENT_HEADER`, immediately before the closing
backtick:

```js
in  vec2 vDstPx;
out vec4 fragColor;
` + ADJUST_UNIFORMS;
```

…change the one line in `FRAGMENT_MAIN`:

```js
  vec4 src = applyAdjust(texture(uSource, uv));
```

…and emit the stage in both branches of `fragmentShaderFor`, between the header
(plus prelude) and `blendFn`:

```js
export function fragmentShaderFor(mode) {
  const name = programNameFor(mode);

  if (isNonSeparableMode(name)) {
    return FRAGMENT_HEADER + NON_SEPARABLE_PRELUDE + ADJUST_STAGE +
      `\nvec3 blendFn(vec3 b, vec3 s) {\n  ${NON_SEPARABLE_GLSL[name]}\n}\n` +
      FRAGMENT_MAIN;
  }

  return FRAGMENT_HEADER + ADJUST_STAGE +
    `\nfloat chan(float b, float s) {\n  ${SEPARABLE_GLSL[name]}\n}\n` +
    '\nvec3 blendFn(vec3 b, vec3 s) {\n' +
    '  return vec3(chan(b.r, s.r), chan(b.g, s.g), chan(b.b, s.b));\n}\n' +
    FRAGMENT_MAIN;
}
```

Add to `src/index.js`:

```js
export { ADJUST_GLSL, ADJUST_UNIFORMS, ADJUST_STAGE } from './adjust/glsl.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: PASS — `89 passed`

Run: `npm test`
Expected: every baseline marker unchanged, **including `53 passed` from
`test/gpu.mjs`**. That suite asserts on shader *structure* in several places —
if any of its assertions break, read them before editing: an assertion that
`fragmentShaderFor` contains an exact substring may need the substring updating,
but one that counts lines or asserts the shader's *shape* is telling you the
splice went somewhere it should not have.

> **Report this honestly.** A green run here means every op has a shader entry
> and the stage is spliced into all 26 programs. It means **nothing** about
> whether `adjustHsl` computes the same colour as `applyHsl`. The overlay has
> no shader at all, by declaration.

- [ ] **Step 5: Commit**

```bash
git add src/adjust/glsl.js src/gpu/glsl.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Generate the adjustment shader stage from the op table, with three-way coverage"
```

---

### Task 16: Conformance Table D

**Files:**
- Modify: `src/conformance.js`, `src/index.js`
- Test: `test/adjust.mjs`

**Interfaces:**
- Consumes: Tasks 1, 5, 6, 11
- Produces:
  - `CONFORMANCE_ADJUSTMENTS: {id, label, adjust, transformed}[]`
  - `conformanceAdjustProject(entry, size = CONFORMANCE_SIZE) -> project`
  - `CONFORMANCE_TABLE_D_NOTE: string`

Table D is built the way Table A is: for each row, a synthetic two-layer
document over `conformancePattern()` — which already sweeps all 65,536
(backdrop, source) red pairs and eight alpha bands — rendered by `renderProject`
and, on a device, by the GPU, `flattenOnto` both, `compareRenders`, reported
under `verdictFor`'s existing PASS / WARN / FAIL rule.

**Two rows are mandatory and are the point of the table.** A **neutral**
adjustment must be bit-identical to no adjustment — which catches the whole
class of "the pass runs and quantises even when it should do nothing", otherwise
invisible. And a **steep LUT on a transformed layer**, in its own row, so 1B's
1–2 LSB `LINEAR` divergence being *amplified* by a step function is attributed
to the adjustment stage rather than misread as a blend-mode bug.

**There is no GPU.** `selectTier` returns `TIER_JS` with the verdict
`'shader probe not run'`, and 1B-2 is not started. So Table D ships running JS
against itself as a regression baseline, and `CONFORMANCE_TABLE_D_NOTE` is what
the route must print on the page — because a green table that means nothing is
worse than an absent one.

- [ ] **Step 1: Write the failing tests**

Append to `test/adjust.mjs`:

```js
console.log('\nconformance Table D\n');

test('a NEUTRAL adjustment renders bit-identically to no adjustment', () => {
  // The mandatory first row, and the one that catches "the pass runs and
  // quantises even when it should do nothing" -- which is invisible in every
  // other way.
  const neutral = CONFORMANCE_ADJUSTMENTS.find((e) => e.id === 'neutral');
  assert.ok(neutral, 'Table D must open with a neutral row');
  const withRow = renderProject(conformanceAdjustProject(neutral), { scale: 1 });
  const without = renderProject(conformanceProject('normal'), { scale: 1 });
  const stat = compareRenders(withRow, without);
  assert.equal(stat.beyondRounding, 0, `${stat.beyondRounding} of ${stat.total} pixels differ`);
  assert.equal(stat.maxDelta, 0);
});

test('every Table D row builds and renders at the conformance size', () => {
  for (const entry of CONFORMANCE_ADJUSTMENTS) {
    const out = renderProject(conformanceAdjustProject(entry), { scale: 1 });
    assert.equal(out.width, CONFORMANCE_SIZE, entry.id);
    assert.equal(out.height, CONFORMANCE_SIZE, entry.id);
  }
});

test('every non-neutral row actually changes the pixels it claims to', () => {
  // A row that renders identically to the neutral one is a row that proves
  // nothing while looking green.
  const base = renderProject(conformanceProject('normal'), { scale: 1 });
  for (const entry of CONFORMANCE_ADJUSTMENTS) {
    if (entry.id === 'neutral') continue;
    const out = renderProject(conformanceAdjustProject(entry), { scale: 1 });
    assert.ok(compareRenders(out, base).beyondRounding > 0, `${entry.id} changed nothing`);
  }
});

test('the transformed rows really do go through resample', () => {
  // The amplification row only means something if the layer is actually
  // interpolated. A "transformed" row whose w happens to equal its buffer width
  // hits resample()'s identity return and tests the untransformed path under a
  // misleading name.
  const rows = CONFORMANCE_ADJUSTMENTS.filter((e) => e.transformed);
  assert.ok(rows.length >= 1, 'Table D needs an adjusted + transformed row');
  for (const entry of rows) {
    const layer = conformanceAdjustProject(entry).layers[1];
    assert.notEqual(layer.w, layer.pixels.width, `${entry.id} is not actually transformed`);
  }
});

test('Table D declares that it has no GPU to compare against', () => {
  // Until 1B-2 lands the route runs JS against itself. A green table that means
  // nothing is worse than an absent one, so the note is not optional.
  assert.match(CONFORMANCE_TABLE_D_NOTE, /no GPU|JS against itself|1B-2/i);
});
```

Add `CONFORMANCE_ADJUSTMENTS`, `conformanceAdjustProject`,
`CONFORMANCE_TABLE_D_NOTE`, `conformanceProject`, `compareRenders`,
`CONFORMANCE_SIZE` to the import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: FAIL — `does not provide an export named 'CONFORMANCE_ADJUSTMENTS'`

- [ ] **Step 3: Write the minimal implementation**

In `src/conformance.js`, add the import:

```js
import { createAdjust } from './adjust/ops.js';
```

…and append:

```js
/**
 * Table D: the per-op adjustment matrix.
 *
 * Built the way Table A is -- a synthetic two-layer document over
 * conformancePattern(), which already sweeps every one of the 65 536
 * (backdrop, source) red pairs and eight alpha bands. Rendered by
 * renderProject and, on a device, by the GPU; flattenOnto both; compareRenders;
 * verdictFor.
 *
 * TWO ROWS ARE MANDATORY AND ARE THE POINT OF THE TABLE:
 *
 *   'neutral'            -- a neutral adjustment must be BIT-IDENTICAL to no
 *                           adjustment, on both tiers. Catches the whole class
 *                           of "the pass runs and quantises even when it should
 *                           do nothing", which is otherwise invisible.
 *   'steep-transformed'  -- a steep LUT on a TRANSFORMED layer, reported in its
 *                           own row. On a transformed layer the GPU samples
 *                           through LINEAR, whose weights mobile GPUs compute at
 *                           ~8 subtexel bits (1B's measured 1-2 LSB). A LUT is a
 *                           step function, and a steep one maps a 1-LSB index
 *                           difference to an arbitrarily large output
 *                           difference. The adjustment stage AMPLIFIES a
 *                           divergence 1B measured and accepted, and this row
 *                           exists so it is attributed correctly rather than
 *                           blamed on the blend maths.
 *
 * The tolerance is NOT raised to absorb that. 1B's reason stands: it would
 * forgive real bugs everywhere else.
 */
export const CONFORMANCE_ADJUSTMENTS = [
  { id: 'neutral', label: 'Neutral — must be bit-identical to none',
    adjust: createAdjust(), transformed: false },
  { id: 'brightness-max', label: 'Brightness +100',
    adjust: createAdjust({ brightness: 100 }), transformed: false },
  { id: 'brightness-min', label: 'Brightness −100',
    adjust: createAdjust({ brightness: -100 }), transformed: false },
  { id: 'contrast-max', label: 'Contrast +100 (steep)',
    adjust: createAdjust({ contrast: 100 }), transformed: false },
  { id: 'contrast-min', label: 'Contrast −100',
    adjust: createAdjust({ contrast: -100 }), transformed: false },
  { id: 'exposure-mid', label: 'Exposure +50',
    adjust: createAdjust({ exposure: 50 }), transformed: false },
  { id: 'temperature-tint', label: 'Temperature +80 / Tint −80',
    adjust: createAdjust({ temperature: 80, tint: -80 }), transformed: false },
  { id: 'stack', label: 'All five stacked (the LUT collapse)',
    adjust: createAdjust({ exposure: 30, temperature: -40, tint: 25, brightness: -20, contrast: 55 }),
    transformed: false },
  { id: 'hsl-global', label: 'HSL global saturation −60',
    adjust: createAdjust({ hsl: { saturation: -60, bands: [] } }), transformed: false },
  { id: 'hsl-bands', label: 'HSL band shifts (red, green, blue)',
    adjust: createAdjust({ hsl: { saturation: 0, bands: [
      { h: 60, s: 40, l: 20 }, {}, {}, { h: -50, s: -70, l: 0 }, {}, { h: 30, s: 80, l: -30 }, {}, {},
    ] } }), transformed: false },
  { id: 'overlay-linear', label: 'Overlay — linear, soft light',
    adjust: createAdjust({ overlay: { kind: 'linear', angle: 30, mode: 'soft light', opacity: 0.8,
      stops: [{ t: 0, r: 255, g: 120, b: 0, a: 1 }, { t: 1, r: 0, g: 60, b: 200, a: 0.4 }] } }),
    transformed: false },
  { id: 'overlay-radial', label: 'Overlay — radial, multiply',
    adjust: createAdjust({ overlay: { kind: 'radial', cx: 0.5, cy: 0.5, radius: 0.6,
      mode: 'multiply', opacity: 1,
      stops: [{ t: 0, r: 255, g: 255, b: 255, a: 0 }, { t: 1, r: 20, g: 0, b: 40, a: 0.9 }] } }),
    transformed: false },
  { id: 'steep-transformed', label: 'Steep LUT on a TRANSFORMED layer — amplification',
    adjust: createAdjust({ contrast: 100 }), transformed: true },
  { id: 'neutral-transformed', label: 'Neutral on a transformed layer — the control',
    adjust: createAdjust(), transformed: true },
];

/**
 * A Table D document: conformanceProject's two `normal` layers, with the
 * adjustment on the source layer.
 *
 * A `transformed` row shrinks the source layer's geometry so drawLayerInto
 * genuinely resamples it. Without that it would hit resample()'s identity
 * return and test the untransformed path under a misleading name -- exactly the
 * shape of failure 1C's docstring calls the worst available.
 */
export function conformanceAdjustProject(entry, size = CONFORMANCE_SIZE) {
  const project = conformanceProject('normal', size);
  const source = project.layers[1];
  source.adjust = entry.adjust;
  if (entry.transformed) {
    source.w = Math.round(size * 0.75);
    source.h = Math.round(size * 0.75);
  }
  return project;
}

/**
 * What the /conformance route must print above Table D.
 *
 * There is no GPU: selectTier returns TIER_JS with the verdict 'shader probe
 * not run', and Plan 1B-2 is not started. So the table runs JS against itself
 * as a regression baseline, and saying so is not optional -- a green table that
 * means nothing is worse than an absent one.
 */
export const CONFORMANCE_TABLE_D_NOTE =
  'No GPU tier exists yet (selectTier returns TIER_JS: shader probe not run, and Plan 1B-2 ' +
  'is not started). Table D is therefore running JS against itself as a regression baseline, ' +
  'not as a GPU comparison. Every row below is green by construction until a real tier lands.';
```

Add to `src/index.js`, extending the `conformance.js` export block:

```js
  CONFORMANCE_MODES, CONFORMANCE_SIZE,
  CONFORMANCE_ADJUSTMENTS, conformanceAdjustProject, CONFORMANCE_TABLE_D_NOTE,
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --max-old-space-size=6144 test/adjust.mjs`
Expected: PASS — `94 passed`

Run: `npm test`
Expected: every baseline marker unchanged. Final state:

```
shim OK
21 files | parsed 21 | failed 0
21 files  |  <0.5% diff: 12   <10%: 5   >=10%: 4   skipped: 0
21 passed          <- test/edit.mjs
28 passed          <- test/proxy.mjs
53 passed          <- test/gpu.mjs
79 passed          <- test/export.mjs
75 passed          <- test/layers.mjs
94 passed          <- test/adjust.mjs
```

**350 assertions**, up from 256.

- [ ] **Step 5: Commit**

```bash
git add src/conformance.js src/index.js test/adjust.mjs
git diff --staged
git commit -m "Add conformance Table D, opening with the bit-identical neutral row"
```

---

### Task 17: Make the adjustment work visible on a device

**Files:**
- Modify: `app/src/app/harness/harness.page.ts`

**Interfaces:**
- Consumes: `presetAdjust` (Task 7), `setAdjust` (Task 8), `createRenderStats` (Task 11), `panelRows` (2A Task 14)
- Produces: a harness that applies a real preset to a real layer and shows the two cost counters

> **This task cannot be verified by `npm test`.** It is a build and a device.
> Step 3 hands verification over explicitly and names what the output must say.

> **Re-read `harness.page.ts` before editing it.** Plan 1B-1's Tasks 9–10, Plan
> 1C-1's Task 14 and **Plan 2A's Task 15** all modify this file, and at the time
> of writing **none of the three had landed** — `git log` ends at 2A's Task 14
> and the file is 99 lines with a `decoded {{ progress() }} layer(s)` line and no
> `panelRows` import. Add alongside whatever is actually there; if 2A's Task 15
> has since landed, the `info.set` payload already carries `masked` / `clipped`
> and you are adding to that object, not replacing it.

Sixteen tasks of engine work are invisible until something renders them. This is
the smallest thing that makes an adjustment observable on a real file, on a real
device — and it is also the first place the two cost counters, the LUT and the
preset table all meet a finger.

- [ ] **Step 1: Apply a preset from the harness**

In `app/src/app/harness/harness.page.ts`, add the imports:

```ts
import { setAdjust, presetAdjust } from '@engine/edit.js';
import { PRESET_IDS } from '@engine/adjust/presets.js';
import { createRenderStats } from '@engine/render.js';
```

Add a control below the file input, inside the existing wrapper `div`:

```html
      @if (project()) {
        <div class="flex flex-wrap gap-2">
          @for (id of presetIds; track id) {
            <button class="border border-slate-300 px-2 py-1" (click)="applyPreset(id)">{{ id }}</button>
          }
          <button class="border border-slate-300 px-2 py-1" (click)="applyPreset('')">clear</button>
        </div>
        <p class="text-slate-500">{{ cost() }}</p>
      }
```

…and the members. `project` may already exist under another name — **check
before adding a second one.**

```ts
  presetIds = PRESET_IDS;
  cost = signal('');

  /**
   * Applies a preset to the BOTTOM layer, which is the one most likely to be
   * large and visible. The point is not the interaction -- 3B builds the real
   * sheets -- it is that a real preset reaches real pixels on a real device.
   */
  applyPreset(id: string) {
    const p = this.project();
    if (!p || !p.layers.length) return;
    setAdjust(p, p.layers[0].id, id ? presetAdjust(id) : { preset: 'none', brightness: 0,
      contrast: 0, exposure: 0, temperature: 0, tint: 0, hsl: null, overlay: null });
    this.draw();
  }
```

- [ ] **Step 2: Show the two cost terms**

Wherever the harness calls `renderProject`, pass a stats object and publish it —
this is the Phase 3 instance of the rule that a cost the user cannot see is a
bug, and it is the only thing that will answer the spec's first open question:

```ts
  private draw() {
    const p = this.project();
    if (!p) return;
    const stats = createRenderStats();
    const started = performance.now();
    const frame = renderProject(p, { scale: p.proxyScale, stats });
    const ms = Math.round(performance.now() - started);
    // Two terms, never one total: they differ by an estimated order of
    // magnitude per layer, and a total would hide which one a slow frame is.
    this.cost.set(`${ms} ms  ·  layers: ${stats.layers}  lut: ${stats.lut}  hsl: ${stats.hsl}  overlay: ${stats.overlay}`);
    // ...existing canvas blit...
  }
```

Add to the `info.set(...)` payload in `onPick` — **add to the object, do not
replace it**:

```ts
      adjusted: project.layers.filter((l: any) => l.adjust).length,
```

- [ ] **Step 3: Hand verification to the user**

Do **not** run the build. Ask the user to run:

```bash
cd a:/test-rnd/app && npm start
```

…open `/harness`, and report the following, from a desktop browser **and** from
the Android device:

1. **Pick any PSD, then tap `noir`.** The image must visibly desaturate, and
   the readout must show `lut: 1  hsl: 1` — one class-A pass and one expensive
   pass. Tap `clear`; it must return **exactly** to how it looked, and the
   counters must go to `lut: 0  hsl: 0`.
2. **Tap `ember`, then `clear`, then `ember` again, ten times in a row.** The
   image must look identical every time it is on `ember`. **If it drifts
   brighter or darker with each tap, the adjustment is being applied in place
   and `layer.pixels` is being destroyed** — stop and report it immediately.
   This is the device-side version of Task 11's assertion, and it is the one
   failure mode that a green suite could still hide if the hook were ever
   changed to reuse a buffer it should not.
3. **Report the `ms` figure with a class-A preset (`ember`) and with an HSL one
   (`noir`), on the phone, on the same file.** Those two numbers are the answer
   to the spec's first open question — *what does an adjustment actually cost on
   a phone, per layer, for class A and for HSL separately?* Every cost figure in
   the spec is derived from a desktop measurement by counting operations. This
   is the first real number.
4. **Report whether an HSL preset is usable at all** on a document with more
   than a handful of layers. If it is not, the honest options are a layer-count
   gate, evaluating HSL only at the reduced interaction scale during gestures,
   or cutting it until a GPU exists — and none of the three should be chosen
   without this measurement.
5. **Pick a PSD with a text layer, resize it, then tap a preset.** The text must
   stay sharp *and* take the adjustment. **Nothing in `npm test` covers this** —
   `create2dSurface` returns null in Node, so a text layer never reaches the
   adjustment hook there. This is the only check that the hook sits below both
   branches of `drawLayerInto`.

Record the answers in the spec's *Open questions* before 3B is written.

> Nothing in this task is proven by `npm test`. That adjustments are applied,
> collapse into one table, survive export and do not corrupt the source buffer
> is (Tasks 2, 11, 12). That Angular renders them, that a preset feels right on
> a phone-sized strip, that HSL is affordable, and that a text layer takes the
> adjustment are device questions.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/harness/harness.page.ts
git diff --staged
git commit -m "Apply presets and show the two adjustment cost counters in the harness"
```

---

## What this plan does not cover

Deferred to **Plan 3B** (the four tool sheets), which depends on every interface
above:

| Spec section | What 3B owns |
|---|---|
| *UI* → Filter | The preset strip, each chip carrying a live thumbnail of *the selected layer* under that preset — the existing 40 × 40 panel thumbnail through a 768-byte table, ~1,600 pixels per chip, built lazily on chip visibility and cached by `(layer.id, preset, mutation)`. The selected chip expanding to an intensity slider over `presetAdjust(id, k)`. |
| *UI* → Adjust | The horizontal picker of the five class-A parameters, one slider with a numeric readout, double-tap-to-reset. |
| *UI* → HSL | Eight colour swatches, three sliders for the selected band, a global saturation slider. |
| *UI* → Overlay | Kind toggle, angle or centre control, the stop editor, the blend-mode chip opening Phase 2's grouped 26-mode sub-sheet, the opacity slider. |
| *Sheet semantics* | `✕ / TITLE / ✓` headers, ~180dp of content, 50dp controls, all within Phase 2's bottom-two-thirds reach rule. `✓` closes; `✕` calls `discardTo` with the history length recorded at open. Tapping a raster tool with no selection opens the **layers sheet** with *"Pick a layer to adjust."* — never a disabled sheet. |
| *Disclosures* | The `◑ adjusted` row badge and the `Adjusted` filter chip rendered from `badgesFor` / `PANEL_FILTERS` (the data lands in Task 14; the pixels are 3B's). The `lut: N / hsl: M` debug readout on `/harness`. |
| *GPU/JS parity* → 1 | **Uploading the 768 LUT bytes as a 256 × 1 RGBA texture** and wiring `uLut`, `uAdjustFlags`, `uHslCentres`, `uHslBands`, `uHslSaturation`. The stage exists (Task 15); nothing binds it. |
| *GPU/JS parity* → 3 | Running Table D against a real GPU, and printing `CONFORMANCE_TABLE_D_NOTE` until there is one. |
| *States* | Every row of the spec's *States* table as real screens, including *preset drifted* showing `Custom` and dropping the chip highlight. |

Not in either plan, and going to `docs/BACKLOG.md`:

- **The overlay's GPU program key.** Declared as `OPS.overlay.gpuDeferred` and
  asserted by Task 15, but unresolved: a per-layer overlay blend mode multiplied
  by the layer's own is a 26 × 26 program matrix that `programNameFor` cannot
  express. It becomes a **precondition on 1B-2**: until it is answered, a layer
  carrying an overlay cannot run on a GPU tier.
- **Adjustment layers**, **document-level adjustment** (Phase 5), **blur /
  sharpen / grain / vignette**, **bitmap overlay textures**, **gradient map**,
  **curves and levels editors**, **selective adjustment**, **baking**, **a
  per-layer adjusted-pixel cache**, and **linear-light colour** — each ruled out
  in the spec's *Not doing* with its reason attached.

---

## Noticed, not doing in 3A

Findings from writing this plan. None are 3A work. **Append them to
`docs/BACKLOG.md` when executing** — a list that lives only in a plan document
is the same as not reporting it.

- **`resample()` may return its argument, and nothing at the call site says
  so.** `src/render.js:20` early-returns `src` when the dimensions match, and it
  is the *default* preview path, not an edge case. Verified by running it: a
  256 × 256 proxy layer at `proxyScale` gets back the same object. The backlog
  already carries the equivalent note for `downscaleImage`; `resample` deserves
  the same JSDoc line, and it is the precondition for this entire phase's
  most dangerous defect. Task 11 pins the behaviour with an assertion but adds
  no docstring, because changing the docstring is not what the task is for.

- **`setLayer` captures object-valued `from` by reference, and there are now
  TWO live instances.** `layer.mask` (Phase 2) and `layer.adjust` (this plan).
  `adjust` is defended by `Object.freeze`; **`mask` is not**, and Phase 2
  toggles it through exactly this path. A one-line `Object.freeze` on the mask
  object in `maskOf` would close it, and it is not done here because Phase 3
  must not quietly change Phase 2's undo semantics.

- **`applyCommand`'s `set` branch is a blind `layer[key] = value`** with one
  special case for `text`. Every future object-valued field inherits the
  reference hazard, and every future field with a paired cache inherits the
  `rendered` / `renderedKey` hazard. A per-field descriptor saying "clone on
  capture" and "invalidate these caches" would close both classes at once.
  Larger than Phase 3, and now carrying three fields' worth of evidence.

- **`hitTest` reads `layer.rendered || layer.pixels` — the UNADJUSTED buffer.**
  Correct only while invariant A holds, which this plan asserts in three places
  but never asserts *at the consumer*. If any future operation ever changes
  alpha — a "fade edges", an alpha curve, an eraser — selection silently stops
  matching what is drawn, and so do the layer mask's effective coverage and
  `composite.js`'s `alphaMap`. The invariant deserves an assertion in
  `test/edit.mjs`, not only in `test/adjust.mjs`.

- **`estimatePeakBytes` does not know about the adjustment scratch.** Task 12
  adds a term of up to document size to the JS export peak (+66.4 MB for the
  measured poster) and `src/budget.js` still has no production caller, so adding
  a term nothing asks for is not progress — but the formula it encodes is now
  known to be incomplete for any document carrying an adjustment. Two reasons
  now to wire it into 1C's export budget rather than leave it as executable
  documentation.

- **`toProjectJson` still does not persist `sourceIndex`.** Reopening a saved
  session cannot export until the file is re-read and re-stamped. Not a Phase 3
  problem, but this plan adds a *second* field to the same round trip and the
  omission is easier to see now than it was.

- **`applyProjectJson` matches saved layers by array index** (`src/edit.js`) —
  the exact class of bug `sourceIndex` was added to fix, and this plan just
  added another field it restores positionally. It should match on
  `sourceIndex` now that one exists.

- **`src/conformance.js` still hard-codes `CONFORMANCE_MODES = SUPPORTED_BLEND_MODES`.**
  Table D gets its own parallel export (Task 16), which is the second one — a
  third would justify a shape rather than another constant.

- **The adjustment stage is spliced into all 26 fragment programs whether or not
  the document has an adjustment.** ~50 extra lines of GLSL per program,
  compiled lazily per mode. On the drivers 1B is wary of, compile time is not
  free. Splitting into adjusted and unadjusted program variants would double the
  program count to buy it back; neither option can be measured from here, and it
  should be settled with the first device compile-time numbers rather than
  guessed at now.

- **`lutDigest` uses `join(',')` on five numbers**, so a parameter of `1` and
  a parameter of `1.0` produce the same key (correct) but two *different*
  objects whose class-A parameters happen to match share nothing else (also
  correct — the table depends on nothing else). It cannot produce a false
  *reuse*; the worst it can do is a false invalidation, which is a wasted 3840
  evaluations. Recorded because it looks like a weakness and is not.

- **Nine of fourteen presets are class-A only; five carry HSL.** Task 7 states
  the split in a comment, and `adjustCostOf` can compute it, but nothing
  *surfaces* it — a user tapping through the strip is choosing a per-frame cost
  without being told. 3B's Filter sheet should mark the five, and that is a UI
  decision this plan cannot make.

- **Nothing under `app/` has automated coverage**, and Task 17 adds to it. The
  mitigation is the same one Phase 2 named — logic lives in `src/`, the Angular
  layer stays thin plumbing — and Phase 3 is the phase that makes it bite twice:
  the four tool sheets are the first place `app/` will hold real per-frame logic
  (slider-to-command plumbing, gesture keys, sheet-session history bookkeeping).
  **Re-check when 3B is written, not after.**
