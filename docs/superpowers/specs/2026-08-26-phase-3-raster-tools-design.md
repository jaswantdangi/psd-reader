# Phase 3 — Raster Tools as Non-Destructive Per-Layer Properties

**Date**: 2026-08-26
**Status**: Design, implementation plan not yet written
**Phase**: 3 of 6 (see *Programme context*)
**Parent spec**: [`2026-08-25-phase-1-engine-gpu-memory-design.md`](./2026-08-25-phase-1-engine-gpu-memory-design.md)
**Depends on**: [`2026-08-26-phase-1b-gpu-compositor-design.md`](./2026-08-26-phase-1b-gpu-compositor-design.md) (tiering, GLSL generation, conformance route), [`2026-08-26-phase-1c-streaming-export-design.md`](./2026-08-26-phase-1c-streaming-export-design.md) (the export walk and its target interface), [`2026-08-26-phase-2-layers-canvas-design.md`](./2026-08-26-phase-2-layers-canvas-design.md) (selection, sheets, the frame-budget ladder)

---

## Programme context

| # | Phase | State |
|---|---|---|
| 0 | Design system + the five real screens | deferred, shrunk |
| 1 | Engine rework, GPU compositor, memory pipeline | 1A, 1B-1, 1C-1 complete; **1B-2 (a real GPU) not started** |
| 2 | Layers panel + canvas interaction | engine half (2A) complete; UI half not started |
| **3** | **Raster tools (filter / adjust / HSL / overlay) as per-layer properties** | **this document** |
| 4 | Creative tools (text, stickers) | not started |
| 5 | Framing + output (crop, ratio, export, share) | not started |

PixelPerfect's bottom rail (`recycler_view_tools`) carries four raster tools —
**Filter**, **Adjust**, **Overlay**, **HSL** — each opening a 180dp sheet with a
`close / TITLE / confirm` header. Phase 3 is those four tools.

**PixelPerfect edits one flat bitmap.** It can afford to bake every tool into
pixels, because there is exactly one buffer and no history beyond an undo of
the whole image. This app has N layers, each of which must survive undo,
reorder, proxy-resolution preview and full-resolution export. So the four tools
cannot be ports; they are re-specified here as **settings stored on a layer and
evaluated at render time**.

None of PixelPerfect's code is reusable — it is Java over an OpenGL ES filter
chain — and, as *Assets and licensing* below establishes, neither are its
assets.

---

## Why this phase exists

### The tension, stated once

An adjustment that is *baked* costs nothing to render and everything to undo.
An adjustment that is *stored* costs nothing to undo and is re-evaluated on
every frame, for every layer that carries one, at every resolution the document
is ever drawn at. Phase 1's founding decision — non-destructive transforms,
proxy preview, full-resolution export — forces the second. Phase 3's entire
design problem is making the second affordable.

### Measured — cited, not re-derived

From the parent spec, JS compositing at a 1024-edge proxy canvas, **desktop**:

| Layers | Per frame |
|---|---|
| 6 | 185 ms |
| 20 | **651 ms** |

Mobile is 3–5× slower: ~2–3 s per drag frame at 20 layers. Full-resolution JS
export is 3.1 s untransformed, 4.3 s transformed on desktop; 12–20 s mobile.

**There is no GPU.** `src/gpu/modes.js` and `src/gpu/glsl.js` generate shaders;
nothing compiles them. `src/gpu/detect.js:selectTier` returns `TIER_JS` with
the verdict `'shader probe not run'` unless a real probe supplies evidence, and
no probe exists. Plan 1B-2 is not started. **Every number in this spec is a JS
tier number, and no part of this design may assume the GPU rescues it.**

### Found by reading, during this design

Six things about the current code shape this design. All are stated so the plan
does not assume otherwise.

1. **`resample()` returns its *input object* when the sizes already match**
   (`src/render.js:20`). 1B's finding 4 establishes that this identity
   early-return is the **default preview path** — `downscaleImage` produces
   `round(layer.w * proxyScale)` and `renderProject` at `scale = proxyScale`
   asks for the same expression, so it hits for every layer.

   Therefore the buffer `drawLayerInto` is holding is, in the common case,
   **`layer.pixels` itself**. An adjustment applied in place would destructively
   overwrite the layer's original pixels — non-destructive editing would
   silently become destructive — and because the next frame reads the same
   buffer, a brightness slider held down would compound frame over frame and run
   away to white. The same aliasing holds for `layer.rendered` on a re-drawn
   text layer, and for the streamed full-resolution buffer export passes as
   `options.pixels`.

   **The adjustment pass must never write into its input.** This is the single
   most dangerous defect available in this phase, and it is the kind that looks
   like a working feature for exactly one frame.

2. **`drawLayerInto` is the only place a layer's pixels meet the compositor**,
   and all three render paths go through it: `renderProject`
   (`src/render.js:196`), `renderSandwiched` (`src/sandwich.js:110`) and the
   export target (`src/export/target-js.js:25`). One insertion point serves
   preview, drag cache and full-resolution export with no second implementation.
   That fact is what makes the ruling below cheap.

3. **`setLayer` captures `from[key] = layer[key]` by reference for
   object-valued fields** (`src/edit.js`). Undo restores that reference. So a
   caller that *mutates* a layer's object-valued field and passes the same
   object has already destroyed the undo entry before it was written. This
   hazard is **already live for `layer.mask`**, which Phase 2 toggles through
   `setLayer`; nothing enforces the rule. Phase 3 adds a second object-valued
   field and must state the rule explicitly.

4. **`revision` and `mutation` are two counters answering two questions**, and
   the split is exactly what an adjustment slider needs. `revision` is bumped by
   `commit`, `undo`, `redo` and `applyProjectJson`, but **not** by `setLayer`'s
   coalescing early-return; `mutation` is bumped by `applyCommand` on every
   applied change including coalesced drag frames. The sandwich cache keys on
   `revision` (`src/sandwich.js:103`). An adjustment drag that reuses one
   gesture key therefore reuses one sandwich build, with **no new machinery
   whatsoever**.

5. **`blendInto` applies `opacity`, `rect.mask` and `clipAlpha` after the
   caller has produced the layer's pixels**, and reads alpha from
   `src[si + 3]`. Nothing in Phase 3 needs to touch that line — provided no
   adjustment modifies alpha. See invariant A below.

6. **`hitTest` selects on `layer.rendered || layer.pixels`** — the
   *unadjusted* buffer — and thresholds on alpha (`> 8`). That is correct only
   while adjustments leave alpha alone. It is a second consumer of the same
   invariant, and it is silent when violated.

---

## Ruling — where adjustments sit in the pipeline

**Adjustments are properties of a layer, evaluated on that layer's own pixels,
after resampling and before `blendInto`. They never see the backdrop, never see
a neighbour, and never produce a new entry in the layer stack.**

Concretely, one hook inside `drawLayerInto`:

```
layer.pixels ─▶ resample() / textPixelsAt()  ─▶ applyAdjustments()  ─▶ blendInto()
                (destination-rect sized)         (into scratch)        (mask, opacity, mode)
```

### Why before blending, and not as an adjustment layer

Three alternatives were considered.

**(b) Adjustment layers** — a stack entry that adjusts the composite beneath it,
which is what Photoshop actually ships. Rejected for this phase:

- It is a new layer *kind*, which means a new command verb in `applyCommand`
  (which knows two: `set` and `reorder`), a new row type in the Phase 2 panel,
  new undo semantics for insert/delete, and an answer for what an adjustment
  layer's thumbnail shows. That is a phase, not a tool.
