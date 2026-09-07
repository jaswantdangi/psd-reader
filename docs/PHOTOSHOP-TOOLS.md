# Photoshop's Toolbar, Tool by Tool — and What Each One Costs Here

**Source**: Glen Smith, *Photoshop Toolbar 2026 — Every Tool* (interactive chart, `glensmith.co.uk/photoshop/tools`)
**Written**: 2026-09-07
**Purpose**: the working reference for implementing tools one at a time. Every entry says what
the tool does, *how it works*, which engine primitive it lands on, and what blocks it.

> **This is a planning document, not a commitment.** A row marked 🔴 is not a promise to build
> that tool. It records what building it would actually require, so the decision gets made with
> the cost visible rather than discovered halfway in.

## How to use this file

Each tool has a fixed row. When you implement one, change its status marker and note the
commit — do not delete the row, because the *mechanism* and *gate* columns stay true and the
next person needs them.

| Marker | Meaning |
|---|---|
| ✅ | Shipped and reachable in the app |
| 🟢 | Engine has it; the app has no UI for it |
| 🟡 | Adjacent — the primitives exist, assembly is the work |
| 🔴 | Blocked on one of the five gates below |
| ⬛ | Out of scope, with a reason |

---

## 1. How the toolbar is organised

**71 tools in 6 families**, plus 12 non-tool controls. Tools stack in *nests*: one toolbar slot
holds several tools, one letter selects the slot, `Shift`+letter cycles within it.

| Family | Tools | Shortcut nests |
|---|---|---|
| Move & Selection | 13 | `V` `M` `L` `W` |
| Crop & Slice | 5 | `C`, plus Frame (standalone) |
| Measurement | 5 | `I` |
| Retouching & Painting | 26 | `J` `B` `S` `Y` `E` `G` `O`, plus two keyless nests |
| Drawing & Type | 19 | `P` `T` `A` `U` |
| Navigation | 3 | `H` `R`, and Zoom |

Two nests genuinely have **no** keyboard shortcut — Blur/Sharpen/Smudge, and the Adjustment
Brush. That is correct Photoshop behaviour, not a gap in the chart. The chart also omits keys
for Frame (`K`) and Zoom (`Z`), which do have them.

**Where the chart and the website disagree** — the chart is right both times:

- **Selection Brush** — the website files it under Marquee; it lives in the Lasso nest, on `L`.
- **Content-Aware Tracing** — listed on the website, absent from the chart. It is a Technology
  Preview that must be enabled in Preferences, so it is not stock toolbar.

---

## 2. The classification that actually predicts cost

Tool names are the wrong axis. Sorted by **what a tool writes**, the 71 collapse into four
groups — and the group, not the tool, determines the work.

| Group | Count | Writes | Fits our command model? |
|---|---|---|---|
| **View-only** | 10 | Nothing in the document | N/A — view state only |
| **Layer geometry / properties** | 16 | A layer field | **Yes, exactly** — `{type:'set', id, from, to}` |
| **Selection-producing** | 14 | A mask | Only once a document selection exists (Gate 1) |
| **Pixel-writing** | 26 | A raster buffer | **No** — needs a different history (Gate 2) |

Two subsystems here already found this split independently, which is decent evidence it is the
real seam and not a convenient story:

- `src/sync/protocol.js` — `UNMAPPABLE_CHANGES = ['brush','filter','adjustment','maskPaint','layerEffect']`
  is *precisely* the pixel-writing group. The sync protocol already decided these can never
  cross the wire as operations.
- `src/segment/mask-ops.js` — `MASK_MODES = ['replace','add','subtract','intersect']` is
  Photoshop's four selection-combine modes, verbatim.

**Consequence for sync**: everything in the pixel-writing group is app-local by design.
Building the painting family needs **no protocol change**, because the protocol already
refuses to carry it.

---

## 3. The five gates

Almost nothing unbuilt is blocked on its own algorithm. Five missing primitives block nearly
all of it, and they are the only real architectural decisions on this list.

### Gate 1 — No document-level selection

