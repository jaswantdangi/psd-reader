# Handoff: Browser PSD Reader, Compositor + Editor

**Generated**: 2026-08-22 (updated)
**Repo**: https://github.com/jaswantdangi/psd-reader — **private**, branch `main`, working tree clean, pushed through `383a59a`
**Status**: In Progress — read, composite and edit all working and verified. No PSD writing by design.

## Goal

A browser-based PSD/PSB pipeline: recover as much of the file as possible, composite layers at exact position and order, and edit them — size, placement, text, blending, layer order.

## Completed

- [x] Reader (`src/reader.js`) — `readDocument()` with `pixels: 'none' | 'eager' | 'stream'`
- [x] Metadata ag-psd discards entirely: ICC (`src/icc.js`), IPTC (`src/iim.js`), EXIF (via exifr), raw block extraction (`src/resources.js`)
- [x] Compositor (`src/composite.js`) — position, order, opacity, masks, groups, clipping runs, 20 separable + 6 non-separable blend modes
- [x] Editor model (`src/edit.js`) — command-based mutations, undo/redo with drag coalescing, hit testing, project JSON
- [x] Editor renderer (`src/render.js`) — non-destructive transforms, bilinear resampling, live text rasterisation
- [x] Two demos: `demo/index.html` (inspector, 3-way composite comparison) and `demo/editor.html` (editing)
- [x] Four test suites, all passing: shim / read / composite / edit
- [x] Git repo created and pushed; fixtures excluded with a fetch script
- [x] Fixed pixelated text on scale (commit `383a59a`)

## Not Yet Done

- [ ] **Image replacement** — you can transform an image layer but not swap the image. Most-requested obvious gap.
- [ ] Layer effects (`fx`) — biggest compositor accuracy gap, affects 4 of 21 fixtures
- [ ] Adjustment layers, smart filters, blend-if ranges, artboard background colour, layer comps
- [ ] Multi-select, alignment, rotation
- [ ] Add / delete / duplicate layers
- [ ] Move decode + composite into a Web Worker (both block the main thread)
- [ ] `dissolve` blend mode; pass-through groups with opacity/blend
- [ ] Streaming reader (needs an ag-psd fork — see Warnings)
- [ ] PSD write support — deliberately dropped, see Key Decisions

## Failed Approaches (Don't Repeat These)

**Most of these were silent — they passed Node tests, or produced convincing wrong numbers.**

1. **`icc` npm package** — needs Node's `Buffer` (`readUInt32BE`), throws on a plain `Uint8Array`. Passes every Node test, dies in the browser. Replaced with `src/icc.js` (~90 lines, zero deps). **Do not reinstall it.**

2. **`const { default: exifr } = await import('exifr')`** — exifr's ESM build has **no default export**; Node's CJS interop invents one. In the browser `exifr` was `undefined`, `.parse` threw, and the `try/catch` swallowed it into a warning. EXIF would have silently died in production with a green suite. Now takes `mod.parse || mod.default?.parse`.

3. **Adding an `ag-psd` import without updating `demo/shims/ag-psd.js`** — blanks the page:
   > `Uncaught SyntaxError: The requested module 'ag-psd' does not provide an export named 'getCompositeImageData'`

   ESM named exports are static and the browser gets the shim, not the package. `test/shim.mjs` guards this and runs **first** in `npm test`.

4. **`ag-psd/dist-es/index.js`** — the `module` field points here but it contains **CommonJS**. The demo loads `dist/bundle.js` (UMD, global `window.agPsd`).

5. **Rasterising text once at natural size, then bitmap-scaling it** — this was the "text looks pixelated when scaled" bug. Text is vector; it must be drawn at the final size. `rasteriseTextAt()` scales the canvas transform (`sx`/`sy` independent) instead of resampling. **Never route text through `resample()`.**

6. **Clearing `layer.rendered` without clearing `layer.renderedKey`** — the next cache lookup hit a matching key, got `null`, and the layer **disappeared**. Invalidate the key.

7. **Comparing all 4 RGBA channels against the embedded composite** — Photoshop stores **white** in RGB under fully transparent pixels; we store zero. Both invisible. Reported `text` and `text-box` as 98% wrong when pixel-perfect. Use `flattenOnto()` on both first.

8. **Counting a delta of 1 as a mismatch** — different rounding of intermediate blend results. `gradient` showed 26% differing at `maxΔ = 1`. Use `stat.percentReal` (tolerance 1), never `stat.percent`. Together, 7 and 8 made a correct compositor look 5/21 right instead of 12/21.

9. **`bytes.buffer.slice(...)` unconditionally in `readDocument`** — copied the whole file, costing 261 MB peak on a 261 MB PSD.

