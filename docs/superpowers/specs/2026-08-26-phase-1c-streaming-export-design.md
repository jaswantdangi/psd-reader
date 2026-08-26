# Phase 1C — Full-Resolution Streaming Export

**Date**: 2026-08-26
**Status**: Design drafted, implementation plan not yet written
**Phase**: 1C of Phase 1 (see the [Phase 1 design](2026-08-25-phase-1-engine-gpu-memory-design.md))

---

## Programme context

Phase 1 of the mobile-first PSD editor splits into three plans:

| # | Plan | State |
|---|---|---|
| 1A | Workspace + proxy load pipeline | **complete** — `src/proxy.js`, `src/budget.js`, `src/load.js`, `app/` |
| 1B | GPU compositor, tier selection, `OffscreenCanvas` text, conformance route | not started |
| **1C** | **Full-resolution streaming export** | **this document** |

1C closes the last clause of the Phase 1 definition of done — *"and export a full-res
PNG"*. Its architecture was already decided in the Phase 1 spec's **Export pipeline**
section; this document specifies that decision rather than revisiting it.

1C depends on 1B and cannot ship before it. Two of 1B's deliverables are load-bearing
here: the WebGL2 tier (which is what tiling is for) and the `OffscreenCanvas` text
abstraction (without which every edited text layer silently vanishes from the export —
see *Text is not exempt*).

---

## Why this phase exists

Editing happens at proxy resolution. A 4961×3508 poster is edited against a
1024-edge proxy at `proxyScale ≈ 0.2064`, so every raster layer in memory is roughly
1/23rd of its real pixel count. Compositing those proxies at `scale: 1` — which is what
`demo/editor.js:453` does today, and what `HarnessPage` would do if asked — would
upscale a 1024-edge bitmap to 4961 px and produce a blurred image at the right
dimensions. That is the worst failure shape available: it looks like it worked.

So export cannot use the pixels the editor is holding. It has to go back to the file.

### What is already measured

Cited from the Phase 1 spike; **not re-derived here**.

| Quantity | Value |
|---|---|
| Full-res JS export, desktop, 4961×3508 / 6 layers | **3.1 s** untransformed, **4.3 s** transformed |
| Same on mobile (3–5× slower) | **12–20 s** |
| Peak memory formula (validated to 1%) | `file bytes + one full-res layer + Σ(proxy layers)` |
| Poster file on disk | **303 MB** |
| Poster decoded pixels, all 6 layers | **398 MB** |
| One full-res layer at canvas size | **66 MB** (4961 × 3508 × 4 = 69,617,552 B) |

Everything below marked *(estimate)* is arithmetic on top of these, or a judgement
call, and is flagged as such. Nothing new has been measured for this document.

### What has to change to make export work

1. **`project.source.uri` is a lie today.** `HarnessPage` passes `` `file://${file.name}` ``
   (`app/src/app/harness/harness.page.ts:62`). Nothing can re-read it. Recorded in
   `docs/BACKLOG.md` under *App* — it is the item that blocks this phase.
2. **Nothing in the project identifies which file layer a project layer came from.**
   The reader's decode order and `createProject`'s flatten order agree today only by
   coincidence of two independent tree walks, and they diverge for pixel-less leaf
   nodes (see *Layer identity*).
3. **`renderProject` has no streaming mode.** It takes a whole project with all pixels
   resident and walks it. Export needs the inverse: pixels arriving one at a time.
4. **Nothing knows the device's texture limits.** 1B queries them for the preview; 1C
   needs them for a canvas that may be larger than any single texture.

---

## Definition of done

> On a phone, open the 4961×3508 poster, reorder two layers, move a third, and export
> a full-resolution PNG that matches a full-resolution reference composite within the
> project's tolerance of 1 — with a progress indicator throughout, a working cancel,
> and no temporary files left behind afterwards.

Concretely, all of:

- [ ] A **Node** suite asserts that the streaming export of a proxy-loaded project is
      pixel-identical to `renderProject(eagerProject, { scale: 1 })` — the existing
      full-res path from `demo/editor.js:454` — for a fixture, **with layers reordered**
      so the spill path is the one under test.
- [ ] Peak memory during export stays inside `file + largest full-res layer + output
      buffer`, on both the fast and the spill path.
- [ ] Cancelling, and killing the app mid-export, both leave zero bytes in the spill
      directory (the second via a sweep at next launch, not via a `finally`).
