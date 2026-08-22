# Handoff: Browser PSD Reader + Compositor

**Generated**: 2026-08-22
**Branch**: n/a — **`a:\test-rnd` is NOT a git repository.** Nothing is version controlled. Consider `git init` before further work.
**Status**: In Progress — read + composite pipeline complete and verified; editing not started.

## Goal

Build a browser-based PSD/PSB reader that recovers as much of the file as possible, and composite its layers at exact position and order. Long-term target is a browser image editor; the immediate next step the user asked for is **making text layers editable**.

## Completed

- [x] Spike: measured `ag-psd` against 21 real Photoshop files (block coverage, memory, round-trip loss)
- [x] Surveyed every JS PSD library — **`ag-psd` is the only one that can write; all others are read-only**
- [x] `src/reader.js` — `readDocument()` over ag-psd, with `pixels: 'none' | 'eager' | 'stream'`
- [x] `src/resources.js` — dependency-free image-resource block extractor
- [x] `src/icc.js` — ICC profile parser (ag-psd does not read ICC at all)
- [x] `src/iim.js` — IPTC-NAA parser (exifr can't read the bare block)
- [x] `src/canvas.js` — worker-safe pixel backend; keeps Canvas out of the decode path
- [x] `src/composite.js` — full compositor: position, order, opacity, visibility, masks, groups, clipping runs, 20 separable + 6 non-separable blend modes
- [x] `demo/` — browser demo with 3-way preview (Photoshop's composite / ours / difference) + accuracy badge
- [x] `test/shim.mjs`, `test/run.mjs`, `test/composite.mjs` — all passing

## Not Yet Done

- [ ] **Text editing (next task — user asked for this, was interrupted)**
- [ ] Layer effects (`fx`) — biggest accuracy gap, affects 4 of 21 fixtures
- [ ] Adjustment layers
- [ ] Smart filters
- [ ] Blend-If ranges (`blend-if` fixture is 25.8% off solely because of this)
- [ ] Artboard background colour (`artboards` 9.8% off solely because of this)
- [ ] Layer comps visibility states
- [ ] `dissolve` blend mode (rendered as normal)
- [ ] Pass-through groups **with** opacity/blend — needs backdrop access
- [ ] Write/save support — deliberately dropped, see Key Decisions
- [ ] Move decode + composite into a Web Worker (both currently block the main thread)
- [ ] Tiled layer storage / OPFS eviction (designed but not built — see Warnings)

## Failed Approaches (Don't Repeat These)

**Six of these were silent — they passed Node tests and only failed in the browser, or produced plausible wrong numbers.**

1. **`icc` npm package** — needs Node's `Buffer` (`readUInt32BE`), throws on a plain `Uint8Array`. Would pass every Node test and die in the browser. Replaced with `src/icc.js` (~90 lines, zero deps). **Do not reinstall it.**

2. **`const { default: exifr } = await import('exifr')`** — exifr's ESM build has **no default export** (`parse` is a named export); Node's CJS interop invents one. In the browser `exifr` was `undefined`, `.parse` threw, and my own `try/catch` swallowed it into a warning. EXIF would have silently stopped working in production with a green test suite. Now takes `mod.parse || mod.default?.parse`.

3. **Adding an `ag-psd` import without updating `demo/shims/ag-psd.js`** — this blanked the page:
   > `Uncaught SyntaxError: The requested module 'ag-psd' does not provide an export named 'getCompositeImageData'`

   The browser gets the shim, not the real package, and ESM named exports are static. `test/shim.mjs` now guards this — **run `npm run test:shim` after touching any `ag-psd` import.**

4. **`ag-psd/dist-es/index.js`** — the `module` field points here but it contains **CommonJS** (zero `export` statements). Cannot be imported by a browser. The demo loads `dist/bundle.js` (UMD, global `window.agPsd`) instead.

5. **Comparing all 4 RGBA channels against the embedded composite** — Photoshop stores **white** in the RGB of fully-transparent pixels; we store zero. Both invisible. This reported `text` and `text-box` as 98% wrong when they are pixel-perfect. Fix: `flattenOnto()` both onto the same background first.

6. **Counting a delta of 1 as a mismatch** — Photoshop rounds intermediate blend results differently. `gradient` showed 26% differing with `maxΔ = 1`. `compareBuffers(a, b, tolerance = 1)` now reports `percentReal`. Together, 5 and 6 made the compositor look 5/21 correct when it was 12/21.

7. **`bytes.buffer.slice(...)` unconditionally in `readDocument`** — copied the whole file. Cost 261 MB of peak on a 261 MB PSD. Now skipped when the view already spans its buffer.

8. **Releasing streamed layers by nulling `_`-prefixed fields** — wrong field. The retained compressed channels live on **`layer.rawData`**. Must null `imageData`, `canvas`, **and `rawData`**.

9. **IIM parser ignoring record numbers** — reported record-1 character-set markers (`ESC % G`) as `City` values. Only **record 2** is content. This also corrected IPTC recovery from an apparent 10/21 to a true 2/21 (8 files carry an empty envelope).

10. **Planned to fork ag-psd for passthrough of unread blocks** — correct for read+write, **wrong once scope narrowed to read-only**. Everything ag-psd drops, it drops on *save*. For reading it handles 343/343 block keys. No fork needed.

11. **Considered `@webtoon/psd`** — 3× faster structure parse but only 80% block coverage (276/343), read-only, no document metadata, last updated 2023, and **returns layers in reverse order**. Rejected. Uninstalled.

12. **Considered writing a PSD codec from scratch** — months of work. `ag-psd` is the only free PSD writer in existence, which is itself evidence of the difficulty.

## Key Decisions

| Decision | Rationale |
|---|---|
| `ag-psd` as the spine, not a custom parser | 343/343 block keys across 21 real files; only 3 unhandled in the whole corpus (`CAI`, `OCIO`, `GenI`) |
| Read-only; write dropped | ag-psd's writer peaks at **3.5–4.2× decoded pixels** (1761 MB for a 512 MB doc — over Chrome's ~1.8 GB budget) and silently drops `Patt`, corrupting pattern fills |
| Never touch Canvas in the decode path | `getImageData()` clamps to 8-bit and premultiplies alpha, destroying 16/32-bit data. `src/canvas.js` installs plain typed arrays |
| Own ICC/IPTC parsers instead of packages | Browser compatibility — see Failed Approaches 1 and 9 |
| Compare composites flattened onto white | Compares what a viewer sees, not RGB hidden under transparent pixels |
| Demo uses `pixels: 'eager'`, not `'stream'` | Compositing needs all layers at once. The streaming path exists and is tested, just not exercised by the preview |

## Current State

**Working** — all three suites pass (`npm test`):
- 21/21 fixtures parse, 0 failures
- Metadata recovery matches independent block scan exactly: ICC 16/21, EXIF 21/21, IPTC 2/21, XMP 21/21
- Compositor vs Photoshop's own output: **12/21 pixel-exact (<0.5%), 5 within 10%, 4 above 10%** — every remaining diff traces to a named unimplemented feature
- Demo serves at `http://localhost:5173`

**Broken**: nothing known.

**Uncommitted changes**: not applicable — no git repo. **All work is untracked and unbacked.**

## Files to Know

| File | Why It Matters |
|---|---|
| `src/reader.js` | Public entry. `readDocument()`. Note the `layer.rawData` release in the stream branch |
| `src/composite.js` | Compositor + `compareBuffers` / `flattenOnto` / `differenceBuffer`. Blend-mode tables at the top |
| `src/resources.js` | Raw block extraction; no ag-psd dependency. Reusable for any block ag-psd ignores |
| `src/icc.js`, `src/iim.js` | Hand-written parsers. Do not swap for npm packages without checking browser support |
| `demo/shims/ag-psd.js` | **Every ag-psd symbol used in `src/` must be listed here** or the browser page blanks |
| `test/shim.mjs` | Guards the above. Runs first in `npm test` |
| `test/composite.mjs` | Accuracy harness against Photoshop's embedded composite |
| `spike/scan.mjs` | Independent structural PSD scanner. Ground truth — does not use ag-psd. **Keep this**; the rest of `spike/` is throwaway |
| `fixtures/` | 30 files: 21 `*.src.psd` Photoshop originals + `*.expected.psd` pairs from ag-psd's repo |

## Code Context

**Public API** (`src/index.js`):

```js
const doc = await readDocument(bytes /* Uint8Array|ArrayBuffer */, {
  pixels: 'none' | 'eager' | 'stream',   // default 'none'
  onLayer,        // (layer, pixels) => void — REQUIRED for 'stream'; copy before returning
  metadata: true, // ICC + EXIF + IPTC + XMP
  embedded: false // also decode Photoshop's own flattened composite
});
// -> { width, height, channels, bitsPerChannel, colorMode,
//      children,            // ag-psd tree; children[0] is the BOTTOM layer
//      layers,              // flattened
//      embeddedComposite,   // {width,height,data} | null
//      resources, linkedFiles, artboards, annotations,
//      metadata: { icc, exif, iptc, xmp } | null,
//      warnings: string[] }

const ours = compositeDocument(doc);            // needs pixels:'eager'
const stat = compareBuffers(flattenOnto(ours), flattenOnto(doc.embeddedComposite));
// -> { percent, percentReal, maxDelta, meanDelta, ... }   use percentReal
```

**Text layer shape** — this is what the next task operates on:

```js
layer.text = {
  text: "TEST",                       // the string
  transform: [1, 0, 0, 1, 36, 66],    // affine [a,b,c,d,tx,ty]; tx,ty = baseline origin
  shapeType: "point",                 // "point" | "box"
  orientation: "horizontal",
  antiAlias: "sharp",
  warp: { style: "none", ... },
  style: {
    font: { name: "AdobeInvisFont", script: 0, type: 0, synthetic: 0 },
    fontSize: 30,
    fillColor: { r: 255, g: 0, b: 0 },
    autoKerning: true, kerning: 0,
  },
  paragraphStyle: { justification: "left", firstLineIndent: 0, ... },
}
// layer bounds for this example: left 36, top 45, right 96, bottom 66
```

**Traps in that shape** (verified, not guessed):
- `style.font.name` is **`"AdobeInvisFont"`** — a placeholder, not the real font. Actual per-run fonts live in the raw EngineData, which ag-psd exposes at `psd.engineData` but does not fully model.
- `layer.text.styleRuns` **does not exist**. Per-character styling is only in EngineData.
- `layer.text.left/top/right/bottom` are all `0` — use `layer.left/top/right/bottom` for the rasterised bounds and `transform[4],[5]` for the baseline.
- The layer also carries **rasterised pixels** in `layer.imageData`, which is what the compositor currently draws. Editing the string does **not** update those pixels.

## Resume Instructions

The next task is **making text editable**. Before writing code, decide the scope with the user — these are very different jobs:

1. **Edit the string only, keep Photoshop's pixels** — trivial, but the canvas won't reflect the change. Almost certainly not what's wanted.
2. **Re-render text ourselves** — needs a shaping/rasterising engine (`opentype.js`, `fontkit`, or `harfbuzzjs`) plus font loading and fallback. This is the real work, and it will not match Photoshop's rasteriser exactly.
3. **Edit and save back to PSD** — requires reinstating write support, which was dropped for good reasons (see Key Decisions). ag-psd has an `invalidateTextLayers: true` write option that makes Photoshop redraw text on load, sidestepping our rasteriser.

To get running:

1. `cd a:/test-rnd && npm install`
2. `npm test`
   - Expected: `shim OK`, then `21 files | parsed 21 | failed 0`, then `<0.5% diff: 12   <10%: 5   >=10%: 4`
   - If the shim check fails: a new `ag-psd` import needs adding to `demo/shims/ag-psd.js`
3. `npm run serve` → http://localhost:5173, click **Load a sample**
   - Expected: `effects.psd` renders, three preview tabs work, amber warning box lists unapplied features
   - If the page is blank: open DevTools console — it is almost always Failed Approach 3
4. Inspect a text layer: `fixtures/text.src.psd` and `fixtures/text-box.src.psd` (point text and box text)

## Setup Required

- Node 24 (tested on v24.19.0). No env vars, no services.
- Demo needs internet on first load — Tailwind comes from the CDN. Parsing is fully offline.
- `--max-old-space-size=6144` is used for the test scripts; large fixtures need it.
- A background server may still be running on :5173 from the previous session.

## Warnings

- **No git.** Nothing here is version controlled or backed up.
- **`Patt` (pattern definitions) is present in 21/21 files and readable by NO library on any platform.** The reader emits a warning naming the consequence. Do not remove that warning — layers with pattern fills will not render correctly and the user must be told.
- **ag-psd does not read the ICC profile at all** — there is no field for it in its types. That is why `src/icc.js` exists. ICC is parsed for *identification* only; nothing converts colour, so CMYK and wide-gamut documents display wrong.
- **The whole file must be resident in memory.** `readPsd()` takes one `ArrayBuffer`; there is no streaming reader. A 2 GB PSB will not open in a tab. Fixing this means forking ag-psd to swap `DataView` for a windowed reader over `Blob.slice()` — feasible because every read primitive funnels through ~15 functions on a `{view, offset}` cursor.
- **32-bit float documents composite through 8-bit maths** — `float-color` decodes to 8-bit before we ever see it.
- **`spike/` is throwaway probe code** except `spike/scan.mjs`. It references `@webtoon/psd`, which has been uninstalled, so several spike scripts will now fail. That is expected.
- Memory shape, measured: read peak ≈ file size + one layer when streaming; streaming 343 MB of pixels cost only **35 MB** over doing nothing. Eager holds everything.
- Parse is **26–54 ms** on real fixtures. The ~4 s figures in `test/memory.mjs` come from a synthetic file stuffed with incompressible noise and are not representative.
