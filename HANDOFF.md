# Handoff: AI Background Removal in the Browser PSD Editor

**Generated**: 2026-09-02
**Repo**: `a:/test-rnd` — branch `phase-1-engine-gpu-memory`, HEAD `9bd242e`
**Deployed**: https://psd-editor.pages.dev (Cloudflare Pages project `psd-editor`, build `90c07ff4`)
**Status**: In Progress — automatic cut, edge controls and brush working; SAM tap path unverified.

> Supersedes the 2026-08-22 handoff, which described the repo at `383a59a` and was
> ~130 commits stale. The still-valid parts of its Failed Approaches are carried
> forward below.

## Goal

Add background removal to the browser PSD editor: cut a subject out of a layer,
correct the result by hand, and tune the edge — entirely on-device, no server,
inside a memory budget that assumes a cheap Android phone.

## Completed

- [x] **Engine `src/segment/`** — pure JS, no browser APIs, runnable in Node:
  - `models.js` — model registry, per-device selection (`autoModel`), licences, sizes
  - `mask-ops.js` — combine/invert/feather, O(n) box blur, soft brush, interpolated stroke
  - `refine.js` — guided filter (pulls alpha onto the real edge) + colour decontamination
  - `cutout.js` — logits→mask resample, `applyCutout`, `paintMask`, `setMaskEdge`
  - `edge.js` — non-destructive edge recipe (blur/shift/contrast/smooth/fade)
- [x] **Masks are writable and persistent.** Generated masks ride the existing
  `set` command (invertible for free) and are written into the project JSON.
- [x] **App wiring** — `bg-remove.worker.ts`, `segment.service.ts`, `cutout-panel.ts`.
- [x] **Selection tool** — armed explicitly; only then does it take the pointer.
- [x] **Edge sliders** — five controls, re-derived from the model's own output.
- [x] **Loader** — determinate during download, indeterminate during inference.
- [x] Deployed to production and confirmed working by the user.

## Not Yet Done

- [ ] **No test file covers `src/segment/**`.** Built at the user's explicit
      direction ("no testing"). `npm test` does not touch any of it.
- [ ] **SAM tap-to-correct is unverified end-to-end.** The pointer path reaches
      the model (proved by the error it produced), but no successful tap observed.
- [ ] Guided upsample at export — see the softness warning under Warnings.
- [ ] Cancellation for a running cut (same gap export already has).
- [ ] `costOf` quotes a download the HTTP cache may already hold across sessions.

## Failed Approaches (Don't Repeat These)

**The WebGPU saga — three attempts, two shipped broken.** Read this before
touching device selection.

1. **Drove `AutoModel` directly and guessed tensor names.** The input/output
   names differ between the BiRefNet, ormbg and MODNet exports and nothing in
   the repo could settle them. Replaced with transformers.js's
   `background-removal` pipeline, which owns that mapping upstream. **Verified
   from the installed package's source**, not assumed:
   `dist/transformers.web.js` → `cloned.putAlpha(masks[i].mask)`, so the result
   is the original image with alpha = mask, 4 channels.

2. **Caught the WebGPU failure at model CONSTRUCTION.** Shipped; changed nothing.
   onnxruntime-web compiles WebGPU kernels **lazily**, so the operator error
   throws at **inference**, not at session creation.

3. **Moved the catch to wrap load-and-run.** Also shipped; also failed. Root
   cause of both: **nothing in this repo can execute WebGPU**, so every fix was
   written blind. The Node probes that "verified" the models ran on
   **onnxruntime-node (native CPU)** — not the browser's WASM backend and not
   WebGPU at all, so they never covered the failing layer.

   **Resolution: WebGPU is disabled.** `pickDevice()` returns `'wasm'`
   unconditionally, with the reasoning in-file. To re-enable, confirm ONE model
   on a real device then gate **per-model** — a blanket `requestAdapter()` check
   is the wrong question, because the capability is **per-operator**.

4. **Made BiRefNet_lite the default.** It publishes only fp32 (224 MB) and fp16
   (115 MB) — no 8-bit build — and fp16 on WASM is unreliable. Forcing the CPU
   path would have broken the default. ormbg q8 is now the default.

5. **Ranked subject match above model rank in `autoModel`.** At 81.9 MB a
   "people" request picked MODNet (7 MB) over ormbg (45 MB), which is both
   higher-ranked *and* human-trained. Subject now only breaks ties at equal rank.

