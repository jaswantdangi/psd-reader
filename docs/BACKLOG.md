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

  **Measured limit of that pin.** Mutation-tested during Task 9. Forcing `planSpill`'s
  match to never fire was caught immediately. But mutating the match comparison from
  `===` to `<=` was an **equivalent mutant on the current fixture and passed
  undetected** — the fixture's `need` sequence is contiguous, so the two comparisons
  cannot diverge on it. The pin therefore catches structural divergence but not an
  off-by-one in the match condition. A fixture whose wanted `sourceIndex` values are
  non-contiguous (a reorder combined with a hidden or zero-opacity layer that
  `wantLayer` skips) would close that hole.

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

## Creative tools (Phase 4)

- ~~**Inserted and replaced image layers break full-resolution export.**~~
  **FIXED** 2026-09-01. `drawsOwnPixels(layer)` in `src/export/order.js` widens
  `isSelfRendering` to a layer flagged `selfSupplied` that carries pixels;
  `wantedIndices`, `assertIdentifiable`, `isFastPath`, `planSpill` and
  `stream.js`'s walk all read it, and `createJsExportTarget.blend` falls back to
  `layer.pixels` only for those layers.

  **The suggested predicate in the original entry was wrong and was not used.**
  `layer.pixels && layer.sourceIndex === null` also describes every layer of an
  EAGERLY read project and would have silently un-refused those exports, and it
  is one `sourceIndex` reset away from describing a proxy-loaded layer whose
  256-edge buffer would then be blended at scale 1 -- exactly the blurred-but-
  correctly-sized failure the entry warned about. Only the code that PUT
  full-resolution pixels on a layer knows they are full resolution, so
  `selfSupplied` is a stamped field on `toLayer`/`blankLayer`, set by
  `insertImageLayer` and `replaceImage` and captured in the undo command's
  `from` alongside `sourceIndex`.
- ~~**Adding and removing a layer is not undoable.**~~ **FIXED** 2026-09-01.
  `applyCommand` handles `insert` and `remove`; `invert` turns each into the
  other; `insertLayer`/`removeLayer` route through `commit`. The command holds
  the LAYER OBJECT, so ids are stable across an undo/redo cycle and undoing a
  delete restores the pixel buffer. Note: `nextLayerId` reads the LIVE stack, so
  a layer inserted after an undo REUSES the abandoned layer's id. Harmless --
  history is linear, so the two can never be in the stack at once -- but a UI
  holding a selected id across an undo will find the new layer rather than
  nothing.
- **A saved project cannot round-trip a created layer.** `applyProjectJson`
  matches by index and throws on a layer-count mismatch, and the JSON carries no
  pixels -- so a session with an inserted sticker reopens as a count mismatch,
  and a created text layer would need both its geometry and its existence
  written.
- **An inserted image larger than the document overflows it.** `insertImageLayer`
  places at natural pixel size deliberately (it is the only size that is not a
  guess), so a phone photo lands as a 4000px layer in a 1000px document. The app
  should pass `w`/`h`; a `maxFraction` option could live in `src/creative/image.js`.
- **`replaceImage` has no `cover` fit.** `cover` overflows the box and there is no
  source-rect/crop in the layer model to clip it with. Adding crop is a model change.
- **`originalContent` is `''` on a created text layer** -- it means "what Photoshop
  had", and Photoshop never had it. Any UI badging "edited" from
  `content !== originalContent` will badge every created layer.

## Framing (Phase 5)

Noticed while building `src/frame/**` (2026-09-01). None of these is a bug in the
framing engine itself; all of them are code the framing engine does not own that
has to learn the frame exists.

- ~~**A saved project silently loses its crop.**~~ **FIXED** 2026-09-01.
  `toProjectJson` writes `frame` (null included, so a pre-crop save un-crops the
  project it is applied to) and `applyProjectJson` restores it through
  `normaliseRect`, re-frozen. Three tests in `test/frame.mjs`. Still open inside
  it: a frame saved against a document of a DIFFERENT size is normalised, not
  rejected — `applyProjectJson` already refuses a layer-count mismatch and could
  refuse this the same way.

- ~~**The frame is not a command `edit.js` understands.**~~ **FIXED** 2026-09-01.
  `applyCommand` handles `frame`, `setFrame` moved to `edit.js` beside the other
  command constructors, and `src/frame` re-exports the REAL `undo`/`redo`/
  `discardTo` rather than wrapping them. `test/frame.mjs` asserts
  `undo === editUndo` so the seam cannot reappear unnoticed.

- ~~**`project.width`/`height` mean the SOURCE document after a crop, not the
  canvas.**~~ **FIXED** 2026-09-01. `canvasSize(project)` in `edit.js` is the one
  accessor for "how big is the thing on screen"; `fitView`, `clampView` and
  `hitTest` all read it, and `hitTest`'s parameters are named `canvasX`/`canvasY`
  to say which space they are in. Still open: `gesture.js` and any UI overlay
  that positions handles from `project.width` — none does today, but the trap is
  the same one.