- [ ] Export succeeds on a device whose `MAX_TEXTURE_SIZE` is 4096 with a document
      wider than 4096.
- [ ] Export succeeds on the JS fallback tier with the same progress and cancel UI.
- [ ] An edited text layer exports sharp; an untouched Photoshop text layer exports at
      full resolution, not upscaled from its proxy.
- [ ] A source file that has become unreadable produces a named error, never a partial
      or blurred PNG.

Out of scope for 1C: crop, aspect-ratio framing, output presets, quality sliders,
watermarks, batch export. Those are Phase 5.

---

## Decisions

| Decision | Rationale |
|---|---|
| Export re-reads the file and streams full-res layers, one at a time | Decided in the Phase 1 spec. Peak is `file + one full layer + output` ≈ 436 MB for the poster — the same order as load's 449 MB, so no new ceiling |
| The engine takes **injected `readSource` and spill adapters**; it never imports Capacitor | House rule: `src/` is plain ESM with no framework imports. Keeps the whole export walk testable in Node against `fs` and a `Map` |
| A **`sourceIndex`** stamped during load is the only layer identity | Decode order and flatten order are two independent tree walks that agree by luck and diverge on pixel-less leaves. Matching by array position is a latent, silent corruption |
| Fast path when `sourceIndex` is monotonic across the draw order | Decided in the Phase 1 spec. Detection is one pass over ≤ a few hundred integers |
| The spill path **spills only what it must**, not every layer | Blend directly while the arriving layer is the next one needed; spill only layers needed later. Moving one layer down spills one layer, not six. Strictly never worse than spilling everything |
| Spill format is a 16-byte header plus **raw straight-alpha RGBA** — no compression | The files live for seconds. Deflating 66 MB in JS costs more than the write it saves. The header makes the file self-describing so a truncated spill is caught, not blended |
| Spill writes are **chunked base64 appends**, not one `writeFile` | Capacitor Filesystem takes base64 on native. Encoding a whole 66 MB layer materialises an ~88.6 MB string *(estimate)* on top of the 436 MB peak — that alone would raise the ceiling. 4 MB chunks cap the extra at ~5.3 MB |
| Spill lives in `Directory.Cache`, in a per-export directory, with a **sweep at next launch** | `finally` does not run when the OS kills the process, and a backgrounded app holding ~450 MB is a prime OOM-kill target. A sweep is the only cleanup that survives a kill |
| Compositing is **layer-major, tile-minor** | Tile-major would re-read the file once per tile — 6 full decodes for the poster at 2048 px tiles. Layer-major keeps it to one pass; all tile accumulators stay resident, which is just the output buffer partitioned |
| Tile edge is `min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE, MAX_VIEWPORT_DIMS, 2048)` | `MAX_TEXTURE_SIZE` alone is not the binding limit — a renderbuffer or viewport can be smaller. 2048 caps GPU memory at ~100 MB for the poster instead of ~200 MB at 4096. **2048 is an estimate; it needs device calibration** |
| Layer slices upload via `texSubImage2D` with `UNPACK_ROW_LENGTH` / `UNPACK_SKIP_*` | WebGL2-only, and it uploads a sub-rectangle straight out of the layer's RGBA array with no CPU-side copy. Without it every tile costs a temporary slice buffer |
| **Text is never exempt from the re-read** | Honours the Phase 1 spec's dated correction. `src/render.js:143` gates the sharp path on `layer.rerendered`, which starts `false`. See *Text is not exempt* |
| Export **fails loudly** when a `rerendered` layer yields null pixels | `rasteriseTextAt` returns `null` without a canvas, and `renderProject` then `continue`s — the layer disappears from a PNG that otherwise looks fine. A missing layer must be an error, not a silent omission |
| Export passes a **`wantLayer` predicate** to the reader so hidden layers are never decoded | Hidden layers are pure waste on the critical path. Three lines in `reader.js`; the index counter must still advance for skipped layers or `sourceIndex` alignment breaks |
| Export passes `metadata: false` **and** suppresses the `Patt` byte-scan | `containsKey` makes three naive O(n·m) passes over the whole file (`docs/BACKLOG.md`, *Engine*). On a 303 MB file, on the export critical path, for a warning already surfaced at load |
| Output is **PNG + project JSON**, via existing `toProjectJson` | PSD writing stays permanently out of scope, unchanged from the R&D decision |
| A **source integrity check** runs before the first layer is blended | Compare byte length against `source.size`, and document dimensions plus pixel-bearing layer count against the project. Same spirit as `applyProjectJson`'s layer-count guard |