Everything in `src/segment/` is a **per-layer cutout mask**. Photoshop's selection is
**document-scoped**: it floats above the layer stack, survives layer switches, and every other
tool reads it as a clip.

- **Unlocks**: 14 tools — 4 marquees, 4 lassos, 3 wand/quick/object, Quick Mask, 2 type masks
- **Already have**: `fullMask`, `emptyMask`, `combineMask` (with the exact four modes),
  `invertMask`, `featherMask`, `boxBlur`, `stampBrush`, `strokeMask`, `cutFraction` —
  all in `src/segment/mask-ops.js`
- **Actual work**: a `project.selection` field and its lifecycle (set / clear / invert /
  grow / save-to-mask), marching-ants rendering, and teaching every edit path to respect it
- **Verdict**: **cheapest high-leverage item on the list.** The mask maths is written; what is
  missing is one concept and its plumbing.

### Gate 2 — No raster undo

History is *property snapshots* — `commit(project, {type:'set', id, from, to})` at
`src/edit.js:632`, inverted by swapping `from` and `to`. A brush stroke's inverse is **the
pixels that were there**: a tile buffer, not a property diff.

- **Blocks**: all 26 pixel-writing tools
- **Actual work**: a genuinely separate history subsystem — dirty-tile snapshots, or a stroke
  replay log with periodic keyframes. Plus a memory budget, on a device already running
  `--max-old-space-size=6144` in tests and holding a proxy-scaled document
- **Verdict**: the largest decision on this page. **Do not start any painting tool before this
  is designed**, or the first one invents an undo model the other 25 have to live with.

### Gate 3 — No foreground / background colour state

Two swatches, with switch (`X`) and reset-to-black-and-white (`D`).

- **Blocks**: the whole painting family, Gradient, Paint Bucket, Quick Mask's overlay colour,
  Type colour, Shape fill
- **Actual work**: trivial — a two-colour signal, plus the Eyedropper that sets it
- **Verdict**: tiny, but **nothing in the painting family starts without it.** Build it first
  because it is a prerequisite, not because it is valuable alone.

### Gate 4 — No mesh / homography warp

Nothing anywhere resamples pixels through a non-affine transform.

- **Blocks**: **Perspective Crop** *and* **Liquify**
- **Note**: Liquify is why fixture `smart-filters-2` sits at **46.38%**. The mesh is already
  parsed and reachable at `placedLayer.filter.list[0].filter.liquifyMesh`
- **Verdict**: **one primitive closes two line items on two different lists** — a toolbar
  feature and a conformance gap. Best cost-to-value ratio of the five.

### Gate 5 — No vector path model

No path, anchor, bezier or shape-layer representation exists.

- **Blocks**: all 19 Drawing & Type vector tools — Pen ×6, Shapes ×7, Path Selection ×2, and
  both Type Masks via their outline
- **⚠️ Read this before citing the handoff**: `HANDOFF-engine-gpu-relay.md` says *"Do not build
  a vector path rasteriser for fidelity."* That verdict is **narrow and still correct** — it is
  about the *conformance number*. All 21 fixtures carry vector layers Photoshop already
  rasterised, so a rasteriser moves **zero pixels** and cannot be verified against the oracle.
  It says **nothing about authoring shapes**, which is a different justification with a
  different payoff. Do not read it as "no vector work, ever."

### Not a gate, but a wide blast radius — canvas rotation

`src/view.js` carries `docScale`, `panX`, `panY` and **no rotation term**. Rotate View needs a
fourth field threaded through `viewToDoc`, `docToView`, `clampView`, `zoomAbout` and every
hit-test in `src/gesture.js`. Small feature, touches a lot.

---

## 4. What the engine already has

Grounding for every "Engine primitive" cell below.