- **`src/index.js` does not re-export `src/frame/**`.** It is another task's
  file. Until it does, the import path is `src/frame/index.js` directly, and
  `test/frame.mjs` imports it that way.

- **`renderSandwiched`'s cache key does not include the frame.** The key is
  `selectionIndex|revision|scale|layerCount`, and a crop drag coalesces, so
  `revision` deliberately does not move during one — which means a gesture that
  re-rendered a *framed* project through the sandwich would reuse a `below` and
  `above` built at the previous frame origin. Harmless as long as the crop UI
  moves an overlay rect in CSS and only commits the frame at gesture end, which
  is what it should do anyway. It becomes a stale-backdrop bug the day someone
  renders the framed project per crop frame.

- **No rotation, no straighten, no flip.** The layer model has no angle field
  (`gesture.js` says so explicitly, and `HANDLES` has four corners and no
  rotation handle), so a straighten slider is not a framing change — it is a new
  transform in the layer model and a resampling pass in `render.js`.

- **`framedProject` allocates one shallow layer copy per layer per call.** At 20
  layers that is 20 small objects per rendered frame, against a composite that
  costs milliseconds — but it is not free, and it is why the render-time caches
  (`rendered`, `renderedKey`, `lut`, `lutKey`) are accessor windows onto the real
  layer rather than copied values. Remove those windows and every frame
  re-rasterises every text layer into an object it throws away.

## Noticed while closing the Phase 4 and Phase 5 gaps (2026-09-01)

- **A self-supplied layer breaks `stream.js`'s peak-memory statement.** The
  header promises `file bytes + one full-resolution layer + output buffer`,
  which holds because exactly one streamed layer is resident at a time. An
  inserted sticker's full-resolution buffer lives on `layer.pixels` for the
  whole session, so a document with N of them costs N extra full-resolution
  buffers through the export peak — and nothing bounds N. Harmless for one
  sticker on a phone photo, not harmless for a collage. Either the header
  should say so or `insertImageLayer` should take a `maxFraction`, which is
  already backlogged above for a different reason.

- **`src/index.js` re-exports neither `src/creative/**` nor `src/frame/**`, and
  not `drawsOwnPixels`.** `test/creative.mjs`, `test/frame.mjs` and parts of
  `test/export.mjs` import the modules directly to stay green while the barrel
  file moves. That is a deliberate test decision, but it means the barrel is now
  an incomplete description of the engine, and an app importing only from it
  cannot add a sticker or crop a document.

- **`hitTest`'s coordinate space changed and no caller was updated.** It now
  takes CANVAS coordinates. Every current caller passes the output of
  `viewToDoc`, which is canvas space, and every current project is uncropped, so
  nothing moves — but `app/`'s editor page was not read as part of this change
  and a caller that computes a document point by hand would now be off by the
  crop offset.

- **`applyProjectJson` normalises a frame saved against a differently-sized
  document instead of refusing it.** It already refuses a layer-count mismatch
  by name; a frame from a 4000px document applied to a 1000px one is the same
  class of "this is not the same PSD" and gets silently clamped instead.

- **No disclosure that layers fall outside the frame.** `framingReport` builds
  the sentence and nothing calls it. `createProject` collects warnings for
  flattened groups, unapplied clipping and vector masks; a crop that hides three
  layers says nothing until some UI asks.

## Noticed while fixing the text-distortion bug (2026-09-01)

