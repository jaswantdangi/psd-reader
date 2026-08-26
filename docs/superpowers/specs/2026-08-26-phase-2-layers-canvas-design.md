# Phase 2 — Layers Panel and Canvas Interaction

**Date**: 2026-08-26
**Status**: Design, implementation plan not yet written
**Phase**: 2 of 6 (see *Programme context*)
**Parent spec**: [`2026-08-25-phase-1-engine-gpu-memory-design.md`](./2026-08-25-phase-1-engine-gpu-memory-design.md)
**Depends on**: [`2026-08-26-phase-1b-gpu-compositor-design.md`](./2026-08-26-phase-1b-gpu-compositor-design.md) (tiering, sandwich cache), [`2026-08-26-phase-1c-streaming-export-design.md`](./2026-08-26-phase-1c-streaming-export-design.md) (`sourceIndex`, source URI)

---

## Programme context

| # | Phase | State |
|---|---|---|
| 0 | Design system + the five real screens | deferred, shrunk |
| 1 | Engine rework, GPU compositor, memory pipeline | 1A complete; 1B and 1C specified, not implemented |
| **2** | **Layers panel + canvas interaction** | **this document** |
| 3 | Raster tools (filter/adjust/HSL/overlay) as per-layer properties | not started |
| 4 | Creative tools (text, stickers) | not started |
| 5 | Framing + output (crop, ratio, export, share) | not started |

Phase 1 produced an engine and a deliberately ugly `/harness` route: pick a
file, see one composited image, no way to touch it. Phase 2 is the first screen
a user could be shown. It replaces `app/src/app/harness/harness.page.ts`.

