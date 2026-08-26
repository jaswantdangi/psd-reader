# Backlog

Deferred findings, noticed but deliberately not fixed. Append here; never delete
an entry without either fixing it or recording why it stopped mattering.

Origin of most entries: the Phase 1A task reviews and whole-branch review
(2026-08-25). Those ran inside a git-ignored workspace, so this file is the only
place they survive.

---

## Correctness gaps (highest priority)

- **Streaming does not release mask pixels — a live memory leak.** `src/reader.js`
  clears `imageData`, `canvas` and `rawData` after each `onLayer` call, but not
  `layer.mask.imageData`, which `decodeLayerPixels` has already populated. Measured
  on `fixtures/masks.src.psd`: **104 KB of mask pixels still resident** after a
  streamed load that reports zero retained layer pixels. It scales with layer area,
  so a poster-sized masked layer retains tens of MB.

  This invalidates part of the Phase 1A memory claim. The spike that measured
  `retainedFullResMB: 0` used **synthetic fixtures with no masks**, so it could not
  have caught this — the guarantee was verified on a case that could not fail.

  Fix is the same change as the Phase 2 mask prerequisite: downscale the mask
  alongside its layer in `loadProjectProxy` and release the full-resolution
  original. Doing both at once nets a memory *reduction* rather than a cost.

- **Layer masks AND clipping are dropped by the editor.** `src/composite.js` applies
  both (17 `mask` references, 12 `clip`); `src/edit.js` and `src/render.js` contain
  **zero of either**. So the read-only compositor honours them, but any document
  opened in the editor renders masked layers as if unmasked and clipped layers as if
  unclipped — in preview *and* in export. This is not a documented limitation, it is
  a silent wrong-pixels bug, and it will look like the editor "breaks" files the
  inspector renders correctly. Found while specifying Phases 1B and 1C, 2026-08-26.
  Fixing it means carrying mask rasters and clipping runs through `toLayer()` and
  honouring them in `renderProject` — Phase 2-sized work, not a patch.

  This is also why Phase 1B's GPU conformance suite compares **GPU against the JS
  compositor**, not GPU against Photoshop: the editor render path is already known
  to differ from Photoshop for these files, so Photoshop is the wrong oracle for it.
- **Decode order and project order diverge.** `src/reader.js` streams every leaf
  node (skipping only groups); `src/edit.js`'s `flatten()` additionally skips leaves
  with neither pixels nor text. Harmless today because `loadProjectProxy` stashes
  proxies **on the node**, not by index — but any future code that matches decoded
  layers to project layers *positionally* (full-resolution export is the obvious
  candidate) would silently misalign every layer after the first skipped one. Give
  layers a stable `sourceIndex` before writing that code.

## Engine (`src/`)

- **The sandwich cache's flattened-`above` path costs up to 2 LSB.** Measured: 7 of
  576 pixels on the `test/gpu.mjs` fixture. The algorithm is exact in real
  arithmetic — source-over is associative — but `above` is quantised to 8 bits when
  flattened and again when blended, and un-premultiplying by its alpha amplifies
  that by `1/ao`. Storing `above` as `Float32Array` (or 16-bit) would restore
  bit-exactness at 4x (or 2x) the buffer cost. Not done: this path only draws drag
  previews and the frame surviving a gesture comes from a full re-render. Revisit if
  the cache is ever reused for anything durable — an export, a thumbnail, a save.

- **`applyProjectJson` had a stale-cache bug** — fixed 2026-08-25 in the Phase 1A
  final-review pass (`src/edit.js`), but the *pattern* is worth watching: any new
  code that clears `layer.rendered` must clear `layer.renderedKey` in the same
  breath, or the layer silently disappears.
- **`containsKey` byte-scans the whole file three times** (`src/reader.js`) looking
  for `Patt`/`Pat2`/`Pat3`, with a naive O(n·m) scan. At the 150 MB file cap that is
  up to three full passes *after* decode has finished. Harmless on desktop; it is now
  on the mobile critical path. `loadProjectProxy` already avoids the metadata cost by
  passing `metadata: false` — this is the remaining avoidable work in the same call.
- **`estimatePeakBytes` has no production caller** (`src/budget.js`). It encodes the
  measured peak formula and is exercised only by a test. Either wire it into the
  guard so the estimate does real work, or accept it as executable documentation.
- **`memoryBudgetBytes` is two-valued in practice, and its comment implies a
  continuum** (`src/budget.js`). With the 150 MB cap and a 0.08 fraction the clamp
  point is ~1.83 GB, so real devices get either 81.9 MB (unknown or ≤1.8 GB) or
  150 MB (2/4/8/16 GB alike). Behaviour is deliberate; the comment should say so.
- **`proxyScaleFor` returns a negative scale for negative dimensions**
  (`src/proxy.js`). Unreachable — PSD headers are unsigned. Guard only if it is ever
  exposed to less-trusted input.