6. **Backticks inside an HTML comment in a component template.** The template is
   a JS template literal; a backtick terminates it. Produced
   `TS2304: Cannot find name 'none'` pointing at `pointer-events-none`. The repo
   had already been broken this way once (commit `06aacba`). **Never use
   backticks inside these templates, comments included.**

7. **Stated twice that "the editor has zero mask support."** It was true when
   `docs/BACKLOG.md` recorded it and false by the time I read it — `src/mask.js`
   already existed. **Verify backlog entries against the code before acting.**

**Carried forward from the previous handoff (still true):**

- **Adding an `ag-psd` import without updating `demo/shims/ag-psd.js` blanks the
  page.** `test/shim.mjs` guards this and runs first in `npm test`.
- **Never route text through `resample()`** — text is vector and must be drawn at
  final size, or it looks pixelated when scaled.
- **Clearing `layer.rendered` without `layer.renderedKey`** makes the layer
  disappear. Invalidate both.
- **`icc` npm package and `exifr`'s default export** both pass in Node and die in
  the browser. Do not reinstall `icc`.

## Key Decisions

| Decision | Rationale |
|---|---|
| On-device only, no server | Matches the app's privacy model; deploys to static Pages |
| CPU (WASM) only, WebGPU off | The only backend observed producing correct masks; see Failed Approaches |
| ormbg q8 (45 MB, Apache-2.0) as default | Verified end-to-end; 8-bit so it runs everywhere |
| BiRefNet MIT over RMBG / @imgly | RMBG-1.4/2.0 is **CC BY-NC**; @imgly is **AGPL**. Both unusable in a shipping product |
| SlimSAM over SAM 3 | SAM 3 ships under Meta's own licence; SlimSAM is Apache-2.0 and smaller |
| SlimSAM at q8, not fp16 | SAM returns a **binary** mask — no soft edge for the precision to land in — and it must survive the CPU path |
| Mask rides the existing `set` command | `setLayer` already captures `from`, so undo is free. No new command type |
| Edge stored as a **recipe**, not baked | Same shape as `layer.adjust`: parameters stored, result derived. Makes sliders reversible |
| Refine + decontaminate are classical, not models | Kilobytes instead of a second 100 MB download |
| Selection tool armed explicitly | With nothing armed the canvas behaves exactly as before; pinch is never intercepted |

## Current State

**Working** (confirmed by the user in the deployed app): automatic cut, model
download with progress, edge sliders, loader. Build exits 0.

**Unverified**: SAM tap-to-correct; the brush (erase/restore) — engine path is
tested in Node, browser path is not.

**Uncommitted**: 11 modified files + `src/segment/edge.js` untracked
(~973 insertions). `git status` before doing anything.

## Files to Know

| File | Why It Matters |
|---|---|
| `src/segment/models.js` | Registry + `autoModel`. Sizes and licences live next to ids on purpose |
| `src/segment/edge.js` | The edge recipe. Order of operations is documented and deliberate |
| `src/segment/cutout.js` | `applyCutout` / `paintMask` / `setMaskEdge`. All amend `mask.source`, never `mask.data` |
| `src/segment/refine.js` | Guided filter + decontamination. Refine MUST run before decontaminate |
| `app/src/app/workers/bg-remove.worker.ts` | `pickDevice()` returns `'wasm'` — read the comment before changing it |
| `app/src/app/services/segment.service.ts` | Worker lifetime, `tool` signal (the arbitration rule), download consent |
| `app/src/app/editor/cutout-panel.ts` | Side panel. Must stay INSIDE `<main>` or it covers the header |
| `src/edit.js` | `maskJson` / `decodeMaskJson` — persists source + recipe, not the derived plane |
| `docs/BACKLOG.md` | ~20 deferred findings for this feature, with FIXED entries struck through |

## Code Context

```js
// The mask a layer carries. `data` is what renders; `source` is what the model
// said; `edge` is the recipe between them. render.js reads ONLY `data`.
layer.mask = {
  data,            // Uint8Array, w*h, 0..255 — alpha multiplier
  source,          // the model's own plane, never mutated
  edge,            // { feather, shift, contrast, smooth, fade }
  width, height,   // ALWAYS layer.pixels dimensions
  disabled,        // honoured; Photoshop saves switched-off masks
  generated: true, // marks it as ours, so persistence writes it out
};

// Engine entry points
buildCutout(logits, srcW, srcH, pixels, options)  // -> { mask, pixels, coverage, empty }
applyCutout(project, id, cut, { mode })           // mode: replace|add|subtract|intersect
paintMask(project, id, points, { radius, hardness, erase, coalesceKey })
setMaskEdge(project, id, { feather: 4 }, coalesceKey)
autoModel(budgetBytes, subject)                   // 'general' | 'people'

// Worker protocol
postMessage({ requestId, kind: 'segment'|'point', pixels, modelId, dtype, points, labels })
// <- { type: 'download', loaded, total } | { type: 'ready', id, device }
// <- { type: 'done', requestId, data, width, height } | { type: 'error', requestId, message }
```