The UI language is taken from
[ProHussain/PixelPerfect-PhotoEditor](https://github.com/ProHussain/PixelPerfect-PhotoEditor):
`activity_photo_editor.xml` is a top bar (`image_view_exit`, `imageViewUndo`,
`imageViewRedo`, `imageViewSaveFinal`), a centre `photo_editor_view`, a bottom
`recycler_view_tools` rail, and one sheet per tool, each carrying its own
`close / TITLE / confirm` header (`image_view_close_filter`, `textViewTitle`,
`image_view_save_filter`, and siblings). Rail items are 80dp, sheets 180dp,
controls 50dp.

**PixelPerfect edits one flat bitmap and has no layers panel.** Everything in
this document about that screen is designed here, not copied.

---

## Why this phase exists

Phase 1's definition of done is *"open a real PSD, see it composited, drag a
layer, export a PNG"*. Phase 2 is what makes "a layer" a thing the user can
name, find, select and change. Without it, `src/edit.js`'s entire command
surface — `setLayer`, `reorderLayer`, `undo`, `redo`, `hitTest`, 26 blend
modes, per-layer opacity and visibility — is reachable only from a demo page
that ships to nobody.

It is also the screen where the engine's biggest correctness gap becomes
visible rather than merely wrong, which is what forces the ruling below.

### Found by reading, during this design

Seven things about the current code shape this design. All are stated so the
plan does not assume otherwise.

1. **`decodeLayerPixels` already decodes layer masks, and `reader.js` never
   releases them.** `node_modules/ag-psd/dist/psdReader.js:617` runs
   `getDataFromLayer(layer, LayerDataType.Mask, …)` and assigns
   `layer.mask.imageData` unconditionally, on the same call `src/reader.js:126`
   makes. The release that follows nulls `layer.imageData`, `layer.canvas` and
   `layer.rawData` — **not** `layer.mask.imageData`. So every full-resolution
   mask raster in the document is retained, RGBA, for the lifetime of the
   session, and nothing reads it.

   This inverts the cost argument for masks: **the editor is already paying
   full price for mask rasters and getting nothing.** Supporting them makes
   memory strictly *better*, because the proxy-mask step gives the reader
   somewhere to release the full-resolution one.

   It also means **Phase 1's measured peak formula is unvalidated for masked
   documents.** `peak ≈ file size + one full-res layer + Σ(proxy layers)` held
   to 1% on two synthetic documents written by ag-psd's writer, which carry no
   masks. A 12-layer 2000×1500 document where every layer is masked retains up
   to ~144 MB nobody budgeted for. The size guard is calibrated on that formula.

2. **`toLayer()` carries neither `mask` nor `clipping`, and `renderProject`
   passes neither `rect.mask` nor `clipAlpha`.** `blendInto` accepts both
   (`src/composite.js:124`, `:141`, `:142`) and `renderList` supplies both. The
   editor render path has therefore been wrong on masked and clipped files
   since it existed, in preview and in export. This is `docs/BACKLOG.md`'s
   highest-priority entry and the input this spec exists to answer.

3. **`applyCommand` bumps no revision counter, and it is the only place that
   can.** `commit()` looks like the funnel, but `setLayer`'s coalescing branch
   returns before reaching it (`src/edit.js:223–229`), and `undo`/`redo` call
   `applyCommand` directly. Anything that needs to know "the project changed" —
   Angular signals, 1B's sandwich-cache invalidation, thumbnail caches — must
   hang off `applyCommand`, not `commit`. Putting it in `commit` would miss
   every coalesced drag frame and every undo.

4. **The coalesce key is not gesture-scoped.** `setLayer` merges when
   `previous.coalesceKey === coalesceKey && previous.id === id`. A literal key
   like `'move'` would merge two *separate* drags of the same layer, minutes
   apart, into one undo entry. The key must carry a per-gesture nonce.

5. **`reorderLayer` cannot coalesce at all.** It routes straight to `commit()`,
   which has no merge branch. A reorder applied live while a finger crosses
   five rows would push five undo entries.

6. **`rerendered` has two owners with two policies.** `src/edit.js:171` sets it
   only for the `text` key; `demo/editor.js:331` sets it for `w`/`h`. And
   `src/render.js:143` branches on it to decide whether a text layer
   re-rasterises or goes through `resample()` — the difference between sharp
   and pixelated scaled text (HANDOFF Failed Approach 5). Phase 2 deletes the
   demo's claim to that decision, so Phase 2 has to settle the policy.

7. **The reader's warnings never reach the project.** `createProject` builds
   `project.warnings` from `flatten()` alone. `doc.warnings` — the `Patt`
   pattern warning and ag-psd's `Unhandled` feature list — is dropped on the
   floor by `src/load.js`. The editor currently cannot tell the user that a
   file uses features it ignores.

---

## Ruling — masks are in, clipping is out and is made visible

The brief is right that shipping a layers panel over a silent wrong-pixels bug
is not acceptable. But "masks and clipping" is one phrase covering two problems
of very different size, and treating them as one unit would either postpone a
cheap fix or drag an expensive one into the wrong phase. So they are ruled on
separately.

### Masks: implemented in Phase 2

**A layer mask is a per-layer alpha multiplier and nothing else.** `blendInto`
already takes it (`if (rect.mask) as *= rect.mask[…] / 255`). It does not
depend on layer order, does not need an intermediate buffer, does not interact
with the sandwich cache, and survives reorder, retype, transform, opacity,
blend-mode change and undo without any of them knowing it exists. In the GPU
compositor it is one extra sampler and one extra multiply on the line that
already computes `as`.

Four reasons it belongs here specifically:

- **It is the gap the layers panel makes visible.** A masked layer is the one
  whose row, thumbnail and canvas would disagree with every other tool the user
  owns.
- **It costs negative memory** (finding 1). The full-resolution mask is already
  decoded and already retained. Downscaling it to a proxy and releasing the
  original is the first time anything frees it.
- **It is bounded.** One new field on the layer, one function moved out of
  `composite.js`, one single-channel resampler, one branch in `renderProject`,
  one uniform in the shader.
- **It restores the inspector/editor agreement** the backlog names: the same
  file renders the same way in `compositeDocument` and `renderProject` — for
  masks at least.

### Clipping: not implemented, carried as data, disclosed in the UI

Clipping is not an extra multiply. `renderList` (`src/composite.js:253–265`)
implements it as a **nested composite**: render the base into its own
full-canvas buffer, build a full-canvas `alphaMap` of the base, blend each
clipped layer into that buffer restricted by the map, then blend the whole
buffer into the backdrop at the base's opacity and mode. Three consequences,
each of which lands squarely on something Phase 2 or Phase 1B has already
committed to:

- **It changes the compositing topology, not a pixel formula.** 1B's GPU
  compositor is specified as a flat ping-pong walk, one full-canvas draw per
  layer. Clipping needs a second FBO pair and an alpha-map texture per clip
  run. That is a change to 1B's architecture, in a phase not yet implemented,
  to support a feature whose interaction model is undecided.
- **It is a relationship between *adjacent* entries in a list this panel exists
  to let the user reorder.** If layer B clips to layer A and the user drags B
  three rows up, the clip is meaningless. Photoshop answers this (the clip
  breaks); we would have to answer it too, and also answer what undo restores,
  what the panel shows mid-drag, and what happens when A is hidden. That is an
  interaction design, not a patch.
- **It breaks the sandwich cache's premise.** 1B's tier-3 cache splits the
  stack at the selection into `below` / `live` / `above`. A clip run straddling
  the selection is not splittable — the clipped layer's alpha depends on a base
  that is now in a different bucket.

Masks are the majority of the wrongness by frequency in real files; clipping is
the minority with the majority of the cost. Doing masks now and clipping later
is the split that buys the most correctness for the least architecture.

**"Later" is not nowhere.** Clipping goes to `docs/BACKLOG.md` as an open
correctness gap with this ruling attached, and it becomes a precondition on any
future phase that wants free reorder *and* Photoshop-faithful rendering of
clipped files.

### What the UI shows instead, so nobody is misled

A caveat in a code comment does not count. Three visible surfaces, none
dismissible for the life of the document:

1. **A per-row chip.** Every layer whose source node had `clipping: true`
   carries a `⛓ clipped` chip in the layers panel, and the chip is a control:
   tapping it opens a one-paragraph explanation — *"In Photoshop this layer is
   clipped to «name of the layer below», so it only shows where that layer is
   opaque. This editor does not apply clipping, so it is drawn in full.
   Reordering will not restore the relationship."* The base layer's name is
   derivable: the nearest layer below with `clipping !== true`.
2. **A document-level warning**, produced by `createProject` alongside the
   existing group warnings and counted in the top bar's warning chip:
   *"N layers are clipped to the layer below. Clipping is not applied — those
   layers are drawn in full and will differ from Photoshop."*
3. **A `Clipped` filter chip** in the panel, so the user can see the whole set
   in one tap rather than scrolling for chips.

The clip chip is deliberately **not a toggle**. There is nothing to toggle: the
renderer has one behaviour, and a control implying otherwise would be worse
than the chip.

---

## Definition of done

> On a phone, open a real PSD, find one layer out of sixty by name, select it,
> see it highlighted on the canvas, move and scale it with one finger, change
> its opacity and blend mode, hide it, drag it to a new z-position, undo the
> lot in the same number of steps a person would count — and a masked layer
> looks the way it looks in Photoshop.

Checked by the user, because build commands are not run here:

- [ ] A masked fixture renders identically through `renderProject` and
      `compositeDocument` (same file, editor vs inspector), on tier 3 **and**
      on tiers 1–2. Both, or masks are not done — see *Risks*.
- [ ] A 60-layer document's panel scrolls smoothly, search narrows it, and
      clearing the search restores the full list with the selection intact.
- [ ] One drag of a layer is **one** undo step. Two separate drags are two.
- [ ] A drag-to-reorder across five rows is one undo step.
- [ ] Pinch-zoom to 4×, pan to a corner, drag a layer 40 doc-px right, undo:
      the layer returns to its exact original `x`, and the view does not move.
- [ ] The top bar's warning chip opens a list containing the group-flattening
      warnings, the clipping warning, and the reader's pattern/unhandled
      warnings.
- [ ] Every state in *States* is reachable and shows its specified copy —
      including filtered-to-zero and the guard refusal.
- [ ] On tier 3, a 20-layer document is still draggable: the debug readout
      names which of Live / Sandwich / Ghost the gesture used, and the layer
      lands where the finger left it.
- [ ] `npm test` green, plus new suites for `src/view.js`, `src/mask.js`,
      `src/gesture.js` and `src/panel.js`.

Explicitly **out of scope**: filters, adjustments, HSL, overlays (Phase 3);
text editing, stickers (Phase 4); crop, ratio, export UI, share (Phase 5); the
design system (Phase 0).

---

## Decisions

| Decision | Rationale |
|---|---|
| **Masks implemented; clipping carried as data but not applied** | Split above. A mask is a per-layer alpha multiply `blendInto` already accepts; clipping is a nested composite that changes 1B's GPU topology and collides with free reorder in this very panel |
| **Masks stored in the layer's own pixel grid, at proxy scale, at exactly `proxyW × proxyH`** | Alignment becomes structural rather than coincidental: mask and pixels are the same grid, so any `scale`, any transform and any future resampler move both identically. There is no second geometry that can drift |
| **The mask is reprojected into layer space at full resolution first, then downscaled** | `mask.left/top` can differ from the layer's bounds and `defaultColor` fills the rest. Resolving that at proxy resolution would quantise a sub-pixel origin offset into several document pixels of misalignment. Order is load-bearing |
| Mask stored as `Uint8Array` (1 byte/px), not RGBA | 60 proxy layers × 1024² × 3 saved bytes is ~189 MB of avoided allocation. Costs one ~30-line single-channel resampler that `resample()` cannot provide |
| `layer.mask.disabled` is honoured and exposed as a toggle | We must read the field to render correctly (Photoshop saves disabled masks). Once read, the toggle is one boolean through the existing `setLayer`, and it is the first control a user reaches for |
| **View transform (pan/zoom) never enters `renderProject`** | The parent spec's non-negotiable: geometry is in document coordinates and `scale` is the proxy mechanism. Zoom is a property of looking, not of the document |
| Pointer→document mapping is a **pure function in `src/view.js`**, Node-tested with a round-trip property | It is the single place a coordinate bug turns every gesture into a wrong *edit*, not just a wrong picture. `getBoundingClientRect` arithmetic scattered through a component is untestable |
| **Two fingers is always the view. One finger inside the selection is the layer. One finger elsewhere is the view** | The only arbitration with no ambiguous case and no mode. Costs a tap-then-drag for a layer's first move; buys a pan that works one-handed, a pinch that never fights a transform, and no accidental document mutation |
| **Four corner scale handles, no rotation handle** | `x/y/w/h` is the whole geometry the model has. A rotate handle needs a field `renderProject`, `resample`, `hitTest`, `toProjectJson` and 1B's `uRect` uniform all have to learn. Absent is honest; disabled is not |
| **Gesture render mode is chosen at pointer-down from the last measured frame, and never changes mid-gesture** | Escalating mid-drag makes the image jump at the worst moment. One decision per gesture, from a real measurement, is both stable and self-tuning |
| **Degradation ladder Live → Sandwich → Ghost, with the active rung shown** | 1B already ships the sandwich and already states its wrongness. Ghost extends the same idea one rung. The rung is visible for the same reason 1B's is: an approximation nobody is told about is a bug |
| **The layers panel is a rail tool opening a bottom sheet with two detents** | Matches PixelPerfect's tool-sheet language. The half detent exists so selection stays legible against the canvas; the full detent exists for triage at 60 layers |
| **The layers sheet has no `confirm`.** Search occupies that slot | Every change is already committed and undoable. A confirm that does nothing teaches the user that confirm means nothing — on every other sheet too |
| **The selected row expands in place** to carry opacity, blend mode, mask toggle and geometry | Keeps the layer's neighbours visible while changing what stacks against them, and avoids a second sheet layer on a phone-height screen |
| **Reorder applies once, on drop** — the drag is a visual-only list preview | `reorderLayer` cannot coalesce (finding 5). One `from → to` command is also what the user thinks they did |
| **Reorder is initiated by a dedicated grip, not long-press** | Long-press adds ~500 ms to every reorder and fights scroll-vs-drag on a long list. A grip costs ~32 px of row width and is unambiguous |
| **`groupPath` recorded during `flatten()`** | Flattening destroys the only structure the file had. The group name is free at that moment, and it is the difference between a panel that cannot describe what was lost and one that can |
| **A revision counter bumped in `applyCommand`, not `commit`** | Finding 3: `commit` is not the funnel. 1B's sandwich cache wants the same counter, so it is one field serving both |
| **`rerendered` gets one owner: `applyCommand`, for `text`, `w` and `h` on text layers** | Finding 6. The demo's policy is the visually correct one (scaled text must re-rasterise, never `resample`); moving it into the engine puts it where Node tests reach it and removes the second writer |
| **No virtualised scrolling** | Row count is bounded by layer count, which is bounded by the memory guard. Virtual scroll plus drag-to-reorder is a known-hostile pairing. The threshold at which this stops holding is stated, not pre-solved |
| **No sort control on the layers list** | The list order *is* the z-order. A sort would either lie about the stack or silently reorder the document. Saying so beats an omission that reads as an oversight |
| **`doc.warnings` merged into `project.warnings` at load** | Finding 7. Otherwise the editor cannot tell the user their file uses patterns, adjustments or effects it ignores |

---

## Architecture

### Where the logic lives

The constraint is unchanged: logic in `src/` where Node tests reach it, Angular
thin. Phase 2 adds four engine modules and, for the first time, engine modules
whose only consumer is the UI. They are still plain ESM and still Node-tested.

| File | New? | Node-testable | Responsibility |
|---|---|---|---|
| `src/mask.js` | new | yes | `projectMask()` (moved out of `composite.js`), `downscaleMask`, `resampleMask` — single-channel, no canvas |
| `src/view.js` | new | yes | `{zoom, panX, panY}` view model. `viewToDoc`, `docToView`, `clampView`, `fitView`, `zoomAbout` — pure |
| `src/panel.js` | new | yes | The panel's derived list: filter + search + duplicate-name disambiguation + badge computation. Pure over a project |
| `src/gesture.js` | new | yes | Gesture arbitration and transform maths: which handle, resulting `x/y/w/h`, minimum-size clamp. Pure over pointer records |
| `src/edit.js` | changed | yes | `mask`, `clipping`, `groupPath`, `revision`, `rerendered` policy, skipped-leaf count |
| `src/render.js` | changed | yes | Apply `layer.mask` |
| `src/composite.js` | changed | yes | `maskFor` exported as `projectMask` so there is one implementation |
| `src/load.js` | changed | yes | Build the proxy mask; release `layer.mask.imageData`; merge `doc.warnings` |

Angular keeps: components, sheet/rail chrome, pointer-event plumbing that calls
`src/gesture.js`, canvas presentation, and `ProjectService` (holds the project,
exposes a `revision` signal, funnels every mutation).

This is the point `docs/BACKLOG.md` flags — *"the moment real logic lands in a
service, that division has stopped holding"*. It is preserved by putting the
arbitration and transform maths in `src/gesture.js` rather than in a directive,
which is the tempting place for it.

### Screen anatomy

```
┌──────────────────────────────────────────┐
│ ←   ⤺  ⤻            ⚠3            ⤓      │  top bar, 56px
├──────────────────────────────────────────┤
│                                          │
│              canvas viewport             │  flex-1
│         (pan / pinch / selection)        │
│                                          │
│   ┌────────────────────┐                 │
│   │ 100%   ▾ Normal    │  floating       │  selection HUD, only when
│   └────────────────────┘  above the rail │  a layer is selected
├──────────────────────────────────────────┤
│  ▤ Layers                                │  tool rail, 80px, h-scroll
└──────────────────────────────────────────┘
```

**The rail carries only tools that work.** Phase 3–5 entries are omitted, not
greyed out: a rail of four disabled icons teaches the user the app is
unfinished, on every screen, forever. The rail is horizontally scrollable from
day one so growing it later changes nothing structural.

Sheets follow PixelPerfect exactly: `close / TITLE / confirm`, ~180px of
content where the content is a slider or horizontal picker, two detents where
it is a list.

**One-handed reach.** The rail, sheet header controls, the sheet's primary list
and the selection HUD are all in the bottom two-thirds. The top bar holds only
back / undo / redo / warnings / export — rare actions, or ones where the reach
is tolerable. Undo and redo are the arguable pair: frequent *and* at the top,
because that is where PixelPerfect puts them and where muscle memory from every
other editor puts them. Recorded as an open question rather than silently
overridden.

### Pan and zoom without corrupting document coordinates

Three coordinate spaces, exactly one conversion between each pair:

```
document px  ──(proxyScale × renderScale)──▶  composite buffer px
composite px ──(view.zoom, view.panX/Y)────▶  CSS px in the viewport
```

- **`renderProject` receives one scale and one only**: `project.proxyScale`
  (optionally multiplied by a gesture-time reduction, below). It never receives
  `view.zoom`. Zoom is applied by the *presentation* of the composite buffer —
  a CSS `transform: translate(px,px) scale(z)` on the canvas element — so the
  document model cannot observe that zoom exists.
- **The view model is explicit**, `{ zoom, panX, panY }`, and is the source of
  truth. `getBoundingClientRect()` is a dev-time cross-check only, never the
  mapping: it silently absorbs layout it should not.
- **`viewToDoc` is pure** and its inverse is tested as a property:
  `docToView(viewToDoc(p, v), v) ≈ p` across a swept range of `p` and `v`. A
  bug here mis-*edits* the document rather than merely mis-drawing it, so it
  gets the strongest verification Node can give.

```js
// src/view.js — illustrative, not the implementation
export const viewToDoc = (view, clientX, clientY, viewport) => ({
  x: (clientX - viewport.left - view.panX) / (view.zoom * view.renderScale),
  y: (clientY - viewport.top  - view.panY) / (view.zoom * view.renderScale),
});
```

`hitTest(project, docX, docY)` then takes the result unmodified. It needs no
change — the parent spec already established that it maps by ratio and works on
proxy buffers as-is.

**Zoom past proxy 1:1 shows proxy pixels, and the UI says so.** `layer.pixels`
is proxy resolution; asking `renderProject` for a larger `scale` upscales a
1024-edge raster. There is no full-resolution data resident to zoom into — that
is the proxy pipeline's entire premise. So:

- Composites are re-rendered at a higher `renderScale` as the user zooms in,
  but **only up to `project.proxyScale`**. Beyond that, zoom is pure CSS
  scaling of an already-rendered buffer: free, and honest about what it shows.
- Zoom caps at **4× proxy 1:1** — a chosen limit, not a measurement. Past it
  there is no information left to reveal and the blur is merely larger.
- Above 1:1 the canvas shows a persistent `2.4× · preview quality` chip.
- **A user cannot pixel-peep to verify an export in Phase 2.** That is a real
  cost of the proxy decision, named here rather than discovered. Removing it
  means re-decoding a full-resolution tile for the visible region, which is its
  own phase.

**Fit-on-open** via `fitView`: scale the composite to the viewport with a small
margin, centred. Double-tap toggles fit ↔ 1:1 about the tap point.

### Gesture arbitration

| Pointers | Where it starts | Result |
|---|---|---|
| 2 | anywhere | pinch-zoom + two-finger pan of the **view**. Never a layer edit |
| 1 | on a transform handle (≥44px hit radius) | scale the selected layer from the opposite corner |
| 1 | inside the selected layer's bounds | move the selected layer |
| 1 | anywhere else | pan the **view** |
| tap (movement under slop) | anywhere | `hitTest` → select, or deselect on a miss |

The cost is explicit: **the first move of any layer is tap-then-drag.** The
alternative — one finger always moves the selection, view panning reserved for
two fingers — was rejected on three counts: two-finger gestures become
ambiguous between pan and pinch, one-handed panning becomes impossible, and
every accidental drag across the canvas becomes an undoable document mutation.

A second pointer arriving mid-drag **ends** the layer drag (committing what it
did, so the undo entry is real) and begins a pinch. Ending rather than
cancelling means a stray finger never destroys work; the cost is an undo entry
for a movement the user may not have wanted, which undo answers.

There is no long-press gesture anywhere in this phase.

### Transform handles

Four corner handles, drawn ~24px, hit-tested at ≥44px, on a 1px selection
outline. The outline is drawn in the **view** layer, not into the composite, so
it costs nothing per frame and can never appear in an export.

- Scaling anchors the opposite corner. Aspect ratio is **not** locked by
  default — there is no second finger free to unlock it, and the model supports
  non-uniform `w`/`h` (as does `rasteriseTextAt`, deliberately: `sx` and `sy`
  are independent there).
- **No flips.** `w` and `h` clamp to a minimum of 1 document pixel rather than
  crossing zero. `renderProject` already does `Math.max(1, round(w*scale))` and
  `resample()` would not survive a negative dimension. A flip is a state the
  project model cannot express; allowing the gesture would produce a layer that
  looks flipped in preview and is not in the export.
- **No rotation.** Same reason, stated in *Decisions* and *Not doing*.
- Handles hide while a gesture is in flight, so the finger is not covering what
  it is manipulating.

`src/gesture.js` owns the maths: given a handle id, an anchor and a document
point, return the new `{x, y, w, h}`. Node-tested against the clamp cases.

### Frame budget and the degradation ladder

The budget differs by tier, so the UI measures rather than assumes.
`ProjectService` keeps `lastFrameMs`, the duration of the most recent completed
composite.

**Two rules apply on every tier**, before any degradation:

1. **One composite in flight.** Pointer moves accumulate into a pending
   transform; a new composite starts only when the previous finishes. This
   alone converts several hundred pointer events into as many frames as the
   device can actually finish, and it is the difference between a laggy drag
   and an unbounded queue that keeps moving after the finger stops.
2. **Every composite is cancellable**, and one that has not finished within
   ~300 ms puts a subtle activity indicator on the canvas rather than leaving
   the UI looking dead.

**The ladder** — chosen at pointer-down from `lastFrameMs`, held for the whole
gesture:

| Rung | Chosen when | What happens | Exact? |
|---|---|---|---|
| **Live** | `lastFrameMs ≤ BUDGET` | full recomposite per frame | yes |
| **Sandwich** | `lastFrameMs > BUDGET` | 1B's tier-3 cache: `below` + live layer + `above`, three blends | only when every layer above the selection is `normal`; 1B specifies the degradation and its disclosure |
| **Ghost** | sandwich still over budget, or the sandwich cannot be built in time | freeze `below` and `above` once at pointer-down; draw the live layer as a 2D-transformed overlay | only for `blendMode: normal` with nothing non-`normal` above. Otherwise it is a **position preview**, labelled as one |

`BUDGET` is **100 ms** — a chosen threshold, not a measurement. It is roughly
where a drag stops reading as direct manipulation and starts reading as a
sequence of jumps. It is a constant so a device report can move it.

Ghost mode's honesty requirements, which are not optional:

- The layer draws at reduced fidelity, with a marching-ants bounding box and a
  small `preview` pill on the selection HUD.
- **Pointer-up always runs one exact composite.** The approximation lasts the
  length of a gesture, exactly as 1B bounds the sandwich's.
- The debug readout names the rung used, for the same reason 1B's shows its
  sandwich state.

**If even Ghost cannot hit the budget** — a 20-layer document on tier 3 on a
slow phone, where the parent spec estimates a single full composite at 2–3 s —
the last resort is a **reduced interaction scale**: composite at
`proxyScale × k` for `k < 1` during gestures only, presented upscaled. Legal
because geometry is in document coordinates and any scale is renderable. It
degrades what the user can see, so it is the bottom rung and it is announced by
the same `preview` pill. There is no rung below it: refusing to let the user
drag would be worse than a blurry drag.

**This entire ladder is designed against estimates. Nothing in it has been
measured on a phone.** See *Risks* and *Open questions*.

### Masks in the model and the renderer

**At load** (`src/load.js`, inside the existing `onLayer`, before the reader
releases the raster):

```js
onLayer: (node) => {
  if (node.imageData) node.proxyData = downscaleImage(node.imageData, scale);
  if (node.mask?.imageData) {
    // Reproject into the LAYER's grid at full resolution, using the same
    // arithmetic composite.js has always used, then shrink to the proxy.
    const full = projectMask(node, node.imageData);      // Uint8Array, layer grid
    node.proxyMask = downscaleMask(full, node.proxyData); // dims TAKEN from the proxy
    node.mask.imageData = undefined;                      // the release nobody did
  }
  …
}
```

Three details carry the whole design:

1. **The mask is reprojected into the layer's own grid, not kept in its own.**
   `mask.left/top/right/bottom` can differ from the layer's bounds, and
   `defaultColor` fills everything outside them. `projectMask` — the existing
   `maskFor`, moved out of `composite.js` so there is exactly one
   implementation — resolves both, once, at the only moment the full-resolution
   mask exists. After this step the mask has **no independent geometry**, so
   there is no second geometry to keep in sync.

2. **The proxy mask's dimensions are taken from the proxy *pixels*, not
   recomputed.** `downscaleMask` is passed `node.proxyData` so it uses that
   buffer's exact `width`/`height` rather than independently evaluating
   `round(w * scale)`. The two expressions agree today; making the mask *read*
   the pixels' dimensions means they cannot disagree tomorrow, at any rounding,
   at any scale, under any future change to `downscaleImage`.

   **This is the answer to how a proxy-scaled mask stays aligned with its
   proxy-scaled layer: it is the same grid by construction — `proxyW × proxyH`
   — not by a matching formula.** At render time both are resampled to the same
   `rect.width × rect.height` from the same source dimensions, so they move
   together under every transform at every scale, permanently.

3. **Reprojection happens at full resolution, downscaling second.** Downscaling
   the mask in *its own* bounds and reprojecting afterwards would resolve any
   sub-pixel offset between the mask's origin and the layer's origin at proxy
   resolution — a half-proxy-pixel error, which is several document pixels of
   misalignment on a large document. Order is load-bearing.

**On the layer** (`toLayer`):

```js
mask: pixelSource && source.proxyMask
  ? { data: source.proxyMask,
      width: pixelSource.width, height: pixelSource.height,
      disabled: source.mask?.disabled === true }
  : null,
```

**At render** (`renderProject`), one branch beside the existing resample:

```js
if (layer.mask && !layer.mask.disabled)
  rect.mask = resampleMask(layer.mask, rect.width, rect.height);
```

`rect.width/height` is the same target `resample()` is given for the pixels, so
mask and pixels resample to identical dimensions from identical source
dimensions. `blendInto` then indexes `rect.mask[sy * rect.width + …]` exactly
as `renderList` has always done.

`resampleMask` is single-channel bilinear, in `src/mask.js`. It cannot reuse
`resample()`, which is RGBA and would cost 4× the memory for a coverage plane.
It gets the same identity early-return, so the default preview path — where
`rect` already equals the proxy dimensions (1B's finding 4) — does no work.

**Memory.** Steady state gains `Σ (proxyW × proxyH)` bytes over masked layers,
about 1 MB per full-canvas masked layer at a 1024 edge. Peak during decode is
unchanged or better, because the full-resolution mask was already being
allocated by ag-psd and is now released instead of retained.

**Cache invalidation.** The mask never changes in Phase 2 except through the
`disabled` toggle, which is a plain `setLayer` and therefore bumps `revision`,
dropping the sandwich and thumbnail caches with everything else.

**Known divergences from Photoshop that the mask work does *not* close**, so
nobody reads "masks are supported" as "masks are exact":

- `userMaskDensity` and `userMaskFeather` are read by ag-psd and applied by
  nobody — not by `composite.js` today, not by this. A 50%-density mask renders
  at full strength.
- **Vector masks** (`layer.vectorMask`, `mask.fromVectorData`) are rasterised
  by nothing in this codebase. A vector-masked layer has no `mask.imageData`
  and renders unmasked. It gets the same treatment as clipping: a chip, a
  document warning, no silent wrongness.
- `mask.positionRelativeToLayer` is ignored. Storing the mask in layer space
  means it moves and scales with the layer, which matches Photoshop's *default*
  (linked) behaviour. An unlinked mask diverges the moment the layer is moved,
  and is warned about at load.

### Clipping carried as data

`toLayer` gains `clipping: source.clipping === true`. Nothing reads it except
the panel, the chip, the filter and the warning. It is copied through
`toProjectJson` / `applyProjectJson` so a saved session does not lose the
disclosure.

The base layer a clip chip names is derived, not stored: the nearest layer
below with `clipping !== true`. If there is none — a clipped layer at the
bottom of the stack, which Photoshop permits and also renders unclipped — the
chip says so.

### The layers panel

**Sheet.** Rail tool → bottom sheet, header `✕ / LAYERS / 🔍`. Two detents:
half (default; canvas stays visible so selection is legible) and full (triage).
No free drag between them — two states have no ambiguous middle.

**Row**, 56px minimum:

```
┌──┬─────────────────────────────────────┬────┬───┐
│▦ │ Hero shot                    #12    │ 👁 │ ⣿ │
│40│ Backgrounds / Sky · ▨ · 62% · Screen│ 44 │32 │
└──┴─────────────────────────────────────┴────┴───┘
 thumb  name + badges                     vis grip
```

- **Thumbnail** 40×40 at 2× DPR, checkerboard behind it, **mask applied** — a
  thumbnail that ignores the mask lies about the one thing the mask work was
  for. Built by box-downscaling `layer.pixels` (already proxy-sized) and
  multiplying by `layer.mask`. Generated lazily as rows enter the viewport,
  cached by `(layer.id, revision-of-pixels | renderedKey)`. 60 thumbnails at
  80×80 RGBA is ~1.5 MB.
- **Name**, single line, tail-ellipsised.
- **Badges, shown only when they differ from the default.** A 60-row list where
  every row reads `raster · normal · 100%` is 60 rows of noise. So: `groupPath`
  when non-empty; `▨ mask` when present; `⛓ clipped` when clipping; `T` when
  `kind === 'text'`; opacity when `< 100%`; blend mode when `≠ normal`; `⚠`
  when the layer came from a group that raised a warning.
- **Text layers show their content** as the secondary line instead of
  `groupPath`, truncated. A layer named `Layer 7` containing `SUMMER SALE` is
  identified by its content, not its name.
- **Visibility** toggle, 44px, `setLayer(…, {visible})` — one undo entry each.
- **Grip**, 32px, initiates reorder. Tap-to-select and scroll stay untouched.

**The selected row expands in place** (one at a time — it *is* the selection):

- Opacity slider, 0–100, coalesced under `opacity#<n>`, with a numeric readout.
- Blend mode → opens a sub-sheet.
- Mask: an on/off toggle when `layer.mask` exists; **nothing at all** when it
  does not. Absent, not disabled.
- Geometry readout in document pixels — `x, y, w × h` — and
  `source 4961 × 3508`. The source dimensions are how a user learns their
  export is full-resolution even though the preview is not.
- Clip disclosure, when clipped.

**Blend-mode sub-sheet.** 26 modes is a Hick's-law problem, so the picker uses
Photoshop's own grouping — which `BLEND_MODES` already encodes in its line
breaks (`normal` / darken family / lighten family / contrast family /
comparative / component) — with group headers and no search.

**A file can carry a mode the picker does not offer.** `toLayer` passes
`source.blendMode` through unfiltered, mapping only `pass through` → `normal`.
So a layer can hold `dissolve`, which `blendInto` silently renders as `normal`.
The picker must therefore handle *current value not in the list*: show it at
the top, marked `Dissolve — not supported, drawn as Normal`, kept as-is but not
re-selectable once changed. Changing away from it is a one-way door that only
undo reopens, and the sheet says so.

### Findability at 60 layers

- **Search**: case-insensitive substring over `name`, `groupPath`, and text
  layers' `content`. Debounced. Client-side over an in-memory array — there is
  no server and no pagination anywhere in this app, so the
  server-paginate/client-sort trap cannot arise here. Stated so nobody
  introduces pagination later and creates it.
- **Filter chips**, multi-select: `Hidden`, `Text`, `Masked`, `Clipped`,
  `Blended` (mode ≠ normal), `Faded` (opacity < 100%), `Warned`. Every one is
  an axis the model already carries — the filter set is *derived from the field
  list*, not invented, which is also how its completeness is checked.
- **No sort.** The list order is the z-order.
- **Duplicate names** are the norm in real PSDs (a dozen `Layer 1`). The panel
  appends a **display-only** discriminator — `Layer 1  #12`, the z-index —
  computed once per revision over the names that actually collide. It is not a
  rename: nothing writes `layer.name`, because a fake edit in the undo history
  would be worse than an ambiguous list.
- **Empty names** already become `'(unnamed)'` in `toLayer`, so they all
  collide and the same discriminator separates them.
- **Selection survives filtering.** A filtered-out selected layer stays
  selected and stays outlined on the canvas; the panel shows a
  *"the selected layer is hidden by the current filter — clear"* affordance
  rather than silently deselecting.

**No virtualisation in Phase 2.** Layer count is bounded by the memory guard,
and 60–150 plain rows scroll acceptably. Virtual scroll plus drag-to-reorder is
a hostile pairing that would be solved for a case we have not met. The
threshold at which this stops holding — roughly a few hundred rows, unmeasured
— goes to the backlog rather than being pre-solved.

### Model field coverage

Every field `src/edit.js` puts on a layer, and every field on the project:

| Field | Surfaced how | If excluded, why |
|---|---|---|
| `id` | row key only | Session-local and meaningless to a user; `applyProjectJson` matches by index, not id |
| `name` | row title, with duplicate discriminator | — |
| `kind` | `T` badge for `text` only | `raster` is the default; badging it puts one identical badge on every row |
| `visible` | eye toggle, every row | — |
| `opacity` | badge when < 100%, slider in the expanded row | — |
| `blendMode` | badge when ≠ normal, grouped picker | — |
| `x` `y` `w` `h` | canvas handles + numeric readout | — |
| `pixels` | thumbnail (mask applied) | — |
| `sourceW` `sourceH` | expanded row, `source W × H` | — |
| `proxyW` `proxyH` | **debug route only** | An implementation detail of the proxy pipeline. Showing `1024 × 724` beside `4961 × 3508` invites the reading that the file was downscaled, which is the opposite of true |
| `rerendered` | **not shown** | An engine cache flag. Its one user-visible consequence — untouched text exporting at proxy resolution — is closed by 1C's full-resolution re-read, so there is nothing left to tell the user. Phase 2's job here is settling its *owner* (finding 6), not displaying it |
| `rendered` `renderedKey` | not shown | Caches |
| `text` | text layers show `content` as the secondary line; a `T` badge | Editing is Phase 4. **No disabled editing controls** — absence reads as "not here yet", a greyed field reads as "broken" |
| `mask` (new) | chip, thumbnail, on/off toggle | — |
| `clipping` (new) | chip + explanation + filter + document warning | Not honoured; disclosed three ways |
| `groupPath` (new) | secondary line + search + filter | — |
| `sourceIndex` (1C) | not shown | Export plumbing with no user meaning |
| `project.fileName` | top bar title | — |
| `project.width` / `height` | document info sheet | — |
| `project.proxyScale` | debug route only | Same reason as `proxyW/H` |
| `project.source` | not shown directly | But an unreadable URI disables export **at open** with a reason — see *States* |
| `project.warnings` | top-bar warning chip → list sheet | — |
| `project.history` / `future` | undo/redo enabled state | — |

### Warnings

`createProject` produces group-flattening and hidden-group warnings today, and
gains the clipping, vector-mask and unlinked-mask warnings from this phase.
`src/load.js` merges `doc.warnings` in (finding 7), which adds the `Patt`
pattern warning and ag-psd's `Unhandled` list.

Presentation:

- **A top-bar chip with a count** (`⚠ 3`), permanent for the life of the
  document, opening a sheet listing every warning in full.
- **Not a toast** — these are permanent properties of the file, and a toast
  that vanishes is indistinguishable from one nobody read.
- **Not a modal on open** — it blocks the first thing the user wants to see, on
  a screen they just waited 12–20 seconds for.
- **Attributed per row where possible.** The group warnings name a group, and
  `groupPath` lets the panel put a `⚠` badge on the specific layers that came
  from it. That is the difference between "three warnings somewhere in this
  document" and "this layer is one of them".

### States

| State | Trigger | What the screen shows |
|---|---|---|
| **Loading** | decode in flight | Determinate progress. The total layer count **is** available at `onStart` time — `src/reader.js:117` computes `flattenLayers` before `onStart` fires — so `onStart`'s payload gains it and a 20-second wait gets a real bar instead of a spinner |
| **Error** | decode threw | The message, the file name, `Retry`, `Pick another file`. Never a blank canvas |
| **Refused by the guard** | Phase 1A size guard | A picker-screen state, before a project exists. Names the file size and the device's limit, as the guard already does, and offers `Pick a smaller file`. **No "try anyway" override** — an OOM in a WebView is a blank screen, which is the failure the guard exists to prevent |
| **Empty document** | `project.layers.length === 0` | Not the same as no document. Every leaf was pixel-less and `flatten()` dropped them all. Copy: *"This PSD has no editable layers. N layers in the file had no pixels or text."* — which requires `flatten()` to **count what it skips** and put the count on the project. Without it the state is empty and inexplicable |
| **Filtered to zero** | search/filter matches nothing | Distinct copy and a `Clear filters` action. Must never show the empty-document copy — the two have opposite remedies |
| **Permission denied** | Capacitor cannot read the source | The document-picker path needs no permission, so this is **not** a panel state. It is an *export* state: `project.source.uri` has become unreadable. The honest move is to detect it **when the editor opens**, disable export and say why, rather than failing at the end of a 20-second export. Offers `Open settings` where the platform has one |
| **Over budget** | `lastFrameMs > BUDGET` | Not an error. The degradation ladder plus the `preview` pill. The user is told fidelity is reduced, never told to wait |
| **Context lost** | 1B demotes to tier 3 | Handled by 1B. The panel's only obligation is that no canvas goes blank and the debug tier indicator changes |

### Undo, redo and the command model

Every mutation goes through `src/edit.js`. Nothing writes a layer field
directly, the panel included.

| Interaction | Command | Coalescing |
|---|---|---|
| move / scale | `setLayer(p, id, {x,y,w,h}, 'xform#' + n)` | per gesture — the nonce is finding 4's fix |
| opacity slider | `setLayer(p, id, {opacity}, 'opacity#' + n)` | per gesture |
| blend mode | `setLayer(p, id, {blendMode})` | none — a discrete choice |
| visibility | `setLayer(p, id, {visible})` | none |
| mask on/off | `setLayer(p, id, {mask: {…, disabled}})` | none |
| reorder | `reorderLayer(p, from, to)` **once, on drop** | n/a — finding 5 |
| selection | not a command | Selection is view state, not document state. Not undoable, not in `toProjectJson` |

**`revision` lives on the project and is bumped in `applyCommand`** (finding 3)
— the one function every path reaches: `commit`, the coalescing early-return,
`undo` and `redo`. `ProjectService` exposes it as a signal, and everything
derived reads it: the panel list, badge computation, undo/redo enablement, 1B's
sandwich invalidation, thumbnail cache keys. Putting the bump in `commit()`
would look correct and miss every drag frame and every undo.

**Undo restores selection context.** Undoing a change to a layer that is not
selected, or is filtered out, scrolls the panel to it and selects it —
otherwise the user presses undo and nothing visibly happens.

### Testing

Node suites, in `src/` where they run:

- **`src/view.js`** — round-trip property `docToView(viewToDoc(p)) ≈ p` across
  a swept range of zoom, pan and viewport; clamping at the zoom cap; `fitView`
  centring.
- **`src/gesture.js`** — each handle's resulting rect from a known anchor; the
  minimum-size clamp; that no input produces a negative `w`/`h`.
- **`src/mask.js`** — `projectMask` reproduces `composite.js`'s `maskFor`
  byte-for-byte on the masked fixtures (it *is* that function, moved; the test
  is what keeps the move honest); `downscaleMask` output dimensions **equal
  `proxyData.width/height`** on a document where `round(w*scale)` is ambiguous;
  `resampleMask` identity early-return.
- **`src/panel.js`** — filter combinations; search over all three fields;
  duplicate-name discrimination including the all-unnamed case; badge
  suppression at defaults; filtered-to-zero distinguishable from empty.
- **`src/edit.js`** — coalescing with distinct gesture nonces produces two
  history entries; `revision` advances on the coalesced path and on undo;
  `rerendered` set for `w`/`h` on text layers and not on rasters.
- **End-to-end masked render** — `renderProject` on a masked fixture at
  `scale: 1` matches `compositeDocument` on the same file within the existing
  `compareBuffers` tolerance, for layers using no clipping, effects or
  adjustments. **This is the assertion the whole mask ruling stands on**, and
  it runs inside `npm test`.

**What `npm test` still cannot cover**, unchanged from 1B: anything the GPU
draws, and anything a finger does. The mask work therefore also lands in 1B's
`/conformance` route as a masked fixture rendered through both paths — see the
first risk. Gestures are checked by the user against the *Definition of done*
list; browser automation is excluded by project rules.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Masks land in `renderProject` but not in 1B's shader.** Masked layers would then render correctly on tier 3 and wrong on tiers 1–2 — a *device-dependent* wrongness, strictly worse than today's uniform wrongness because it is unreproducible on the developer's machine | **High** | The mask is one sampler and one multiply on the line that already computes `as`. 1B's spec and its conformance route must both grow it, and the *Definition of done* requires the masked fixture to pass on both paths. **Masks are not done until this is done** — a tier-3-only implementation must not ship |
| **The frame-budget ladder is designed entirely against estimates.** No number in it is measured: the 100 ms budget is a chosen threshold, the sandwich's ~100 ms is 1B's own stated arithmetic-not-measurement, and the 2–3 s tier-3 figure is the parent spec's 3–5× extrapolation from desktop | **High** | Every rung is a constant, the active rung is on the debug readout, and pointer-up always runs an exact composite. The user's first device run calibrates it. If tier 3 is unusable at 20 layers even in Ghost, the honest answer is the reduced-interaction-scale rung, not a smaller layer cap |
| **Clipping becomes visible without becoming supported.** The panel now advertises a relationship it does not honour, and free reorder can silently destroy a clip run the file expressed. Undo restores the order but the flag it restores is decorative | **High** | Three non-dismissible disclosure surfaces whose copy says the editor does not apply clipping and that reordering will not restore it. Tracked in `docs/BACKLOG.md` as an open correctness gap, not as done |
| **Tap-to-select-then-drag may test badly.** Every other editor the user has touched moves a layer on the first drag | Medium | It is the only arbitration with no ambiguous case. Reversible: the alternative is one flag in `src/gesture.js`. Listed as an open question and the first thing to put in front of a real user |
| **Masked documents were never in the memory measurements.** The peak formula the size guard is calibrated on held to 1% on two documents that carry no masks (finding 1) | Medium | This phase *reduces* mask memory rather than adding it, so the direction is safe. But the guard's calibration is now known to be untested for a whole class of file, and that belongs with the open 150 MB-cap question |
| **`projectMask` is moved out of `composite.js`**, which is the pixel-validated 12/21 oracle | Medium | Move, do not rewrite. `composite.js` keeps importing the moved function so there is one implementation and the oracle exercises it on every run; a Node test asserts byte-for-byte equality against the fixtures |
| **`groupPath`, `clipping`, `mask` and `sourceIndex` all land on `toLayer` in overlapping phases** (1C is adding `sourceIndex` concurrently) | Medium | All four are additive fields on one object literal. Coordinate the edit; do not let two phases each rewrite `toLayer` |
| **No virtualisation.** A pathological PSD with 400 layers inside the size cap would scroll badly | Low | Bounded by the guard; threshold stated and backlogged rather than pre-solved |
| **Thumbnail generation on a 60-layer document could stall the sheet open** | Low | Lazy per row via viewport intersection, cached by `(id, revision)`. The source is already proxy-sized, so each is a small box-downscale |

---

## Open questions

- **Does tap-then-drag survive contact with a real user**, or does the first
  drag on an unselected layer need to select-and-move in one gesture? The
  latter is one flag in `src/gesture.js`; it costs the guarantee that no
  accidental canvas drag mutates the document.
- **What is `lastFrameMs` on a real phone, per tier, at 6 and 20 layers?**
  Every threshold in the ladder is a guess until this exists. Carried forward
  from 1B's open questions, now with a UI that depends on the answer.
- **Is 100 ms the right budget, or is the perceptual cliff lower?** A drag
  updating at 10 fps may already be unacceptable, which would push more
  documents onto Ghost than this design assumes.
- **Should undo/redo stay in the top bar?** Frequent, and out of one-handed
  reach. PixelPerfect puts them there and so does every desktop editor; a
  bottom placement would be more reachable and less familiar.
- **How many layers does a real target PSD have?** Every findability decision
  here — no virtualisation, no pagination, search-not-sort — is sized for tens
  to low hundreds. Nothing in this project has measured a real user's file.
- **Does the half-detent sheet leave enough canvas to be worth having** on a
  short phone, or does it collapse to the full detent in practice?
- **What should reordering a clipped layer do**, when clipping eventually
  lands? Deciding it now would be speculative, but it is the question that
  blocks clipping from ever being a patch.

---

## Not doing

- **Clipping.** Ruled above. Carried as data, disclosed three ways, backlogged.
- **Mask editing** — painting, moving, deleting, inverting, applying. Phase 2
  honours what the file carries and offers one on/off toggle. Painting needs a
  brush, which is a tool, which is a later phase.
- **`userMaskDensity` / `userMaskFeather` / vector masks.** Not applied by
  `composite.js` either. Vector masks get the same chip-and-warning disclosure
  as clipping; density and feather are recorded in the backlog.
- **Rotation and flipping.** The project model is `x/y/w/h`. Adding rotation
  means teaching `renderProject`, `resample`, `hitTest`, `toProjectJson` and
  1B's `uRect` uniform about it — an engine change, not a handle.
- **Layer add, delete, duplicate, rename, merge, group.** Phase 2 edits the
  layers the file has. Each is a new command type with its own undo semantics;
  `applyCommand` currently knows two verbs.
- **Multi-select and bulk operations.** Every command in `edit.js` targets one
  `id`. Multi-select needs a command batch or a compound command, and the undo
  semantics of a partial batch are a design in themselves.
- **Text editing.** Phase 4. Content is displayed read-only, with no disabled
  controls standing in for it.
- **Filters, adjustments, HSL, overlays** (Phase 3); **crop, ratio, export UI,
  share** (Phase 5); **the design system** (Phase 0). The rail ships only tools
  that work.
- **A `confirm` on the layers sheet**, and **greyed-out rail entries for
  unbuilt tools.** Both teach the user that a control can mean nothing.
- **Zooming into full-resolution pixels.** No full-resolution data is resident;
  that is the proxy pipeline's premise. Zoom is capped and labelled.
- **Virtualised scrolling.** Backlogged with its threshold.
- **A size-guard override.** The guard's refusal is final on that device.
- **Browser-automated gesture testing.** Excluded by project rules; the
  *Definition of done* checklist is the substitute, and it is manual.

---

## Noticed, not doing

Findings from reading the code for this spec. None are Phase 2 work; all should
be appended to `docs/BACKLOG.md`, because a list that lives only in a spec is a
list nobody re-reads.

- **`layer.mask.imageData` is decoded and never released** (`src/reader.js:126`
  vs `:128–130`; ag-psd `psdReader.js:617`). Full-resolution mask rasters are
  retained for the whole session on every streamed load, today, for nothing.
  Phase 2 fixes it as a side effect of using them — but if the mask ruling is
  ever reversed, the release must still happen. **The largest unmeasured memory
  term in the pipeline**, and the reason the Phase 1 peak formula is
  unvalidated for masked documents.
- **`maskFor` ignores `mask.disabled`** (`src/composite.js:172`). The read-only
  inspector applies masks Photoshop is not applying. That is a live
  wrong-pixels bug in `compositeDocument` — **the oracle** — and it would
  surface as a fixture mismatch nobody has attributed correctly.
- **`maskFor` ignores `userMaskDensity` and `userMaskFeather`.** ag-psd reads
  both. A 50%-density mask renders at full strength in the inspector, and after
  Phase 2 in the editor too.
- **Vector masks are invisible to the whole codebase.** `layer.vectorMask` and
  `mask.fromVectorData` are never consulted, so a vector-masked layer renders
  unmasked everywhere. Phase 2 discloses it; nothing fixes it.
- **`doc.warnings` never reaches `project.warnings`** (`src/load.js`). Phase 2
  merges them, but the *shape* deserves a proper fix: `createProject` takes a
  `doc` and ignores a field on it, which will happen again.
- **`toLayer` passes `blendMode` through unfiltered.** A layer can hold a mode
  `BLEND_MODES` does not list and `blendInto` does not implement (`dissolve` is
  the known one) and it renders as `normal` with no warning. `renderList` warns
  about `dissolve`; the project path does not.
- **`'(unnamed)'` is stored in `layer.name`**, so a layer genuinely named
  `(unnamed)` is indistinguishable from an empty one, and `toProjectJson`
  persists the substitution as if it were the file's own name.
- **`applyProjectJson` matches by array index** and validates only the count.
  Two different PSDs with the same layer count silently cross-apply. 1C is
  introducing `sourceIndex` for exactly this class of bug; the persistence path
  should use it too.
- **`hitTest` uses `layer.rendered || layer.pixels`** and falls back to bounds
  when neither exists. A text layer retyped but not yet re-rasterised at the
  current size hit-tests against its box, not its glyphs — worth knowing when
  selection feels imprecise.
- **`estimatePeakBytes` still has no production caller** (already backlogged).
  Phase 2 does not add one; 1C's export budget remains the natural home.
- **Nothing under `app/` has automated coverage** (already backlogged). Phase 2
  is the phase that makes this bite: it adds gesture plumbing, a sheet, a rail
  and a service. The mitigation is the `src/view.js` / `src/gesture.js` /
  `src/panel.js` split — but that only holds if the Angular side stays as thin
  as it is specified to be. Re-check when it is written, not after.