- It breaks the sandwich cache's premise in the same way clipping does: an
  adjustment layer above the selection is a non-`normal` operation on the
  backdrop, so `sandwichStateFor` would have to degrade to `below`-only for
  every document that has one — which is every document the feature is for.
- It is not what the brief asks for and not what the four PixelPerfect tools
  are. Deferred with the ruling attached, not refused. See *Not doing*.

**(c) One adjustment of the whole composite**, PixelPerfect's actual model.
This is *dramatically* cheaper — one pass over the canvas, independent of layer
count — and it is the honest comparison, because it is the thing PixelPerfect
users are actually experiencing. Rejected because it cannot be stored per layer,
which is the phase's requirement, and because a document-wide tone curve belongs
with output framing (Phase 5), not with a per-layer tool rail. **Named as a
future feature, because it is the cheap 80% of what a user wants and the
existing pipeline would absorb it in one pass.**

**(a) Per-layer, before blending — chosen.** Four reasons, in order of weight:

1. **It is the only option compatible with the streaming export walk.**
   `exportFullRes` (`src/export/stream.js`) sees one layer at a time, in an
   arrival order that may not be blend order, and hands each to
   `target.blend(layer, pixels)`. An adjustment that is a pure function of
   *that layer's own pixels and its own stored parameters* needs nothing else in
   scope. **Constraint (4) verified: export requires no change at all.** The
   adjustment is applied inside `drawLayerInto`, which `target-js.js` already
   calls, at `scale: 1`, on the full-resolution stream. An adjustment-layer
   design would instead require the target to expose a read-modify-write of the
   accumulator, which the tiled GPU target (1C-2) would have to implement twice.
