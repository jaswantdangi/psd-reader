# Backlog

Deferred findings, noticed but deliberately not fixed. Append here; never delete
an entry without either fixing it or recording why it stopped mattering.

Origin of most entries: the Phase 1A task reviews and whole-branch review
(2026-08-25). Those ran inside a git-ignored workspace, so this file is the only
place they survive.

---

## Engine (`src/`)

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
