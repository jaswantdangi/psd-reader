# Phase 1B — GPU Compositor and Fallback Tiers

**Date**: 2026-08-26
**Status**: Design, implementation plan not yet written
**Phase**: 1B of Phase 1 (see *Programme context*)
**Parent spec**: [`2026-08-25-phase-1-engine-gpu-memory-design.md`](./2026-08-25-phase-1-engine-gpu-memory-design.md)

---

## Programme context

Phase 1 of the mobile-first PSD editor is split into three plans:

| # | Plan | State |
|---|---|---|
| 1A | Workspace + proxy load pipeline | **complete** — `loadProjectProxy`, size guard, decode worker, `/harness` |
| **1B** | **GPU compositor and fallback tiers** | **this document** |
| 1C | Full-resolution streaming export | not started |

1A established the shape everything here depends on: layers arrive as
proxy-resolution `Uint8ClampedArray` buffers, geometry (`x/y/w/h`) stays in
**document coordinates**, and `renderProject`'s `scale` parameter is what draws
the proxy. 1B replaces the *renderer* behind that contract. It changes no part
of the load pipeline and no part of the project model.

The parent spec's **Render architecture** section already decided the tiering.
This document specifies it; it does not re-decide it.

---

## Why this phase exists

### Measured (from the parent spec — not re-derived here)

JS compositing at proxy resolution, 1024-edge proxy canvas, **desktop**:

| Layers | Per frame |
|---|---|
| 6 | 185 ms |
| 20 | **651 ms** |

Mobile is 3–5× slower, so a 20-layer document costs roughly 2–3 s per drag
frame. Full-res JS export, desktop: 3.1 s untransformed, 4.3 s transformed.
Peak memory follows `file bytes + one full-res layer + Σ proxy layers`,
validated to 1%.

The cause is in the renderer's own docstring: *"the whole stack is recomposited
on every change"*. 1A bounded the memory. 1B is the speed half.

### Found by reading, during this design

Four things about the current code shape the design and were not in the parent
spec. All are stated so the plan does not assume otherwise.

1. **The project path implements neither layer masks nor clipping.**
   `src/composite.js` has both (`maskFor`, `alphaMap`, the `clipping` run in
   `renderList`). `src/edit.js:toLayer()` copies neither field onto the layer,
   and `src/render.js:renderProject` passes no `rect.mask` and no `clipAlpha`
   to `blendInto`. So masked and clipped layers already render wrong in the
   editor today, before any GPU work. **The GPU compositor targets
   `renderProject` semantics and will faithfully reproduce this gap.** It is a
   pre-existing defect, not a regression — but it is the reason the conformance
   suite cannot compare the GPU against Photoshop's embedded composite (see
   *Conformance route*).

2. **`BLEND_MODES` in `edit.js` lists 18 modes; the compositor implements 26.**
   The UI list omits `vivid light`, `linear light`, `pin light`, `hard mix`,
   `subtract`, `divide`, `darker color`, `lighter color`. Layers read from a
   file carry whatever mode Photoshop stored, and `renderProject` passes it
   straight through. **The shader must cover all 26 that `composite.js`
   implements, not the 18 the UI offers.** `dissolve` and `pass through` fall
   through to `normal` in `blendInto` (`blend = fn || SEPARABLE.normal`) and
   must do the same on the GPU.

3. **Untouched Photoshop text is already a raster, so it does not vanish in a
   worker.** `src/render.js:143` gates the `textPixelsAt` path on
   `layer.rerendered`, which starts `false` (`src/edit.js:71`). The parent
   spec's blanket "text layers vanish in a Web Worker" is true only of text the
   user has retyped or resized — the parent spec already carries this
   correction, dated 2026-08-25. The abstraction is still required (Phase 4
   makes text editable, and the harness already exposes retyping), but the
   blast radius in 1B is smaller than "all text".

4. **The default preview path is a 1:1 blit, not a resample.**
   `downscaleImage` produces `round(layer.w * proxyScale)` and `renderProject`
   at `scale = project.proxyScale` asks for `round(layer.w * scale)` — the same
   expression. So `resample()` hits its identity early-return for every layer
   wider than `1/scale` px. This is load-bearing for conformance: it means the
   common preview case can be **bit-exact** between GPU and JS rather than
   merely close, provided the GPU uses `NEAREST` when the rect matches the
   texture size.

---

## Definition of done

> On a real device, a 20-layer proxy document drags at interactive speed
> through the GPU tier, the same document renders identically through the JS
> tier, and the in-app conformance route reports zero blend-mode failures.

Checked by the user, because build commands are not run here:

- [ ] `/harness` shows which tier was selected and **why** (the probe's verdict
      string), plus a rolling ms/frame readout.
- [ ] Dragging a layer on a 20-layer document is visibly interactive. The user
      reports the observed ms/frame; this spec does not predict it.
- [ ] `/conformance` reports `percentReal == 0` for all 26 modes on the
      untransformed synthetic matrix, GPU vs JS.