| Subsystem | File | Provides |
|---|---|---|
| Layer model + history | `src/edit.js` | kinds `image` / `text` / `group` / `adjustment`; commands `set` / `reorder` / `remove` / `frame` / `insert`; undo/redo by command inversion; gesture coalescing; `hitTest` |
| Blend modes | `src/edit.js:37` | 26 modes — Photoshop's full list |
| Adjustments | `src/adjust/ops.js` | `exposure` `temperature` `tint` `brightness` `contrast` (class A, composed into one 3×256 LUT), `hsl` (class B), `overlay` (class P, positional) |
| Presets | `src/adjust/presets.js` | 14 named looks |
| **Gradients** | `src/adjust/ops.js` → `normaliseOverlay` | **linear + radial, multi-stop RGBA, `angle` / `cx` / `cy` / `radius`, blend mode, GLSL, scale-invariant.** Plus an `image` kind (texture fill) |
| Crop & canvas | `src/frame/frame.js` | `setFrame`, `setRatio`, `resizeCanvas` with 9 anchors, `framingReport`, `layerFate` |
| Creative | `src/creative/{image,text,layers}.js` | `insertImageLayer`, `replaceImage`, `insertTextLayer`, `retypeText`, `resizeTextBox`, `blankLayer`, `insertLayer`, `removeLayer`, `centreIn` |
| Masks | `src/mask.js` | `layerRect`, `pixelRect`, `projectMask`, `downscaleMask`, `resampleMask` |
| Mask ops | `src/segment/mask-ops.js` | `fullMask`, `emptyMask`, `combineMask`, `invertMask`, `boxBlur`, `featherMask`, `stampBrush`, `stampInto`, `strokeMask`, `isOpaque`, `cutFraction`, `MASK_MODES` |
| Segmentation | `src/segment/{models,cutout,refine,edge}.js` | models `BASE` / `CLICK` / `PORTRAIT` / `LITE`; `buildCutout`, `applyCutout`, `paintMask`, `guidedRefine`, `decontaminate`, `applyEdge` |
| View | `src/view.js` | pan + zoom, `fitView`, `zoomAbout`, `clampView`, doc↔view mapping. **No rotation** |
| Gestures | `src/gesture.js` | corner handles, tap/drag arbitration, resize-from-anchor, render-mode budgeting |
| Compositor | `src/composite.js` | the correctness oracle — blend modes, artboards, Blend If |
| GPU | `src/gpu/` | GLSL generation, draw plans, blend modes. **Never compiled — see handoff** |
| Export | `src/export/` | tiled full-resolution PNG streaming |

---

## 5. The tools

### 5.1 Move & Selection — 13 tools

#### Move nest — `V`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 1 | **Move** | `V` | Repositions layer content | Translate the layer origin; auto-select picks the layer under the pointer | `setLayer{x,y}`, `gesture.moveBy`, `hitTest` | ✅ |
| 2 | **Artboard** | `V` | Creates and manages artboards | An artboard is a group with a rect that both **clips** and **fills** | `applyArtboard` in `composite.js` — bit-exact | 🟡 |

**Artboard note.** Reading is done and verified (`artboards.src.psd` 9.79% → 0.00%). Two gaps:
`renderProject` does **not** clip, because it walks the flat `project.layers` — the rect has to
be carried onto each leaf in `flatten()` at `src/edit.js:374`. And nothing can *create* an
artboard. The renderer half is already on the handoff's list and is **held by the other
session**, which owns `src/edit.js`.

#### Marquee nest — `M`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 3 | **Rectangular Marquee** | `M` | Rectangular selection | Rasterise a rect into the selection mask, combine by mode | `fullMask` + `combineMask` | 🟡 Gate 1 |
| 4 | **Elliptical Marquee** | `M` | Oval / circular selection | Same, with an antialiased ellipse edge | `combineMask`, `featherMask` | 🟡 Gate 1 |
| 5 | **Single Row Marquee** | — | One-pixel horizontal row | Degenerate rect, height 1 | `combineMask` | 🟡 Gate 1 |
| 6 | **Single Column Marquee** | — | One-pixel vertical column | Degenerate rect, width 1 | `combineMask` | 🟡 Gate 1 |

All four share one implementation and differ only in which rect they rasterise. Modifiers
(`Shift` add, `Alt` subtract, `Shift+Alt` intersect) map **1:1** onto `MASK_MODES`.