The bug itself is fixed (`rasteriseTextAt` scales by one factor; `retypeText`
re-fits a PSD text layer's box to our own measurement on the first edit). What
it exposed and this change did not touch:

- ~~**`measureText`'s height is a convention, not a font metric.**~~ FIXED
  2026-09-01. It composes `actualBoundingBox{Left,Right,Ascent,Descent}` into
  an ink extent, the same quantity Photoshop stores; the fixture layer's height
  is 21 on both sides of the first edit and its top no longer moves. Both stubs
  now model bounding-box metrics.

- **The PSD's typeface is still never read.** `toLayer` hardcodes
  `fontFamily: FONT_STACKS[0]`, `bold: false`, `italic: false` for every text
  layer, so a correctly-sized box still redraws in the wrong face. Disclosed in
  the text sheet; nothing fixes it. It also means our measured width is the
  width of OUR font, so the re-fitted box is right for what we draw and not for
  what the file contained.

- **PSD leading is ignored.** Line height is now the FONT's own advance
  (`fontBoundingBoxAscent + Descent`), falling back to 1.2em. Better than the
  old flat 1.25, but still not the file's: `paragraphStyle.autoLeading` and
  `style.leading` are read by ag-psd and dropped by `toLayer`, so a PSD with
  explicit leading re-flows at the font's spacing instead of the document's.
  `fixtures/text.src.psd` is single-line, so no test in the suite would catch
  it.

- **The text layer's transform matrix is not applied to `fontSize`.** `toLayer`
  reads `style.fontSize` raw. PSD text can carry a scale in its transform, so a
  scaled text layer re-renders at the wrong size however good the box maths is.

- **A text box is a scale target, not a text frame — there is no wrapping.** A
  box dragged narrower than the string scales the whole line down uniformly
  instead of wrapping it. Nothing in the UI says so.

- **`arbitrate` hit-tests handles against the layer's CURRENT box while a scale
  drag now starts from `liveTextRect`.** On the very first drag of a PSD text
  layer the grabbed corner and the anchor corner differ by the re-fit. One-time
  and small next to the re-fit itself, but it is a real discontinuity.

- **No browser-level pixel test for text exists anywhere in the suite.** Both
  stubs return transparent `getImageData`, so no assertion in this repo has ever
  looked at a glyph. Every claim about text APPEARANCE, before and after this
  change, rests on transform arithmetic alone.

## Noticed while fixing the CR line break and the ink-extent metrics (2026-09-01)

Both bugs are fixed: `measureText` splits on `/\r\n|\r|\n/` and every door
into the model normalises to LF; the box it returns is the glyphs' ink extent
rather than an invented line box. What that surfaced and did not fix:

- **The file's own baseline is read and thrown away.** `text.transform[5]` is
  the first baseline in document coordinates — 66 in `fixtures/text.src.psd`,
  exactly `bounds.bottom` — and `transform[4]` is the pen x, exactly
  `bounds.left`. `toLayer` keeps neither. Anchoring our re-render on the file's
  baseline instead of centring our box on the file's box would make the
  switch to live rendering exact in POSITION even where the substituted
  typeface's ink height differs, which is the one case `anchorBox`'s
  `recentre` still exists to paper over.

- **The typeface substitution is now the ONLY remaining first-edit jump, and it
  is horizontal.** With both boxes measuring ink, height and top hold across
  the first edit; the width still moves (60 in the file against ~77 from Arial
  for "TEST" at 30px) purely because `toLayer` hardcodes `FONT_STACKS[0]`. The
  fixture cannot even tell us better — its `style.font.name` is
  `AdobeInvisFont`, a placeholder — but a real document usually can.

- **Line advance is now platform-dependent.** `fontBoundingBoxAscent/Descent`
  differs between engines for the same font, so a multi-line layer's box, and
  the boxes stored in a saved project file, depend on which browser measured
  them. Nothing detects or discloses that. The old 1.25 was wrong everywhere
  but at least wrong identically.

- **A leading blank line contributes no ascent.** `"\nAB"` puts its first
  baseline at the very top of the box, because an empty line inks
  nothing.
  Geometrically right, and arguably not what someone pressing Enter first
  expects.

- **`text-sheet.ts` still splits on `'\n'` by hand** for its "N line(s)"
  readout. Correct today only because the model is normalised at every door; it
  is a second splitter that can drift from `splitTextLines`.

- **Still no browser-level pixel test for text.** The stubs now model
  bounding-box metrics, which is a stronger assumption than the flat width they
  modelled before, and nothing in this repo verifies any of it against a real
  text engine. Every number in this change rests on that model.

## Noticed while fixing the ignored text transform and the discarded typeface (2026-09-01)

Both bugs are fixed: `toLayer` bakes the transform's vertical scale into
`fontSize` and reads `style.font.name` into `text.sourceFont`, picking the
nearest stack it can draw and disclosing the substitution. What that surfaced
and did not fix:

- **The spike this work started from was wrong on three of four files, and the
  regex is still in `spike/font-probe.mjs`.** Read structurally (see
  `src/engine-data.js`), `werps.src.psd` has `/EngineDict` bytes and NO live
  text layer — no TySh block on any of its seven layer records — and
  `text.src.psd` / `text-box.src.psd` name no font in their style runs at all;
  the "MyriadPro-Regular" the spike reported came from ResourceDict's
  document-level StyleSheetSet, 8000 characters past the layer's own runs.
  Exactly ONE layer in the corpus names a real typeface. The probe is left in
  place as a spike, but anyone re-running it will get the same wrong answers.

- **`bold` and `italic` are still hardcoded false for every layer read from a
  file.** ag-psd exposes `style.fauxBold` and `style.fauxItalic`, which are
  precisely what our two flags mean, and a name like `AachenBTBold` carries the
  weight as well. A bold PSD headline still arrives regular.

- **Per-character style runs are read and discarded.** `text-box.src.psd`
  carries two runs, one character then four (`test/text-engine.mjs` asserts it),
  and ag-psd surfaces them as `text.styleRuns`. The model holds ONE style per
  layer. Nothing in this change makes per-run styling harder to add later, but
  nothing warns a user that a mixed-style layer will be flattened to its first
  run's style either.

- **Rotation and non-uniform scale are disclosed, not drawn.** A rotated text
  layer renders upright and a stretched one renders undistorted; both raise a
  project warning. No fixture in the corpus exercises either, so both paths are
  tested only against synthetic layers built in `test/edit.mjs`.

- **The transform's translation is still thrown away**, as the previous entry
  already noted — `transform[4]`/`[5]` are the pen and first baseline. The scale
  now being read makes that omission more conspicuous, not less: we read four
  of the six numbers in the matrix.

- **`effectiveFontSize` is rounded to an integer at ingest**, following the
  model's existing convention. "outer glow" computes 16.601 and stores 17, a
  2.4% error that then compounds with the box re-fit on the first edit.
  `sourceFontSize` and `sourceScale` keep the exact pair, so nothing is lost —
  but nothing uses them to render either.

- **`src/engine-data.js`'s raw parser is used only by the test suite.** It is
  the oracle that proves ag-psd's font resolution against the file's own bytes,
  and deliberately not on the read path, where it would be a second decode of
  something already in hand. If it ever drifts from ag-psd, the test says so —
  which is the whole point — but no production path benefits from it.

---

## User-supplied fonts (2026-09-01, `src/fonts.js` + `app/.../fonts.service.ts`)

Noticed while building font loading, deliberately not fixed.

- **Weight and slant are matched by NAME, never by the file's own tables.** A
  file called `MyFont.ttf` that is actually the bold cut registers as regular
  and is reported as a style MATCH, which is a confident wrong answer of exactly
  the kind the rest of the module refuses. The `OS/2` table has `usWeightClass`
  and `fsSelection` and would settle it from the bytes. Reading it needs a font
  parser this app deliberately does not have; `FontFace.weight`/`.style`
  descriptors are also left unset, so every loaded face is registered at 400
  normal.

- **`bold` / `italic` on a layer still synthesise over the real face.** They are
  hardcoded false at ingest (a pre-existing entry above), and `fontSpec` emits
  `bold 17px "AachenBT-Bold", …`. Toggling **B** on a layer already drawing the
  bold FILE asks the browser for faux bold on top of a bold face. Selecting the
  bold file from a loaded family instead would need per-family face grouping,
  which the registry has the data for (`stem` + `styleKey`) and does not do.

- **Nothing survives a reload.** The registry dies with the tab — deliberate, so
  nobody's licensed fonts are persisted — but `toProjectJson` writes
  `fontFamily: '"AachenBT-Bold", Arial, …'` into the saved project. Reopening
  restores a family the font set no longer has, canvas falls through to the
  substitute, and NOTHING says so: the sheet reads "the file asks for
  AachenBTBold" while the stored family still names a file. A load-time check
  comparing saved families against the registry would catch it.

- **A font load re-draws layers one undo step each.** `setLayer` only coalesces
  commands targeting the same layer, so loading one font for six layers is six
  history entries. Stated in the UI rather than hidden, and `✕ Discard changes`
  backs the whole session out at once, but it is still six taps of Undo for
  anyone who closes the sheet with `✓` first.

- **Applying overwrites a hand-picked stack.** If a user chose Georgia on a
  layer and then loads the file the document actually asks for, the load wins.
  Defensible — they just picked the file — but their choice is gone with no
  mention beyond the layer count in the note.

- **`.dfont`, `.ttc` and bare `.pfb` are refused.** `FontFace` cannot parse a
  collection or a PostScript Type 1 binary, and a Mac user's licensed fonts are
  often exactly those. They are refused by extension with a message naming the
  four formats, which is honest and still a dead end for that user.

- **The style-word list is six words.** `SemiBold`, `Medium`, `Thin`,
  `Condensed`, `Oblique` and the rest are NOT split off, so `Roboto-Medium.ttf`
  has stem `robotomedium` and does not answer `Roboto-Regular`. Deliberate —
  every added word is a chance to eat a family word — but it means a real family
  can fail to match on a weight nobody thought to list.

---

## Noticed while giving a text box its two operations (2026-09-01)

Resolves the earlier entry **"A text box is a scale target, not a text frame —
there is no wrapping."** It is now a text frame: `shapeType`/`boxWidth` reach the
model, `render.js` wraps a paragraph to the author's width, and a corner drag
re-flows it instead of scaling it. Point text still does not wrap, which is
correct — it has no box, so there is nothing to wrap to.

- **`boxBounds`' HEIGHT is read and thrown away.** `text-box.src.psd` carries
  `[0, 0, 128.99352, 49]` and only the width survives into the model. Photoshop
  CLIPS a paragraph that overflows its box and badges the overflow; we grow the
  layer downwards instead, so a file whose text already overflows renders text
  Photoshop was hiding. Nothing in the UI says so. Deliberate — a box that clips
  needs an overflow affordance to be usable at all, and there is none — but it
  is a real divergence from the file.

- **Only `left`/`center`/`right` justification survives.** `toLayer` maps
  `paragraphStyle.justification` through three values; a PSD can also say
  `justifyLeft`, `justifyCenter`, `justifyRight` and `justifyAll`, all of which
  land silently on `left`. Full justification is exactly the setting whose
  absence is most visible in a wrapped paragraph, because every line's right
  edge moves.

- **`firstLineIndent`, `startIndent`, `endIndent`, `spaceBefore` and
  `spaceAfter` are all ignored.** They are read from the file into
  `paragraphStyle` and never reach `layer.text`. Each one moves where the lines
  break or where they sit, so a paragraph with any of them set is wrapped to the
  wrong width or spaced wrongly, with no disclosure.

- **The every-line composer is not detected.** `wrapParagraph` is greedy, which
  is Photoshop's SINGLE-line composer.  `paragraphStyle.everyLineComposer` is
  `false` in both fixtures, so the corpus cannot tell the difference — a file
  that asks for the every-line composer gets greedy breaks and no warning.

- **Created text is always point text, and there is no way to convert.** A layer
  typed into the sheet gets `shapeType: 'point'`, so it can never wrap and its
  handle drag can only scale. Photoshop offers point ↔ paragraph conversion;
  this has no control for it, and no way to draw a box in the first place.

- **A refused reflow on the canvas is dropped silently.** `ProjectService.
  resizeTextBox` returns the engine's message and `canvas-stage.ts` discards it,
  because the canvas has no error surface. In practice the only refusal reachable
  from a drag is "no measurer", which cannot happen on the main thread — but the
  same is true of every other silent path that later turned out to have a second
  cause.

- **The two shapes have identical handles.** Whether a corner drag will reflow
  or scale is discoverable only from the text sheet's copy. A different handle
  shape for a text frame — or edge handles for width and corner handles for
  scale, which is what Figma and InDesign do — would say it on the canvas, and
  needs `HANDLES`/`arbitrate` in `src/gesture.js` to grow beyond four corners.

- **"A different type size in the SAME column" exists in the engine and in no
  UI.** `retypeText(id, { fontSize, boxWidth })` does it in one command and is
  tested; the Size slider always scales the box, so reaching it from the app
  takes two gestures (drag Size, then drag the box back).

- **Wrapping costs one `ctx.measureText` per token, per measurement.** Kerning
  crosses the space between two words, so a cached per-word width is an
  approximation and this is not. A 60-word paragraph is ~120 measurements per
  `measureText()` call — once per keystroke and once per `textPixelsAt` cache
  miss, NOT once per frame. It has not been measured on a phone.

- **No browser-level pixel test covers a wrapped paragraph either.** The Node
  stub advances a flat 10px per character at every size, where a real face
  advances proportionally to the em. So the "scale preserves the wrap" claim is
  asserted on the ratio the breaks are derived from and never on the breaks
  themselves; only a browser can close that gap.

## Background removal (2026-09-01, `src/segment/**` + `app/.../segment.service.ts`)

Built fast and without tests at the user's explicit direction. That decision is
the source of most of this list, and it is recorded rather than implied.

- **NOTHING HERE HAS BEEN EXECUTED IN A BROWSER.** The pure engine
  (`resampleLogits` -> `guidedRefine` -> `decontaminate` -> `applyCutout`) was
  smoke-run in Node against a synthetic 64x64 layer and behaves; every claim
  about the WORKER, the model download, WebGPU selection, the Angular wiring and
  the panel's layout rests on reading alone. No suite covers `src/segment/**`.

- **The canvas does not yet consume `cutMode`.** `app-cutout-panel` emits
  `modeChange` and `editor.page.ts` stores it in a signal, but `canvas-stage.ts`
  was not touched -- so the brush and tap-to-correct have a full UI, a working
  engine path (`paintMask`, `pointAt`) and NO pointer events feeding them. The
  automatic cut works end to end; the two manual modes are wired at both ends
  and disconnected in the middle. This is the single largest gap.

- **The BiRefNet input and output tensor names are guessed.** The worker probes
  `model.sessions.model.inputNames` for something containing `image` or `pixel`,
  falls back to `pixel_values`, and takes the first output tensor by position.
  That is defensive rather than correct -- the real names are one execution away
  and were not available without running it.

- **Generated masks cost ~1.4 MB of JSON per cut layer.** `maskJson` base64s the
  raw coverage plane: one byte per proxy pixel, x1.37 for the encoding. PNG-
  packing the plane through `src/export/png.js` would cut that by roughly an
  order of magnitude and was skipped for time.

- **A saved cut is silently dropped when the proxy edge changes.**
  `applyProjectJson` restores a generated mask only when its dimensions match
  the layer's current pixel buffer -- correct, because render.js indexes the
  plane with no bounds check -- but the user is told nothing when it refuses.
  Reopening a project on a device with a different budget can lose the cut with
  no message.

- **Export upscales the proxy mask, and only warns above 2x.**
  `exportSoftnessNote` discloses it; nothing fixes it. Guided upsampling against
  the full-resolution layer's own edges is a strict improvement over plain
  resampling at no model cost, and is the obvious follow-up.

- **`selfSupplied` is not set on a decontaminated layer.** `applyCutout` writes
  new `pixels` when decontamination ran, but does not stamp the flag that tells
  `src/export/order.js` a layer carries its own full-resolution buffer. Those
  pixels are PROXY resolution, so the flag would be a lie -- but it means the
  export re-reads the original layer from the PSD and the exported edges keep
  the background spill the editor removed. Preview and export therefore disagree
  on colour as well as sharpness.

- **Subject presets are three entries in a registry, not three tested paths.**
  Only the general model was reasoned through. `BiRefNet-portrait-ONNX` and
  `BiRefNet_512x512-ONNX` are assumed to share the general model's input and
  output shape; if either differs the probe above will pick the wrong tensor.

- **No cancellation.** Same gap the export path already has: a cut that takes 20
  seconds on the WASM fallback cannot be stopped, and backgrounding the app
  mid-inference has no defined behaviour.

- **`@huggingface/transformers` was added to `app/package.json` and never
  installed.** No `npm install` was run, so the dependency is declared and
  absent. It is also not in `allowedCommonJsDependencies`, which currently lists
  only `ag-psd` -- whether the worker bundle needs it there is unknown.

---

## Zip handovers (`src/bundle.js`, `app/src/app/services/bundle.service.ts`, 2026-09-01)

Noticed while building the PSD-plus-fonts zip import; deliberately not fixed.

- **The manifest pass runs on the main thread, and walks every central-directory
  record.** `BundleService.readManifest` uses `unzipSync` with a filter that
  inflates nothing, and stops COLLECTING at `BUNDLE_ENTRY_CAP + 1` — but fflate's
  loop still parses every record in the directory. An adversarial archive
  declaring a million entries does a million header reads before the entry cap
  can refuse it. The per-record work is microseconds, so this is a jank risk
  rather than a hang, and the fix is fflate's streaming `Unzip` (which can be
  abandoned mid-directory) or moving the whole read into a worker.