**Model selection, as it actually resolves:**

| Budget | General | People |
|---|---|---|
| 150 MB | Standard (ormbg q8, 45 MB) | Standard |
| 81.9 MB | Standard | Standard |
| 40 MB | Light (MODNet q8, 7 MB) | Light |

## Resume Instructions

1. `cd a:/test-rnd/app && npm install` — `@huggingface/transformers` 3.8.1 is required.
2. `cd a:/test-rnd && npm test`
   - Expected: all suites pass. **Nothing here covers `src/segment/**`.**
3. Verify the engine without a browser:
   ```
   node -e "import('./src/segment/index.js').then(m=>{const W=64,H=64;
   const s=new Uint8Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)s[y*W+x]=(x>20&&x<44&&y>20&&y<44)?255:0;
   console.log('feather', m.applyEdge(s,W,H,{feather:4})[32*W+20]);
   console.log('reversible', m.applyEdge(s,W,H,{feather:0}).every((v,i)=>v===s[i]));})"
   ```
   - Expected: `feather 113`, `reversible true`
4. Build and deploy (the user runs builds; do not run them to "verify"):
   ```
   cd app && npm run build
   npx wrangler pages deploy dist/app/browser --project-name=psd-editor --branch=main --commit-dirty=true
   ```
5. **Most likely next task**: commit the work (see Warnings), then verify the SAM
   tap path on a real device.

## Setup Required

- Node 24. `@huggingface/transformers` ^3.8.1 in `app/`.
- Models download from the Hugging Face CDN on first use — **first cut needs
  internet**; afterwards the browser cache serves them.
- Cloudflare: `npx wrangler whoami` must show `jaswantdangi00@gmail.com`.

## Edge Cases & Error Handling

- Model finds nothing → mask is all-255, `isOpaque` catches it, panel says
  "Nothing found to cut out" rather than spending an undo step.
- Device below ~31 MB budget → `autoModel` returns null, `unavailableReason`
  explains it, **the brush still works** (no model needed).
- Worker dies (OOM kill on a phone) → `onerror` rejects every in-flight request;
  without it the button just stops responding.
- Saved mask whose dimensions no longer match the layer → **refused silently**.
  `render.js` indexes the plane with no bounds check, so restoring a mismatched
  one would read past the end. The user is told nothing — a known gap.

## Warnings

- **Commit before anything else.** 11 files modified, `src/segment/edge.js`
  untracked, and the deployed bundle corresponds to no commit. A redeploy from a
  clean checkout would silently revert the feature. **Stage exact files** — the
  tree has also carried unrelated Select-tool work.
- **The cut-out tool and the Select tool both claim single-pointer events, and
  the cut-out wins.** `canvas-stage.ts` checks `seg.tool()` before `selectMode`
  reaches `arbitrate`. With Select on and a cut-out armed, taps cut rather than
  pick and the Select toggle looks broken. Nothing states this.
- **Export softens the cut.** The mask is generated on the 1024px proxy and
  export streams at full resolution, so it is upscaled on the way out.
  `exportSoftnessNote` discloses it above 2×; nothing fixes it. Guided upsampling
  is the obvious follow-up.
- **Decontamination rewrites `layer.pixels` at PROXY resolution**, but export
  re-reads the original from the PSD — so the exported file keeps spill the
  editor removed. Deliberately NOT papered over with `selfSupplied`, which would
  be a lie about resolution.
- **A generated mask costs ~1.4 MB of JSON per cut layer** (base64 of one byte
  per pixel). PNG-packing would cut that ~10×.
- **Cuts are CPU-only and single-threaded.** `app/public/_headers` deliberately
  omits COOP/COEP, so onnxruntime-web cannot use WASM threads either. Several
  seconds per cut is expected and the UI says so.
- **`npm test` does not cover this feature at all.** Any "tests pass" claim about
  background removal is meaningless.