2. **It preserves tile independence.** Every Phase 3 operation is *pointwise* —
   the output at a pixel depends only on the input at that pixel (plus, for
   overlay, that pixel's normalised position). 1B's tiling argument —
   *"none of the 26 blend modes is a neighbourhood operation… tiles need no
   overlap and no seam blending"* — extends unchanged. This is also the reason
   radius-based effects are excluded; see the second ruling.
3. **One insertion point.** Finding 2: preview, sandwich and export all route
   through `drawLayerInto`. There is no second implementation to keep in step.
4. **The mask composes correctly with no design work.** `blendInto` applies
   `rect.mask` to `as` after the caller has produced the pixels, so a mask
   limits *where the adjusted layer shows*, which is the Photoshop semantic and
   the only one anyone would expect.

### Why after resample, not before

Pointwise operations do not commute with bilinear interpolation: for a
non-linear `f`, `f(αa + (1−α)b) ≠ αf(a) + (1−α)f(b)`. So the order is a
decision, not an implementation detail, and it is **after**:

- The GPU forces it. A fragment shader samples `uSource` — through the `LINEAR`
  or `NEAREST` filter — and only then has a value to adjust. Doing it before
  would mean a separate pre-pass writing an adjusted texture, which is a second
  FBO per layer and a second upload path.
- It makes the pass cost proportional to the **destination** rect, which at
  proxy scale is the smaller of the two for any downscaled layer.
- On the default preview path the two orders coincide anyway, because
  `resample()` identity-returns and there is no interpolation to commute with.

The cost of the choice is stated in *GPU/JS parity*: on a **transformed** layer,
the adjustment is applied to an interpolated value, and a steep curve amplifies
1B's known 1–2 LSB filter divergence.

### What is not being built

- Adjustment layers (option b).
- Document-level adjustment (option c) — deferred to Phase 5.
- Any operation that reads a neighbouring pixel.
- Any operation that modifies alpha (invariant A).
- Baking. Nothing in Phase 3 ever writes adjusted pixels back into
  `layer.pixels`, `layer.rendered`, or a saved project.

---

## Ruling — radius-based effects are excluded, entirely

**No Phase 3 operation has a pixel radius.** Blur, sharpen, unsharp mask,
Gaussian glow, bloom, drop shadow, film grain and noise are all out. This is a
ruling, not a scheduling accident, and it rests on three independent reasons —
any one of which would be sufficient.

1. **Proxy/export fidelity, which is constraint (5) directly.** A radius is in
   *pixels*, and the preview has 1/23rd of the document's pixels. The naive fix
   — scale the radius by `proxyScale` — fails at both ends: at a typical
   `proxyScale ≈ 0.2`, a 5 px blur previews as a 1 px blur (visually almost a
   no-op) and exports as a 5 px blur, and a 2 px blur previews as 0.4 px, which
   no integer-tap kernel can express. The user would tune a slider against a
   preview that does not show what it does. **That is the same failure shape
   1C's own docstring names as the worst available: it looks like it worked.**
   The honest alternatives — render radius effects at full resolution for the
   preview, or decode a full-resolution tile for the visible region — are each
   their own phase.
2. **Tile independence, which is constraint (4)'s other half.** 1B: *"This
   stops being true the moment layer effects (drop shadow, glow, blur) arrive —
   those would need halos."* The tiled GPU export target would need per-tile
   halos sized to the radius, and the JS export walk would need a layer's
   neighbours resident — which the one-layer-at-a-time peak formula
   (`file + one full-res layer + output`) does not permit.
3. **Cost.** A separable Gaussian at radius 8 is two passes of 17 taps, ~34
   texture reads per pixel, against the 3 table lookups a pointwise op costs.
   On a JS tier already at 651 ms for 20 layers, one blurred layer would cost
   more than the entire rest of the frame.

**Two near-misses, ruled separately so nobody re-litigates them:**

- **Vignette** is pointwise in *normalised position*, so it tiles safely and —
  parameterised in normalised document coordinates rather than pixels — it is
  genuinely scale-invariant. It is eligible on every technical ground. It is
  excluded because it is a **document** effect: a vignette applied to one layer
  of twenty is meaningless, and a vignette applied to all twenty is twenty
  vignettes. It belongs with framing and output, Phase 5.
- **Grain / noise** is pointwise in position and seed, so it also tiles. It is
  excluded because it is **not scale-invariant**: grain generated per pixel at
  proxy resolution has ~23× the apparent grain size of grain generated per pixel
  at full resolution, so the preview and the export would carry visibly
  different textures. Generating it in normalised coordinates instead would make
  the export's grain a smooth upscale of the proxy's, which is not grain. There
  is no cheap correct answer, so there is no grain.

The consequence to accept openly: **PixelPerfect's filter set almost certainly
contains looks that depend on blur or grain, and those looks cannot be
reproduced.** Phase 3's presets are tone and colour only. Said in *Assets and
licensing*, and again in *Not doing*.

---

## Definition of done

> On a phone, select one layer of twenty, apply a named filter, nudge its
> brightness and contrast with a slider that tracks the finger, shift the reds
> with HSL, lay a gradient overlay over it, undo the lot in four steps, and
> export a full-resolution PNG in which that layer — and only that layer —
> carries all four.

Checked by the user, because build commands are not run here:

- [ ] Four sheets — Filter, Adjust, Overlay, HSL — open from the rail, each with
      PixelPerfect's `close / TITLE / confirm` header, and each requiring a
      selected layer.
- [ ] A brightness slider drag is **one** undo step. Two separate drags are two.
- [ ] `✕` on a sheet returns the layer to exactly its state when the sheet
      opened, in one action, regardless of how many sliders were touched.
- [ ] Applying a filter to layer 5 changes layer 5 and nothing else, verified
      against a layer above it in `difference` mode.
- [ ] A layer with four adjustments renders at the same frame cost as the same
      layer with one — the debug readout's ms/frame does not change materially
      when the second, third and fourth are added. **This is the assertion the
      whole LUT design stands on.**
- [ ] Adding an adjustment to a layer and then *moving* it costs no more per
      frame than moving it did before. (The sandwich cache holds; only the live
      layer re-adjusts.)
- [ ] The exported PNG and the on-screen preview agree on colour, checked by
      eye against a strongly-adjusted layer. Any radius effect would fail this;
      there are none.
- [ ] Undo after a filter tap restores the previous filter, not "none".
- [ ] Saving and reopening a project restores every adjustment parameter.
- [ ] The debug readout shows, per frame, how many layers carried a class-A LUT
      and how many carried HSL — the two cost terms, separately.
- [ ] `npm test` green, plus new suites for `src/adjust/lut.js`,
      `src/adjust/ops.js`, `src/adjust/apply.js` and the GLSL coverage
      assertion.
- [ ] `/conformance` gains Table D (per-op adjustment matrix) and reports it
      GPU-vs-JS — **when a GPU exists**. Until 1B-2 lands, the route runs Table
      D JS-against-itself as a regression baseline and says so on the page.

Explicitly **out of scope**: adjustment layers, blur/sharpen/grain/vignette,
bitmap overlay textures, curves/levels editors with draggable control points,
selective (masked) adjustments beyond the layer mask the file already carries,
text editing and stickers (Phase 4), crop and export UI (Phase 5).

---

## Decisions

| Decision | Rationale |
|---|---|
| **Adjustments are per-layer, applied after resample and before `blendInto`** | The ruling above. It is the only shape the one-layer-at-a-time export walk can serve without a second implementation, and `drawLayerInto` is already the single point all three render paths share |
| **Every operation is pointwise; no operation has a pixel radius** | The second ruling. Preserves 1B's tile independence, keeps proxy and full-resolution output identical by construction, and keeps the per-pixel cost within a small multiple of the blend itself |
| **No operation modifies alpha** (invariant A) | `blendInto` reads alpha for `as`, `rect.mask` multiplies it, `hitTest` thresholds it, and `alphaMap` in `composite.js` builds clipping from it. One invariant keeps four consumers correct; violating it is silent in three of them |
| **All per-channel operations collapse into a single 3 × 256 lookup table** | Stack depth stops mattering. Four adjustments cost what one costs. This is the mechanism that makes the feature affordable on a JS tier already at 651 ms for 20 layers |
| **The LUT is built in shared plain ESM and uploaded to the GPU verbatim as a 256 × 1 RGBA texture, sampled with `texelFetch`** | Both tiers then read *the same 768 bytes*. For the majority of the operation surface, GPU/JS divergence is not reduced — it is structurally impossible. Directly answers the parity problem for everything except HSL and overlay |
| **Exactly one cross-channel operation: `hsl`** | HSL cannot be a per-channel LUT and must be evaluated per pixel in two implementations. Keeping the count at one keeps the *divergent* surface at one function and one conformance row |
| **"Filter" is a named bundle of the same parameters Adjust and HSL expose, not a separate mechanism** | Costs nothing to render (it folds into the same LUT), makes every preset editable after it is applied, and removes any need to ship third-party assets. A preset is data we author |
| **"Overlay" is a procedural gradient with a blend mode and opacity. No bitmap textures** | PixelPerfect's 30 overlay PNGs are third-party assets in a repository with **no LICENSE file** and cannot be assumed shippable. A gradient in normalised layer coordinates is scale-invariant, tile-safe, needs no asset, and adds no term to the export peak |
| **Ops are declared in one table carrying both the JS body and the GLSL body; a Node test asserts the key sets are identical** | The same construction 1B uses for blend modes (`src/gpu/modes.js` + the coverage test in `test/gpu.mjs`). It makes a *missing* shader impossible; it does not and cannot make a *wrong* one impossible — see *Risks* |
| **The adjustment stack is one frozen object on the layer, replaced wholesale on every change** | Finding 3: `setLayer` captures the previous value by reference. Mutating in place destroys the undo entry before it is written. Freezing makes the rule enforced rather than remembered |
| **Adjustment drags use a gesture-scoped coalesce key, exactly as opacity does** | Finding 4. `revision` then does not move during the drag, so the sandwich cache survives the gesture and only the live layer re-adjusts. Zero new invalidation machinery |
| **No per-layer adjusted-pixel cache** | It would cost ~3 MB per full-canvas proxy layer — ~60 MB at 20 layers, against a steady-state editing footprint of ~36 MB for the measured 12-layer document. The only repeated-render case is a gesture, and the sandwich cache already covers it |
| **One shared scratch buffer per render context, grown monotonically** | Finding 1 forbids in-place adjustment, so a destination buffer is mandatory. One shared buffer sized to the largest destination rect is O(1) allocations instead of O(layers) per frame. It adds one buffer-sized term to the JS export peak, stated below |
| **Applied in a fixed, declared order: LUT → HSL → overlay** | Pointwise operations do not commute. An undeclared order is a bug the user discovers by getting a different result than the same sliders gave yesterday |
| **All arithmetic stays in the 0..255 non-linear space `composite.js` blends in** | Photometrically wrong — "exposure" in gamma space is not exposure — but *consistent with the oracle*, which is what conformance measures against. Adopting linear light would make the JS compositor a systematically worse reference and cannot be done in the same phase as validating a new feature. The tool is labelled `Brightness`, never `Exposure (EV)` |
| **`✕` discards the sheet's whole session; there is no `confirm` that bakes** | PixelPerfect's `✕`/`✓` mean cancel/apply because it bakes. Nothing bakes here, so `✓` is just "close". `✕` rolls history back to the length recorded at sheet-open, which is one new six-line helper in `edit.js` and no new command type |
| **Tapping a raster tool with no selection opens the layers sheet with a prompt** | Phase 2's rule stands: no disabled controls, and the rail carries only tools that work. The tool works — it needs a target, so it asks for one in the place targets are chosen |

---

## Architecture

### Module layout

Plain ESM, no DOM, no framework, Node-testable except where marked.

| File | New? | Node-testable | Responsibility |
|---|---|---|---|
| `src/adjust/ops.js` | new | yes | The op table. Per op: parameter schema, neutral value, the JS evaluator, and the GLSL body. Pure data + functions + strings — the same shape as `src/gpu/modes.js` |
| `src/adjust/lut.js` | new | yes | `buildLut(adjust)` → 768 bytes. Composes every class-A op in declared order into one 3 × 256 table. `isNeutral(adjust)`, `digest(adjust)` |
| `src/adjust/apply.js` | new | yes | `applyAdjustments(pixels, adjust, out)` — the per-pixel pass. Reads `pixels`, writes `out`, **never aliases** |
| `src/adjust/presets.js` | new | yes | The named filters, authored here as parameter bundles. Data only |
| `src/adjust/scratch.js` | new | yes | One monotonically-growing buffer per render context |
| `src/adjust/glsl.js` | new | yes | Assembles the adjustment stage of the fragment shader from `ops.js`. Pure strings |
| `src/gpu/glsl.js` | changed | yes | Splices the adjustment stage between `texture(uSource, uv)` and the `as` computation |
| `src/render.js` | changed | yes | One hook in `drawLayerInto` |
| `src/edit.js` | changed | yes | `adjust` on the layer; `discardTo()`; `adjust` through `toProjectJson` / `applyProjectJson` |
| `src/conformance.js` | changed | yes | Table D generator: per-op synthetic documents |

Angular keeps the four sheets, the sliders, the preset strip and the pointer
plumbing that mints a gesture key and calls `setLayer`. Nothing in `app/`
computes a pixel.

### The data model

```js
// layer.adjust — one frozen object, replaced wholesale, or null when neutral.
{
  preset: 'none' | '<preset id>',   // resolved into the numbers below at build time
  // ---- class A: per-channel pointwise. Collapse into ONE 3x256 LUT. ----
  brightness:  0,    // -100..100
  contrast:    0,    // -100..100
  exposure:    0,    // -100..100  (a gain in 0..255 space; labelled Brightness+ in the UI)
  temperature: 0,    // -100..100  (per-channel gain, warm/cool)
  tint:        0,    // -100..100  (per-channel gain, green/magenta)
  // ---- class B: cross-channel pointwise. Evaluated per pixel. ----
  hsl: null | {
    bands: [ {h:0,s:0,l:0} x8 ],   // red orange yellow green aqua blue purple magenta
    saturation: 0,                  // -100..100, global
  },
  // ---- positional: pointwise in normalised layer coordinates. ----
  overlay: null | {
    kind: 'linear' | 'radial',
    angle: 0,                       // degrees, linear only
    stops: [ {t, r, g, b, a}, ... ],
    mode: '<one of the 26>',
    opacity: 1,
  },
}
```

`null` is the neutral value for the whole object, and `isNeutral()` short-cuts
the entire pass. A layer with no adjustments costs exactly what it costs today —
one branch.

**Parameter count is deliberately small.** Five class-A sliders, one HSL block,
one overlay. Curves and levels editors, split toning, clarity, dehaze and
selective colour are all expressible in this model and are all *not* being
built; the model is the constraint on the tool, not the other way round.

### The evaluation pipeline, in order

```
              ┌─ resample(src, rect.w, rect.h)      may RETURN src ITSELF (finding 1)
 layer.pixels ┤
              └─ textPixelsAt(layer, rect.w, rect.h) returns layer.rendered ITSELF

   ─▶ applyAdjustments(pixels, layer.adjust, scratch.acquire(rect.w, rect.h))
        1. class-A LUT      out.r = lut[0][in.r]; out.g = lut[1][in.g]; out.b = lut[2][in.b]
        2. hsl              cross-channel, only when adjust.hsl is non-neutral
        3. overlay          gradient value at (x/w, y/h), blended by mode at opacity,
                            its alpha multiplied by the pixel's own alpha
        alpha copied through untouched (invariant A)

   ─▶ blendInto(dest, out.data, rect, layer.opacity, layer.blendMode)
        rect.mask and clipAlpha applied here, as today
```

Two details are load-bearing:

- **`out` is never `pixels`.** `applyAdjustments` asserts `out.data !== pixels.data`
  and throws if it is. Finding 1 is a defect that survives review by looking
  correct; a runtime assertion in the one function that could commit it is
  cheaper than remembering.
- **Overlay is clipped to the layer's own alpha.** `overlayAlpha *= pixel.a / 255`.
  Without it, a gradient overlay would paint into the transparent region of a
  layer and turn a cut-out into a rectangle — which is exactly what the *document*
  overlay PixelPerfect ships does, and exactly not what a per-layer overlay
  should do.

### The LUT, and why stack depth stops mattering

Every class-A op is a function `f: channel value → channel value` that depends
on nothing but that channel (temperature and tint are per-channel *gains*, so
they qualify — they read one channel and write it, with a different constant per
channel). Composition of such functions is itself such a function. So:

```js
// src/adjust/lut.js — illustrative
export function buildLut(adjust) {
  const lut = new Uint8Array(768);            // [r 0..255][g 0..255][b 0..255]
  for (let c = 0; c < 3; c++)
    for (let v = 0; v < 256; v++) {
      let x = v;
      for (const op of CLASS_A_ORDER) x = OPS[op].eval(x, c, adjust);
      lut[c * 256 + v] = Math.max(0, Math.min(255, Math.round(x)));
    }
  return lut;
}
```

768 evaluations of the whole stack, once per parameter change — not per pixel,
not per layer, not per frame. The per-pixel cost is then **three array indexes
and three stores, for any number of stacked class-A operations**.

That is the answer to the brief's cost question. Four adjustments on a layer
cost what one costs. The *Definition of done* makes it a user-checkable
assertion rather than a claim.

The LUT is cached on the layer as a derived value keyed on `digest(adjust)` — a
short string built from the numeric parameters. It is **not** persisted, **not**
part of the command model, and **not** part of undo; it is rebuilt from
parameters whenever the digest changes. Cost of a rebuild during a slider drag:
768 evaluations, an estimated tens of microseconds, once per frame.

### HSL — the one cross-channel operation

Eight hue bands with `h`/`s`/`l` offsets plus a global saturation, evaluated per
pixel: RGB → HSL, weight the pixel's hue against the band centres with a
triangular falloff, apply the weighted offsets, HSL → RGB.

This is the expensive one and the design does not pretend otherwise. Order-of-
magnitude estimate, from the measured 651 ms / 20 layers ≈ 32.5 ms per layer per
frame at proxy: an HSL pass is roughly **1.5–3× the cost of the `blendInto` pass
it precedes** *(estimate, derived from operation count — divides, branches and
two colour-space conversions per pixel — not measured)*. A class-A LUT pass is
roughly **0.15–0.25×** *(estimate, same basis)*.

Three things bound it:

1. **It is skipped entirely when neutral**, decided once per layer per frame
   from the digest, not per pixel.
2. **There is exactly one of it.** The op count in class B is one and stays one;
   vibrance, selective colour and split toning would each be another and are all
   in *Not doing*.
3. **The Phase 2 ladder measures rather than predicts**, so an HSL-heavy
   document demotes on its own. See below.

### Cost, and how the frame-budget ladder responds

The brief's scenario: **four adjustments on each of twenty layers.**

With the LUT collapse, that is 20 class-A passes, not 80. Estimated added cost
per full-canvas layer at a 1024-edge proxy, from the 32.5 ms/layer/frame figure
above: ~5–8 ms, so **20 layers ≈ +100–160 ms**, taking a 651 ms desktop frame to
roughly **750–810 ms** — a ~15–25% regression *(estimate)*. Mobile at 3–5×:
roughly **2.3–4.0 s** per frame.

Without the collapse — one pass per adjustment — the same document would be 80
passes, an estimated **+400–640 ms**, near double. That difference is the design.

If all twenty layers also carry HSL, add an estimated **+1.0–2.0 s** desktop.
That document is not interactively editable on the JS tier at 20 layers, and
this spec does not claim it is.

**Phase 3 adds no new rung to the ladder.** Phase 2's ladder —
Live → Sandwich → Ghost → reduced interaction scale — is chosen at pointer-down
from `lastFrameMs`, *a real measurement of the previous completed composite*.
Because adjustments make composites slower rather than differently shaped, the
ladder absorbs them with no change. What Phase 3 must add is three things:

1. **A gesture-scoped coalesce key on every adjustment drag**
   (`nextGestureKey('adjust')`), so `revision` does not move and the sandwich
   cache holds. During a slider drag on layer *i*, `below` and `above` are
   cached composites that already contain their own layers' adjustments,
   computed once at cache build; **only layer *i* re-adjusts per frame.** An
   adjustment drag is therefore structurally identical in cost to a move drag,
   which is the single most important consequence of putting adjustments on the
   layer rather than in the stack.
2. **A disclosure of the two cost terms.** The debug readout gains
   `lut: N / hsl: M` — how many layers ran each pass this frame. Phase 1B and
   Phase 2 both established that an approximation or a cost the user cannot see
   is a bug; this is the Phase 3 instance of the same rule.
3. **An admission about the first gesture.** The rung is chosen from the *last*
   measured frame. Adding an adjustment changes the cost *between* gestures, so
   **the first gesture after an adjustment is added may be chosen one rung too
   optimistic and will overshoot the budget.** It self-corrects on the second
   gesture. This is accepted, not solved; solving it would mean predicting frame
   cost from the model, which is exactly the guessing the measured ladder exists
   to replace.

**One deliberate omission.** Adjustments are *not* skipped or approximated on
the Ghost rung. Ghost already freezes `below` and `above` and draws the live
layer as a transformed overlay; dropping the live layer's adjustment on top of
that would mean the layer changes colour when the finger goes down. A position
preview that is the wrong colour reads as a bug, not as a preview.

### Cache invalidation

This is constraint (3), and the existing counters answer it with no new
machinery. Stated as a table because the failure mode is subtle in both
directions.

| Event | `mutation` | `revision` | Sandwich cache | LUT cache | Correct? |
|---|---|---|---|---|---|
| Slider frame *n* of a drag (coalesced) | bumps | **does not bump** | **survives** — key unchanged | rebuilt (digest changed) | Yes. Only the live layer re-adjusts, which is the point |
| First frame of the drag (`commit`) | bumps | bumps | rebuilt once | built | Yes |
| Preset tap (discrete, no coalesce key) | bumps | bumps | rebuilt | built | Yes |
| Sheet `✕` (`discardTo`) | bumps per pop | bumps per pop | rebuilt | rebuilt from restored params | Yes |
| Undo / redo | bumps | bumps | rebuilt | rebuilt | Yes |
| Adjustment change on a layer **below** the selection | bumps | bumps | rebuilt | rebuilt | Yes — `below` is a real composite of those layers and must be redone |
| Adjustment change on a layer **above** the selection | bumps | bumps | rebuilt | rebuilt | Yes, for the same reason |

The only genuinely new hazard is the one finding 3 names: **`layer.adjust` must
be replaced, never mutated**, or `setLayer`'s `from` capture holds the same
object the `to` does and undo becomes a no-op. Two defences, both cheap:

- `Object.freeze` the object every time one is built, so an in-place mutation
  throws in strict mode instead of silently corrupting history.
- A Node test that mutates through a stale reference and asserts undo still
  restores. Real coverage for a class of bug that is invisible by inspection.

And the standing project rule, restated because Phase 3 touches the same
territory: **nothing in this phase writes `layer.rendered`, and therefore
nothing in this phase needs to clear `renderedKey`.** Adjusted pixels live in
the shared scratch and are consumed by `blendInto` in the same call. If a future
change ever caches an adjusted buffer on the layer, the pair
`layer.adjusted` / `layer.adjustedKey` must be cleared together and the key must
include the adjustment digest, the source pixel identity and the destination
dimensions.

### Export — constraint (4), verified

`exportFullRes` needs **no change**. The walk hands `target.blend(layer, pixels)`
one layer at a time, and `createJsExportTarget` calls
`drawLayerInto(dest, layer, 1, { pixels, onMissing })`. The adjustment hook is
inside `drawLayerInto`, so:

- Adjustments apply at **full resolution**, to the **streamed full-resolution
  pixels**, with the same parameters and the same LUT bytes the preview used.
- Nothing needs a neighbour, so the arrival-order/blend-order problem and the
  spill path are entirely unaffected. A layer read back from a spill file goes
  through the identical `blend` call.
- A self-rendering text layer (`rerendered === true`) is adjusted after
  `textPixelsAt` returns, exactly as in preview.
- On the GPU export target (1C-2), the adjustment is in the fragment shader
  after `texture(uSource, uv)`, so it composes with tiling for free — the
  pointwise argument again.

**Two things export must account for, and one number.**

1. **A scratch buffer at full resolution.** Finding 1 forbids in-place work, so
   an adjusted layer needs a destination the size of its destination rect. On
   the JS export tier that is up to the document size. 1C's fallback-tier peak
   formula already reads
   `file + one full-res layer + one resampled copy + output buffer`; Phase 3
   adds **at most one more buffer of the same order**, and only when at least
   one layer carries a non-neutral adjustment. For the measured
   4961 × 3508 poster that is **+66.4 MB** *(derived from 1C's arithmetic, not
   measured)*. It is the same buffer for every layer — the scratch grows to the
   largest destination rect and is reused — so it is one term, not N.

   Mitigation is available and free: the scratch can be released between the
   composite phase and the PNG encode peak, in the same place 1C already drops
   the file bytes.

2. **`estimatePeakBytes` should learn the term.** It already has no production
   caller (backlogged); adding a term it will not be asked for is not progress.
   Recorded in *Noticed, not doing*.

3. **Nothing is adjusted twice.** The proxy pixels the editor holds are never
   used at export — 1C's whole premise — so there is no path on which the
   adjustment could be applied to an already-adjusted buffer. Worth stating
   because the identity-return aliasing of finding 1 makes double application a
   plausible-looking failure.

### Proxy fidelity — constraint (5), answered

**Every Phase 3 operation is scale-invariant by construction, because every one
is pointwise and carries no length parameter.**

| Operation | Depends on | Scale-invariant? |
|---|---|---|
| class-A LUT | the pixel's own channel value | Yes. Identical bytes at any resolution |
| `hsl` | the pixel's own three channels | Yes |
| `overlay` gradient | the pixel's **normalised** position in the layer rect | Yes. `(x + 0.5) / rect.width`, never a pixel offset |

The one place resolution enters at all is the *input* to the operation: at proxy
scale the input has been box-downscaled by `downscaleImage`, and at full
resolution it has not. So the preview shows the adjustment applied to an
averaged pixel and the export shows it applied to the original — which is the
same relationship a preview already has to an export for every blend mode, and
is bounded by the same argument. It is not a new class of divergence.

Radius-based effects would break this, which is the second ruling.

**What this buys**, and it is worth naming because it is unusual: the adjustment
parameters need no `proxyScale` term anywhere. There is no scaling rule to get
wrong, no place for a preview/export mismatch to hide, and no device-specific
calibration. That is the payment the radius exclusion buys.

### GPU/JS parity — constraint (6)

Adjustments double the conformance surface: each op needs a JS evaluator and a
GLSL body, and they must agree. Four mechanisms, in descending order of strength.

**1. For class A, divergence is structurally impossible.** The LUT is built once
in `src/adjust/lut.js` — shared plain ESM, Node-tested — and the GPU **uploads
those exact 768 bytes** as a 256 × 1 RGBA texture, sampled with `texelFetch`
(integer index, no filtering, no interpolation):

```glsl
int i = int(floor(c * 255.0 + 0.5));
vec3 adjusted = vec3(
  texelFetch(uLut, ivec2(i_r, 0), 0).r,
  texelFetch(uLut, ivec2(i_g, 0), 0).g,
  texelFetch(uLut, ivec2(i_b, 0), 0).b);
```

Both tiers read the same table. There is no shader arithmetic to diverge —
brightness, contrast, exposure, temperature, tint and every preset built from
them contribute **zero** new conformance risk. That is the majority of the
surface, and it is the design's answer to the parity problem.

The index conversion is exact on the default preview path: for a `NEAREST`
sample of an unorm8 texture, `c` is `float32(n/255)`, and `floor(c*255+0.5)`
recovers `n` for all `n` in 0..255 (the round-trip error is ~1.2e-7, far inside
the half-LSB margin). This is the same argument 1B makes for `NEAREST` at 1:1
being bit-exact, applied one stage later.

**2. For HSL and overlay, generation prevents omission and nothing prevents
divergence.** `src/adjust/ops.js` carries both bodies for each op, `glsl.js`
assembles the shader from it, and a Node test asserts the key sets match —
identical in construction to `test/gpu.mjs`'s existing assertion that
`GPU_BLEND_MODES` covers `BLEND_MODE_NAMES`. **That test proves the shader has
an entry for every op. It cannot prove the entry is right, because nothing in
this repository can compile GLSL.** 1B's accepted gap is restated verbatim for
the new surface.

**3. Conformance Table D.** `/conformance` gains a fourth table, built the same
way Table A is: for each op, a synthetic two-layer document over
`conformancePattern()` — which already sweeps every one of the 65,536
(backdrop, source) red pairs and eight alpha bands — with the op set to a
neutral value, a mid value and both extremes. Rendered by `renderProject` and by
the GPU, `flattenOnto` both, `compareBuffers(a, b, 1)`, reporting
`percent / percentReal / maxDelta / meanDelta` under 1B's existing PASS / WARN /
FAIL rule.

Two rows are mandatory and are the point of the table:

- **A neutral adjustment must be bit-identical to no adjustment**, on both
  tiers. This catches the whole class of "the pass runs and quantises even when
  it should do nothing", which is otherwise invisible.
- **A steep LUT on a transformed layer**, reported in its own pass — see the
  risk below.

**4. The residual risk, named rather than papered over.** On a **transformed**
layer the GPU samples through `LINEAR`, whose weights mobile GPUs compute at
~8 subtexel bits, giving 1B's documented routine deltas of 1–2 LSB. A LUT is a
step function, and a *steep* one — high contrast, a hard-toned preset — maps a
1-LSB index difference to an arbitrarily large output difference. **The
adjustment stage amplifies a divergence 1B measured and accepted.**

Three things bound it and none of them removes it:

- The **default preview path is 1:1 `NEAREST`** (1B finding 4), where `c` is
  exact and the amplification cannot occur at all. It occurs only on transformed
  layers.
- 1B already reports transformed layers as a **separate pass with WARN as the
  target**. Phase 3 adds `adjusted + transformed` as its own reported row, so
  the amplification is visible as itself rather than misattributed to the blend
  maths — which is precisely the failure 1B's four-column table exists to
  prevent.
- Presets are authored by us and can avoid pathological slopes. That is a
  mitigation on our own content, not on user parameters, and the Adjust sliders
  can reach a steep curve.

**Raising the tolerance is not on the table**, for the reason 1B gives: it would
forgive real bugs everywhere else.

### Filters — what a preset actually is

A preset is a **named bundle of the parameters above**, in `src/adjust/presets.js`,
as data:

```js
{ id: 'ember', label: 'Ember',
  brightness: 4, contrast: 18, temperature: 22, tint: -6,
  hsl: { bands: [...], saturation: -8 } }
```

Applying it writes those numbers into `layer.adjust` and sets
`preset: 'ember'`. Consequences, all of them good and all of them free:

- **Zero render cost.** A preset folds into the same composed LUT (and, when it
  uses one, the same single HSL evaluation). A filter is not an extra pass.
- **Presets are editable after applying.** Tap Ember, then open Adjust and pull
  the contrast back. PixelPerfect cannot do this; here it falls out of the model.
  Touching a slider clears `preset` to `'custom'` so the strip does not claim a
  look the numbers no longer are.
- **Intensity is one multiply.** A 0–100 strength slider scales every parameter
  in the bundle toward neutral before the LUT is built. One slider, no new op.
- **Undo is a single `setLayer`.** Undoing a preset restores the *previous*
  parameters, not neutral — which is what the *Definition of done* checks,
  because "undo a filter" resetting to none is the obvious wrong implementation.

Target: **12–16 presets**, tone and colour only, named by us. The set cannot
include anything built on blur or grain; see the second ruling and *Not doing*.

### Overlay, and assets and licensing

PixelPerfect ships **30 overlay textures** and a set of named filters. The
programme's founding spec already qualifies its use of that repository:
*"it contributes screen flow, layout patterns and (subject to licensing checks)
assets only."* Those checks resolve as follows.

**The repository has no LICENSE file.** Under default copyright that means the
assets are all-rights-reserved, and neither the 30 overlay PNGs nor the filter
implementations may be shipped. Two further points, both of which matter more
than they look:

- **The filter *parameters* are as much the author's work as the textures.**
  Copying the numbers out of a GLSL shader and calling them data would be
  copying. Our presets are authored from scratch; the reference contributes the
  *idea* that a filter strip exists and roughly what a strip of looks feels
  like, which is layout, not content.
- **"Ask for a licence later" is not a design.** A feature whose entire content
  is unlicensed third-party assets cannot be specified as shipping and then
  rescued by an email. So the feature is specified to not need them.

**Therefore Overlay ships as procedural gradients only**: linear (angle) or
radial (centre, radius), 2–4 colour stops, composited over the layer with any of
the 26 blend modes at an opacity. In normalised layer coordinates, so it is
scale-invariant; pointwise in position, so it tiles; generated from ~10 numbers,
so it adds nothing to the export peak and nothing to the APK.

That is a genuine subset of what PixelPerfect's Overlay does, and it is honest
about it: light leaks, duotone washes and colour grades are reachable; bokeh,
dust, scratches, lens flare and paper textures are not.

**A bitmap overlay library is deferred, not refused.** It needs three things
before it can be specified: (a) assets we have the right to ship, or that we
author; (b) a resampling rule and its proxy/full-res divergence budget, since a
texture stretched to a layer resamples differently at the two resolutions;
(c) an export-time memory line, because a full-resolution overlay texture is
another `w × h × 4` buffer resident during a walk whose peak formula is already
tight. Backlogged with those three preconditions attached.

**Gradient map** — luminance → colour ramp, the mechanism behind most duotone
looks — was considered and deferred. It is cross-channel, so it is a second
class-B op and a second divergent shader function, for one look. Recorded in
*Not doing* rather than half-built.

### UI

Four rail entries, PixelPerfect's sheet language throughout: `✕ / TITLE / ✓`,
~180dp of content, 50dp controls, all within Phase 2's bottom-two-thirds reach
rule.

| Tool | Sheet content |
|---|---|
| **Filter** | Horizontal strip of preset chips, each with a live thumbnail of *the selected layer* under that preset (built from the layer's existing 40 × 40 panel thumbnail through the same LUT — cheap, and it shows the user their own image rather than a stock one). Selected chip expands to an intensity slider |
| **Adjust** | Horizontal picker of the five class-A parameters; the selected one gets one slider with a numeric readout and a double-tap-to-reset |
| **HSL** | A row of eight colour swatches (the bands), then three sliders for the selected band, plus a global saturation slider |
| **Overlay** | Kind toggle (linear/radial), an angle or centre control, a stop editor, a blend-mode chip opening Phase 2's grouped 26-mode sub-sheet, and an opacity slider |

**Sheet semantics.** `✓` closes. `✕` discards the whole session by rolling
history back to the length recorded at open, through a new
`discardTo(project, historyLength)` in `edit.js` that pops without pushing to
`future` — six lines, no new command type, and it does not leave a discarded
experiment on the redo stack where the user would find it by accident.

**Every sheet requires a selection.** Phase 2 established that the rail carries
only tools that work and that greyed-out controls teach the user a control can
mean nothing. So the rail entries are always present and always enabled;
tapping one with nothing selected opens the **layers sheet** with a one-line
prompt, because a tool that needs a target should ask in the place targets are
chosen.

**Two disclosures, neither dismissible:**

- A layer carrying any non-neutral adjustment gets an **`◑ adjusted` badge** in
  the Phase 2 panel row, and joins a new **`Adjusted` filter chip**. Phase 2's
  badge rule — shown only when it differs from the default — applies unchanged.
- The debug readout gains the `lut: N / hsl: M` counters described above.

### States

| State | Trigger | What the screen shows |
|---|---|---|
| **No selection** | a raster tool tapped with nothing selected | The layers sheet, with *"Pick a layer to adjust."* Never a disabled sheet |
| **Neutral** | every parameter at its default | The reset control on each slider is absent, not disabled; the `Adjusted` badge is absent from the row |
| **Over budget** | `lastFrameMs > BUDGET` | Phase 2's ladder and `preview` pill, unchanged. Phase 3 adds only the two cost counters to the debug readout |
| **Unsupported blend mode on an overlay** | user picked one, then the file was reopened | Cannot arise — the overlay's mode is chosen from `BLEND_MODES`, which is our list, not the file's. Stated so the Phase 2 "mode not in the picker" handling is not duplicated here for no reason |
| **Preset drifted** | a slider touched after a preset | The strip shows `Custom`, and the previously-selected chip is no longer highlighted. Silently keeping the highlight would claim a look the numbers are not |

### Testing

Node suites, in `src/` where they run:

- **`src/adjust/lut.js`** — a neutral `adjust` yields the **identity** LUT,
  byte for byte (`lut[c*256+v] === v`); the composed LUT of `[a, b]` equals `b`
  applied to `a`'s output at all 768 entries; every parameter at both extremes
  produces a LUT with no `NaN` and no out-of-range byte; the digest changes iff
  a parameter changes.
- **`src/adjust/apply.js`** — **the aliasing assertion**: passing the same
  buffer as input and output throws (finding 1); a neutral `adjust` produces a
  buffer bit-identical to the input; **alpha is unchanged for every op at every
  parameter value** (invariant A, over the conformance pattern); overlay alpha
  is clamped by the source pixel's alpha.
- **`src/adjust/ops.js` / `glsl.js`** — the key sets of the JS evaluators and
  the GLSL bodies are identical, and every emitted body is non-empty. The same
  assertion shape as `test/gpu.mjs`'s blend-mode coverage test, and the same
  limit: it proves presence, never correctness.
- **`src/edit.js`** — an adjustment drag with one gesture key produces one
  history entry and does **not** bump `revision`; two drags produce two;
  `discardTo` returns the layer to its pre-sheet state and leaves `future`
  empty; `toProjectJson` → `applyProjectJson` round-trips every parameter;
  **mutating a stale `layer.adjust` reference does not corrupt undo** (the
  finding-3 test).
- **`src/sandwich.js`** — an adjustment change on the selected layer under a
  coalesce key reuses one cache build (`cache.builds` does not advance) while
  the rendered frame changes; a change on a layer *below* the selection does
  rebuild.
- **End-to-end** — `renderProject` at `scale: 1` on a project with a known
  adjustment matches a reference buffer computed independently; and the same
  project rendered through `createJsExportTarget` at scale 1 produces the
  identical buffer, which is the assertion that **preview and export agree**.

**What `npm test` still cannot cover**, unchanged and restated: anything the GPU
draws. Adjustments enlarge that gap by one shader stage. Table D on a device is
the only thing that closes it, and until 1B-2 exists there is no GPU to run it
against — so Table D ships running JS-against-itself as a regression baseline,
and the route says so on the page rather than showing a green table that means
nothing.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **The JS tier is the only tier that exists, and Phase 3 makes its measured 651 ms / 20-layer frame worse.** 1B-2 is not started and `selectTier` returns `TIER_JS` with `'shader probe not run'`. Every "the GPU makes this free" instinct is unavailable | **High** | The LUT collapse makes stack depth free, which is the largest single lever available without a GPU. The sandwich cache makes an adjustment drag cost one layer. The ladder measures rather than predicts. Beyond that the answer is honest: a 20-layer document with HSL on every layer is not interactively editable on this tier, and the spec says so instead of implying otherwise |
| **A steep LUT amplifies 1B's accepted 1–2 LSB `LINEAR` divergence on transformed layers into a visible colour difference** — on tiers that do not exist yet and cannot be tested from this repository | **High** | The default preview path is 1:1 `NEAREST`, where the index is exact and the amplification cannot occur. Table D reports `adjusted + transformed` as its own pass so it is attributed correctly. The tolerance is not raised. Unclosable without a device |
| **In-place adjustment would destructively overwrite `layer.pixels`**, because `resample()` identity-returns its input on the default preview path — and would compound frame over frame, so a held slider runs away | **High** | A runtime assertion in `applyAdjustments` that input and output buffers differ, plus a Node test for it. The scratch buffer is mandatory rather than an optimisation. Named in *Why this phase exists* so the plan cannot treat the identity return as a convenience |
| **Generation proves the shader has an entry per op; it cannot prove the entry is right.** Two implementations of HSL and of the gradient overlay must agree, and nothing in this repository compiles GLSL | **High** | Class A carries zero risk by construction (shared LUT bytes). Class B is deliberately held to one op. Table D on a device is the only real check, and it is manual — 1B's accepted gap, restated for a larger surface |
| **HSL's cost is estimated, not measured**, at 1.5–3× a blend pass. If it is worse, an HSL slider drag is unusable on the JS tier at any interesting layer count | Medium | The ladder measures the real frame and demotes. The `hsl: M` counter makes the term visible instead of buried in a total. A device report can move `BUDGET` or, if it must, gate HSL behind a layer-count threshold — which would be a new decision, taken with data |
| **The export peak gains one buffer of up to document size** (+66.4 MB for the measured poster, derived from 1C's arithmetic) on the JS export tier | Medium | One shared scratch, not one per layer; allocated only when some layer is non-neutral; released before the PNG encode peak, in the same place 1C drops the file bytes. `estimatePeakBytes` should learn the term — backlogged, since it still has no production caller |
| **Working in 0..255 gamma space makes "exposure" and "contrast" photometrically wrong**, and a user coming from a real photo editor will notice | Medium | Deliberate: linear light would make the JS compositor a systematically worse oracle, and it cannot be adopted in the same phase as validating a new feature. The UI never labels a control in photometric units. Recorded as an open question with the RGBA16F question it resembles |
| **Presets we author will be compared to PixelPerfect's**, and ours cannot include any look built on blur or grain | Medium | Stated in the ruling and in *Not doing*. The compensation is real and worth naming to the user: our presets are editable after applying, which theirs are not |
| **`layer.adjust` mutated in place silently destroys undo** — and the same hazard is *already live* for `layer.mask` from Phase 2 | Medium | `Object.freeze` on every built object, plus a Node test that mutates through a stale reference and asserts undo still restores. The Phase 2 instance is a separate backlog entry |
| **The first gesture after an adjustment is added picks its rung from a pre-adjustment measurement** and overshoots the budget once | Low | Self-corrects on the second gesture. Predicting cost from the model instead is exactly the guessing the measured ladder replaced |
| **Building a preset thumbnail per chip could stall the Filter sheet open** on a 16-preset strip | Low | Each is the existing 40 × 40 panel thumbnail through a 768-byte table — ~1,600 pixels per chip. Built lazily on chip visibility, cached by `(layer.id, preset, mutation)` |

---

## Open questions

- **What does an adjustment actually cost on a phone, per layer, for class A and
  for HSL separately?** Every cost figure in this spec is derived from the
  desktop 651 ms / 20-layer measurement by operation counting. The `lut` and
  `hsl` counters exist to make the first device run answer this.
- **Is HSL affordable at all on the JS tier?** If not, the honest options are a
  layer-count gate, evaluating it only at the reduced interaction scale during
  gestures, or cutting it from Phase 3 until a GPU exists. All three are worse
  than the current design and none should be chosen without data.
- **Should the whole adjustment stack become a small 3D LUT** (17³ or 33³,
  trilinear) once HSL's cost is known? It would collapse class B too and give it
  class A's parity property — at the cost of matching trilinear interpolation
  byte-for-byte across two tiers, ~15 KB per layer, and visible banding at hue
  band boundaries. Deferred until there is a measurement to justify it.
- **Does a per-layer tool rail match what a user reaches for?** PixelPerfect's
  tools are document-wide because it has one bitmap. A user opening a PSD may
  well expect "make the whole photo warmer", which this phase cannot do. The
  document-level adjustment deferred to Phase 5 is the answer if so — and the
  question is whether it should have been Phase 3 instead.
- **How many presets is the right number?** 12–16 is a guess sized to a
  horizontal strip on a phone, not to any measured preference.
- **Is `✕`-discards-the-session right**, or do users expect `✕` to close and
  keep — as it does on the layers sheet, which has no `✓` at all? The two
  sheets would then behave differently, which Phase 2's consistency rule
  dislikes. Currently resolved in favour of matching PixelPerfect on the tool
  sheets; worth putting in front of a user.
- **Should adjustments be copyable between layers?** The obvious request, and
  cheap (one frozen object), but it needs an interaction and a place to live.

---

## Not doing

- **Adjustment layers.** Ruled above: a new layer kind, a new command verb, and
  a permanent degradation of the sandwich cache. Backlogged with the ruling.
- **A document-level adjustment.** The cheap 80% of what a user wants, and the
  thing PixelPerfect actually does. Deferred to Phase 5, where framing and
  output live.
- **Blur, sharpen, unsharp mask, glow, bloom, drop shadow.** Ruled above on
  three independent grounds. They also remain out of scope for 1B and 1C for the
  tiling reason.
- **Grain and noise** — not scale-invariant, so preview and export would carry
  visibly different textures. **Vignette** — scale-invariant and tile-safe, but a
  document effect, so Phase 5.
- **Bitmap overlay textures.** No licence, an unbudgeted export-time buffer, and
  an unresolved resampling rule. Backlogged with those three preconditions.
- **Any PixelPerfect asset or filter parameter.** No LICENSE file means
  all-rights-reserved. Presets are authored here.
- **Gradient map, split toning, vibrance, clarity, dehaze, selective colour.**
  Each is a second cross-channel op — a second divergent shader function — for
  one look apiece.
- **Curves and levels editors** with draggable control points. The LUT
  mechanism would carry them; the interaction is a phone-sized design problem
  and the parameters are unbounded in a way presets are not.
- **Selective adjustment** — a brush or gradient that limits an adjustment to
  part of a layer. The layer mask the file already carries limits the whole
  layer; anything finer needs a brush, which is a tool, which is a later phase.
- **Baking an adjustment into pixels.** Not even as an opt-in "apply" action.
  There is no user need it serves that non-destructive storage does not, and it
  would be the one path that can lose data.
- **A per-layer adjusted-pixel cache.** ~60 MB at 20 full-canvas proxy layers
  against a ~36 MB steady-state footprint. The sandwich cache already covers the
  only repeated-render case.
- **Linear-light or wide-gamut colour.** Would make the JS compositor a worse
  oracle mid-validation. Same shape as 1B's deferred RGBA16F question, and it
  should be answered at the same time.
- **Raising the conformance tolerance above 1** to absorb LUT amplification.
  1B's reason stands: it would forgive real bugs everywhere else.
- **Browser-automated verification** of any of this. Excluded by project rules;
  the *Definition of done* checklist is the substitute and it is manual.

---

## Noticed, not doing

Findings from reading the code for this spec. None are Phase 3 work; all should
be appended to `docs/BACKLOG.md`, because a list that lives only in a spec is a
list nobody re-reads.

- **`resample()` may return its argument, and nothing says so at the call site.**
  `src/render.js:20` early-returns `src` when the dimensions match, and 1B's
  finding 4 establishes that this is the *default* path, not an edge case. So
  `drawLayerInto`'s local `pixels` is frequently `layer.pixels` itself. The
  backlog already carries the equivalent note for `downscaleImage`; `resample`
  deserves the same JSDoc line, and it is the precondition for the whole
  aliasing hazard in this phase.
- **`setLayer` captures object-valued `from` by reference, and this is already
  live for `layer.mask`.** `src/edit.js` does `from[key] = layer[key]`, so
  `setLayer(p, id, { mask: someMutatedObject })` writes an undo entry whose
  `from` and `to` are the same object. Phase 2 toggles the mask through exactly
  this path. Nothing enforces that callers build a new object, and the failure is
  invisible until someone presses undo.
- **`applyCommand`'s `set` branch is a blind `layer[key] = value`** with one
  special case for `text`. Every future object-valued field inherits the
  reference hazard above, and every future field that has a paired cache
  inherits the `rendered`/`renderedKey` hazard. A shape fix — a per-field
  descriptor saying "clone on capture" and "invalidate these caches" — would
  close both classes at once. Larger than Phase 3.
- **`hitTest` reads `layer.rendered || layer.pixels`, i.e. the *unadjusted*
  buffer.** Correct only while invariant A holds. If any future operation ever
  changes alpha — a "fade edges", an alpha curve, an eraser — selection silently
  stops matching what is drawn, and so do the layer mask's effective coverage and
  `composite.js`'s `alphaMap`. The invariant deserves to be asserted somewhere
  other than a spec.
- **`toProjectJson` does not persist `sourceIndex`.** Reopening a saved session
  therefore cannot export until the file is re-read and re-stamped. Not a Phase 3
  problem, but Phase 3 adds a second field (`adjust`) to the same round-trip and
  the omission is easier to see now.
- **`src/conformance.js` hard-codes `CONFORMANCE_MODES = SUPPORTED_BLEND_MODES`.**
  Table D needs a parallel export, and the route needs a way to say "this table
  has no GPU to compare against yet" rather than rendering an empty pass.
- **`estimatePeakBytes` still has no production caller** (already backlogged).
  Phase 3 adds a term to the export peak that ought to live in it, which is one
  more reason to wire it into 1C's export budget rather than leave it as
  executable documentation.
- **PixelPerfect's filter implementation is OpenGL ES fragment shaders in Java,
  and its parameters are authorship, not data.** The founding spec's
  "subject to licensing checks" resolves to "no licence", and that applies to the
  numbers as well as the PNGs. Worth recording once, in the backlog, so the
  question is not reopened every phase.
- **The four tool sheets are the first place `app/` will hold real per-frame
  logic** — slider-to-command plumbing, gesture keys, sheet-session history
  bookkeeping. `docs/BACKLOG.md` already flags that nothing under `app/` has
  automated coverage and that the src/-holds-the-logic division stops holding the
  moment real logic lands in a service. Phase 2 was the phase that made it bite;
  Phase 3 is the phase that makes it bite twice. The mitigation is the same and
  it is only a mitigation if the Angular side stays as thin as specified.