10. **Releasing streamed layers by nulling `_`-prefixed fields** — wrong field. Retained channels live on **`layer.rawData`**. Null `imageData`, `canvas` **and `rawData`**.

11. **IIM parser ignoring record numbers** — reported record-1 character-set markers as `City`. Only **record 2** is content. Corrected IPTC from an apparent 10/21 to a true 2/21 (8 files carry an empty envelope).

12. **`flatten()` hiding a whole group** — `for (const l of out) l.visible = false` marked *every* layer flattened so far, not just that group's. Capture `out.length` before recursing.

13. **A test that silently skipped** — the text-layer cases ran against `effects.psd`, which has no text layer, and printed "skipped" while counting as passing. Now runs against `text.src.psd` with an assertion that the layer exists.

14. **`git add <dir>`** — `src/resources.js` was missed from an explicit staging list and would have broken the clone (`reader.js` imports it). Always read `git diff --staged --name-only` and verify every relative import resolves.

15. **Planned to fork ag-psd for block passthrough** — correct for read+write, **wrong for read-only**. Everything ag-psd drops, it drops on *save*. For reading it handles 343/343 keys.

16. **Considered `@webtoon/psd`** — 3× faster structure parse but 80% block coverage, read-only, no document metadata, stale since 2023, **reverse layer order**. Rejected, uninstalled.

17. **Considered writing a PSD codec from scratch** — months. ag-psd is the only free PSD writer in existence, which tells you how hard it is.

## Key Decisions

| Decision | Rationale |
|---|---|
| `ag-psd` as the spine | 343/343 block keys across 21 real files; only 3 unhandled corpus-wide (`CAI`, `OCIO`, `GenI`) |
| Read-only; no PSD write | ag-psd's writer peaks at **3.5–4.2× decoded pixels** (1761 MB for a 512 MB doc) and silently drops `Patt`, corrupting pattern fills |
| Canvas never in the decode path | `getImageData()` clamps to 8-bit and premultiplies alpha, destroying 16/32-bit data |
| Non-destructive transforms | Layers keep original pixels; `x/y/w/h` apply at render time. Scale to 20% and back loses nothing |
| Every mutation is a command | Undo/redo is replaying the inverse. Drags coalesce into one history entry |
| Groups flattened in the editor | Keeps every layer individually editable. Lossless only for pass-through groups at full opacity — warned on open |
| Resizing text switches it to live rendering | Photoshop's text pixels are a bitmap; upscaling can only blur. Badged `re-drawn` so it's never silent |
| Export = PNG + project JSON | Avoids reinstating write support |

## Current State

**Working** — `npm test`, all four suites:
- 21/21 fixtures parse, 0 failures
- Metadata matches an independent block scan exactly: ICC 16/21, EXIF 21/21, IPTC 2/21, XMP 21/21
- Compositor vs Photoshop's own output: **12/21 pixel-exact (<0.5%), 5 within 10%, 4 above** — every remaining diff traces to a named unimplemented feature
- Editor: 20 tests passing

**Broken**: nothing known.

**Uncommitted**: none. Working tree clean, `main` in sync with `origin/main`.

## Files to Know

| File | Why It Matters |
|---|---|
| `src/reader.js` | `readDocument()`. Note the `layer.rawData` release in the stream branch |
| `src/composite.js` | Compositor for the *unedited* document + `compareBuffers` / `flattenOnto`. Blend tables at the top |
| `src/edit.js` | Editable model, commands, undo, hit testing, project JSON |
| `src/render.js` | Renders the *edited* project. Text goes through `textPixelsAt`, never `resample` |
| `src/resources.js` | Raw block extraction, no ag-psd dependency. Reusable for any block ag-psd ignores |
| `src/icc.js`, `src/iim.js` | Hand-written parsers. Do not swap for npm packages without checking browser support |
| `demo/shims/ag-psd.js` | **Every ag-psd symbol used in `src/` must be listed here** or the browser blanks |
| `test/shim.mjs` | Guards the above. Runs first |
| `test/edit.mjs` | Edit model + text scaling. Stubs `globalThis.document` to test canvas maths in Node |
| `scripts/fetch-fixtures.mjs` | Fixtures are gitignored; this downloads all 21 |

## Code Context