---

## Architecture

### Hard prerequisite — a real, re-readable source URI

Export is a function of the file. If the file cannot be re-opened, there is no export,
and no amount of engine work substitutes. **This is a prerequisite, not a detail: 1C
cannot start until a picker lands.**

What must exist before the first line of 1C is written:

| Platform | Mechanism | Trap |
|---|---|---|
| Android / iOS | A native file picker plugin (none is installed today — `app/package.json` has `@capacitor/filesystem` and `@capacitor/share` only), **then a copy of the picked file into `Directory.Data`**, whose path becomes `source.uri` | An Android SAF `content://` URI from `ACTION_OPEN_DOCUMENT` is dead after a process restart unless `takePersistableUriPermission` was called. Copying sidesteps the whole permission model |
| Web (modern) | `showOpenFilePicker()` → keep the `FileSystemFileHandle`; re-read via `queryPermission` / `requestPermission` | A permission re-prompt can appear at export time, seconds after the user tapped Export |
| Web (fallback) | Keep the `File` object from `<input type="file">` | It is a reference to an OS file, not a memory copy, so it costs nothing — but `arrayBuffer()` rejects with `NotReadableError` if the file moved or was deleted |

The recommended native path is **copy at load**. It costs one 303 MB write and roughly
1–3 s *(estimate)* on the poster, and buys a URI that survives process restart with no
permission model at all. The cost is real and belongs in the load progress UI, not
hidden.

`project.source` therefore grows a discriminator:

```
source = { uri, name, size, kind: 'native' | 'filehandle' | 'blob' }
```

The engine never interprets `kind`. An app-side resolver maps it to bytes and hands the
engine a `readSource()` callback. Reading over the Capacitor bridge must **not** use
`Filesystem.readFile`, which returns base64 — a 303 MB file becomes a ~404 MB string
*(estimate)*. Use `Capacitor.convertFileSrc(uri)` and `fetch(...).arrayBuffer()`, which
streams binary and works inside a worker.

### The pipeline

```
Export tap
  └─ main thread: build the export order from the project (no pixels)
       └─ worker
            ├─ readSource()                          → file bytes (303 MB)
            ├─ integrity check                       → size, dims, layer count
            ├─ readDocument(pixels:'stream',
            │               metadata:false,
            │               patterns:false,
            │               wantLayer)                per pixel-bearing layer:
            │      ├─ arriving layer is next needed? → blend now
            │      ├─ needed later?                  → spill to disk
            │      └─ not in the order?              → discard
            │      then drain: while the next needed layer is
            │            spilled or self-rendering   → blend it, advance
            ├─ RELEASE file bytes                    ◀── before readback
            ├─ drain any remaining spills in order
            ├─ readback (per tile on the GPU tier)   → output buffer (66 MB)
            ├─ encode PNG
            └─ cleanup spill directory (finally)
  └─ main thread: chunked write to Filesystem → Share
```

Layer geometry stays in **document coordinates** throughout. A layer arrives at its
natural `sourceW × sourceH` and is drawn into `x, y, w, h` — the same numbers the proxy
preview used, at `scale: 1` instead of `proxyScale`. That is what makes the transform
non-destructive: nothing was ever baked into the proxy pixels.

`resample()` early-returns when sizes match, so an untransformed layer costs nothing —
which is exactly the 3.1 s vs 4.3 s gap in the measured numbers.

### Layer identity — why `sourceIndex` is not optional

Two independent tree walks produce the two orderings that export has to reconcile:

- `reader.js` flattens `psd.children` depth-first and **decodes every leaf**, including
  leaves with no pixels.
- `edit.js:flatten()` walks the same tree and **drops any leaf with neither
  `imageData`, `proxyData` nor `text`** (`src/edit.js:124`).

They agree on order but not on membership. An empty layer, or a shape layer that decoded
to nothing, is decode index *n* and is absent from `project.layers` entirely. Matching
export arrivals to project layers by array position therefore misaligns from that layer
onward — every layer after it blends with the wrong geometry, opacity and blend mode.
It would look like a plausible image. That is the failure class this project keeps
finding by hand, so:

- `src/load.js` stamps each streamed node with a monotonic counter over **all**
  pixel-bearing leaves, decoded or skipped.