#### Lasso nest — `L`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 7 | **Selection Brush** | `L` | Paints a selection freehand | Stamp a brush dab along the stroke, into the selection mask | `strokeMask` + `stampBrush` — **already written** | 🟡 Gate 1 |
| 8 | **Lasso** | `L` | Freehand selection outline | Accumulate points, auto-close, scanline-fill the polygon | polygon fill (new, small) | 🟡 Gate 1 |
| 9 | **Polygonal Lasso** | `L` | Straight-line segments | Click to place vertices; same fill as Lasso | shares #8 | 🟡 Gate 1 |
| 10 | **Magnetic Lasso** | `L` | Snaps the path to image edges | Live-wire: least-cost path over a gradient-magnitude cost field between anchors | needs an edge-cost field; `src/segment/edge.js` is adjacent | 🟡 Gate 1 |

Selection Brush is the cheapest of the four here — `strokeMask` and `stampBrush` already exist
and already do exactly this. It is arguably the **first selection tool to build**, because it
proves Gate 1 end to end with almost no new algorithm.

#### Smart-selection nest — `W`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 11 | **Object Selection** | `W` | Box or click, ML isolates the object | Segmentation model returns logits, thresholded to a mask | `segment/` `CLICK` + `BASE` models — **shipped, as background removal** | 🟢 Gate 1 to reframe |
| 12 | **Quick Selection** | `W` | Brush that grows into similar adjacent pixels | Region growing / graph-cut seeded by the brush stroke | `guidedRefine` + `mask-ops` | 🟡 Gate 1 |
| 13 | **Magic Wand** | `W` | Selects uniform colour within a tolerance | Flood fill on colour distance; flags for tolerance, antialias, contiguous, sample-all-layers | none — but roughly 50 lines | 🟡 Gate 1 |

**Object Selection is effectively already built** and mis-framed. The `CLICK` model *is*
click-to-segment; it is wired to the cut-out panel as "background removal" rather than as a
selection tool. Reframing it costs Gate 1 and a UI entry, not a model.

---

### 5.2 Crop & Slice — 5 tools

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 14 | **Crop** | `C` | Removes outer image areas | Set the document frame; layers keep their pixels | `frame/frame.js` — `setFrame`, `setRatio`, `framingReport`, `layerFate` | ✅ |
| 15 | **Perspective Crop** | `C` | Crops while correcting perspective | Four corners → target rect: solve a homography, inverse-map resample | **none** | 🔴 Gate 4 |
| 16 | **Slice** | `C` | Divides an image for web export | Rect regions written as export metadata | — | ⬛ web-export era |
| 17 | **Slice Select** | `C` | Manages sliced regions | — | — | ⬛ |
| 18 | **Frame** | `K` | A shape that contains and masks a placed image | Layer with a clipping rect plus a fit mode | `layer.clipping` exists; `IMAGE_FITS = ['contain','stretch']` exists | 🟡 |

Crop is genuinely complete, including the parts usually skipped — nine canvas anchors, ratio
locking, and a per-layer report of what a crop would destroy.

---

### 5.3 Measurement — 5 tools, nest `I`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 19 | **Eyedropper** | `I` | Samples a colour into the foreground swatch | Read the composited pixel at a point; optional N×N average | renderer can already read back | 🟡 Gate 3 |
| 20 | **Color Sampler** | `I` | Up to 10 persistent readout points | Stored doc-space points, re-read on every change | — | ⬛ low value |
| 21 | **Ruler** | `I` | Measures distance and angle; also straightens | Two points; the straighten action rotates the canvas | needs canvas rotation | ⬛ low value |
| 22 | **Note** | `I` | Text annotation stored in the PSD | An annotation record in the file | — | ⬛ low value |
| 23 | **Count** | `I` | Tallies objects by clicking | Numbered markers | — | ⬛ |

**Eyedropper is the only one worth building**, and only because Gate 3 needs it — a colour
swatch you cannot fill from the image is close to useless on a touch device.