- [ ] `/conformance` reports the 21 fixtures GPU vs JS with a pass/fail column,
      and the transformed pass separately from the untransformed one.
- [ ] A tier override (`?tier=2`, `?tier=3`) renders the same document
      correctly through each tier.
- [ ] Simulating context loss (`WEBGL_lose_context`, exposed behind the same
      query param) demotes to the JS tier without a blank canvas.
- [ ] `npm test` still green, plus a new suite covering `src/sandwich.js`,
      `src/surface.js` and the GLSL/mode-table coverage assertion.

Explicitly **out of scope for 1B**: full-resolution export orchestration (1C),
layers panel, tool rail, filters, crop, design system.

---

## Decisions

| Decision | Rationale |
|---|---|
| GPU work lives in `src/gpu/`, plain ESM, no framework imports | Same rule as the rest of the engine. The parts needing no GL context (mode table, GLSL generation) stay importable by the Node suites |
| Exactly **one** WebGL2 context for the whole app, owned by one service | Browsers cap contexts per page (~16 in Chrome) and evict the oldest; mobile Safari drops them on backgrounding. A second context is a guaranteed loss event |
| Blend in the fragment shader; `gl.BLEND` stays **disabled** | Fixed-function blending cannot see the backdrop colour, which all six non-separable modes and 19 of the 20 separable ones require |
| Ping-pong FBO pair, **RGBA8**, not RGBA16F | Two independent reasons: RGBA8 quantises at the same points as the `Uint8ClampedArray` oracle, so conformance measures the shader rather than the storage; and RGBA16F is colour-renderable in WebGL2 only with `EXT_color_buffer_float`/`EXT_color_buffer_half_float` |
| **One specialised program per blend mode**, compiled lazily on first use | A 26-way `switch` on a uniform int is exactly the shape old Mali/Adreno compilers miscompile or serialise. A typical document uses 1–3 modes, so lazy compilation costs almost nothing |
| GLSL **generated** from a shared mode table; a Node test asserts coverage against `composite.js` | The most likely regression is adding a mode to the JS table and forgetting the shader. Generation makes drift impossible by construction; the test makes completeness assertable inside `npm test` — the one real guarantee `npm test` can still give about the GPU path |
| Full-canvas quad per layer, not the layer's quad | The ping-pong destination starts empty, so the backdrop must be carried through anyway. A full-canvas pass does that for free and reproduces the JS loop's `x0..x1` clamp exactly. At 1024² × 20 layers that is 21 Mpx of mostly early-returning fragments |
| `NEAREST` iff the destination rect equals the texture size, `LINEAR` otherwise | Mirrors `resample()`'s identity early-return. Makes the default preview path bit-exact instead of merely close (finding 4 above) |
| Textures uploaded from the raw typed array — never `ImageBitmap`, never a DOM canvas | The same reason `src/canvas.js` exists: `createImageBitmap` and DOM upload paths premultiply alpha and may colour-convert. The pixel path stays away from the DOM |
| The capability probe **compiles, links and runs a 1×1 blend**, then reads it back | `getContext('webgl2') !== null` says nothing about whether the driver's shader compiler works. The failure this catches is an all-black canvas on one phone model |
| Tier is selected **before** decode | It decides which thread the proxy pixels land on. Deciding afterwards forces a ~36 MB copy back across the boundary |
| The 1A decode worker **becomes** the render worker | Proxies never cross the thread boundary at all, and demoting to the JS tier needs no transfer back. `PsdLoaderService` stops calling `worker.terminate()` on `done` |
| Sandwich cache is **drag-scoped**: approximate during the drag, exact on drag end | It is an approximation for any non-`normal` mode above the selection (see *Sandwich cache*). Bounding it to the drag bounds the wrongness to a few hundred ms of a gesture nobody is reading pixel values during |
| Conformance compares GPU against the **JS project renderer**, not against Photoshop | `renderProject` implements neither masks nor clipping (finding 1), so a Photoshop comparison would fail for reasons that have nothing to do with the GPU |
| Conformance adds a **synthetic 26-mode matrix** alongside the 21 fixtures | The fixtures exercise only the modes Photoshop's own feature tests happen to use. Most of the 26 are not covered by them, and a broken `setSat` would not show up |
| Both buffers go through `flattenOnto()` before every comparison | GPU and JS write different RGB under `alpha == 0` (JS `continue`s and leaves zero). Comparing raw is HANDOFF Failed Approach 7 in a new place |
| Tolerance 1 via `percentReal`, with `percent`, `maxDelta` and `meanDelta` printed beside it | GLSL ES 3.00 has no `precise` qualifier, so the compiler may reassociate float expressions. Bit-exactness cannot be promised, only measured. Printing the raw numbers keeps a *systematic* ±1 bias visible instead of silently forgiven |
| `hard mix`'s threshold is compared in **integer space** | It is the only mode discontinuous at its boundary; see *Colour precision*. Every other threshold is either continuous across it or unreachable at 8-bit input |

---

## Architecture

### Module layout