- `src/edit.js:toLayer()` copies it to `layer.sourceIndex`.
- Export's stream uses the same counter, so `sourceIndex` matches by construction on
  both sides.

A re-rendered text layer draws itself and has no file counterpart; it keeps its
`sourceIndex` for ordering but is never awaited from the stream.

### Fast path and spill path

Build `order[]` — the project's layers, bottom to top, minus the invisible and the
zero-opacity. Then:

**Fast path** — `order[]` has strictly increasing `sourceIndex`. Arrival order is blend
order. Blend each layer as it streams, release it, move on. Nothing touches disk. This
is the common case: reordering is a deliberate act, and most exports follow none.

**Spill path** — otherwise. Rather than spilling everything, keep a pointer `need` into
`order[]`:

- The arriving layer *is* `order[need]` → blend it, advance `need`.
- It appears later in `order[]` → spill it and discard the memory copy.
- It appears nowhere in `order[]` → discard it. (It was hidden, or `wantLayer` already
  stopped it being decoded.)
- After each blend, **drain**: while the next needed layer is already spilled or is a
  self-rendering text layer, satisfy it immediately and advance.

Moving one layer from the top of the stack to the bottom spills **one** layer, not six.
Moving one from the bottom to the top spills the layers it jumped. The worst case is a
full reversal, which spills all but one — the parent spec's ~398 MB figure is that worst
case, and it stays the honest upper bound.

Peak memory is unchanged on both paths: exactly one full-res layer is resident at a time.

### Spill format and lifecycle

Path: `Directory.Cache / psd-export / <exportId> / <sourceIndex>.rgba`.
`exportId` is a timestamp plus a random suffix, so two exports never collide.

File layout — little-endian, then the pixels:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `PSDX` |
| 4 | 4 | version, `1` |
| 8 | 4 | width |
| 12 | 4 | height |
| 16 | `width × height × 4` | RGBA, **straight (unassociated) alpha** |

Straight alpha because that is what `composite.js` and `render.js` use end to end; a
premultiplied spill would round-trip through a lossy conversion twice.

The reader validates magic, version, and that the byte length matches the header. A
short file is a truncated write — usually a full disk — and must raise, never blend.

**Cleanup:**

| Situation | Mechanism |
|---|---|
| Success | `rmdir({ recursive: true })` in a `finally` |
| Failure / thrown | Same `finally` |
| User cancel | Same `finally`, reached via the cancellation check |
| `worker.terminate()` | Main thread does a best-effort `rmdir` of the known `exportId` |
| **Process killed** | **Sweep at next launch** — delete every `psd-export/*` directory. Nothing else survives an OOM kill or a swipe-away |

`Directory.Cache` is deliberate: the OS may reclaim it under pressure, which is correct
for temp files, and it is excluded from backup on both platforms.

There is **no reliable API for free disk space** on either platform through Capacitor
(`navigator.storage.estimate()` reports the web-storage quota, not the native
filesystem). The spill path therefore cannot pre-flight. It writes, catches the write
failure, cleans up, and reports *"not enough free space to export this document"*.

### Tiled compositing — GPU tier

`MAX_TEXTURE_SIZE` is commonly **4096** on older Android GPUs. The poster is 4961 px
wide, so its canvas cannot be one texture.

Tile edge is the minimum of every relevant limit, not just the obvious one:

```
tileEdge = min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE,
               MAX_VIEWPORT_DIMS[0], MAX_VIEWPORT_DIMS[1], EXPORT_TILE_CAP)
```

`EXPORT_TILE_CAP` ships at **2048** *(estimate — needs device calibration)*. The
arithmetic for the poster:

| Tile edge | Tiles | Tile accumulators | Scratch (ping-pong) | GPU total |
|---|---|---|---|---|
| 2048 | 3 × 2 = 6 | 66.4 MB (= the canvas) | 16.8 MB | ~100 MB *(estimate)* |
| 4096 | 2 × 1 = 2 | 66.4 MB | 67.1 MB | ~200 MB *(estimate)* |

The accumulators total the canvas either way — they *are* the output buffer, partitioned
— so the tile edge only trades tile count against scratch size. 2048 is the safer
default on a phone.

**Layer-major, tile-minor.** For each arriving layer:

1. Compute its document-space destination rect from `x, y, w, h`.
2. Intersect with each tile. Skip non-intersecting tiles entirely.
3. For each intersecting tile, `texSubImage2D` the intersecting slice of the layer's
   RGBA array using `UNPACK_ROW_LENGTH` / `UNPACK_SKIP_PIXELS` / `UNPACK_SKIP_ROWS`, so
   no CPU-side slice buffer is allocated.