---

### 5.4 Retouching & Painting — 26 tools

**Every tool in this section is behind Gate 2 (raster undo), with two exceptions called out
below.** Read the Gate 2 section before starting any of them.

#### Healing nest — `J`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 24 | **Spot Healing Brush** | `J` | Removes blemishes with no source point | Content-aware fill over the dab — PatchMatch-style synthesis from surroundings | none | 🔴 Gate 2 |
| 25 | **Remove** | `J` | AI object removal | An inpainting model | none — but `segment/` already ships an ONNX-style model pipeline to reuse | 🔴 Gate 2 + model |
| 26 | **Healing Brush** | `J` | Clones from a source, blending texture and tone | Gradient-domain (Poisson) blend of source texture into destination colour | none | 🔴 Gate 2 |
| 27 | **Patch** | `J` | Lasso a region, drag it onto a source | Region-level healing — same blend, selection-driven | none | 🔴 Gate 2 + Gate 1 |
| 28 | **Content-Aware Move** | `J` | Moves a selection and fills the hole | Move + inpaint the vacated region | none | 🔴 Gate 2 + Gate 1 |
| 29 | **Red Eye** | `J` | Fixes red-eye | Desaturate and darken red-dominant pixels inside a small region | `hsl` band weights already target hue ranges | 🟡 **simplest in the nest** |

Red Eye is a hue-targeted local adjustment, not synthesis. If it were expressed as an
adjustment over a mask rather than as painted pixels, it **skips Gate 2 entirely**.

#### Brush nest — `B`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 30 | **Brush** | `B` | Paints strokes | Stamp dabs along the path at a spacing fraction; hardness, flow, opacity, blend mode | `stampBrush` (masks only) | 🔴 Gate 2 + 3 |
| 31 | **Pencil** | `B` | Hard-edged aliased strokes | Same, antialiasing off | shares #30 | 🔴 Gate 2 + 3 |
| 32 | **Colour Replacement** | `B` | Repaints hue, keeps luminosity | Per-pixel hue/sat substitution within a tolerance of the sampled colour | `hsl` op is the same maths | 🔴 Gate 2 + 3 |
| 33 | **Mixer Brush** | `B` | Blends like wet paint | Carries a paint reservoir; picks up and deposits colour per dab | none | 🔴 Gate 2 + 3 |

#### Stamp nest — `S`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 34 | **Clone Stamp** | `S` | Copies pixels from a sampled offset | Dab reads from `point + fixed offset`, aligned or not | none | 🔴 Gate 2 |
| 35 | **Pattern Stamp** | `S` | Paints a tiling pattern | Dab reads from a tiled pattern source | `overlay` `image` kind is adjacent | 🔴 Gate 2 |

#### History nest — `Y`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 36 | **History Brush** | `Y` | Paints back from an earlier state | Dab reads from a named history snapshot | none | 🔴 Gate 2, *strictly after* |
| 37 | **Art History Brush** | `Y` | Stylised strokes from a history state | Same source, stroke synthesis on top | none | 🔴 Gate 2, *strictly after* |

These two need Gate 2's snapshots to exist **as addressable states**, not just as an undo
stack. That is a stronger requirement than the rest of the section — build them last.

#### Eraser nest — `E`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 38 | **Eraser** | `E` | Erases to transparency | Dab writes alpha 0 (or the background colour on a Background layer) | `paintMask` is the mask-side twin | 🔴 Gate 2 |
| 39 | **Background Eraser** | `E` | Erases the colour under the crosshair, keeps edges | Per-dab: sample the hotspot, erase pixels within tolerance, protect the foreground colour | none | 🔴 Gate 2 |
| 40 | **Magic Eraser** | `E` | Erases a uniform colour region | Magic Wand flood fill, then delete | shares #13 | 🔴 Gate 2 |