- **The whole archive is materialised on the main thread.** `file.arrayBuffer()`
  brings the entire zip into the heap before anything is classified, so a 200 MB
  handover is 200 MB resident on the main thread while the document is unpacked
  beside it. The decode itself is already in a worker; the unzip is not. Peak
  today is `zip + PSD + one File-sized copy of the PSD`.

- **Reading a zip cannot be cancelled.** Same gap the export and cut-out paths
  have. A big archive shows "Reading…" with no way out but closing the tab.

- **Entries that are neither a PSD nor a font are ignored in silence.**
  `classifyBundle` returns them as `ignored` with `why: 'unsupported'`, and only
  the `unsafe-path` ones are ever mentioned to the user. A designer who zips
  `.ttc` or `.dfont` fonts — common on macOS, and unloadable by `FontFace` — is
  told nothing about why their typefaces did not arrive. The data is already
  there; only the sentence is missing.

- **A zip can only ever REPLACE the open document.** There is no "add the fonts
  from this zip to what is already open". A user whose PSD is open and whose
  fonts are in an archive has to unzip by hand — which is the exact chore this
  feature exists to remove.

- **The Fonts sheet does not distinguish a face that came from a zip from one
  picked by hand.** Both read as "Drawing". After two handovers and a manual
  pick, the user cannot tell which file a family came from without reading the
  file name and remembering.