- **`downscaleImage` returns its input object when scale is 1** (`src/proxy.js`).
  Load-bearing — it is what makes a sub-1024 document cost nothing — but the return
  type deserves a JSDoc line saying the result may be the argument.
- **Box-average windows overlap by one source pixel at non-integer ratios**
  (`src/proxy.js`). Marginally softer than an exact box filter, never wrong.

## Tests

- **`test/proxy.mjs` sourceW assertion does not discriminate** old from new
  behaviour; its sibling `proxyW/H` assertion does. Harmless, but it is not the
  proof its name claims.
- **`test/proxy.mjs` asserts `progressCalls > 0`** rather than `=== layer count`, so
  it would pass if `onProgress` fired exactly once. Two characters to strengthen.
- **No test exercises 2/4/8 GB device memory**, which all clamp to the same budget.
  One assertion that they do would document the two-valued reality above.
- **`test/edit.mjs`'s "layers start at their original bounds" cannot fail.** Since
  `sourceW/H` are derived from the same bounds as `w/h`, the assertion is
  documentation. An attempt to strengthen it with `proxyW === pixels.width` was
  reverted — that is tautological too, because `proxyW` and `pixels` are assigned
  from the same object in the same literal in `toLayer()`, and on an eager load
  every one of those dimensions coincides anyway. The discriminating coverage lives
  in `test/proxy.mjs` against a genuinely downscaled fixture. Worth revisiting only
  if `edit.mjs` ever gains a proxy-loaded fixture.

## Export (Phase 1C)

- **Export has no cancellation path.** The Phase 1C spec calls for defined behaviour
  when a user backgrounds the app mid-export, and Task 7's brief is titled "progress
  phases and the cancellation signal" — but the brief defines no cancellation
  interface and none was invented. So a 12-20 s mobile export currently cannot be
  stopped: no abort signal, no defined state if the worker is killed part-way, and
  spilled files from an abandoned run are cleaned only by the launch sweep.
  Backgrounding an app mid-task is normal phone behaviour, not an edge case.

- **`planSpill` and the export walk are two implementations of one state machine.**
  They are pinned by a single assertion (walk's actual spill writes == `planSpill`'s
  prediction). That assertion is load-bearing: weaken or reorder it and the two can
  drift into producing a plausible-looking wrong image with a green suite. If either
  side is ever refactored, check that assertion still compares what it claims to.

## App (`app/`)

**Nothing under `app/` has automated coverage.** That was a deliberate design
decision — logic lives in `src/` where the Node suites run, so the Angular layer
stays thin plumbing. Worth re-checking as the app grows: the moment real logic
lands in a service, that division has stopped holding.

- **`webWorkerTsConfig` in `app/angular.json` is dead configuration.** The
  `@angular/build:application` builder validates but never reads it — the worker
  bundle inherits the app tsconfig instead. So `app/tsconfig.worker.json` and its
  `lib` setting have no effect on the build. Written by the schematic, not by us,
  but anyone reading it will believe something untrue.
- **`app/src/styles.scss` mixes Sass and PostCSS import semantics.** Sass passes
  `@import "x.css"` through as plain CSS but resolves the extensionless
  `@import "tailwindcss"` itself, possibly before `@tailwindcss/postcss` sees it.
  Both probably work; two independent "probably"s in five lines is worth replacing
  with `@use` for Ionic.
- **`app/tsconfig.app.json` includes only `src/**/*.ts`, not `../src`.** Resolved in
  practice — `allowJs` defers engine JS to esbuild's loader — but it means the user's
  build is the real test of the `@engine/*` mapping.
- **Root-level `.angular/cache` is not gitignored** (`app/.angular/cache` is). Only
  bites if someone runs `ng` from the repo root.
- **`project.source.uri` is currently a synthetic string.** The harness passes
  `file://<name>`, which nothing can re-read. Full-resolution export (Plan 1C)
  depends on this being a real, re-readable URI — a file picker must land first.

## Unverified by execution

Build commands are not run in this project, so the following are unconfirmed by
anything but reading. The user's first build and first device run settle them.

- Whether the Ionic 8 → 9 import fix in `app.config.ts` is the only API drift on the
  entry path.
- Whether Sass and `@tailwindcss/postcss` actually cooperate, and whether Ionic's
  base styles reach the page at all.
- Whether `allowedCommonJsDependencies` suppresses the `ag-psd` bailout warning for
  the *worker* bundle specifically.
- Whether the emitted worker chunk's size is tolerable given `ag-psd` is bundled into
  it, and whether `exifr`'s dynamic import is inlined despite never executing under
  `metadata: false`.
- Whether an oversized file produces the guard message rather than a blank screen.
- **Whether the 150 MB cap and 81.9 MB unknown-device fallback are calibrated
  correctly.** They are conservative guesses. This is a named open question in the
  Phase 1 spec and needs a real device to close.