#### Gradient nest — `G`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 41 | **Gradient** | `G` | Drag defines the axis of a colour ramp | Project each pixel onto the drag axis → `t`, look up the stop ramp | **`overlay`: linear + radial, multi-stop RGBA, `angle`/`cx`/`cy`/`radius`, blend mode, GLSL** | 🟡 **strong candidate** |
| 42 | **Paint Bucket** | `G` | Fills an enclosed area | Magic Wand flood fill, then fill with foreground colour or a pattern | shares #13 | 🔴 Gate 2 + 3 |

**The Gradient tool is much closer than it looks.** The ramp evaluator, the multi-stop model,
the polar parameters a drag would set, and the GLSL all exist — as a *layer adjustment* in
`normaliseOverlay`. What is missing is only:

1. the drag interaction that writes `angle` / `cx` / `cy` / `radius` (`gesture.js` is the right home);
2. the three gradient kinds Photoshop has and `OVERLAY_KINDS` does not — **reflected, angle, diamond**;
3. optionally, applying it as pixels rather than as a non-destructive adjustment — which is
   what would drag it behind Gate 2. **Shipped as an adjustment, it skips Gate 2.**

#### Blur nest — no shortcut

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 43 | **Blur** | — | Softens locally | Convolution over the dab footprint | `boxBlur` exists, for **masks** not colour | 🔴 Gate 2 |
| 44 | **Sharpen** | — | Enhances local edges | Unsharp mask over the dab | none | 🔴 Gate 2 |
| 45 | **Smudge** | — | Smears pixels along the stroke | Each dab carries colour picked up from the previous position | none | 🔴 Gate 2 |

#### Adjustment Brush — no shortcut

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 46 | **Adjustment Brush** | — | Paints a **local, non-destructive** adjustment | An adjustment plus a mask that scopes it — the stroke writes the *mask*, not pixels | `adjust/ops.js` + `paintMask` + `stampBrush` — **both halves exist** | 🟡 **skips Gate 2** |

**This is the highest-value tool in the whole section.** It gives the *feel* of painting —
brushing an effect onto part of an image — while writing only a mask, so it is fully invertible
under the existing command history. It needs Gate 3 (a colour is not even required for most
uses) and nothing else.

#### Dodge nest — `O`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 47 | **Dodge** | `O` | Lightens | Tone-range-weighted gain — shadows / midtones / highlights, with an exposure amount | `exposure` op + tone weighting | 🔴 Gate 2 *or* via #46 |
| 48 | **Burn** | `O` | Darkens | Same, negative | shares #47 | 🔴 Gate 2 *or* via #46 |
| 49 | **Sponge** | `O` | Saturates or desaturates | Saturation gain over the dab | `hsl` saturation exists | 🔴 Gate 2 *or* via #46 |