- **The "which document?" chooser is an unfiltered list.** Fine for the two or
  three PSDs a real handover has; an archive of twenty would need search or
  grouping. Sizes are shown, dimensions are not — and dimensions are what
  actually distinguishes a print file from a web export.

- **There are now two refusal screens.** `svc.state() === 'refused'` (the memory
  guard) and `bundle.status() === 'refused'` render similar-looking but separate
  markup with different escape hatches. They should converge before a third one
  appears.

## Noticed while building the image overlay (2026-09-01)

Deliberately not fixed. The feature that shipped is `kind: 'image'` with
`stretch` and `cover`, capped at `OVERLAY_IMAGE_EDGE` and carried into the
export worker inside `layer.adjust`.

- **`tile` is not implemented, and the reason is a real constraint rather than
  time.** A grain tile locked to SOURCE pixels is the one fit rule that is not
  scale-invariant — its frequency would double between the proxy and the export,
  which is precisely the class of bug `overlaySourceWindow` exists to make
  impossible. A tile expressed as "repeat N times across the rect" IS
  scale-invariant, but it needs a repeat count in the model, a control for it,
  and a texture stored well above the 1024 cap to be worth having: grain
  resampled up from a 1024-edge proxy is mush. That is a different storage
  decision, not a third `case` in the sampler.