| File | Thread | Node-testable | Responsibility |
|---|---|---|---|
| `src/gpu/modes.js` | any | yes | The mode table: name → id, separable/non-separable, and the GLSL body for each. Pure data + strings |
| `src/gpu/glsl.js` | any | yes | Assembles a fragment shader source string for one mode from `modes.js`. Pure |
| `src/gpu/detect.js` | browser | no | Capability probe. Returns a tier and a human-readable verdict |
| `src/gpu/compositor.js` | browser | no | The WebGL2 compositor: texture cache, ping-pong, per-layer draw, tiling, readback, context-loss handling |
| `src/sandwich.js` | any | **yes** | Fallback-tier cache. Pure buffer arithmetic over `renderProject` |
| `src/surface.js` | any | **yes** | 2D surface abstraction (`OffscreenCanvas` → `document` → `null`) |

`src/composite.js` gains exactly one line — an exported `BLEND_MODE_NAMES`
derived from its existing private tables — so the coverage test has something
to assert against. No behaviour change; the pixel-validated code is otherwise
untouched.

None of these introduce a new `ag-psd` symbol, so `demo/shims/ag-psd.js` and
`test/shim.mjs` are unaffected.

### Tier selection

Three tiers, chosen once at startup, cached, and overridable by a query param
for testing.

| Tier | Selected when | Pixels live | Preview presented via |
|---|---|---|---|
| 1 — WebGL2 in worker | `OffscreenCanvas` + `transferControlToOffscreen` + worker probe passes | worker | worker owns the canvas |
| 2 — WebGL2 main thread | probe passes, but no `transferControlToOffscreen` | main thread | direct render to the canvas |
| 3 — JS + sandwich cache | probe fails, or context lost at runtime | wherever they already are | `putImageData` |

**The boundary between 1 and 2 is `transferControlToOffscreen`, not
`OffscreenCanvas`.** They are separate features: `new OffscreenCanvas(w, h)`
shipped in Safari earlier than the transfer method (16.4, 2023). Probing the
constructor alone would put older iOS Safari in tier 1 and give it a canvas it
cannot present.

Detection runs in two steps, because the context that matters is the one the
compositor will actually own:

1. **Main thread, cheap.** `typeof OffscreenCanvas`, presence of
   `HTMLCanvasElement.prototype.transferControlToOffscreen`, and — for tier 2
   only — a `webgl2` context on a 1×1 canvas.
2. **Authoritative, in the target thread.** Create the real context, compile
   and link the `normal` and `hue` programs (one separable, one non-separable —
   `hue` exercises `setSat`/`setLum`/`clipColor`, the fiddliest path), render
   one 1×1 blend of a known pair into an RGBA8 FBO, `readPixels`, and compare
   against the byte the JS compositor produces for the same input. Also read
   `MAX_TEXTURE_SIZE`, `MAX_VIEWPORT_DIMS`, and
   `getShaderPrecisionFormat(FRAGMENT_SHADER, HIGH_FLOAT)`.

Fail any of these → tier 3, with the verdict string surfaced on `/harness`.
GLSL ES 3.00 mandates `highp` in fragment shaders, so the precision check
should never fail; it costs one call and drivers have been known to lie.

Context creation attributes:

```js
{ alpha: true, premultipliedAlpha: false, antialias: false,
  depth: false, stencil: false, preserveDrawingBuffer: false,
  powerPreference: 'high-performance' }
```

`premultipliedAlpha: false` is required — the compositor works in **straight
(unassociated) alpha** end to end, matching `blendInto`.
`failIfMajorPerformanceCaveat` is deliberately **not** set; it is inconsistent
across browsers and would risk demoting working devices (see *Open questions*).

Unpack state is pinned before every upload, not assumed:

```js
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
```

### Where the pixels live

Tier selection happens **before** decode because it decides the destination.

- **Tiers 1 and 3-in-worker**: the 1A decode worker keeps the proxy buffers and
  becomes the render worker. The main thread receives a project whose layers
  carry `proxyW`/`proxyH` and `pixels: null`. `hitTest` maps by ratio on
  geometry alone and is unaffected; the layers panel (Phase 2) needs metadata
  only. `PsdLoaderService` stops terminating the worker on `done`.
- **Tier 2 and 3-on-main-thread**: the worker transfers the proxy buffers out
  exactly as 1A does today.

Tier 3 therefore runs in whichever thread already holds the pixels. That is not
extra work — `src/render.js` and `src/sandwich.js` are thread-agnostic plain
ESM — and it removes the transfer-back path a strictly-main-thread tier 3 would
need after a context loss.

### The composite pass

One draw call per layer, bottom to top, ping-ponging between two RGBA8
texture-backed FBOs.

A texture cannot be sampled and rendered to in the same draw, hence ping-pong
rather than read-modify-write. The alternatives were rejected:
`EXT_shader_framebuffer_fetch` is not exposed in WebGL2 at all, and
`KHR_blend_equation_advanced` is not a WebGL extension and covers only the W3C
mode set — not `vivid light`, `pin light`, `hard mix`, `subtract`, `divide`,
`darker color` or `lighter color`.

Per layer:

1. Bind the destination FBO, set the viewport to the canvas size.
2. Bind the previous accumulator as `uBackdrop`, the layer texture as `uSource`.
3. Set `uRect` (the destination rect in pixels, exactly as `renderProject`
   computes it), `uOpacity`, and the mode's program.
4. Draw a full-canvas triangle.
5. Swap.

The fragment shader is a literal transcription of `blendInto`:

```glsl
#version 300 es
precision highp float;

uniform sampler2D uBackdrop;
uniform sampler2D uSource;
uniform vec4  uRect;      // left, top, width, height — destination pixels
uniform vec2  uCanvas;
uniform float uOpacity;

in  vec2 vDstPx;          // destination pixel coordinate, +0.5 at texel centre
out vec4 fragColor;

vec3 blendFn(vec3 b, vec3 s);   // generated per mode — see below

void main() {
  vec4 dst = texture(uBackdrop, vDstPx / uCanvas);

  vec2 uv = (vDstPx - uRect.xy) / uRect.zw;
  // Reproduces the JS loop bounds x0..x1 / y0..y1 exactly.
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) {
    fragColor = dst; return;
  }

  vec4 src = texture(uSource, uv);

  float as = src.a * uOpacity;
  if (as <= 0.0) { fragColor = dst; return; }   // byte-exact passthrough

  float ab = dst.a;
  float ao = as + ab * (1.0 - as);
  if (ao <= 0.0) { fragColor = vec4(0.0); return; }

  vec3 B = blendFn(dst.rgb, src.rgb);
  // Written in the JS association order on purpose. Do NOT rewrite as
  // mix(src.rgb, B, ab) — algebraically equal, differently rounded.
  vec3 C = src.rgb + ab * (B - src.rgb);

  fragColor = vec4((as * C + ab * dst.rgb * (1.0 - as)) / ao, ao);
}
```

Three details that are load-bearing rather than stylistic:

- **The `as <= 0.0` short-circuit is not an optimisation.** Without it a
  transparent source fragment would run the full straight-alpha divide and
  re-quantise the backdrop. Returning `dst` unchanged is an exact
  unorm8 → float → unorm8 round trip and matches JS's `continue`.
- **The `ao <= 0.0` guard replaces JS's second `continue`.** Straight alpha
  divides by `ao`; the JS loop skips the pixel entirely.
- **Do not "simplify" the arithmetic.** `mix`, `fma`, and any algebraic
  rearrangement change the rounding. GLSL ES 3.00 has no `precise` qualifier,
  so the compiler may reassociate anyway — that is a bound on how exact this
  can ever be, and it is why the tolerance is 1 rather than 0.

**Sampling.** `uSource` is `NEAREST` when
`round(rect.width) === tex.width && round(rect.height) === tex.height`,
`LINEAR` otherwise, both `CLAMP_TO_EDGE`. At 1:1 the vertex stage emits
`vDstPx` at texel centres, so `uv * texSize` lands exactly on texels and the
blit is bit-exact — the case finding 4 identified as the default preview path.
`NEAREST` at 1:1 is not merely equivalent to `LINEAR`; it removes the
reduced-precision filter weights described under *Colour precision*.

### Blend modes in GLSL

The 20 separable modes port mechanically. Every 0..255 formula in
`composite.js` divides cleanly into 0..1 — verified expression by expression
against the table:

```glsl
float m_multiply(float b, float s)   { return b * s; }
float m_screen(float b, float s)     { return b + s - b * s; }
float m_colorBurn(float b, float s)  { return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
float m_colorDodge(float b, float s) { return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float m_softLight(float b, float s) {
  float d = (b <= 0.25) ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return (s <= 0.5) ? b - (1.0 - 2.0 * s) * b * (1.0 - b)
                    : b + (2.0 * s - 1.0) * (d - b);
}
```

`<= 127.5` becomes `<= 0.5`, and there is no tie to worry about: an 8-bit
sample is always `n/255`, never exactly `0.5`. `dissolve` and `pass through`
map to the `normal` program, as they already do in `blendInto`.

**The six non-separable modes are the only fiddly work**, and the fiddliness is
narrower than it looks. `composite.js:setSat` sorts the three channels by index
and writes back into their original positions. GLSL ES 3.00 does permit dynamic
vector indexing, but it compiles to conditional moves or scratch memory and has
a history of driver bugs. It is also unnecessary — the sort is an
implementation artifact, not part of the maths. The closed form is exactly
equivalent, componentwise:

- the minimum channel maps to `(mn - mn) * s / (mx - mn)` = 0
- the middle to `(mid - mn) * s / (mx - mn)`
- the maximum to `(mx - mn) * s / (mx - mn)` = s

which is precisely what the sorted version assigns. So:

```glsl
const vec3  LUM_W = vec3(0.3, 0.59, 0.11);
const float EPS   = 1e-6;

float lum(vec3 c) { return dot(c, LUM_W); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  // NOTE: l, n and x are computed ONCE, before both branches. The JS version
  // mutates c inside the first branch and then tests the STALE x. Recomputing
  // here would be tidier and would diverge. Keep it stale.
  if (n < 0.0) c = l + (c - l) * (l / max(l - n, EPS));
  if (x > 1.0) c = l + (c - l) * ((1.0 - l) / max(x - l, EPS));
  return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

// Closed form of the W3C sort-based SetSat. Branch-free, no dynamic indexing.
vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  return (mx > mn) ? (c - mn) * (s / (mx - mn)) : vec3(0.0);
}

vec3 m_hue(vec3 b, vec3 s)          { return setLum(setSat(s, sat(b)), lum(b)); }
vec3 m_saturation(vec3 b, vec3 s)   { return setLum(setSat(b, sat(s)), lum(b)); }
vec3 m_color(vec3 b, vec3 s)        { return setLum(s, lum(b)); }
vec3 m_luminosity(vec3 b, vec3 s)   { return setLum(b, lum(s)); }
vec3 m_darkerColor(vec3 b, vec3 s)  { return lum(s) < lum(b) ? s : b; }
vec3 m_lighterColor(vec3 b, vec3 s) { return lum(s) > lum(b) ? s : b; }
```

The `max(·, EPS)` guards cover a 0/0 that is believed unreachable — `l - n` is
zero only when all three channels are equal, and `setLum` is only ever called
with an `l` taken from a non-negative source, so the `n < 0` branch cannot fire
on a grey. In JS the result would be `NaN`, which `Uint8ClampedArray` stores as
0; in GLSL a `NaN` written to a unorm8 target is undefined and has been
observed as garbage. Two instructions to delete a class of driver-specific
artifact.

`clipColor`'s stale-`x` behaviour is the one place where matching the oracle
means copying something that looks like a bug. It is faithful to
`composite.js`, which is what conformance measures against.

### Colour precision

The JS compositor is 0..255 integers in a `Uint8ClampedArray`; GLSL is `highp`
floats. Every known divergence source, with its magnitude:

| Source | Magnitude | Handling |
|---|---|---|
| float32 vs float64 arithmetic | < 0.01 LSB at `highp` | `precision highp float`; the probe asserts `HIGH_FLOAT.precision >= 23` |
| `mediump` if a driver silently downgrades | 1–4 LSB, compounding | The probe's 1×1 readback catches it; tier 3 rather than render wrong |
| Compiler reassociation of the composite expression | ≤ 1 LSB | Unpreventable — ES 3.00 has no `precise`. This is why tolerance is 1 |
| float → unorm8 write, tie-breaking | ±1 LSB, only at exact `.5` | GL leaves ties implementation-defined; `Uint8ClampedArray` rounds half-to-even. Tolerance 1 |
| RGB under `alpha == 0` | up to 255 | `flattenOnto()` both buffers before comparing |
| `LINEAR` filter weight quantisation | 1–2 LSB, transformed layers only | Reported as a separate conformance pass; `NEAREST` at 1:1 avoids it entirely |
| Accumulation over N layers | does not compound differently | RGBA8 ping-pong quantises at the same points the `Uint8ClampedArray` accumulator does. A reason to *keep* RGBA8 |
| `hard mix` threshold | **255 LSB — the full channel range** | See below |

**`hard mix` is the one genuine trap.** `(b, s) => b + s >= 255 ? 255 : 0` is
discontinuous at its boundary, and in float space `float(n/255) + float(m/255)`
where `n + m == 255` may round to `0.99999994`. The output then flips from 255
to 0 — a maximal error out of a half-ULP of rounding. Every other threshold in
the table is safe: `linear burn` and `linear dodge` are continuous across
theirs (both branches agree at the boundary), and `color burn`, `color dodge`
and `divide` test against exactly-representable 0.0 and 1.0. So `hard mix`
alone compares in integer space:

```glsl
float m_hardMix(float b, float s) {
  return (floor(b * 255.0 + 0.5) + floor(s * 255.0 + 0.5) >= 255.0) ? 1.0 : 0.0;
}
```

**The conformance suite avoids false failures the same way `test/composite.mjs`
already does**, and for the same two reasons that once made a correct
compositor look 5/21 right instead of 12/21 (HANDOFF Failed Approaches 7 and 8):

- `flattenOnto()` both buffers first. GPU and JS write different RGB beneath
  fully transparent pixels — JS `continue`s and leaves zero, while the GPU's
  `as <= 0` path writes the backdrop's stored RGB through. Comparing raw would
  report large differences in pixels nobody can see.
- Report `stat.percentReal` at tolerance 1, never `stat.percent`.

But tolerance must not become a place to hide a real bug, so the table prints
`percent`, `percentReal`, `maxDelta` and `meanDelta` side by side. A shader
that is uniformly one greylevel wrong shows as a high `percent` with
`percentReal == 0` and `meanDelta == 1` — passing, but visibly suspicious in a
way a single pass/fail column would conceal. The pass rule:

| Verdict | Rule |
|---|---|
| **PASS** | `percentReal == 0` |
| **WARN** | `percentReal < 0.1` and `maxDelta <= 2` |
| **FAIL** | anything else |