All three are **local adjustments wearing a brush costume**. Routed through the Adjustment
Brush (#46) they need no raster history at all. That is very likely the right way to ship them.

---

### 5.5 Drawing & Type — 19 tools

#### Pen nest — `P` — all Gate 5

| # | Tool | Key | What it does | Mechanism | Status |
|---|---|---|---|---|---|
| 50 | **Pen** | `P` | Precise paths | Place anchors, drag to set handles → cubic bezier | 🔴 Gate 5 |
| 51 | **Freeform Pen** | `P` | Freehand paths | Sample the drag, fit curves to the point sequence | 🔴 Gate 5 |
| 52 | **Curvature Pen** | `P` | Curves without handles | Click points, infer smooth handles between them | 🔴 Gate 5 |
| 53 | **Add Anchor Point** | — | Adds a node | Split a segment, de Casteljau at `t` — the shape must not change | 🔴 Gate 5 |
| 54 | **Delete Anchor Point** | — | Removes a node | Remove and refit the neighbouring segments | 🔴 Gate 5 |
| 55 | **Convert Point** | — | Corner ↔ smooth | Break or mirror the handle pair at an anchor | 🔴 Gate 5 |

#### Type nest — `T`

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 56 | **Horizontal Type** | `T` | Horizontal text | Text layer, rasterised at its target size | `creative/text.js` — `insertTextLayer`, `retypeText`, `resizeTextBox`, `liveTextRect` | ✅ |
| 57 | **Vertical Type** | `T` | Vertical text | Vertical writing mode: stacked advance, per-glyph rotation rules for Latin vs CJK | needs writing-mode in the text renderer | 🟡 |
| 58 | **Vertical Type Mask** | `T` | Vertical text as a selection | Glyph outlines → selection mask | 🔴 Gate 1 + #57 |
| 59 | **Horizontal Type Mask** | `T` | Horizontal text as a selection | Glyph outlines → selection mask | 🔴 Gate 1 |

Text is the one authoring feature that is genuinely finished — including box resize, live
rect, and a resample-vs-re-rasterise decision that is recorded in history (`src/edit.js:646`),
so undoing a text resize cannot strand the layer on the wrong renderer.

#### Path Selection nest — `A` — Gate 5

| # | Tool | Key | What it does | Mechanism | Status |
|---|---|---|---|---|---|
| 60 | **Path Selection** | `A` | Selects and moves whole paths | Hit-test the path, translate all anchors | 🔴 Gate 5 |
| 61 | **Direct Selection** | `A` | Adjusts individual points and handles | Hit-test anchors and handles, move one | 🔴 Gate 5 |

#### Shape nest — `U` — Gate 5

| # | Tool | Key | What it does | Mechanism | Status |
|---|---|---|---|---|---|
| 62 | **Rectangle** | `U` | Rectangles | Four anchors, with live per-corner radii | 🔴 Gate 5 |
| 63 | **Ellipse** | `U` | Ellipses and circles | Four-arc bezier approximation | 🔴 Gate 5 |
| 64 | **Triangle** | `U` | Triangles | Three anchors, optional corner radius | 🔴 Gate 5 |
| 65 | **Polygon** | `U` | N-sided polygons | N anchors on a circle | 🔴 Gate 5 |
| 66 | **Star** | `U` | Stars | N points with an indent ratio — split out from Polygon in recent versions | 🔴 Gate 5 |
| 67 | **Line** | `U` | Straight lines | Two anchors, stroke weight, optional arrowheads | 🔴 Gate 5 |
| 68 | **Custom Shape** | `U` | Preset shapes | Path from a library | 🔴 Gate 5 |

Once Gate 5 exists, these seven are **one implementation and seven parameter generators** —
they all emit a path and share the fill / stroke / live-corner machinery.

---

### 5.6 Navigation — 3 tools

| # | Tool | Key | What it does | Mechanism | Engine primitive | Status |
|---|---|---|---|---|---|---|
| 69 | **Hand** | `H` | Pans the view | Translate `panX` / `panY`, clamped | `view.js` — `clampView`; pan gesture | ✅ |
| 70 | **Rotate View** | `R` | Rotates the canvas view only | A view-space rotation; the document is untouched | **missing** — see the note under the gates | 🔴 |
| 71 | **Zoom** | `Z` | Magnifies and reduces | Scale about a focal point, clamped to `MIN_DOC_SCALE`..`maxDocScale` | `view.js` — `zoomAbout`, `fitView` | ✅ |

---

### 5.7 Non-tool controls — 12

| Control | Key | Notes | Status |
|---|---|---|---|
| **Foreground colour** | — | Gate 3 | 🔴 |
| **Background colour** | — | Gate 3 | 🔴 |
| **Switch foreground / background** | `X` | Gate 3 | 🔴 |
| **Default black & white** | `D` | Gate 3 | 🔴 |
| **Quick Mask** | `Q` | Once Gate 1 exists this is a **render mode**, not a feature: show the selection as a red overlay and let brush tools edit it | 🟡 Gate 1 |
| **Standard Screen Mode** | `F` | Desktop chrome concept | ⬛ mobile |
| **Full Screen with Menu Bar** | `F` | | ⬛ mobile |
| **Full Screen** | `F` | | ⬛ mobile |
| **Edit Toolbar** | — | Customise the toolbar. Our rail is already curated — `RAIL` in `editor.page.ts:37` carries only tools that work | ⬛ |
| **Add from device** | — | Place an image from the filesystem | ✅ `insertImageLayer` |
| **Add free Adobe Stock images** | — | Adobe service | ⬛ |
| **Generate image** | — | Adobe Firefly | ⬛ needs a service |

The rail's own comment — *"The rail carries only tools that work. Phase 4-5 entries are absent,
not greyed"* — is the right policy and should survive everything on this page. **Do not add a
disabled tool button to the rail as a roadmap marker.** That is what this file is for.

---

## 6. Suggested build order

Ordered by what unblocks the most for the least, not by tool popularity.

### Phase A — the cheap unlocks (roughly 16 tools)

1. **Gate 3** — foreground / background swatches, `X`, `D`
2. **Eyedropper** (#19) — makes Gate 3 usable on a touch device
3. **Gate 1** — `project.selection`, its lifecycle, marching ants
4. **Selection Brush** (#7) — proves Gate 1 end to end with **zero new algorithm**
5. **Marquees** (#3–6) — one implementation, four rect generators
6. **Magic Wand** (#13) — flood fill; unlocks Magic Eraser and Paint Bucket later
7. **Lasso / Polygonal Lasso** (#8, #9) — one polygon fill, two input modes
8. **Quick Mask** (`Q`) — a render mode over Gate 1
9. **Reframe Object Selection** (#11) — the model is already shipped

### Phase B — high value, still no raster history

10. **Adjustment Brush** (#46) — both halves exist; gives the feel of painting without Gate 2
11. **Dodge / Burn / Sponge** (#47–49) — routed through #46
12. **Red Eye** (#29) — a hue-targeted local adjustment, same route
13. **Gradient** (#41) — drag interaction over the existing `overlay` engine, plus the three
    missing kinds

### Phase C — one primitive, two payoffs

14. **Gate 4** — mesh / homography warp
15. **Perspective Crop** (#15), and **Liquify**, which closes `smart-filters-2` at 46.38%

### Phase D — the wall

16. **Gate 2** — raster history. Design it fully before writing a single brush
17. The painting family (#30–45) — Brush and Eraser first, History Brushes last

### Phase E — vector

18. **Gate 5** — path model
19. Shapes (#62–68) first — one implementation, seven generators — then Pen (#50–55), then the
    Type Masks (#58, #59)

**Phases A and B together convert about 16 tools from absent to shipped using code that already
exists**, and neither depends on the two unknowns currently blocking the branch (the unrun UXP
plugin, the never-compiled GLSL).

---

## 7. Corrections this analysis produced

Recorded here because they change what a future session would conclude from the existing docs.

1. **`HANDOFF-engine-gpu-relay.md`'s "do not build a vector path rasteriser" needs a scope
   line.** It is a verdict about the *conformance number*, and reads as a blanket ban on vector
   work. Authoring shapes is a different justification with a different payoff (19 tools).
2. **Object Selection is already built and mis-labelled.** The `segment/` `CLICK` model is
   click-to-segment; it is presented only as background removal.
3. **A gradient engine already exists** in `normaliseOverlay` — multi-stop, linear and radial,
   with GLSL. Nothing in the docs says so, and "gradient tool" reads as greenfield.
4. **`MASK_MODES` is Photoshop's selection-combine model, verbatim.** Whoever wrote it built
   the selection semantics before there was a selection.
5. **Liquify and Perspective Crop are the same missing primitive.** They sit on two different
   lists — a conformance gap and a toolbar gap — and neither list mentions the other.

## 8. Not analysed here

- **Menu commands** — Filters, Transform, Layer Styles, Adjustments-as-layers. The toolbar is
  a fraction of Photoshop's surface, and `effects` (layer styles, 23.03%) is already tracked in
  the handoff as a nine-sub-feature conformance gap, not a tool.
- **Tool *options bars*.** Each of the 71 has one, and the options often carry more behaviour
  than the tool. Worth its own pass before implementing any single tool in depth.
- **Brush engine parameters** — dynamics, tip shapes, texture, dual brush, scattering. Assume
  the first brush ships with spacing, hardness, size, flow and opacity, and nothing else.