- **The bilinear sampler aliases under heavy minification.** `applyOverlay`
  samples bilinearly (matching `resample`, so the overlay is filtered like the
  layer under it) and the anti-alias budget is spent once, on import. A texture
  at 1024 drawn into a 200 px layer rect at proxy scale is a 5x reduction that
  four neighbours cannot band-limit. Smooth light leaks are unaffected; a
  high-frequency texture will sparkle, and it will sparkle DIFFERENTLY at proxy
  and at export. The honest fix is a per-destination-pixel box average, which is
  scale-dependent by construction and therefore needs its own argument about why
  proxy and export may legitimately differ.

- **The app does not deduplicate textures across layers.** `normaliseOverlay`
  keeps the caller's array rather than copying, and structured clone preserves
  shared references — so ONE object applied to twelve layers is one buffer,
  end to end. But the sheet decodes on every pick, so picking the same file for
  twelve layers is twelve decodes and twelve 4 MB buffers. A cache keyed on
  `name + size + lastModified` in a service would collapse them; it was left out
  because it is a Map that outlives every project in the tab.

- **The undo stack retains every texture it has ever held.** `setLayer` captures
  the previous `adjust` object in the command's `from`, and `project.history` is
  unbounded — no cap anywhere in `src/edit.js`. So replacing a layer's overlay
  picture five times leaves five 4 MB textures resident until the history is
  discarded. Real on a phone, invisible everywhere, and it is a property of the
  history rather than of this feature — but this is the first field big enough
  for it to matter.