Untransformed layers are expected to PASS at `maxDelta == 0`. Transformed
layers are reported in their own pass, where WARN is the realistic target.

### Tiling for `MAX_TEXTURE_SIZE`

`MAX_TEXTURE_SIZE` is commonly **4096** on older Android GPUs; some report
2048. Real documents exceed both (the measured poster is 4961 px wide).

**Tiling is safe because none of the 26 blend modes is a neighbourhood
operation.** Every one reads exactly one backdrop pixel and one source pixel at
the same coordinate, so the composite of a rectangular region depends only on
that region of each layer. Tiles need no overlap and no seam blending. This
stops being true the moment layer effects (drop shadow, glow, blur) arrive —
those would need halos — which is one more reason they stay out of scope.

The tile edge is queried, never assumed:

```js
const limit = Math.min(
  gl.getParameter(gl.MAX_TEXTURE_SIZE),
  gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0],
  gl.getParameter(gl.MAX_VIEWPORT_DIMS)[1],
  TILE_CAP,
);
```

`TILE_CAP` exists because the limit is not the binding constraint on a phone —
memory is. Two ping-pong RGBA8 textures at 4096² cost 128 MB before a single
layer is uploaded; at 2048² they cost 32 MB. **`TILE_CAP = 2048` is an
estimate, not a measurement**, and the harness must print the chosen tile edge
and the resulting texture footprint so the user can report what a real device
tolerates.

**Preview does not tile.** The proxy edge is 1024 (`DEFAULT_PROXY_EDGE`), well
inside every limit worth supporting. Tiling exists for 1C's full-resolution
export; 1B builds it and exercises it through the conformance route's
full-resolution pass. If a device ever reports a limit below the proxy edge,
the probe fails it to tier 3 rather than tiling the preview.

Two mechanics the export path depends on, specified here because they belong to
the compositor:

- **Sub-rect uploads.** At full resolution a single layer can itself exceed
  `MAX_TEXTURE_SIZE`, so only the part of it intersecting the current tile is
  uploaded, via `UNPACK_ROW_LENGTH` / `UNPACK_SKIP_ROWS` / `UNPACK_SKIP_PIXELS`.
  These are **WebGL2-only** — WebGL1 has no equivalent and would need a
  CPU-side row copy per tile. A concrete payoff for the WebGL2 requirement.
- **A one-texel halo on transformed layers.** With `LINEAR` filtering, a
  destination tile edge samples source texels just outside the tile's source
  rect. The sub-rect must therefore be expanded by one texel on every side
  whenever the layer transform is not identity, with `CLAMP_TO_EDGE` handling
  the document border. Skipping this produces a hairline seam per tile
  boundary — visible, and the kind of artifact that is easy to misattribute to
  the blend maths.

### Text, `OffscreenCanvas` and the worker

`measureText` and `rasteriseTextAt` both open with
`if (typeof document === 'undefined') return null`. In a worker that is a
silent `null`, and `renderProject`'s `if (!pixels) continue` drops the layer.

`src/surface.js` mirrors what `src/canvas.js` already does for ag-psd:

```js
/** A 2D drawing surface, or null where none exists (Node). */
export function create2dSurface(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') { /* document.createElement('canvas') */ }
  return null;
}
```

`OffscreenCanvas` is checked **first**, `document` second. Order matters for
`test/edit.mjs`, which stubs `globalThis.document` to observe the canvas calls
(`setTransform`, `fillText`, `measureText`) — Node 24 has no global
`OffscreenCanvas`, so the stub still wins and those 20 tests keep passing
unchanged. `render.js`'s two guards become `if (!surface) return null`, and
`getContext('2d', { willReadFrequently: true })` is accepted by both surface
types.

Two consequences that are easy to miss:

1. **The texture cache must key on `renderedKey`, not on layer id.**
   `textPixelsAt` rewrites `layer.rendered` whenever the key changes, and the
   GPU would otherwise keep uploading the stale bitmap. This is the same
   invalidation hazard as HANDOFF Failed Approach 6, one level up: a stale
   *texture* is as invisible a bug as a stale `renderedKey`. Cache entries are
   `{ texture, key }` where `key` is `layer.renderedKey` for re-drawn text and
   a monotonic `pixelsRevision` for rasters.
2. **Fonts in a worker are the unverified part.** `WorkerGlobalScope.fonts`
   exists in the CSS Font Loading spec and is implemented in Chromium; Safari's
   worker support is patchier. `FONT_STACKS` names only system families
   (Arial, Helvetica, Segoe UI, …), and whether an `OffscreenCanvas` 2D context
   inside a Capacitor WebView resolves those or silently substitutes a fallback
   face **cannot be determined without a device**. The conformance route
   therefore includes a text fixture rendered through tier 1 and tier 2 and
   compares the two — a mismatch localises the problem to font resolution
   rather than to the compositor.

Unchanged and non-negotiable: **text never goes through `resample()`**
(Failed Approach 5). On the GPU that means a re-drawn text layer's texture is
uploaded at its final destination size and sampled `NEAREST`, never uploaded at
natural size and scaled by the sampler.