4. Draw into the tile's scratch with the layer's blend shader, then swap scratch and
   accumulator. WebGL cannot read and write one texture in a draw, so the scratch is
   required — but one scratch serves all tiles, because tiles are processed one at a
   time within a layer.
5. Release the layer.

Resampling is free here: a transformed layer is a textured quad with `LINEAR` filtering,
so the tile split and the transform compose in the same draw. The 3.1 s / 4.3 s gap is a
JS-path cost and does not apply to the GPU tier.

Ordering is orthogonal to tiling. A layer drained from a spill file goes through exactly
the same per-tile blend as a layer straight off the stream.

**Readback** is per tile, into one tile-sized scratch array, then row-copied into the
output buffer. Two things bite here and both are cheap to get right:

- WebGL's framebuffer origin is bottom-left; `ImageData` rows run top-down. The rows
  must be flipped on the copy.
- The shader math must be **straight alpha**, matching `composite.js`, and the context
  must be created with `premultipliedAlpha: false`. A premultiplied pipeline diverges
  from the JS oracle at exactly the partially-transparent pixels the fixtures test.

`readPixels` is synchronous and stalls the pipeline. An async `PIXEL_PACK_BUFFER` +
`fenceSync` path exists but costs a second GPU-side copy of the same size; not worth it
for a once-per-export operation.

### Fallback tier

On the JS compositor tier (no WebGL2, or a lost context), export runs **the same walk**:
same `sourceIndex` matching, same fast/spill decision, same drain, same progress and
cancellation. What changes:

- Blend target is one `createBuffer(width, height)` — 66.4 MB for the poster, not tiles.
- **No tiling.** There is no texture limit to respect, and the parent spec says so.
- Transformed layers go through `resample()`, which is where the measured 3.1 s → 4.3 s
  difference comes from.

One correction to the peak formula on this tier: `resample()` allocates a **new** buffer
at the destination size, so a transformed layer is briefly resident twice —
`sourceW × sourceH × 4` plus `w × h × 4`. For an upscaled layer the second term is the
larger. Peak on the fallback tier is therefore:

```
file + one full-res layer + one resampled copy + output buffer      (derived, not measured)
```

For the poster with a layer scaled to 150%, that is 303.4 + 66.4 + 149.4 + 66.4 ≈ 585 MB
*(estimate)*. The mitigation is available and cheap: release the file bytes before the
composite phase rather than after, which drops 303 MB out of that window.

Speed is the measured 3.1–4.3 s desktop, 12–20 s mobile. That is why this tier needs the
same progress UI as decode, not a spinner.

### Text is not exempt

The Phase 1 spec carries a dated correction that constrains this phase directly:

> `src/render.js:143` gates the `textPixelsAt` path on `layer.rerendered`, which starts
> `false` (`src/edit.js:71`), so an untouched Photoshop text layer falls through to
> `resample()` like any raster. At proxy scale that is the identity early-return and
> harms nothing, but a full-resolution export would upscale its 1024-edge raster and
> blur it. **Plan 1C must not assume text is exempt from the full-res re-read.**

Honoured as three distinct cases:

| Case | `rerendered` | Export behaviour |
|---|---|---|
| Untouched Photoshop text | `false` | It is a raster. Stream its full-res pixels from the file like any other layer, and resample only if transformed |
| Retyped / restyled text | `true` | `textPixelsAt(layer, w, h)` re-rasterises at the final size. Never streamed, never spilled — it is generated at its position in the drain |
| Moved or resized, not retyped | **depends on the UI** | Engine `setLayer` sets `rerendered` only for the `text` key (`src/edit.js:171`). `demo/editor.js:331` sets it explicitly on `w`/`h` changes. Export must handle both and assume neither |

That third row is a genuine ambiguity, and it is safe: whichever value the UI chose,
export does the best available thing. `rerendered: true` re-draws sharp;
`rerendered: false` upscales the **full-resolution** raster, which is still the best
data that exists. What is *not* safe is upscaling the proxy — which is precisely what
the current code does, and precisely what streaming fixes.