- **Switching an image overlay back to `linear` keeps the pixels.** Deliberate:
  toggling kinds should not make the user find the file again. The cost is up to
  4 MB held by an overlay that is not using it, until Remove.

- **A reopened project asks for the picture once per layer.** The save stores
  `source` (the file name) and drops the pixels, and `overlayNeedsImage` makes
  the sheet say so — but there is no "re-link this file everywhere it is named"
  action, so a texture used on twelve layers is twelve trips through the OS
  picker. The font loader already solved the same shape of problem with
  `applyLoaded()`; an overlay equivalent has nowhere to live yet because there
  is no overlay service.

- **The sheet shows no thumbnail of the picked texture.** The file name, its
  dimensions and its megabytes are shown; the picture itself is not, so a user
  with `leak-01.png` through `leak-08.png` cannot tell them apart without
  applying each. The pixels are right there in the model, so this is a
  `<canvas>` and a `putImageData`, not a decode.

- **The overlay still pins its layer to the JS tier, and the image kind makes
  the deferral worse.** `OPS.overlay.gpuDeferred` already records the 26x26
  program-matrix problem; a texture adds a second per-layer sampler and its own
  upload on top. Nothing regresses today because `selectTier` returns TIER_JS
  for everything, but 1B-2 now has more to resolve than it did.

## Select tool — noticed, not done

Found while building the Select mode (`selectMode` in `arbitrate`, the header
toggle, the non-modal sheet). None of these are regressions; all are gaps the
mode makes visible.

- **`hitTest` ignores `layer.mask`, so a cut-out layer is still pickable in the
  area it no longer draws.** `src/edit.js` thresholds `layer.rendered ||
  layer.pixels` alpha and never consults the coverage plane. Before the cut-out
  tool this was academic; now a layer can be 90% erased and still swallow every
  tap over its old bounding box — including the taps meant for the layer that
  is now visible underneath it. Select mode's cycle is the workaround, not a
  fix: the user has to tap twice to reach a layer that is the only thing
  actually drawn at that point.

- **The cycle is blind.** Repeated taps walk down the stack, but nothing says
  how deep the pile is, which rung the current pick is on, or that the next tap
  will wrap back to the top. Photoshop and Figma both offer a LIST of what is
  under the pointer as well as a cycle. The layers sheet has the list; there is
  no route from a canvas point to it.

- **A sheet open in select mode leaves ~40% of the screen as canvas.** The
  sheet is capped at 40vh instead of 72vh so the canvas is reachable, which
  gives the sheet body about 265 CSS px on a 844px phone. The Layers and Fonts
  sheets are lists and simply scroll in less room; the slider sheets fit. No
  sheet was re-laid-out for the shorter height.

- **Select mode hides the scale handles but still draws the selection box.**
  Correct — the box is the identity readout the mode exists to move — but there
  is no in-canvas statement that a corner drag will now pick instead of scale.
  The only explanation is the lit header button and the pill.