### Sandwich cache (tier 3 only)

Cache the composite of everything below the selected layer and everything above
it, so a drag re-blends three buffers instead of N.

```
below  = renderProject over layers [0 .. i-1]      cached
live   = layer i, re-rendered every frame
above  = renderProject over layers [i+1 .. n-1]    cached
frame  = blendInto(blendInto(copy(below), live), above)
```

**This is an approximation, and pretending otherwise would be dishonest.**
`above` is composited onto a transparent buffer, but 25 of the 26 blend modes
read the backdrop. Only `normal` — `(b, s) => s` — is independent of it, and
source-over is associative, so:

- **Exact** when every layer above the selection is `normal` at any opacity.
  That is the common case in a real document.
- **Wrong** otherwise, by an amount that depends on the mode. `difference` or
  `hard mix` above the selection can be visibly wrong.

Three things bound it:

1. The sandwich is used **only while a pointer is down**. On drag end the full
   stack is re-rendered and the exact composite replaces it. The wrongness
   lasts the length of a gesture.
2. If any layer above the selection has a non-`normal` mode, `above` is not
   used at all: the cache degrades to `below` plus a live re-blend of
   `[i .. n-1]`. That still skips the bottom of the stack, which is where most
   layers usually sit.
3. `/harness` shows which of the three states is active, so the approximation
   is never silent.

Invalidation is keyed on `(selectionIndex, revision)`, where `revision` is a
counter bumped by `edit.js`'s existing `commit()`. Any mutation, reorder or
selection change drops both halves. Undo/redo goes through `commit()` and is
therefore covered.

**The parent spec's "~100 ms (vs 651 ms today)" is an estimate, not a
measurement.** It divides 651 ms by 20 layers and multiplies by three. The
arithmetic ignores that the sandwich buffers are full-canvas (1024², ~1 Mpx
each) while the 20 measured layers were of unknown and probably smaller size,
so the real figure is likely higher. `src/sandwich.js` is pure buffer
arithmetic and fully covered by `npm test` for *correctness*; its *speed* is
for the harness readout to establish, on the device that matters.

### Conformance route

GPU conformance cannot run in `npm test`: Node has no WebGL, `headless-gl` is a
fragile native build on Windows, and browser automation is excluded by project
rules. An in-app route is the substitute, and it has a real advantage — it
tests the actual device driver, which is where GPU output actually differs.

`/conformance` in the app, beside `/harness`. Three tables:

**Table A — the 26-mode synthetic matrix.** For each mode, a two-layer
document: a full-canvas backdrop and a full-canvas source, both filled with a
deterministic pattern that sweeps all four channels (a 256×256 buffer where
`r = x`, `g = y`, `b = (x * 7 + y * 13) & 255`, and `a` swept in bands
including 0 and 255). Rendered by `renderProject` and by the GPU compositor,
`flattenOnto` both, `compareBuffers(a, b, 1)`.

This table is the point. **The 21 fixtures exercise only the modes Photoshop's
own feature tests happen to use; most of the 26 are not among them.** A broken
`setSat` would sail through a fixtures-only suite. The generator lives in
`src/` so the JS half also runs as a Node test, giving a stable baseline the
GPU half is compared against.

**Table B — the 21 fixtures, GPU vs the JS project renderer.** Loaded through
`loadProjectProxy`, rendered by both paths at `scale = project.proxyScale`
(untransformed, expected bit-exact) and again at `scale = proxyScale * 0.61`
(transformed, reported separately). Compared as above.

Not against Photoshop's embedded composite: `renderProject` implements neither
masks nor clipping (finding 1), so that comparison would measure a known engine
gap, not the GPU. The Photoshop comparison stays where it already works, in
`test/composite.mjs` against `compositeDocument`.

**Table C — tier cross-check.** The text fixture and two fixtures from B
rendered through tier 1 and tier 2 and compared to each other. A tier-1-only
difference localises to the worker environment — font resolution being the
prime suspect.

**Getting the fixtures to the app.** They are gitignored and fetched by
`scripts/fetch-fixtures.mjs`. The route takes them from a directory picker
(`<input type="file" webkitdirectory multiple>`) pointed at `fixtures/`. That
needs no build configuration, ships no PSDs into the bundle or the APK, and
works identically under `ng serve` and in a Capacitor build. An `assets` glob
onto `../fixtures` was considered and rejected: it would bloat the APK by
~13 MB and would still need the picker on device.

**What `npm test` still guarantees about the GPU path**: one thing, and it is
the most likely regression. `src/gpu/glsl.js` generates the shader from
`src/gpu/modes.js`, and a Node test asserts that the generated set of mode
names is exactly `BLEND_MODE_NAMES` from `composite.js`. Adding a mode to the
JS table without adding it to the shader becomes a red suite rather than a
layer that renders as `normal` on one code path and correctly on the other.