```js
// Reading
const doc = await readDocument(bytes, {
  pixels: 'none' | 'eager' | 'stream',   // default 'none'
  onLayer,        // required for 'stream'; copy before returning, buffer is released
  metadata: true,
  embedded: false // also decode Photoshop's own flattened composite
});
// -> { width, height, channels, bitsPerChannel, colorMode, children /* [0] = BOTTOM */,
//      layers, embeddedComposite, resources, linkedFiles, artboards, annotations,
//      metadata: { icc, exif, iptc, xmp }, warnings }

// Editing
const project = createProject(doc, fileName);   // needs pixels:'eager'
setLayer(project, id, { x, y, w, h, opacity, blendMode, visible, rerendered }, coalesceKey);
setLayer(project, id, { text: { content, fontSize, color, fontFamily, align, bold, italic } });
reorderLayer(project, fromIndex, toIndex);      // 0 = bottom
undo(project); redo(project);
hitTest(project, x, y);                         // topmost non-transparent layer
const buffer = renderProject(project, { scale });
toProjectJson(project); applyProjectJson(project, json);
```

**Layer shape in the editor:**
```js
{
  id, name, kind: 'raster' | 'text',
  visible, opacity /* 0..1 */, blendMode,
  x, y, w, h,                  // current placement — NOT the source bounds
  pixels,                      // original decoded pixels, never mutated
  sourceW, sourceH,
  rerendered,                  // true = we draw it, not Photoshop
  rendered, renderedKey,       // text raster cache — invalidate BOTH
  text: { content, originalContent, fontFamily, fontSize, color, bold, italic, align } | null,
}
```

**Text layer traps** (verified against `fixtures/text.src.psd`, not guessed):
- `style.font.name` is **`"AdobeInvisFont"`** — a placeholder. Real per-run fonts live in raw EngineData that ag-psd does not model.
- `layer.text.styleRuns` **does not exist**. Per-character styling is EngineData-only, so one text layer = one style here.
- `layer.text.left/top/right/bottom` are all `0`. Use `layer.left/top/...` and `transform[4],[5]` for the baseline.

## Resume Instructions

1. `cd a:/test-rnd && npm install`
2. `node scripts/fetch-fixtures.mjs` — fixtures are gitignored
3. `npm test`
   - Expected: `shim OK` → `21 files | parsed 21 | failed 0` → `<0.5% diff: 12   <10%: 5   >=10%: 4` → `20 passed`
   - If the shim check fails: a new `ag-psd` import needs adding to `demo/shims/ag-psd.js`
4. `npm run serve`
   - Inspector: http://localhost:5173
   - Editor: http://localhost:5173/demo/editor.html
   - If a page is blank: DevTools console — it is almost always Failed Approach 3
5. Most likely next task is **image replacement** (see Not Yet Done). The transform path already exists; it needs a file input that decodes an image into `layer.pixels` and recomputes `sourceW/sourceH`.

## Setup Required

- Node 24 (tested v24.19.0). No env vars, no services.
- Demos need internet on first load (Tailwind CDN). Parsing is offline.
- Test scripts use `--max-old-space-size=6144` for the larger fixtures.

## Warnings

- **`gh` reverts to the wrong account between sessions.** It was on `hellomipl`, which cannot see this private repo, and `git push` failed with a misleading `Repository not found`. Fix: `gh auth switch --hostname github.com --user jaswantdangi`. Four accounts are authenticated (`jaswantdangi`, `hellomipl`, `dangijaswant`, `jaswantmipl`) — check before pushing. Commit identity is set **repo-locally** to `jaswantdangi <79034803+jaswantdangi@users.noreply.github.com>`; the global config is a different user and was left alone.
- **`Patt` (pattern definitions) is present in 21/21 files and readable by NO library on any platform.** The reader warns about it. **Do not remove that warning** — layers with pattern fills render wrong and the user must be told.
- **ag-psd does not read the ICC profile at all.** That is why `src/icc.js` exists. ICC is parsed for *identification* only — nothing converts colour, so CMYK and wide-gamut documents display wrong.
- **The whole file must be resident.** `readPsd()` takes one `ArrayBuffer`; no streaming reader. A 2 GB PSB will not open. Fixing it means forking ag-psd to swap `DataView` for a windowed reader over `Blob.slice()` — feasible because every read primitive funnels through ~15 functions on a `{view, offset}` cursor.
- **`spike/` and `fixtures/` are gitignored.** `spike/` is throwaway probe code except `spike/scan.mjs` (an independent structural PSD scanner, useful as ground truth). Several spike scripts reference `@webtoon/psd`, which is uninstalled, so they now fail — expected.
- **32-bit float documents composite through 8-bit maths** — they decode to 8-bit before we see them.
- Read peak ≈ file size + one layer when streaming; streaming 343 MB of pixels costs ~35 MB over structure-only. Parse is 26–54 ms on real fixtures; the ~4 s in `test/memory.mjs` is a synthetic incompressible file and not representative.