- **`hitTestBelow` reaches the layers below by handing the engine a shallow
  project with a shorter `layers` array.** One object and one array of
  references per TAP, and the engine's own hit rule applied unchanged. Cheap
  and correct, but it is a trick: an engine-side `hitStack(project, x, y)`
  would be the honest primitive, and would also make the cycle testable in
  `test/` rather than only through the component.

## Clipping masks — landed, with two gaps left open

Clipping is implemented in the preview (`2e61d43`, `b608f86`, `ae95239`) and in
full-resolution export (`0d74b09`, `649b9fd`, `79daed1`). What follows is what
was NOT closed.

- **No fixture exercises clipping.** Verified by walking every layer of all 21
  documents: **80 nodes, zero with `clipping === true`.** Every assertion behind
  both changes therefore runs against hand-shaped documents, and the real-file
  corpus cannot catch a regression here. An earlier backlog note implying real
  files were rendering wrong was never evidenced. Getting one genuine clipped
  PSD into `fixtures/` is the single highest-value follow-up — it would convert
  ~29 hand-built assertions into corpus-backed ones.

- **A GPU export target must assemble clip runs itself, and nothing enforces
  it.** `exportFullRes` hands a whole run to the target and closes it with
  `flush()`; `createJsExportTarget` composites the run through the preview's own
  `drawClipRunInto`. A future GPU target that ignores the run boundary would
  silently reproduce the exact bug just fixed. The browser makes this nearly
  free — `globalCompositeOperation = 'source-atop'` is the native equivalent —
  but the contract is currently a convention, not an assertion. Pin it the way
  `planSpill` and the export walk are pinned to each other.

- **Export peak grew, deliberately and only for clipped documents:**
  `fileBytes + max(largestLayerBytes, clipRunBytes) + proxyTotalBytes +
  clipScratchBytes`. The scratch is `w·h·5` = **83.0 MiB on a 4961×3508
  poster**, one lazily grown pair per export. Both new terms are 0 on an
  unclipped document, asserted by `allocations === 0`, so all 21 fixtures cost
  what they cost before, to the byte.

## After the GPU / relay / segment session

### Correction to the record

`ea0d66d "Add the Android platform so this can run on a phone"` also contains
`server/relay.js`, which its message does not mention. A relay change was staged
by a concurrent agent between the moment the staged list was read and the moment
the commit ran; the content is correct and belongs to `ce0386f`'s line of work,
but the message does not account for it. History was not rewritten because
another session was live on the branch. Reading `--staged` once and committing
later is not the same as reading it immediately before committing, which is the
rule this broke.

### The GPU tier is planned, not rendered

`src/gpu/plan.js` decides a frame and is fully checked in Node — 77 assertions.
Nothing draws. Still missing, none of it verifiable without a browser: context
and program creation cached by `programNameFor`, texture upload, the ping-pong
FBO pair, the group FBO plus its R8 clip-alpha plane, LUT/HSL uniform binding,
the `clip-alpha` reduction pass, presentation, and conformance Table D on real
hardware. **`GPU_BUDGET_BYTES` (256 MB) is a policy, not a measurement** — there
is no `navigator.gpuMemory`; refusing early costs a slow JS frame, refusing late
costs a lost context.

### The relay is loopback-only

32 assertions green against a real server on a real port. Backpressure is proven
rather than asserted: 100 MB pushed at a stalled peer read 4 frames and froze
for 3 s, peak buffered 0.5 MB against a 1.1 MB bound, RSS +3.5 MB. Before
shipping it needs TLS (`wss://` per the spec), an origin check, a rate-limit key
that survives a proxy (`remoteAddress` collapses behind one, and the pairing code
is the entire security model), and a heartbeat.

### The vector rasteriser is not a fidelity fix

Recorded because it was nearly built on a false premise. All 21 fixtures were
scanned: **14 vector-bearing layers, every one already rasterised by Photoshop**,
and `shapes.src.psd`/`gradient.src.psd` composite at 0.00% real diff, maxDelta 0.
There is no fixture where a rasteriser changes an output pixel, and substituting
ours for Photoshop's could only make 12/5/4 worse. A rasteriser is still wanted
for crisp zoom, editable shapes and upscaled export — a different feature with
different success criteria, and it needs a fixture saved with *Maximize
Compatibility* off before any of it can be measured. Note also that no fixture
has a linear gradient; `gradient.src.psd` is radial-only.

### Half of src/segment/ is still untested

`mask-ops.js` and `refine.js` are pinned by 87 assertions. `cutout.js`,
`models.js`, `edge.js` and both `index.js` barrels are not, and were deliberately
left alone because a concurrent session had them mid-edit. `resampleLogits`
lives in `cutout.js`, so it is untested despite being in scope by name.