**The failure mode to guard.** `rasteriseTextAt` returns `null` when `document` is
undefined (`src/render.js:81`), and `renderProject` then hits `if (!pixels) continue;`
(`src/render.js:153`). In a worker without 1B's `OffscreenCanvas` abstraction, every
edited text layer disappears from an export that otherwise succeeds. Export must
therefore **treat a null result from a `rerendered` layer as a fatal error** naming the
layer, not as a skip. Silence here would ship a PNG that is wrong in a way nobody checks.

A second, softer text hazard: the worker needs the same fonts as the preview, loaded via
the `FontFace` API and `self.fonts.add()`. If a font resolves differently in the worker,
the export does not match what the user saw. `FONT_STACKS` (`src/edit.js:26`) is shared,
which limits the blast radius, but the fallback a device picks for `"Segoe UI"` is not
guaranteed to be the same in both contexts.

### Encoding and delivery

Encoding the 66.4 MB output buffer to PNG has one specific, document-sized trap:

**4961 × 3508 = 17,403,188 px, which is over the 16,777,216 px canvas-area limit that
older iOS enforces.** So the obvious route — `OffscreenCanvas` + `convertToBlob` — can
fail on exactly the case this phase exists for.

- **Primary**: `OffscreenCanvas` + `convertToBlob({ type: 'image/png' })`, guarded by
  `width * height <= CANVAS_AREA_CAP`. Note that `putImageData` premultiplies and
  `convertToBlob` un-premultiplies, so RGB under partial alpha can shift by ±1 — inside
  the project's tolerance-1 convention, and worth stating rather than discovering.
- **Fallback**: a dependency-free JS PNG writer using stored (uncompressed) deflate
  blocks plus CRC32. Roughly 80 lines, output ~66.5 MB for the poster *(estimate)*, and
  it never allocates a canvas. Needed whenever the area cap is exceeded or
  `convertToBlob` rejects.

Encode is its **own** memory peak, separate from the composite peak: output buffer
(66.4 MB) + canvas backing store (66.4 MB) + the blob. Both peaks must fit; neither
overlaps the file bytes if those were released first.

Delivery has the mirror-image base64 problem. `Filesystem.writeFile` takes base64 on
native, so a 66 MB PNG becomes an ~88.6 MB string *(estimate, assuming V8 keeps it as a
one-byte string; a UTF-16 promotion would double it)*. Write it in chunks —
`Filesystem.writeFile` for the first slice, `Filesystem.appendFile` thereafter, ~4 MB of
binary per call. That is ~17 bridge round-trips for the poster PNG, each carrying ~5.3 MB
of base64. Then `Share.share({ files: [uri] })`.

The project JSON goes out alongside it via the existing `toProjectJson`, unchanged. PSD
writing remains permanently out of scope.

### Progress and cancellation

A 12–20 s mobile export with no feedback reads as a frozen app. Progress is not polish.

Phases, with the weights the UI should use:

| Phase | Span | Granularity |
|---|---|---|
| `read` — bytes from the URI | 0–10% | byte counter, if `fetch` gives one |
| `parse` — `readPsd` structure | 10–15% | none; it is one synchronous call |
| `layers` — decode, blend, spill | 15–85% | **real**: n of N, the only honest phase |
| `drain` — read spills back | 85–90% | n of spilled |
| `readback` | 90–92% | per tile |
| `encode` | 92–98% | none |
| `write` + share | 98–100% | per chunk |

The `parse` and `encode` phases are single synchronous calls with no interior yield.
The progress bar must not pretend otherwise — an indeterminate state during those two is
honest; a fake creep is not.

**Cancellation.** The stream loop already awaits `onLayer` per layer
(`src/reader.js:127`), which is the natural yield point. A `cancel` message posted to
the worker is queued and only processed when the loop yields, so **cancel latency is up
to one full-layer decode** — an estimated 1–3 s on mobile for a 66 MB layer. That is
acceptable and must be stated in the UI copy ("Cancelling…"), not hidden behind an
instantly-dismissed dialog.

`SharedArrayBuffer` + `Atomics.load` would allow polling inside the decode, but it
requires cross-origin isolation (COOP/COEP), which a Capacitor WebView does not have by
default. Not worth the deployment change for a 1–3 s improvement.

The main thread sends `cancel`, waits for the worker's `cancelled` acknowledgement —
which is what runs the spill `finally` — and after a timeout falls back to
`worker.terminate()` plus a best-effort `rmdir`.

**Backgrounding**, via `App.appStateChange`:

| Platform | What actually happens | Defined behaviour |
|---|---|---|
| Android | The worker keeps running; a backgrounded app holding ~450 MB is a prime OOM-kill target | Do **not** auto-cancel — the user may be reading a notification. Persist an "export in progress" marker so the next launch's sweep finds the orphaned spill directory |
| iOS | The WebView suspends within seconds; JS stops. On resume it continues from where it stopped | Export simply pauses. Progress should say so rather than appearing stalled |
| Either, after a kill | Worker gone, page reloaded | Show *"Export was interrupted"* and offer retry. **Never** restore a stale progress bar |

Screen-off is equivalent to backgrounding on both platforms, and keeping the screen awake
would need another plugin. Listed as an open question rather than assumed.

### Testing

What **can** run in `npm test`, because the engine takes injected adapters:

- **The oracle.** Streaming export of a proxy-loaded fixture, through the JS compositor,
  with `readSource` backed by `fs` and an in-memory `Map` as the spill adapter, compared
  against `renderProject(eagerProject, { scale: 1 })`. Tolerance 1 via `percentReal`,
  per the project convention. Run it **with layers reordered** so the spill path is what
  is being asserted, not the fast path.
- Order detection: monotonic → fast path; one swap → spill path; and the *count* of
  layers spilled, which is what proves the "spill only what you must" rule.
- `sourceIndex` alignment against a fixture containing a pixel-less leaf — the case that
  makes positional matching wrong.
- Spill codec round-trip, including a truncated file raising rather than blending.
- Tile partition arithmetic: tile counts, intersection rects, and edge tiles at
  non-multiple dimensions.

What **cannot**, and is manual, exactly as in the Phase 1 spec: GPU tiling, texture-limit
behaviour, Capacitor Filesystem and Share, cancellation timing, backgrounding, and the
iOS canvas area cap. The in-app conformance route from 1B gains an **export column** so
the same 21 fixtures are checked through the export path on a real device driver.

> **Accepted gap, inherited from Phase 1:** a green `npm test` proves the export *walk*
> is correct. It says nothing about the GPU path or any Capacitor call. Those are settled
> by the conformance route and by the user's device, and no mocked test should be reported
> as if it settled them.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **No re-readable source URI exists yet.** Without a picker, export cannot be built or tested at all | **Blocking** | Treated as a prerequisite with its own task; recorded in `docs/BACKLOG.md`. Copy-at-load is the recommended mechanism |
| **The spill path may double or triple export time.** ~796 MB of traffic through base64 and the Capacitor bridge at an estimated 20–50 MB/s adds 16–40 s *(estimate)* to a 12–20 s export | **High** | Spill only what is needed, which collapses the common reorder to one or two layers. OPFS is the real fix — see Open questions. **Unverifiable without a device** |
| **An edited text layer silently vanishes** if 1B's `OffscreenCanvas` abstraction is missing or regresses | **High** | Fatal error on a null `rerendered` raster, naming the layer. Never `continue` |
| **`sourceIndex` misalignment** would blend every layer after a pixel-less leaf with the wrong geometry — a plausible-looking wrong image | **High** | Stamp the index at load; never match by array position. Node test against a fixture with a pixel-less leaf |
| **iOS canvas area cap** rejects a 17.4 Mpx `OffscreenCanvas` — the poster case exactly | Medium | Area check plus a dependency-free JS PNG writer. **Cannot be verified without an iOS device** |
| **Encode peak is a second peak** — output plus canvas backing store plus blob | Medium | Release file bytes before the composite phase; treat encode as its own budgeted window |
| **A layer's bounds can exceed the canvas.** The "one full-res layer" term is bounded by the largest *layer*, not the document, so it can exceed 66 MB | Medium | Compute the true largest-layer size during the structure parse and budget against it, not against canvas area |
| **`resample()` doubles the transformed-layer term** on the fallback tier — an estimated 585 MB peak for a 150% upscale | Medium | Release file bytes earlier. **Derived, not measured** |
| **`MAX_TEXTURE_SIZE` is not the only limit.** Renderbuffer and viewport limits can be smaller | Medium | Take the min of all four, cap at 2048 |
| **Cancel latency of up to one layer decode** (1–3 s estimated) reads as an unresponsive cancel | Low | Say "Cancelling…" and mean it. `SharedArrayBuffer` rejected — needs cross-origin isolation |
| **Orphaned spill directories** after an OOM kill — up to 398 MB, or 531 MB as base64 | Low | Sweep every `psd-export/*` at launch. A `finally` cannot cover a killed process |
| **Full disk mid-spill**, with no API to pre-flight free space | Low | Catch the write failure, clean up, report "not enough free space" |
| **Worker fonts differ from preview fonts**, so the export does not match what the user saw | Low | Shared `FONT_STACKS`; load via `FontFace`. Only affects `rerendered` text |
| **`containsKey`'s three full byte-scans** land on the export critical path | Low | Suppress the pattern scan for export; the warning was already surfaced at load |

