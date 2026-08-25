# Phase 1 — Engine Rework, GPU Compositor, Memory Pipeline

**Date**: 2026-08-25
**Status**: Design approved, implementation plan not yet written
**Phase**: 1 of 6 (see *Programme context*)

---

## Programme context

We are building a mobile-first photo editor that opens PSDs and preserves
layering, in Ionic, reusing the `psd-reader` R&D engine. Its UI is modelled on
[ProHussain/PixelPerfect-PhotoEditor](https://github.com/ProHussain/PixelPerfect-PhotoEditor),
a native Android photo editor. None of that repo's code is reusable — it is
Java with an OpenGL filter pipeline — so it contributes screen flow, layout
patterns and (subject to licensing checks) assets only.

The work is decomposed into six phases, each with its own spec and plan:

| # | Phase | State |
|---|---|---|
| 0 | Design system + the five real screens | deferred, shrunk (see below) |
| **1** | **Engine rework, GPU compositor, memory pipeline** | **this document** |
| 2 | Layers panel + canvas interaction | not started |
| 3 | Raster tools (filter/adjust/HSL/overlay) as per-layer properties | not started |
| 4 | Creative tools (text, stickers) | not started |
| 5 | Framing + output (crop, ratio, export, share) | not started |

Phase 0 was originally first. It is deferred because Phase 1 needs a host to
run in, so **Phase 1 creates the minimal Ionic workspace itself**. Phase 0
shrinks to "design system and real screens", layered on afterwards.

---

## Why this phase exists

A spike measured the engine against realistic documents. The 21 fixtures could
not answer the question — they are Photoshop feature-tests, mostly 200×200,
13 MB for all 21 — so two synthetic documents were generated with ag-psd's
writer and measured.

### Measured: memory

Peak follows a formula that held to within 1% on both documents:

> **peak ≈ file size + one full-res layer + Σ(proxy layers)**

| Document | File | Eager (today) | Stream + proxy |
|---|---|---|---|
| 2000×1500, 12 layers | 104.6 MB | 410 MB | **214 MB** |
| 4961×3508, 6 layers | 303.4 MB | 1,068 MB | **449 MB** |

Two conclusions:

1. **Streaming works.** `retainedFullResMB: 0` on both runs — the release in
   `reader.js` is genuinely effective.
2. **The file itself is 68–78% of peak, and it is irreducible during decode**
   because `readPsd()` demands one contiguous `ArrayBuffer`. The mobile ceiling
   is therefore set by *file size*, not layer count or canvas size.

### Measured: speed

Interactive cost, proxy sources at a 1024-edge proxy canvas, **on desktop**:

| Layers | Per frame | At ¼ preview |
|---|---|---|
| 6 | 185 ms | 22 ms |
| 20 | **651 ms** | 48 ms |

Full-res export, desktop: 3.1 s untransformed, 4.3 s transformed.

Mobile runs roughly 3–5× slower, so a 20-layer document costs ~2–3 s per drag
frame and ~12–20 s per export. The cause is stated in the renderer's own
docstring: *"the whole stack is recomposited on every change"*.

**Speed, not memory, is the binding constraint.** Memory has a cheap fix;
rendering needs an architecture change.

### Measured: `ag-psd` bundling

`dist/index.js` and `dist-es/index.js` are **byte-identical CommonJS** (3892
bytes, zero ESM statements) and there is no `exports` field — the `module`
field is simply wrong and no ESM build exists. This is a non-issue under a
bundler: Vite/esbuild pre-bundle CJS→ESM automatically. The demo's UMD shim
(HANDOFF "Failed Approach 3") was an artifact of the demo running *without* a
bundler and does not carry into the Ionic app. Cost is one line:
`allowedCommonJsDependencies: ['ag-psd']`.

### Found by reading, not measuring

- **`createProject` and `pixels:'stream'` are incompatible today.** `reader.js`
  nulls `imageData` after `onLayer`, and `edit.js` drops any node without it
  (`if (!node.imageData && !node.text) continue`). Streaming a PSD currently
  yields a project with **every raster layer silently missing**.
- **`rasteriseTextAt` returns `null` when `document` is undefined**, so text
  layers vanish in a Web Worker.
- **`resample()` early-returns when sizes match**, so untransformed layers cost
  nothing at export.
- **`textPixelsAt` re-rasterises at final size**, so text exports sharp even
  from a proxy project. Raster layers do not — they would upscale and blur.

---

## Definition of done

> Open a real PSD on a phone, see it composited correctly, drag a layer at
> interactive speed, and export a full-res PNG.

Explicitly **out of scope**: layers panel, tool rail, filters, stickers, crop,
design system. Phase 1 ships the engine plus a deliberately ugly harness route.

---

## Decisions

| Decision | Rationale |
|---|---|
| GPU (WebGL2) compositing, with a **runtime** JS fallback | Chosen for the unknown-document case. Fallback ships to production for device spread, accepting two production paths |
| GPU produces preview **and** export | One path means WYSIWYG; collapses export from 12–20 s to well under a second |
| JS compositor retained as **test oracle** | Preserves the 12/21 pixel-exact fixture validation as an assertion, not a memory |
| Edit at proxy resolution, export at full | The only way past the measured memory and speed ceilings |
| `x/y/w/h` stay in **document coordinates** | `renderProject`'s existing `scale` parameter *is* the proxy mechanism; transforms stay resolution-independent and non-destructive |
| **Release file bytes after decode** | They are 68–78% of peak and are only needed during decode. Turns memory into a spike, not a plateau |
| Sandwich caching in the **fallback tier only** | GPU does not need it; the JS path cannot survive without it |
| Size guard refuses oversized files | An OOM in a WebView is a silent blank screen — the worst available failure |
| App is built **inside `test-rnd`** | One repo, no cross-repo versioning. Drift against `demo/` is an accepted, managed cost |

---

## Architecture

### Load pipeline

```
pick file → size guard → worker ─┬─ readDocument(pixels:'none')    structure + dims
                                 ├─ compute proxy scale
                                 ├─ readDocument(pixels:'stream') ─ per layer:
                                 │      downscale → stash on node → release full raster
                                 ├─ RELEASE file bytes, keep URI  ◀── the 68–78% term
                                 └─ transfer proxy buffers to main thread
```

Steady-state editing memory becomes **proxies alone** — ~36 MB for the
12-layer document, ~17 MB for the poster.

The stash exploits an existing property: `onLayer` receives the live ag-psd
node, and `doc.children` holds those same object references.

```js
onLayer: (node) => { node.proxyData = downscale(node.imageData, scale); }
```

**Proxy scale** is `min(1, PROXY_EDGE / max(docW, docH))`, where `PROXY_EDGE`
derives from viewport × devicePixelRatio, clamped by the memory budget.

**Size guard** derives a budget from `navigator.deviceMemory` with a hard
ceiling, and refuses above it with an explicit message naming the file size and
the limit.

### Render architecture

Three tiers, selected once at startup by capability detection:

| Tier | Selected when | Drag cost, 20 layers |
|---|---|---|
| WebGL2 in worker (OffscreenCanvas) | default | GPU-bound |
| WebGL2 on main thread | no OffscreenCanvas (older iOS Safari) | same, briefly blocks UI |
| JS compositor + sandwich cache | no WebGL2, or context lost | ~100 ms (vs 651 ms today) |

Layers become proxy-sized textures, uploaded once and re-uploaded only when
pixels change. Compositing is a ping-pong FBO walk, bottom to top.

**Blend modes**: 20 separable modes port mechanically from the tables in
`composite.js` to GLSL. The 6 non-separable modes (`hue`, `saturation`,
`color`, `luminosity`, `darker color`, `lighter color`) need the W3C
`setLum`/`setSat`/`clipColor` helpers and are the only fiddly shader work.
`dissolve` remains unimplemented, as today.

**Sandwich cache** (fallback tier): cache the composite of layers below the
selected layer and above it, so a drag re-blends 3 buffers instead of N,
making drag cost independent of layer count.

**Text in a worker**: canvas creation must be abstracted to `OffscreenCanvas`,
mirroring what `canvas.js` already does for ag-psd, or text layers vanish.
Fonts load via the `FontFace` API.

### Edit model changes

In `src/edit.js`:

- `flatten()` skip condition → `node.proxyData || node.imageData`
- `toLayer()` pixels → `source.proxyData || source.imageData`
- **`sourceW/sourceH` should be derived from layer bounds, not `imageData`.**
  They currently read `source.imageData?.width ?? w`.

  > **Corrected 2026-08-25, during Task 3.** An earlier draft of this spec
  > claimed a proxy load would make these silently record *proxy* dimensions.
  > That is wrong: the reader nulls `imageData` before `createProject` runs, so
  > the `?? w` fallback already yielded document bounds. The change is still
  > worth making — it makes the value unconditionally correct rather than
  > accidentally correct — but it is a robustness fix, not a live defect.

  `proxyW/proxyH` for the buffer dimensions are genuinely new and are required
  by export.
- Project gains `proxyScale` and `source: { uri, name, size }`.

`hitTest` needs **no change** — it maps by ratio and works on proxy buffers
as-is. Undo/redo is unaffected.

### Export pipeline

```
export → worker → re-read file from URI → stream full-res, one layer at a time
       → blend into full-res target → readback → PNG → Share / Filesystem
```

Peak is `file + one full layer + output buffer` — 435 MB for the poster, the
same order as load. No new ceiling.

**Trap 1 — reordering breaks arrival-order blending.** The file yields layers
bottom→top, but the edited project may have reordered them, and blending is
sequential and order-dependent. Fast path when order is unchanged: blend as
they stream. Otherwise **spill each full-res raster to Capacitor Filesystem on
arrival, then read back in project order**. Memory stays at one layer; disk
pays instead (~398 MB temporary for the poster).

**Trap 2 — mobile GPU texture limits.** `MAX_TEXTURE_SIZE` is commonly **4096**
on older Android GPUs, and the poster is 4961 wide; a full-canvas texture would
fail to allocate. Export composites in **tiles sized to the device's queried
limit**, never an assumed one.

**On the fallback tier**, export runs the same streaming walk through the JS
compositor instead of the GPU. Both traps still apply — reordering still forces
the spill path — but tiling does not, since there is no texture limit to
respect. It is slow (the measured 3–4 s desktop, 12–20 s mobile) and therefore
requires the same progress UI as decode.

### Testing

- The four existing Node suites keep running against the JS compositor, so the
  oracle stays intact.
- New Node suite: proxy pipeline correctness — all layers present after a
  streamed load, full-res dimensions recorded, transforms in document space.
- **GPU conformance cannot run in `npm test`. Node has no WebGL.** `headless-gl`
  is a fragile native build on Windows; browser automation is excluded by
  project rules. Instead, an **in-app conformance route** runs the 21 fixtures
  through both the GPU and JS paths and prints a `percentReal` pass/fail table
  (tolerance 1, per HANDOFF "Failed Approach 8"), run manually. This also tests
  the real device driver, which is where GPU output actually differs.

> **Accepted gap:** a green `npm test` will no longer mean the renderer is
> correct. The conformance route is what keeps the GPU path honest, and it is
> manual.

### Repository integration

The app is built inside `test-rnd`:

```
test-rnd/
├ src/                  engine — shared by tests, demos and the app
├ test/                 4 existing suites, unchanged
├ demo/                 existing R&D pages (will drift; accepted)
├ fixtures/             gitignored, fetch script
├ app/                  NEW — Ionic Angular + Capacitor
└ docs/superpowers/specs/
```

- npm workspaces at the root so `app/` carries its own `package.json` without
  a second lockfile.
- `app/tsconfig` maps `@engine/*` → `../src/*` (relative to the `app/` root).
- `allowedCommonJsDependencies: ['ag-psd']` in `angular.json`.
- Worker via Angular's `ng generate web-worker`.
- Services: `PsdLoaderService`, `CompositorService` (tier selection),
  `ProjectService`, `ExportService`.
- Capacitor: Filesystem (read PSD, write export and spill), Share, file picker.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| GPU output diverges from Photoshop; no automated coverage | High | In-app conformance route; JS oracle retained; tolerance-1 comparison |
| Two production render paths diverge in behaviour | High | Conformance route runs *both* tiers against the fixtures |
| `MAX_TEXTURE_SIZE` 4096 on older GPUs | Medium | Query at startup; tiled compositing for export |
| Importing `../src` across the workspace boundary may fight Angular's esbuild | Medium | Verify early; fall back to a path-mapped local copy if it resists |
| Engine in `src/` drifts from `demo/` usage | Medium | Accepted cost of the one-repo decision; demos are R&D, not product |
| Decode time (12–20 s mobile for large files) | Medium | Worker keeps UI responsive; progress UI required, cannot be hidden |
| Spill-to-disk export needs ~398 MB temp | Low | Only on the reordered path; clean up on completion and on failure |

## Open questions

- What is the hard file-size cap, in MB? Needs a real device to calibrate; the
  guard ships with a conservative default until then.
- Does `OffscreenCanvas` + WebGL2 work in the Capacitor WebView on the oldest
  Android target? Determines whether tier 1 or tier 2 is the common case.

## Not doing

PSD **writing** (unchanged from the R&D decision — ag-psd's writer peaks at
3.5–4.2× decoded pixels and silently drops `Patt`). Layer effects, adjustment
layers, smart filters, blend-if. `dissolve`. Streaming reader (would require
forking ag-psd).