> **Accepted gap, restated from the parent spec:** a green `npm test` does not
> mean the renderer is correct. It means the mode tables agree, the sandwich
> arithmetic is right, and the surface abstraction resolves. Everything about
> what the GPU actually draws is established by the manual conformance route.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **No automated GPU coverage; conformance is manual and device-specific.** Nothing in this repo can verify the shader on the phones that matter | High | In-app conformance route with the synthetic 26-mode matrix; JS oracle retained; tolerance-1 comparison with the raw deltas printed alongside. Accepted, not solved |
| **The sandwich cache is a correctness compromise**, not just a cache. Any non-`normal` mode above the selection makes the mid-drag frame wrong | High | Drag-scoped, exact re-render on drag end, degrades to `below`-only when a non-`normal` mode sits above the selection, and shows its state on the harness |
| **Bilinear filter divergence on transformed layers.** Mobile GPUs typically compute `LINEAR` weights at ~8 subtexel bits, giving routine deltas of 1–2 | Medium | `NEAREST` at 1:1 so the default preview path is unaffected; transformed conformance reported as a separate pass with WARN as the target. The tolerance must not be raised to make this go away |
| **`OffscreenCanvas` + WebGL2 in the Capacitor WebView on the oldest Android target is unverified.** Decides whether tier 1 or tier 2 is the common case | Medium | The probe compiles, links and runs a real blend, so a broken driver demotes rather than renders black. Which tier is *typical* needs a device |
| **Font resolution in a worker `OffscreenCanvas` is unverified.** Text could render in a substituted face, silently, and differ from the main thread | Medium | Conformance Table C compares tier 1 against tier 2 on a text fixture. Cannot be closed without a device |
| **Two ping-pong textures plus layer textures on a phone.** A 1024² preview pair is ~8 MB and safe; a 2048² export tile pair is ~32 MB on top of the export peak 1C already budgets | Medium | `TILE_CAP` is configurable and the harness prints the chosen edge and footprint. The 2048 default is an estimate |
| **Context loss on backgrounding** — mobile Safari drops WebGL contexts aggressively | Medium | `webglcontextlost` handled, default prevented, tier demoted to 3 and re-rendered from `layer.pixels`, which is still resident. One restore attempt, then stay on tier 3 for the session |
| **26 programs is 26 shader compiles** on a device where each may cost tens of ms | Low | Lazy: compiled on first use of each mode. A typical document uses 1–3. The probe pre-compiles `normal` and `hue` only |
| **Tile halo omission produces hairline seams** that read as a blend bug | Low | Specified explicitly above; the conformance route's full-resolution pass renders a fixture wider than the tile edge |
| **`renderProject` still ignores masks and clipping**, and the GPU reproduces that faithfully | Low for 1B, real for the product | Named here and in *Why this phase exists*. Not fixed in 1B — fixing it changes the project model, not the renderer, and belongs with the layers panel |

---

## Open questions

- Does `transferControlToOffscreen` + WebGL2 work in the Capacitor WebView on
  the oldest Android target, and on iOS 16.x? Decides whether tier 1 or tier 2
  is the common case. Carried forward from the parent spec, still open.
- What `MAX_TEXTURE_SIZE` do the target devices actually report? `TILE_CAP` is
  currently an estimate chosen for memory, not for the hardware limit.
- What is the real sandwich-cache frame time at 20 layers on a phone? The
  ~100 ms figure is arithmetic, not a measurement.
- Does the worker's `OffscreenCanvas` 2D context resolve the `FONT_STACKS`
  families, or substitute silently?
- Should `failIfMajorPerformanceCaveat` be set, to keep software WebGL2
  (SwiftShader) out of tiers 1 and 2? It is a memory hog on mobile, but the
  flag is inconsistently implemented and would risk demoting working devices.
- Once conformance is established and stable, is RGBA16F accumulation worth the
  extension dependency? It is strictly higher quality but makes the JS oracle a
  systematically worse reference, so it cannot be adopted and validated at the
  same time.

---

## Not doing

- **`dissolve`** — unchanged from the R&D decision. Maps to `normal`, as today.
- **Layer effects, adjustment layers, smart filters, blend-if.** Effects in
  particular would break tile independence by introducing neighbourhood
  operations that need halos.
- **Masks and clipping in the project path.** Absent today
  (`edit.js`/`render.js` carry neither); the GPU compositor mirrors
  `renderProject` exactly rather than diverging from it. Fixing it changes the
  project model and belongs with the layers panel.
- **Export orchestration** — streaming full-res re-read, spill-to-disk on
  reorder, progress UI. 1B provides the tiled compositor and the readback; 1C
  drives them.
- **A worker for tier 2.** No `transferControlToOffscreen` means no way to
  present from a worker, and shuttling `ImageBitmap`s per frame to work around
  it is a second render path for the least-common tier.
- **`headless-gl`, `puppeteer`, or any browser automation** for conformance.
  Fragile on Windows and forbidden by project rules respectively.
- **Raising the comparison tolerance above 1.** The known divergence sources
  are all bounded at 1 LSB except `LINEAR` filtering, which is reported in its
  own pass. Raising the tolerance to make that pass green would forgive real
  bugs everywhere else.