---

## Open questions

- **Should spill use OPFS instead of Capacitor Filesystem?** `navigator.storage.getDirectory()`
  with `createSyncAccessHandle()` is worker-only, synchronous, and **binary** — no base64,
  no bridge round-trips. It would remove the single largest estimated cost in this phase
  and the 1.33× on-disk multiplier. Availability in the Capacitor WebView on the oldest
  Android target is unverified. The Phase 1 spec names Capacitor Filesystem, so that is
  what is specified; OPFS is a measured-decision candidate, not a silent substitution.
- **What is `EXPORT_TILE_CAP` really?** 2048 is a judgement call from GPU-memory
  arithmetic, not a measurement. A device sweep should settle whether 4096 is safe where
  the driver reports it.
- **Does the JS PNG fallback ever actually fire?** It depends entirely on the oldest iOS
  target's canvas area cap. If it never fires, ~80 lines of unexercised code ship —
  which is its own risk.
- **Can export write output rows straight into a streaming PNG encoder**, band by band,
  and skip the full-res output buffer entirely? It would remove 66 MB from the peak, but
  only works with the JS encoder (a canvas needs the whole image) and only if tiles are
  read back in horizontal bands.
- **Should export offer JPEG?** It sidesteps nothing — the canvas is the constraint
  either way — but it makes the share payload an order of magnitude smaller. Arguably
  Phase 5's decision, not this one.
- **Does anything keep the screen awake during a 20 s export?** Screen-off is
  backgrounding. No plugin for it is installed.
- **What is the real per-layer decode time on mobile**, which sets cancel latency? The
  12–20 s figure is a whole-export number; the per-layer split is unmeasured.

---

## Not doing

- **PSD writing.** Permanently out of scope, unchanged from the R&D decision. Export is
  PNG plus project JSON.
- **Layer masks.** `composite.js` applies them; `edit.js:toLayer()` does not carry
  `mask` onto the project, so `renderProject` has never applied them. Export matching
  the preview is the requirement, so export does not apply them either. This is a real
  fidelity gap against Photoshop and belongs in the backlog, not in 1C.
- **Layer effects, adjustment layers, smart filters, blend-if, `dissolve`.** Unchanged
  from Phase 1. Export reproduces what the editor shows, which is what WYSIWYG means.
- **Crop, aspect ratios, output presets, quality settings, batch export.** Phase 5.
- **Resumable export.** An interrupted export restarts. Making it resumable would mean
  persisting partial composites, which costs more than the 12–20 s it saves.
- **Async `readPixels` via `PIXEL_PACK_BUFFER` + `fenceSync`.** Costs a second GPU-side
  copy to remove one stall in a once-per-export operation.

---

## Noticed, not doing in 1C

Findings from reading the code for this spec. None are 1C work; all should be tracked.

- **Layer masks are dropped by the edit model** (`src/edit.js:43`). `composite.js`
  applies them, `render.js` cannot. Every masked layer has rendered wrong since the
  editor existed, in preview and now in export. The most significant fidelity gap found
  while writing this document.
- **`rerendered` is set by the UI, not the engine.** `applyCommand` sets it only for the
  `text` key (`src/edit.js:171`); `demo/editor.js:331` sets it for `w`/`h`. Two callers,
  two policies, and `render.js:143` branches on it. It should have one owner.
- **`containsKey` runs unconditionally**, even under `metadata: false`
  (`src/reader.js:134`). Already in `docs/BACKLOG.md`; export makes it matter twice per
  document instead of once.
- **`estimatePeakBytes` still has no production caller** (`docs/BACKLOG.md`). Export is
  the natural one: it can budget the composite window before starting, instead of
  discovering the ceiling by being killed.
- **`app/` has no automated coverage at all** (`docs/BACKLOG.md`). 1C adds the export
  service, the source resolver and the spill adapter to that untested surface. The
  "logic lives in `src/`" division holds only if the adapters stay genuinely trivial —
  worth re-checking when they are written, not after.
