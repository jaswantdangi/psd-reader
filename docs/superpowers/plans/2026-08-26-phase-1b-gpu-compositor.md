# Phase 1B-1 — Compositor Foundations and the JS Fallback Tier

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every part of the Phase 1B compositor that a machine without a GPU can prove correct — the blend-mode table, the generated GLSL, the 2D surface abstraction that stops edited text vanishing in a worker, the sandwich cache that makes the JS tier draggable, the conformance fixtures, and the tier-selection decision — and land them in the harness so a drag on the JS tier is measurably interactive.

**Architecture:** `src/gpu/modes.js` holds one table of blend-mode GLSL bodies transcribed from `composite.js`; `src/gpu/glsl.js` assembles a complete fragment shader from it, so a mode can never exist in one and not the other. `src/surface.js` resolves `OffscreenCanvas` → `document` → `null`, replacing the two bare `typeof document === 'undefined'` guards in `render.js` that silently drop an edited text layer inside a worker. `src/sandwich.js` caches the composite below and above the dragged layer so a drag frame re-blends three buffers instead of N. `src/gpu/detect.js` decides the tier from a capability object, pure and testable, leaving an explicit `probe` slot that the GPU plan fills.

**Tech Stack:** Node 24 (ESM, `node:assert/strict`), `ag-psd` 31, Ionic 8 + Angular standalone + Capacitor 8, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-08-26-phase-1b-gpu-compositor-design.md`](../specs/2026-08-26-phase-1b-gpu-compositor-design.md)

---

## This is part 1 of 2

Phase 1B's spec is larger than one executable plan. It is split at the line where
verification changes hands:

| Plan | Covers | Verified by |
|---|---|---|
| **1B-1 — this document** | mode table, GLSL generation, `src/surface.js`, `src/sandwich.js`, conformance fixtures, tier selection, harness drag + capability readout | `npm test` (tasks 1–8) and the user's browser (tasks 9–10) |
| 1B-2 — *not yet written* | `src/gpu/compositor.js`, the authoritative shader probe, tiling and sub-rect uploads, context-loss demotion, the render worker, the `/conformance` route | a real device, only |

The split is not a scope cut. Every requirement in the spec lands in one of the
two plans, and 1B-1 leaves 1B-2 named, typed slots rather than gaps — most
visibly `selectTier`'s `probe` field, which **refuses a GPU tier until the probe
that compiles, links and reads back a real blend has run**.

1B-1 ships working software on its own: the JS tier gains its sandwich cache and
a ms/frame readout, edited text stops vanishing off the main thread, and the
harness reports what the device's WebGL2 support actually is — which answers the
spec's first open question before a single line of 1B-2 is written.

---

## Deviations from the spec, and why

Five, all found by reading the code the spec describes. Each is implemented the
corrected way; the spec's text is otherwise binding.

1. **`composite.js` needs no change.** The spec asks for a new exported
   `BLEND_MODE_NAMES` "derived from its existing private tables". That already
   exists, as `SUPPORTED_BLEND_MODES` (`src/composite.js:62`), is already
   exported from `src/index.js`, and is already asserted against `BLEND_MODES` by
   `test/edit.mjs`. Adding a second name for the same list is exactly the drift
   the spec is trying to prevent. **The coverage test asserts against
   `SUPPORTED_BLEND_MODES`, and `composite.js` is not touched at all.**

2. **The revision counter cannot live only in `commit()`.** The spec says
   "`revision` is a counter bumped by `edit.js`'s existing `commit()`" and
   "Undo/redo goes through `commit()` and is therefore covered". Reading
   `src/edit.js:240-254`: `undo()` and `redo()` call `applyCommand()` **directly**
   and never touch `commit()`. A cache keyed on a commit-only counter would serve
   stale pixels after every undo. Task 5 bumps it in `commit()`, `undo()`,
   `redo()` and `applyProjectJson()` — every mutation path — and *not* in
   `applyCommand()`, because the coalesced frames of a drag go through
   `applyCommand()` and must **not** invalidate the cache. That asymmetry is the
   whole reason the sandwich survives a gesture, and Task 5 has a test for it.

3. **Both sandwich states are exact, not one.** The spec calls the cache "an
   approximation" and then specifies mitigation 2 — degrade to `below`-only and
   re-blend `[i .. n-1]` live whenever a non-`normal` mode sits above the
   selection. With that mitigation implemented the wrong case never runs: the
   degraded path is byte-for-byte identical to `renderProject`, and the cached
   path differs only by the ≤1 LSB of double quantisation inherent in compositing
   `above` onto a transparent buffer first. Task 6 asserts both, with different
   strengths, rather than assuming either. **The harness's state readout is
   therefore a speed indicator, not a correctness warning**, and Task 10 words it
   that way.

4. **`render.js` gains an exported `drawLayerInto`.** The spec does not mention
   it. `sandwich.js` has to re-blend one live layer per frame, and the only
   alternative to reusing `renderProject`'s per-layer body is copying the
   text-versus-resample branch into a second file — which is precisely how text
   ends up going through `resample()` (HANDOFF Failed Approach 5). The extraction
   is behaviour-preserving and Task 5 proves it.

5. **`vDstPx.y` is a row index, not a GL bottom-up y.** Every buffer in this
   engine is row-major from the top (`data[(y * width + x) * 4]`), and
   `readPixels` returns rows in the same order the textures were uploaded, so the
   composite is self-consistent with no flip. **Presenting the final accumulator
   to a *visible* canvas in 1B-2 therefore needs a Y flip in the present pass.**
   Stated in a comment on `VERTEX_SHADER` so the GPU plan inherits it rather than
   discovering it as an upside-down preview.

---

## Global Constraints

- **Engine code is plain ESM JavaScript in `src/`** — no TypeScript, no framework imports. It is consumed by Node tests, the existing `demo/` pages, and the Angular app alike.
- **GPU code cannot be tested by `npm test`.** Node has no WebGL. This plan produces GLSL **source strings** and asserts what they contain; nothing here compiles a shader. Tasks 1–3 say so in their own words. Do not add `headless-gl`, do not invent a Node GPU harness, do not claim a generated shader is "verified".
- **Do not run build commands.** Per project rules, the user builds and verifies. Tasks 9 and 10 hand verification over explicitly.
- **Never route text through `resample()`.** Text is vector; it must be drawn at final size (HANDOFF Failed Approach 5). `drawLayerInto` keeps that branch intact — do not flatten it while extracting.
- **Invalidate `renderedKey`, never `rendered` alone** — a stale key returns `null` and the layer disappears (HANDOFF Failed Approach 6).
- **Layer geometry stays in document coordinates.** `x/y/w/h` are full-resolution document space; `scale` is what draws the proxy. Nothing in this plan changes that.
- **Comparison tolerance is 1**, via `stat.percentReal`, never `stat.percent` (HANDOFF Failed Approach 8). `flattenOnto()` both buffers before comparing (Failed Approach 7).
- **Stage exact files.** Never `git add .` or `git add <dir>`; read `git diff --staged` before every commit.
- **`test/shim.mjs` does not recurse into subdirectories** (`fs.readdirSync(srcDir)`, `test/shim.mjs:28`). Nothing in `src/gpu/` imports `ag-psd`, so the guard is not needed here — but if a later file in `src/gpu/` ever does, the shim check will not catch it and the demo pages will blank.
- Test scripts run with `--max-old-space-size=6144` where they load fixtures.
- Branch: `phase-1-engine-gpu-memory`. Do not push without explicit approval.

**Expected baseline before Task 1.** Run `npm test` and confirm these five markers
appear, in this order (`test/composite.mjs` prints its counts on one summary line,
so the third marker is a fragment of that line, not a line of its own):

```
shim OK
21 files  |  parsed 21  |  failed 0
<0.5% diff: 12   <10%: 5   >=10%: 4
21 passed          <- test/edit.mjs
26 passed          <- test/proxy.mjs
```

If any of those five differs, stop and report it before starting — every
"Expected" below is written against this baseline.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/gpu/modes.js` | The blend-mode table: name → GLSL body, separable vs non-separable, and the mode → program mapping. Pure data and strings. |
| `src/gpu/glsl.js` | Assembles a complete vertex and fragment shader source for one mode from `modes.js`. Pure string work. |
| `src/gpu/detect.js` | Tier selection. `selectTier` is pure; `probeCapabilities` is the cheap browser half. |
| `src/surface.js` | 2D drawing surface: `OffscreenCanvas` → `document` → `null`. |
| `src/sandwich.js` | Drag-time cache for the JS tier. Pure buffer arithmetic over `renderProject`. |
| `src/conformance.js` | Deterministic conformance inputs and the PASS/WARN/FAIL rule, shared by the Node suite and (in 1B-2) the in-app route. |
| `test/gpu.mjs` | Suite for all of the above. |

**Modified:**

| File | Change |
|---|---|
| `src/render.js` | Use `create2dSurface`; extract and export `drawLayerInto` |
| `src/edit.js` | `project.revision`, bumped by `commit`, `undo`, `redo`, `applyProjectJson` |
| `src/index.js` | Export the new modules |
| `package.json` | `test:gpu` script |
| `app/src/app/harness/harness.page.ts` | Capability readout; drag through the sandwich cache with a ms/frame readout |

`src/composite.js` is deliberately **not** in either table. See deviation 1.

---

### Task 1: The blend-mode table

**Files:**
- Create: `src/gpu/modes.js`
- Create: `test/gpu.mjs`
- Modify: `src/index.js`, `package.json`

**Interfaces:**
- Consumes: `SUPPORTED_BLEND_MODES` from `src/composite.js` (existing export, test-only)
- Produces:
  - `SEPARABLE_GLSL: Record<string, string>` — body of `float chan(float b, float s)`, 20 entries
  - `NON_SEPARABLE_GLSL: Record<string, string>` — body of `vec3 blendFn(vec3 b, vec3 s)`, 6 entries
  - `GPU_BLEND_MODES: string[]` — all 26, in `SUPPORTED_BLEND_MODES` order
  - `isNonSeparableMode(name: string) -> boolean`
  - `programNameFor(mode: unknown) -> string` — always returns a key of one of the two tables

> **No GPU is involved in this task.** Every value here is a string. Nothing
> compiles, and `npm test` proves only that the table covers what `composite.js`
> implements — which the spec names as the single most likely regression in the
> whole phase.

- [ ] **Step 1: Write the failing tests**

Create `test/gpu.mjs`:

```js
import assert from 'node:assert/strict';
import {
  SUPPORTED_BLEND_MODES,
  SEPARABLE_GLSL, NON_SEPARABLE_GLSL, GPU_BLEND_MODES, programNameFor, isNonSeparableMode,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('\nblend mode table\n');

test('the GPU mode table covers exactly what the compositor implements', () => {
  // The regression this exists for: adding a mode to composite.js and
  // forgetting the shader, so the layer renders as `normal` on one code path
  // and correctly on the other. Asserted in both directions, because a mode
  // present here but absent there would render something nothing else can.
  const missing = SUPPORTED_BLEND_MODES.filter((m) => !GPU_BLEND_MODES.includes(m));
  const extra = GPU_BLEND_MODES.filter((m) => !SUPPORTED_BLEND_MODES.includes(m));
  assert.deepEqual(missing, [], 'implemented by composite.js but absent from the shader table');
  assert.deepEqual(extra, [], 'in the shader table but not implemented by composite.js');
  assert.equal(GPU_BLEND_MODES.length, 26);
});

test('separable and non-separable are disjoint, and together they are the whole table', () => {
  const both = Object.keys(SEPARABLE_GLSL).filter((m) => Object.hasOwn(NON_SEPARABLE_GLSL, m));
  assert.deepEqual(both, [], 'a mode cannot be both — the generator would emit two blendFn');
  assert.equal(Object.keys(SEPARABLE_GLSL).length, 20);
  assert.equal(Object.keys(NON_SEPARABLE_GLSL).length, 6);
});

test('dissolve and pass through compile to the normal program', () => {
  // blendInto does `const blend = fn || SEPARABLE.normal`, so both already
  // render as normal today. The GPU must not diverge from that.
  assert.equal(programNameFor('dissolve'), 'normal');
  assert.equal(programNameFor('pass through'), 'normal');
});

test('an unknown or missing blend mode falls through to normal', () => {
  assert.equal(programNameFor(undefined), 'normal');
  assert.equal(programNameFor(null), 'normal');
  assert.equal(programNameFor(''), 'normal');
  assert.equal(programNameFor('constructor'), 'normal', 'prototype keys must not resolve');
  assert.equal(programNameFor('multiply'), 'multiply');
  assert.equal(programNameFor('hue'), 'hue');
});

test('every separable body works in 0..1 — only hard mix mentions 255', () => {
  // composite.js is 0..255 integers. A formula left in that space would be
  // silently, hugely wrong on the GPU and would still compile.
  for (const [name, body] of Object.entries(SEPARABLE_GLSL)) {
    if (name === 'hard mix') {
      assert.match(body, /255\.0/, 'hard mix must compare in integer space');
      continue;
    }
    assert.ok(!/255/.test(body), `"${name}" still carries a 0..255 constant: ${body}`);
  }
  assert.equal(isNonSeparableMode('hue'), true);
  assert.equal(isNonSeparableMode('multiply'), false);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: FAIL — `SyntaxError: The requested module '../src/index.js' does not provide an export named 'SEPARABLE_GLSL'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/gpu/modes.js`:

```js
/**
 * The blend-mode table, shared by the GLSL generator and the coverage test.
 *
 * Pure data and strings — no WebGL, no DOM — so `npm test` can import it. That
 * is deliberate: Node has no GPU, and this file plus `glsl.js` are the only
 * part of the GPU path a Node suite can say anything about.
 *
 * Every body is a transcription of the matching entry in composite.js, divided
 * into 0..1. Do NOT "simplify" one. GLSL ES 3.00 has no `precise` qualifier, the
 * JS compositor is the oracle conformance measures against, and an algebraic
 * rewrite changes the rounding.
 */

/**
 * Body of `float chan(float b, float s)` for each separable mode, in the same
 * order as composite.js's SEPARABLE.
 */
export const SEPARABLE_GLSL = {
  'normal': 'return s;',
  'darken': 'return min(b, s);',
  'multiply': 'return b * s;',
  'color burn': 'return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s);',
  'linear burn': 'return (b + s < 1.0) ? 0.0 : b + s - 1.0;',
  'lighten': 'return max(b, s);',
  'screen': 'return b + s - b * s;',
  'color dodge': 'return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));',
  'linear dodge': 'return (b + s > 1.0) ? 1.0 : b + s;',
  'overlay': 'return (b <= 0.5) ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);',
  'hard light': 'return (s <= 0.5) ? 2.0 * s * b : 1.0 - 2.0 * (1.0 - s) * (1.0 - b);',
  'soft light':
    'float d = (b <= 0.25) ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);\n' +
    '  return (s <= 0.5) ? b - (1.0 - 2.0 * s) * b * (1.0 - b)\n' +
    '                    : b + (2.0 * s - 1.0) * (d - b);',
  'vivid light':
    'return (s <= 0.5)\n' +
    '    ? (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / (2.0 * s)))\n' +
    '    : (s >= 1.0 ? 1.0 : min(1.0, b / (2.0 * (1.0 - s))));',
  'linear light': 'return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);',
  'pin light': 'return (s <= 0.5) ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);',
  // The ONE mode that must compare in integer space. It is discontinuous at its
  // boundary, and float(n/255) + float(m/255) where n + m == 255 can round to
  // 0.99999994 -- flipping the output from 255 to 0, a full-channel-range error
  // out of half a ULP of rounding. Every other threshold in this table is either
  // continuous across it (linear burn, linear dodge) or tests an
  // exactly-representable 0.0 / 1.0 (color burn, color dodge, divide).
  'hard mix': 'return (floor(b * 255.0 + 0.5) + floor(s * 255.0 + 0.5) >= 255.0) ? 1.0 : 0.0;',
  'difference': 'return abs(b - s);',
  'exclusion': 'return b + s - 2.0 * b * s;',
  'subtract': 'return max(0.0, b - s);',
  'divide': 'return (s <= 0.0) ? 1.0 : min(1.0, b / s);',
};

/**
 * Body of `vec3 blendFn(vec3 b, vec3 s)` for each non-separable mode, in the
 * same order as composite.js's NON_SEPARABLE. These need lum/sat/setLum/setSat,
 * which glsl.js emits as a prelude.
 */
export const NON_SEPARABLE_GLSL = {
  'hue': 'return setLum(setSat(s, sat(b)), lum(b));',
  'saturation': 'return setLum(setSat(b, sat(s)), lum(b));',
  'color': 'return setLum(s, lum(b));',
  'luminosity': 'return setLum(b, lum(s));',
  'darker color': 'return (lum(s) < lum(b)) ? s : b;',
  'lighter color': 'return (lum(s) > lum(b)) ? s : b;',
};

/** All 26, in composite.js's SUPPORTED_BLEND_MODES order. */
export const GPU_BLEND_MODES = [
  ...Object.keys(SEPARABLE_GLSL),
  ...Object.keys(NON_SEPARABLE_GLSL),
];

export const isNonSeparableMode = (name) => Object.hasOwn(NON_SEPARABLE_GLSL, name);

/**
 * The program a layer's blend mode compiles to.
 *
 * Mirrors blendInto's `const blend = fn || SEPARABLE.normal` exactly:
 * `dissolve`, `pass through` and anything unrecognised render as `normal`.
 *
 * One specialised program per mode -- never a switch on a uniform int, which is
 * the shape old Mali/Adreno compilers miscompile or serialise. A typical
 * document uses one to three modes, so lazily compiling per mode costs almost
 * nothing.
 *
 * `Object.hasOwn` rather than `in`, so `programNameFor('constructor')` cannot
 * resolve to a prototype member and emit `undefined` into a shader.
 */
export function programNameFor(mode) {
  if (typeof mode !== 'string') return 'normal';
  if (Object.hasOwn(SEPARABLE_GLSL, mode) || Object.hasOwn(NON_SEPARABLE_GLSL, mode)) return mode;
  return 'normal';
}
```

Add to `src/index.js`:

```js
export {
  SEPARABLE_GLSL, NON_SEPARABLE_GLSL, GPU_BLEND_MODES, programNameFor, isNonSeparableMode,
} from './gpu/modes.js';
```

Add to the `scripts` block of `package.json`:

```json
"test:gpu": "node test/gpu.mjs",
```

…and append `&& node test/gpu.mjs` to the existing `test` script so it runs in the suite.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/gpu.mjs`
Expected: PASS — `5 passed`

Run: `npm test`
Expected: `shim OK` → `21 files | parsed 21 | failed 0` → `<0.5% diff: 12   <10%: 5   >=10%: 4` → `21 passed` → `26 passed` → `5 passed`

- [ ] **Step 5: Commit**

```bash
git add src/gpu/modes.js src/index.js test/gpu.mjs package.json
git diff --staged
git commit -m "Add the GPU blend-mode table with a coverage test against composite.js"
```

---

### Task 2: Shader assembly and the twenty separable programs

**Files:**
- Create: `src/gpu/glsl.js`
- Modify: `src/index.js`
- Test: `test/gpu.mjs`

**Interfaces:**
- Consumes: `SEPARABLE_GLSL`, `programNameFor`, `isNonSeparableMode` (Task 1)
- Produces:
  - `VERTEX_SHADER: string` — one full-canvas triangle from `gl_VertexID`, no attribute buffers
  - `fragmentShaderFor(mode: string) -> string` — a complete `#version 300 es` fragment shader
  - Uniform contract that 1B-2's compositor binds: `uBackdrop` (sampler2D), `uSource` (sampler2D), `uRect` (vec4 left/top/width/height in destination pixels), `uCanvas` (vec2), `uOpacity` (float)

> **Nothing here is compiled.** `npm test` asserts what the emitted string
> contains — the transcription, the two early-outs, the association order. That
> a driver accepts it is established only by 1B-2's probe, on a device.

- [ ] **Step 1: Write the failing tests**

Append to `test/gpu.mjs`, before the final `console.log`:

```js
console.log('\nshader assembly\n');

/**
 * Comment-stripped source. The templates deliberately carry prose that names
 * the very constructs these tests forbid ("Do NOT rewrite as mix(...)"), so
 * asserting against raw text would fail on its own documentation.
 */
const code = (src) => src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const count = (s, ch) => s.split(ch).length - 1;

test('every mode produces a structurally complete fragment shader', () => {
  for (const mode of GPU_BLEND_MODES) {
    const src = fragmentShaderFor(mode);
    assert.ok(src.startsWith('#version 300 es'), `${mode}: #version must be the first characters`);
    assert.ok(src.includes('precision highp float;'), `${mode}: missing precision qualifier`);
    const body = code(src);
    assert.equal(count(body, 'void main()'), 1, `${mode}: expected exactly one main()`);
    assert.equal(count(body, 'vec3 blendFn('), 1, `${mode}: expected exactly one blendFn`);
    assert.equal(count(body, '{'), count(body, '}'), `${mode}: unbalanced braces`);
    assert.equal(count(body, '('), count(body, ')'), `${mode}: unbalanced parens`);
  }
});

test('multiply is transcribed, not paraphrased', () => {
  const src = code(fragmentShaderFor('multiply'));
  assert.ok(src.includes('float chan(float b, float s)'), 'separable modes go through chan()');
  assert.ok(src.includes('return b * s;'));
  assert.ok(src.includes('return vec3(chan(b.r, s.r), chan(b.g, s.g), chan(b.b, s.b));'));
});

test('a separable program carries no non-separable prelude', () => {
  // Dead code the driver still has to parse, on hardware where each compile
  // costs tens of ms.
  const src = code(fragmentShaderFor('screen'));
  assert.ok(!src.includes('setSat'), 'separable shaders must not carry setSat');
  assert.ok(!src.includes('clipColor'), 'separable shaders must not carry clipColor');
});

test("the composite expression keeps blendInto's association order", () => {
  for (const mode of GPU_BLEND_MODES) {
    const src = code(fragmentShaderFor(mode));
    assert.ok(src.includes('vec3 C = src.rgb + ab * (B - src.rgb);'),
      `${mode}: the blend-toward-backdrop step must stay in the JS association order`);
    assert.ok(src.includes('fragColor = vec4((as * C + ab * dst.rgb * (1.0 - as)) / ao, ao);'),
      `${mode}: the straight-alpha composite must stay in the JS association order`);
  }
});

test('no generated shader uses an interpolation builtin', () => {
  // mix(src.rgb, B, ab) is algebraically equal and differently rounded. So is
  // any other rearrangement. This is the assertion that stops a later tidy-up.
  for (const mode of GPU_BLEND_MODES)
    assert.ok(!/\bmix\s*\(/.test(code(fragmentShaderFor(mode))), `${mode} uses mix()`);
});

test("both of blendInto's early-outs survive into the shader", () => {
  const src = code(fragmentShaderFor('normal'));
  // Not optimisations. Without the first, a transparent source fragment runs
  // the straight-alpha divide and re-quantises the backdrop instead of leaving
  // it as an exact unorm8 round trip.
  assert.ok(src.includes('if (as <= 0.0) { fragColor = dst; return; }'));
  assert.ok(src.includes('if (ao <= 0.0) { fragColor = vec4(0.0); return; }'));
  // And the rect clamp, which reproduces the JS loop's x0..x1 / y0..y1 bounds.
  assert.ok(src.includes('any(lessThan(uv, vec2(0.0)))'));
  assert.ok(src.includes('any(greaterThanEqual(uv, vec2(1.0)))'));
});

test('hard mix compares in integer space, and nothing else does', () => {
  assert.ok(code(fragmentShaderFor('hard mix')).includes('floor(b * 255.0 + 0.5)'));
  for (const mode of GPU_BLEND_MODES) {
    if (mode === 'hard mix') continue;
    assert.ok(!/255/.test(code(fragmentShaderFor(mode))),
      `${mode} carries a 0..255 constant into the shader`);
  }
});

test('the vertex shader needs no attribute buffers and lands on texel centres', () => {
  assert.ok(VERTEX_SHADER.startsWith('#version 300 es'));
  assert.ok(VERTEX_SHADER.includes('gl_VertexID'), 'the full-canvas triangle is generated, not uploaded');
  assert.ok(!/^\s*in\s+vec/m.test(VERTEX_SHADER), 'declaring an attribute would need a VBO to feed it');
  assert.ok(VERTEX_SHADER.includes('vDstPx = c * uCanvas;'),
    'vDstPx must be a linear function of position so it interpolates to pixel centres');
});
```

Add `VERTEX_SHADER` and `fragmentShaderFor` to the existing import at the top of `test/gpu.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: FAIL — `does not provide an export named 'fragmentShaderFor'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/gpu/glsl.js`:

```js
/**
 * Generates the compositor's GLSL from modes.js.
 *
 * Generated rather than hand-written for one reason: the likeliest regression
 * in this phase is adding a blend mode to composite.js and forgetting the
 * shader. Generation makes that impossible by construction, and the coverage
 * test in test/gpu.mjs makes it assertable inside `npm test` -- the one real
 * guarantee `npm test` can give about the GPU path.
 *
 * Nothing here touches WebGL, so it imports and runs in Node.
 */
import { SEPARABLE_GLSL, NON_SEPARABLE_GLSL, programNameFor, isNonSeparableMode } from './modes.js';

/**
 * One full-canvas triangle from gl_VertexID. No attributes, no VBO, no VAO
 * contents -- the compositor binds an empty VAO and calls drawArrays(TRIANGLES, 0, 3).
 *
 * `vDstPx` is the destination pixel coordinate and lands on texel CENTRES after
 * interpolation (pixel 0 receives 0.5). That is what makes the 1:1 NEAREST blit
 * bit-exact rather than merely close -- `uv * texSize` comes out on whole texels.
 *
 * NOTE FOR THE PRESENT PASS: vDstPx.y is a ROW INDEX, matching the row-major
 * layout of every Uint8ClampedArray in this engine and of readPixels. Compositing
 * and readback are self-consistent with no flip. Presenting the final accumulator
 * to a VISIBLE canvas needs a Y flip in the present pass, or the preview is upside
 * down.
 */
export const VERTEX_SHADER = `#version 300 es
precision highp float;

uniform vec2 uCanvas;
out vec2 vDstPx;

void main() {
  vec2 c = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(c * 2.0 - 1.0, 0.0, 1.0);
  vDstPx = c * uCanvas;
}
`;

const FRAGMENT_HEADER = `#version 300 es
precision highp float;

uniform sampler2D uBackdrop;
uniform sampler2D uSource;
uniform vec4  uRect;      // left, top, width, height -- destination pixels
uniform vec2  uCanvas;
uniform float uOpacity;

in  vec2 vDstPx;
out vec4 fragColor;
`;

/**
 * Ported from composite.js's lum / sat / clipColor / setLum / setSat.
 * Emitted only for the six non-separable programs.
 */
const NON_SEPARABLE_PRELUDE = `
const vec3  LUM_W = vec3(0.3, 0.59, 0.11);
const float EPS   = 1e-6;

float lum(vec3 c) { return dot(c, LUM_W); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  // l, n and x are computed ONCE, before both branches. composite.js mutates c
  // inside the first branch and then tests the STALE x. Recomputing here would
  // be tidier and would diverge from the oracle. Keep it stale.
  //
  // max(., EPS) covers a 0/0 believed unreachable: l - n is zero only when all
  // three channels are equal, and setLum is only ever called with an l taken
  // from a non-negative source, so the n < 0 branch cannot fire on a grey. In
  // JS the result would be NaN, which Uint8ClampedArray stores as 0; a NaN
  // written to a unorm8 target in GL is undefined and has been observed as
  // garbage. Two instructions to delete a class of driver-specific artifact.
  if (n < 0.0) c = l + (c - l) * (l / max(l - n, EPS));
  if (x > 1.0) c = l + (c - l) * ((1.0 - l) / max(x - l, EPS));
  return c;
}

vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

// Closed form of the W3C sort-based SetSat: branch-free, and with no dynamic
// vector indexing. GLSL ES 3.00 permits dynamic indexing, but it compiles to
// conditional moves or scratch memory and has a history of driver bugs. The
// sort in composite.js is an implementation artifact, not the maths -- the
// minimum channel maps to 0, the maximum to s, the middle to
// (mid - mn) * s / (mx - mn). That is exactly what this computes, componentwise.
vec3 setSat(vec3 c, float s) {
  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  return (mx > mn) ? (c - mn) * (s / (mx - mn)) : vec3(0.0);
}
`;

/** A literal transcription of blendInto's inner loop, one fragment at a time. */
const FRAGMENT_MAIN = `
void main() {
  vec4 dst = texture(uBackdrop, vDstPx / uCanvas);

  vec2 uv = (vDstPx - uRect.xy) / uRect.zw;
  // Reproduces blendInto's x0..x1 / y0..y1 clamp exactly.
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) {
    fragColor = dst; return;
  }

  vec4 src = texture(uSource, uv);

  float as = src.a * uOpacity;
  // Not an optimisation. Without it a transparent source fragment would run the
  // straight-alpha divide and re-quantise the backdrop. Returning dst unchanged
  // is an exact unorm8 -> float -> unorm8 round trip, matching JS's \`continue\`.
  if (as <= 0.0) { fragColor = dst; return; }

  float ab = dst.a;
  float ao = as + ab * (1.0 - as);
  // Replaces blendInto's second \`continue\`: straight alpha divides by ao.
  if (ao <= 0.0) { fragColor = vec4(0.0); return; }

  vec3 B = blendFn(dst.rgb, src.rgb);
  // JS association order on purpose. Do NOT rewrite as mix(src.rgb, B, ab) --
  // algebraically equal, differently rounded.
  vec3 C = src.rgb + ab * (B - src.rgb);

  fragColor = vec4((as * C + ab * dst.rgb * (1.0 - as)) / ao, ao);
}
`;

/**
 * Complete fragment shader source for one blend mode.
 *
 * @param {string} mode  A layer's blendMode. Unknown values, `dissolve` and
 *   `pass through` all yield the `normal` program, matching blendInto.
 * @returns {string}
 */
export function fragmentShaderFor(mode) {
  const name = programNameFor(mode);

  if (isNonSeparableMode(name)) {
    return FRAGMENT_HEADER + NON_SEPARABLE_PRELUDE +
      `\nvec3 blendFn(vec3 b, vec3 s) {\n  ${NON_SEPARABLE_GLSL[name]}\n}\n` +
      FRAGMENT_MAIN;
  }

  return FRAGMENT_HEADER +
    `\nfloat chan(float b, float s) {\n  ${SEPARABLE_GLSL[name]}\n}\n` +
    '\nvec3 blendFn(vec3 b, vec3 s) {\n' +
    '  return vec3(chan(b.r, s.r), chan(b.g, s.g), chan(b.b, s.b));\n}\n' +
    FRAGMENT_MAIN;
}
```

Add to `src/index.js`:

```js
export { VERTEX_SHADER, fragmentShaderFor } from './gpu/glsl.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/gpu.mjs`
Expected: PASS — `13 passed`

Run: `npm test`
Expected: unchanged through `26 passed`, then `13 passed`

- [ ] **Step 5: Commit**

```bash
git add src/gpu/glsl.js src/index.js test/gpu.mjs
git diff --staged
git commit -m "Generate the compositor fragment shader from the mode table"
```

---

### Task 3: The six non-separable programs

**Files:**
- Test: `test/gpu.mjs`

**Interfaces:**
- Consumes: `fragmentShaderFor` (Task 2), `NON_SEPARABLE_GLSL` (Task 1)
- Produces: nothing new — this task **only adds assertions**. Task 2's
  implementation already emits the prelude; this pins the three details that are
  easy to "fix" into divergence.

The six non-separable modes are the only fiddly work in the whole shader, and
the fiddliness is concentrated in three places that all look like bugs:
`clipColor` reads a stale `x`, `setSat` is written as a closed form rather than
a sort, and two divides carry an epsilon guard for a case believed unreachable.
Each is deliberate. Without a test they get tidied away.

> **Still no GPU.** These are string assertions over generated source.

- [ ] **Step 1: Write the failing tests**

Append to `test/gpu.mjs`, before the final `console.log`:

```js
console.log('\nnon-separable modes\n');

test('the six non-separable modes get the colour-space prelude', () => {
  for (const mode of Object.keys(NON_SEPARABLE_GLSL)) {
    const src = code(fragmentShaderFor(mode));
    assert.ok(src.includes('float lum(vec3 c)'), `${mode}: missing lum`);
    assert.ok(src.includes('float sat(vec3 c)'), `${mode}: missing sat`);
    assert.ok(src.includes('vec3 setLum(vec3 c, float l)'), `${mode}: missing setLum`);
    assert.ok(src.includes('vec3 setSat(vec3 c, float s)'), `${mode}: missing setSat`);
    assert.ok(src.includes('vec3 clipColor(vec3 c)'), `${mode}: missing clipColor`);
    assert.ok(src.includes(NON_SEPARABLE_GLSL[mode]), `${mode}: body not emitted`);
  }
  assert.ok(code(fragmentShaderFor('hue')).includes('LUM_W = vec3(0.3, 0.59, 0.11)'),
    'the luminance weights must match composite.js exactly');
});

test('setSat is the branch-free closed form, with no dynamic vector indexing', () => {
  const src = code(fragmentShaderFor('hue'));
  assert.ok(src.includes('(mx > mn) ? (c - mn) * (s / (mx - mn)) : vec3(0.0)'));
  // composite.js sorts three channel indices and writes back by index. GLSL ES
  // 3.00 permits that and compiles it to conditional moves or scratch memory,
  // with a history of driver bugs. The sort is an implementation artifact.
  assert.ok(!/\bc\s*\[/.test(src), 'dynamic vector indexing must not appear');
  assert.ok(!/\bsort\b/.test(src));
});

test('clipColor computes l, n and x once, before either branch', () => {
  const src = code(fragmentShaderFor('color'));
  const xAt = src.indexOf('float x = max(');
  const branchAt = src.indexOf('if (n < 0.0)');
  assert.ok(xAt > -1 && branchAt > -1, 'clipColor is not shaped as expected');
  assert.ok(xAt < branchAt,
    'x must be computed BEFORE the branch that mutates c. composite.js tests the ' +
    'STALE x; recomputing it would be tidier and would diverge from the oracle.');
});

test('both non-separable divides carry the NaN guard', () => {
  // In JS a 0/0 yields NaN, which Uint8ClampedArray stores as 0. In GLSL a NaN
  // written to a unorm8 target is undefined and has been observed as garbage.
  const src = code(fragmentShaderFor('saturation'));
  assert.ok(src.includes('max(l - n, EPS)'));
  assert.ok(src.includes('max(x - l, EPS)'));
  assert.ok(src.includes('const float EPS   = 1e-6;'));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: PASS — `17 passed`.

**These four tests pass immediately**, because Task 2 already emitted the
prelude. That is the point of the task: they are regression pins on details a
later reader will otherwise "correct". Confirm they pass, then deliberately
break one to prove each pin bites — edit `NON_SEPARABLE_PRELUDE` in
`src/gpu/glsl.js` to recompute `x` after the first branch:

```glsl
  if (n < 0.0) c = l + (c - l) * (l / max(l - n, EPS));
  x = max(c.r, max(c.g, c.b));
  if (x > 1.0) c = l + (c - l) * ((1.0 - l) / max(x - l, EPS));
```

Run `node test/gpu.mjs` and confirm `FAIL clipColor computes l, n and x once, before either branch`. Then revert that edit — `git checkout src/gpu/glsl.js` — and re-run to confirm `17 passed`.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: unchanged through `26 passed`, then `17 passed`

- [ ] **Step 4: Commit**

```bash
git add test/gpu.mjs
git diff --staged
git commit -m "Pin the three deliberate oddities in the non-separable GLSL"
```

---

### Task 4: The 2D surface abstraction

**Files:**
- Create: `src/surface.js`
- Modify: `src/render.js`, `src/index.js`
- Test: `test/gpu.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `create2dSurface(width: number, height: number) -> OffscreenCanvas | HTMLCanvasElement | null`

`measureText` and `rasteriseTextAt` both open with
`if (typeof document === 'undefined') return null`. Inside a Web Worker that is a
silent `null`, and `renderProject`'s `if (!pixels) continue` then drops the
layer. **An edited text layer simply vanishes, with no error anywhere** — and the
render worker in 1B-2 makes that the normal case, so this is a prerequisite, not
polish.

Untouched Photoshop text is unaffected: `render.js:143` gates the `textPixelsAt`
path on `layer.rerendered`, which starts `false`. Only text the user has retyped
or resized takes this path.

- [ ] **Step 1: Write the failing tests**

Append to `test/gpu.mjs`, before the final `console.log`:

```js
console.log('\n2d surface\n');

test('Node has no 2D surface at all', () => {
  // Neither global exists here, and pretending otherwise would make
  // rasteriseTextAt return a buffer of nothing.
  assert.equal(create2dSurface(8, 8), null);
});

test('falls back to document when there is no OffscreenCanvas', () => {
  globalThis.document = { createElement: (tag) => ({ tag, width: 0, height: 0 }) };
  try {
    const surface = create2dSurface(7, 3);
    assert.equal(surface.tag, 'canvas');
    assert.equal(surface.width, 7);
    assert.equal(surface.height, 3);
  } finally { delete globalThis.document; }
});

test('prefers OffscreenCanvas over document', () => {
  // Order is load-bearing, in both directions. Reversing it would put a worker
  // on the document path -- the bug this file exists to fix. And checking
  // document first would break test/edit.mjs, which stubs globalThis.document
  // to observe setTransform/fillText and relies on that stub winning in Node.
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; this.offscreen = true; } };
  globalThis.document = { createElement: () => ({ tag: 'canvas', width: 0, height: 0 }) };
  try {
    const surface = create2dSurface(5, 5);
    assert.equal(surface.offscreen, true, 'a worker must get the OffscreenCanvas, not a DOM canvas');
  } finally { delete globalThis.OffscreenCanvas; delete globalThis.document; }
});

test('measureText returns null where there is no surface', () => {
  assert.equal(measureText({ content: 'x', fontSize: 12, fontFamily: 'Arial' }), null);
});

test('rasteriseTextAt returns null where there is no surface', () => {
  const layer = { text: { content: 'x', fontSize: 12, fontFamily: 'Arial', color: '#000', align: 'left' } };
  assert.equal(rasteriseTextAt(layer, 10, 10), null);
});
```

Add `create2dSurface`, `measureText` and `rasteriseTextAt` to the existing import at the top of `test/gpu.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: FAIL — `does not provide an export named 'create2dSurface'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/surface.js`:

```js
/**
 * A 2D drawing surface, wherever this happens to be running.
 *
 * render.js reaches for a canvas to rasterise re-drawn text. Both entry points
 * opened with `if (typeof document === 'undefined') return null`, which inside a
 * Web Worker is a silent null -- and renderProject's `if (!pixels) continue`
 * then drops the layer. An edited text layer simply vanishes, with no error
 * anywhere.
 *
 * Same idea as canvas.js one level up: keep the DOM out of the pixel path, and
 * make the absence of a surface explicit rather than incidental.
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvas | HTMLCanvasElement | null} null in Node, which has
 *   no text rasteriser at all.
 */
export function create2dSurface(width, height) {
  const w = Math.max(1, Math.round(width) || 1);
  const h = Math.max(1, Math.round(height) || 1);

  // OffscreenCanvas FIRST. Order matters in both directions: reversing it would
  // put a worker on the document path, and checking document first would break
  // test/edit.mjs, which stubs globalThis.document to observe the canvas calls
  // and relies on that stub winning under Node (which has no global
  // OffscreenCanvas).
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  return null;
}
```

In `src/render.js`, add the import beneath the existing one:

```js
import { create2dSurface } from './surface.js';
```

Replace the opening of `measureText` (lines 61-63):

```js
export function measureText(text) {
  const surface = create2dSurface(1, 1);
  if (!surface) return null;
  const ctx = surface.getContext('2d');
```

Replace the opening of `rasteriseTextAt` (lines 80-93) down to and including the `getContext` call:

```js
export function rasteriseTextAt(layer, width, height) {
  const natural = measureText(layer.text);
  if (!natural || !natural.width || !natural.height) return null;

  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const canvas = create2dSurface(w, h);
  if (!canvas) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
```

Both surface types accept `getContext('2d', { willReadFrequently: true })`, and
`create2dSurface` has already applied the size — the two `canvas.width = w` /
`canvas.height = h` lines are gone.

Add to `src/index.js`:

```js
export { create2dSurface } from './surface.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/gpu.mjs`
Expected: PASS — `22 passed`

Run: `npm test`
Expected: unchanged through `26 passed`, then `22 passed`. **`21 passed` for
`test/edit.mjs` is the assertion that matters here** — its five text tests drive
`rasteriseTextAt` through a `globalThis.document` stub, and they only keep
passing because Node has no global `OffscreenCanvas` and the document branch is
still reachable.

- [ ] **Step 5: Commit**

```bash
git add src/surface.js src/render.js src/index.js test/gpu.mjs
git diff --staged
git commit -m "Resolve a 2D surface through OffscreenCanvas so worker text does not vanish"
```

---

### Task 5: What the sandwich cache needs from render.js and edit.js

**Files:**
- Modify: `src/render.js`, `src/edit.js`, `src/index.js`
- Test: `test/gpu.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `drawLayerInto(dest: Buffer, layer: object, scale?: number) -> void` — draws one layer exactly as `renderProject` does, including the visibility, bounds, text and resample rules
  - `project.revision: number` — starts at 0, bumped by `commit`, `undo`, `redo` and `applyProjectJson`, and **not** by the coalesced frames of a drag

Two edits to two files, one deliverable: everything `src/sandwich.js` needs in
order to exist without duplicating renderer logic or inventing its own
invalidation.

**Where the revision bump goes is not a detail.** `setLayer` calls `commit()` on
the first frame of a drag and takes the coalescing branch — `applyCommand()`
directly — for every frame after. Bumping inside `applyCommand()` would
invalidate the cache on every frame and make the whole feature pointless.
Bumping only inside `commit()` would leave `undo()` and `redo()` serving stale
pixels, because neither calls it.

- [ ] **Step 1: Write the failing tests**

Append to `test/gpu.mjs`, before the final `console.log`:

```js
console.log('\nrenderer extraction and revisions\n');

/**
 * Deterministic non-flat pixels: flat colour hides rounding differences.
 *
 * `alphaFloor` raises the alpha ramp's bottom end. Full-range alpha is the
 * better default, but the sandwich cache's `above` half divides by its own
 * accumulated alpha, so a near-transparent stack there amplifies quantisation
 * error out of the range the exactness test can bound. One test raises the
 * floor for exactly that reason and says so.
 */
const gradient = (w, h, seed, alphaFloor = 0) => {
  const buffer = createBuffer(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    buffer.data[i]     = (x * 11 + seed * 37) & 255;
    buffer.data[i + 1] = (y * 13 + seed * 61) & 255;
    buffer.data[i + 2] = (x * y + seed * 17) & 255;
    const a = (x * 9 + y * 5 + seed * 23) & 255;
    buffer.data[i + 3] = alphaFloor + Math.round((a * (255 - alphaFloor)) / 255);
  }
  return buffer;
};

const SIZE = 24;

/**
 * @param {{mode?:string, opacity?:number, hidden?:boolean,
 *          left?:number, top?:number, alphaFloor?:number}[]} specs
 */
const syntheticProject = (specs) => createProject({
  width: SIZE, height: SIZE,
  children: specs.map((s, i) => {
    const left = s.left ?? 0, top = s.top ?? 0;
    const w = SIZE - left, h = SIZE - top;
    return {
      name: `L${i}`, left, top, right: left + w, bottom: top + h,
      blendMode: s.mode ?? 'normal', opacity: s.opacity ?? 1, hidden: s.hidden === true,
      proxyData: gradient(w, h, i + 1, s.alphaFloor ?? 0),
    };
  }),
}, 'synthetic.psd');

test('renderProject is exactly a fold of drawLayerInto over the layer list', () => {
  const project = syntheticProject([{}, { mode: 'multiply' }, { left: 3, top: 5, opacity: 0.4 }]);
  const folded = createBuffer(SIZE, SIZE);
  for (const layer of project.layers) drawLayerInto(folded, layer, 1);
  assert.deepEqual(Array.from(folded.data), Array.from(renderProject(project, { scale: 1 }).data));
});

test('drawLayerInto skips hidden and zero-opacity layers', () => {
  const project = syntheticProject([{ hidden: true }, { opacity: 0 }]);
  const dest = createBuffer(SIZE, SIZE);
  for (const layer of project.layers) drawLayerInto(dest, layer, 1);
  assert.ok(dest.data.every((v) => v === 0), 'nothing visible should have been drawn');
});

test('commit bumps the project revision', () => {
  const project = syntheticProject([{}, {}]);
  assert.equal(project.revision, 0, 'a fresh project starts at 0');
  setLayer(project, project.layers[0].id, { x: 4 });
  assert.equal(project.revision, 1);
});

test('undo and redo bump it too — commit() alone does not cover them', () => {
  // undo() and redo() call applyCommand directly (src/edit.js:240-254). A cache
  // keyed on a commit-only counter would serve stale pixels after every undo.
  const project = syntheticProject([{}, {}]);
  setLayer(project, project.layers[0].id, { x: 4 });
  const after = project.revision;
  undo(project);
  assert.equal(project.revision, after + 1, 'undo must invalidate caches');
  redo(project);
  assert.equal(project.revision, after + 2, 'redo must invalidate caches');
});

test('the coalesced frames of a drag do not bump it', () => {
  // This asymmetry IS the sandwich cache. The first frame commits (one bump);
  // every frame after extends that entry through applyCommand and must leave
  // the counter alone, or the cache rebuilds 60 times a second.
  const project = syntheticProject([{}, {}]);
  const id = project.layers[0].id;
  setLayer(project, id, { x: 1 }, 'drag');
  const afterFirst = project.revision;
  for (let i = 2; i <= 10; i++) setLayer(project, id, { x: i }, 'drag');
  assert.equal(project.revision, afterFirst, 'a gesture is one bump, not ten');
});

test('applyProjectJson bumps it', () => {
  const project = syntheticProject([{}, {}]);
  const before = project.revision;
  applyProjectJson(project, JSON.parse(JSON.stringify(toProjectJson(project))));
  assert.ok(project.revision > before, 'every layer was just replaced');
});
```

Add `createBuffer`, `createProject`, `setLayer`, `undo`, `redo`, `toProjectJson`, `applyProjectJson`, `renderProject` and `drawLayerInto` to the existing import at the top of `test/gpu.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: FAIL — `does not provide an export named 'drawLayerInto'`

- [ ] **Step 3: Extract drawLayerInto**

In `src/render.js`, replace `renderProject` (lines 118-159) with:

```js
/**
 * Draw one layer into `dest`, exactly as renderProject does.
 *
 * Extracted from renderProject's loop so sandwich.js can re-blend a single live
 * layer per drag frame. The alternative -- copying the text-versus-resample
 * branch into a second file -- is precisely how text ends up going through
 * resample(), which is the one thing this renderer must never do.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} dest
 * @param {object} layer
 * @param {number} [scale]  1 renders at document resolution.
 */
export function drawLayerInto(dest, layer, scale = 1) {
  if (!layer.visible || layer.opacity <= 0) return;

  const rect = {
    left: Math.round(layer.x * scale),
    top: Math.round(layer.y * scale),
    width: Math.max(1, Math.round(layer.w * scale)),
    height: Math.max(1, Math.round(layer.h * scale)),
  };
  if (rect.left >= dest.width || rect.top >= dest.height) return;
  if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0) return;

  let pixels;
  if (layer.kind === 'text' && layer.rerendered) {
    // Draw the glyphs at their final size. Rasterising once and resampling the
    // bitmap is what made scaled text look pixelated.
    pixels = textPixelsAt(layer, rect.width, rect.height);
  } else {
    // Raster layers really are bitmaps — resampling is all there is.
    const source = layer.pixels;
    if (!source || !source.width || !source.height) return;
    pixels = resample(source, rect.width, rect.height);
  }
  if (!pixels) return;

  blendInto(dest, pixels.data, rect, layer.opacity, layer.blendMode);
}

/**
 * @param {object} project
 * @param {{scale?: number}} [options]
 *   `scale` 1 renders at document resolution; lower values are for interactive preview.
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderProject(project, options = {}) {
  const { scale = 1 } = options;
  const width = Math.max(1, Math.round(project.width * scale));
  const height = Math.max(1, Math.round(project.height * scale));
  const dest = createBuffer(width, height);

  for (const layer of project.layers) drawLayerInto(dest, layer, scale); // bottom to top

  return dest;
}
```

- [ ] **Step 4: Add the revision counter**

In `src/edit.js`, add the field to `createProject`'s return object, immediately above `history`:

```js
    /**
     * Bumped by every mutation, so caches keyed on it drop on any commit, undo
     * or redo — but NOT on the coalesced frames of a drag, which take
     * applyCommand directly and leave it alone. That asymmetry is the whole
     * reason the sandwich cache survives a gesture.
     */
    revision: 0,
    history: [],
    future: [],
```

In `commit()`, after `project.future.length = 0;`:

```js
  project.revision = (project.revision ?? 0) + 1;
```

In `undo()`, after `project.future.push(command);`:

```js
  // undo() and redo() call applyCommand directly, NOT commit — so each has to
  // bump this itself or a cache keyed on it serves stale pixels afterwards.
  project.revision = (project.revision ?? 0) + 1;
```

In `redo()`, after `project.history.push(command);`:

```js
  project.revision = (project.revision ?? 0) + 1;
```

In `applyProjectJson()`, after `project.future.length = 0;`:

```js
  project.revision = (project.revision ?? 0) + 1;
```

Update the export line in `src/index.js`:

```js
export { renderProject, resample, rasteriseTextAt, measureText, drawLayerInto } from './render.js';
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node test/gpu.mjs`
Expected: PASS — `28 passed`

Run: `npm test`
Expected: unchanged through `26 passed`, then `28 passed`. `21 passed` for
`test/edit.mjs` proves the extraction changed no rendered pixel — its
render, move, hide and text tests all go through `renderProject`.

- [ ] **Step 6: Commit**

```bash
git add src/render.js src/edit.js src/index.js test/gpu.mjs
git diff --staged
git commit -m "Extract drawLayerInto and add a mutation revision counter"
```

---

### Task 6: The sandwich cache

**Files:**
- Create: `src/sandwich.js`
- Modify: `src/index.js`
- Test: `test/gpu.mjs`

**Interfaces:**
- Consumes: `drawLayerInto`, `renderProject` (Task 5); `project.revision` (Task 5); `createBuffer`, `blendInto` (existing)
- Produces:
  - `createSandwichCache() -> {key, below, above, state, builds}`
  - `sandwichStateFor(project, selectionIndex) -> 'exact' | 'below'`
  - `renderSandwiched(cache, project, selectionIndex, options?) -> Buffer`
  - `SANDWICH_EXACT = 'exact'`, `SANDWICH_BELOW_ONLY = 'below'`

`renderProject` recomposites the whole stack on every change — 651 ms at 20
layers on desktop, 3–5× that on a phone. During a drag only one layer moves, so
the composite below it and the composite above it can be built once and reused
for the rest of the gesture.

The `above` half is only usable when every layer above the selection blends
`normal`: source-over is associative, but 25 of the 26 modes read the backdrop
and `above` was composited onto a transparent buffer instead. When one of them
is present the cache **degrades** — it keeps `below` and re-blends `[i .. n-1]`
live. Slower, and exact.

- [ ] **Step 1: Write the failing tests**

Append to `test/gpu.mjs`, before the final `console.log`:

```js
console.log('\nsandwich cache\n');

test('the degraded path is byte-for-byte identical to a full render', () => {
  // Nothing is cached above the selection, so the same layers are blended onto
  // the same accumulator in the same order. There is no room for divergence.
  const project = syntheticProject([{}, { left: 2 }, { mode: 'multiply' }, { mode: 'difference' }]);
  assert.equal(sandwichStateFor(project, 1), SANDWICH_BELOW_ONLY);
  const frame = renderSandwiched(createSandwichCache(), project, 1, { scale: 1 });
  assert.deepEqual(Array.from(frame.data), Array.from(renderProject(project, { scale: 1 }).data));
});

test('the cached path matches a full render everywhere at tolerance 1', () => {
  // `above` is composited onto a transparent buffer and then source-over'd, so
  // it quantises to 8 bits twice where the direct path quantises once. That is
  // the entire cost of the cache, and it is measured here rather than assumed.
  //
  // alphaFloor on the two layers above the selection is not decoration: `above`
  // stores straight-alpha RGB divided by its own accumulated alpha, so a
  // near-transparent stack up there amplifies half-LSB storage error by 1/ao
  // before flattenOnto damps it again. Keeping ao above ~0.6 bounds the whole
  // thing at 1 LSB, which is what makes this assertion deterministic rather
  // than probabilistic.
  const project = syntheticProject([
    {}, { left: 2 },
    { opacity: 0.55, alphaFloor: 200 },
    { top: 4, opacity: 0.8, alphaFloor: 200 },
  ]);
  assert.equal(sandwichStateFor(project, 1), SANDWICH_EXACT);
  const frame = renderSandwiched(createSandwichCache(), project, 1, { scale: 1 });
  // flattenOnto both first, and read percentReal — the same rule the rest of
  // this repo compares by. A failure here is a real defect in the cache, not a
  // tolerance to raise.
  const stat = compareBuffers(flattenOnto(frame), flattenOnto(renderProject(project, { scale: 1 })), 1);
  assert.equal(stat.percentReal, 0,
    `beyond rounding on ${stat.beyondRounding} px, maxDelta ${stat.maxDelta}, meanDelta ${stat.meanDelta}`);
});

test('state is exact when every layer above the selection is normal', () => {
  const project = syntheticProject([{ mode: 'multiply' }, {}, { opacity: 0.3 }, {}]);
  // A non-normal mode BELOW the selection is irrelevant — `below` is a real
  // composite of those layers, not an approximation of them.
  assert.equal(sandwichStateFor(project, 1), SANDWICH_EXACT);
});

test('a visible non-normal layer above degrades it', () => {
  const project = syntheticProject([{}, {}, { mode: 'hard mix' }]);
  assert.equal(sandwichStateFor(project, 1), SANDWICH_BELOW_ONLY);
});

test('a hidden or zero-opacity non-normal layer above does not', () => {
  // renderProject skips these entirely, so they cannot make the cache wrong.
  assert.equal(sandwichStateFor(syntheticProject([{}, {}, { mode: 'difference', hidden: true }]), 1),
    SANDWICH_EXACT);
  assert.equal(sandwichStateFor(syntheticProject([{}, {}, { mode: 'difference', opacity: 0 }]), 1),
    SANDWICH_EXACT);
});

test('the cache survives the frames of one drag', () => {
  // The load-bearing test. If this fails the feature does nothing at all.
  const project = syntheticProject([{}, {}, {}, {}]);
  const cache = createSandwichCache();
  const id = project.layers[1].id;

  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 1);
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 1, 'a second frame with nothing changed must reuse the cache');

  setLayer(project, id, { x: 1 }, 'drag');           // first frame of a gesture -> commit
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 2);

  for (let f = 2; f <= 12; f++) {
    setLayer(project, id, { x: f }, 'drag');         // coalesced -> no bump
    renderSandwiched(cache, project, 1, { scale: 1 });
  }
  assert.equal(cache.builds, 2, 'eleven more frames of one gesture must not rebuild it');
});

test('a commit rebuilds it', () => {
  const project = syntheticProject([{}, {}, {}]);
  const cache = createSandwichCache();
  renderSandwiched(cache, project, 1, { scale: 1 });
  setLayer(project, project.layers[2].id, { opacity: 0.5 });
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 2, 'a layer above the selection changed');
});

test('an undo rebuilds it', () => {
  const project = syntheticProject([{}, {}, {}]);
  const cache = createSandwichCache();
  setLayer(project, project.layers[2].id, { opacity: 0.5 });
  renderSandwiched(cache, project, 1, { scale: 1 });
  undo(project);
  renderSandwiched(cache, project, 1, { scale: 1 });
  assert.equal(cache.builds, 2);
});

test('selecting the top layer needs no above buffer', () => {
  const project = syntheticProject([{}, {}, {}]);
  const cache = createSandwichCache();
  const frame = renderSandwiched(cache, project, 2, { scale: 1 });
  assert.equal(cache.above, null, 'an empty slice must not allocate a full-canvas buffer');
  assert.deepEqual(Array.from(frame.data), Array.from(renderProject(project, { scale: 1 }).data));
});

test('an out-of-range selection falls back to the full render', () => {
  const project = syntheticProject([{}, {}]);
  const cache = createSandwichCache();
  const full = Array.from(renderProject(project, { scale: 1 }).data);
  for (const index of [-1, 2, null, undefined, 1.5])
    assert.deepEqual(Array.from(renderSandwiched(cache, project, index, { scale: 1 }).data), full);
  assert.equal(cache.builds, 0, 'nothing should have been cached');
});
```

Add `compareBuffers`, `flattenOnto`, `createSandwichCache`, `renderSandwiched`, `sandwichStateFor`, `SANDWICH_EXACT` and `SANDWICH_BELOW_ONLY` to the existing import at the top of `test/gpu.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: FAIL — `does not provide an export named 'createSandwichCache'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/sandwich.js`:

```js
/**
 * Drag-time cache for the JS fallback tier.
 *
 * renderProject recomposites the whole stack on every change -- 651 ms for 20
 * layers on desktop, 3-5x that on a phone. During a drag only ONE layer moves,
 * so the composite of everything below it and everything above it can be built
 * once and reused for the rest of the gesture:
 *
 *     below = renderProject over layers [0 .. i-1]      cached
 *     live  = layer i, re-blended every frame
 *     above = renderProject over layers [i+1 .. n-1]    cached
 *
 * The `above` half is only usable when every layer above the selection blends
 * `normal`. Source-over is associative, but 25 of the 26 modes read the
 * backdrop and `above` was composited onto a transparent buffer instead. When
 * one of them is present the cache DEGRADES: it keeps `below` and re-blends
 * [i .. n-1] live, which is slower and exact. `sandwichStateFor` reports which
 * of the two is in force, so the harness can show it.
 *
 * Both states are correct. The cached one differs from a full render only by
 * the <=1 LSB of quantising `above` twice, which test/gpu.mjs measures.
 */
import { createBuffer, blendInto } from './composite.js';
import { renderProject, drawLayerInto } from './render.js';

/** Everything above the selection is `normal`, so `above` is cached. */
export const SANDWICH_EXACT = 'exact';
/** A non-`normal` mode sits above the selection, so only `below` is cached. */
export const SANDWICH_BELOW_ONLY = 'below';

/** One cache per canvas. Reused across frames; rebuilt when its key changes. */
export const createSandwichCache = () => ({
  key: null, below: null, above: null, state: SANDWICH_EXACT, builds: 0,
});

/**
 * Whether the `above` half can be cached for this selection.
 *
 * Layers renderProject would skip anyway -- hidden, or zero opacity -- cannot
 * make the cache wrong, so they do not degrade it. A non-`normal` mode BELOW
 * the selection is likewise irrelevant: `below` is a real composite of those
 * layers, not an approximation of them.
 */
export function sandwichStateFor(project, selectionIndex) {
  for (let i = selectionIndex + 1; i < project.layers.length; i++) {
    const layer = project.layers[i];
    if (!layer.visible || layer.opacity <= 0) continue;
    if (layer.blendMode !== 'normal') return SANDWICH_BELOW_ONLY;
  }
  return SANDWICH_EXACT;
}

/**
 * renderProject reads only width, height and layers, so a slice of the stack
 * can be rendered without touching render.js.
 */
const sliceProject = (project, from, to) => ({
  width: project.width, height: project.height, layers: project.layers.slice(from, to),
});

function rebuild(cache, project, selectionIndex, scale, key) {
  cache.state = sandwichStateFor(project, selectionIndex);
  cache.below = renderProject(sliceProject(project, 0, selectionIndex), { scale });
  cache.above =
    cache.state === SANDWICH_EXACT && selectionIndex + 1 < project.layers.length
      ? renderProject(sliceProject(project, selectionIndex + 1, project.layers.length), { scale })
      : null;
  cache.key = key;
  cache.builds++;
}

/**
 * One drag frame.
 *
 * Falls back to a plain renderProject when the selection is out of range, so a
 * caller never has to special-case "nothing selected".
 *
 * @param {object} cache  from createSandwichCache(); reused across frames
 * @param {object} project
 * @param {number} selectionIndex  index into project.layers; 0 is the bottom
 * @param {{scale?: number}} [options]
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderSandwiched(cache, project, selectionIndex, options = {}) {
  const { scale = 1 } = options;

  if (!Number.isInteger(selectionIndex) || selectionIndex < 0 || selectionIndex >= project.layers.length)
    return renderProject(project, { scale });

  // `revision` is bumped by commit, undo, redo and applyProjectJson, and NOT by
  // the coalesced frames of a drag -- which is what lets one gesture reuse a
  // single build. Layer count is in the key too, so a reorder cannot leave the
  // slice boundaries pointing at different layers.
  const key = `${selectionIndex}|${project.revision ?? 0}|${scale}|${project.layers.length}`;
  if (cache.key !== key) rebuild(cache, project, selectionIndex, scale, key);

  const frame = createBuffer(cache.below.width, cache.below.height);
  frame.data.set(cache.below.data);   // copy: `below` has to survive the next frame

  drawLayerInto(frame, project.layers[selectionIndex], scale);

  if (cache.state === SANDWICH_EXACT) {
    if (cache.above)
      blendInto(frame, cache.above.data,
        { left: 0, top: 0, width: frame.width, height: frame.height }, 1, 'normal');
  } else {
    for (let i = selectionIndex + 1; i < project.layers.length; i++)
      drawLayerInto(frame, project.layers[i], scale);
  }

  return frame;
}
```

Add to `src/index.js`:

```js
export {
  createSandwichCache, renderSandwiched, sandwichStateFor,
  SANDWICH_EXACT, SANDWICH_BELOW_ONLY,
} from './sandwich.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/gpu.mjs`
Expected: PASS — `38 passed`

Run: `npm test`
Expected: unchanged through `26 passed`, then `38 passed`

- [ ] **Step 5: Commit**

```bash
git add src/sandwich.js src/index.js test/gpu.mjs
git diff --staged
git commit -m "Add the drag-scoped sandwich cache for the JS tier"
```

---

### Task 7: Conformance fixtures and the pass rule

**Files:**
- Create: `src/conformance.js`
- Modify: `src/index.js`
- Test: `test/gpu.mjs`

**Interfaces:**
- Consumes: `createBuffer`, `compareBuffers`, `flattenOnto`, `SUPPORTED_BLEND_MODES` (existing); `createProject` (existing)
- Produces:
  - `conformancePattern(width?, height?, role?: 'backdrop' | 'source') -> Buffer`
  - `conformanceProject(mode: string, size?: number) -> project` — two full-canvas layers
  - `compareRenders(a: Buffer, b: Buffer) -> stat` — `flattenOnto` both, then `compareBuffers` at tolerance 1
  - `verdictFor(stat) -> 'PASS' | 'WARN' | 'FAIL'`
  - `CONFORMANCE_MODES: string[]`, `CONFORMANCE_SIZE = 256`

This is the input side of the spec's Table A. 1B-2's `/conformance` route renders
each of these projects through the GPU and compares it against
`renderProject`; this task builds the projects, the comparison rule and the pass
rule, and proves the **JS half** — the oracle — behaves.

The 21 PSD fixtures exercise only the modes Photoshop's own feature tests happen
to use. Most of the 26 are not among them, and a broken `setSat` would sail
straight through a fixtures-only suite.

- [ ] **Step 1: Write the failing tests**

Append to `test/gpu.mjs`, before the final `console.log`:

```js
console.log('\nconformance fixtures\n');

test('the pattern is deterministic', () => {
  assert.deepEqual(
    Array.from(conformancePattern(32, 32, 'source').data),
    Array.from(conformancePattern(32, 32, 'source').data),
  );
});

test('red sweeps every backdrop/source byte pair exactly once', () => {
  // This is what makes `hard mix`'s b + s == 255 diagonal impossible to miss:
  // 256 of the 65 536 pairs sit exactly on it.
  const backdrop = conformancePattern(256, 256, 'backdrop');
  const source = conformancePattern(256, 256, 'source');
  const seen = new Uint8Array(65536);
  for (let i = 0; i < 256 * 256; i++) seen[backdrop.data[i * 4] * 256 + source.data[i * 4]]++;
  assert.ok(seen.every((n) => n === 1), 'every (backdrop, source) red pair must occur exactly once');
});

test('both roles include a fully transparent and a fully opaque band', () => {
  for (const role of ['backdrop', 'source']) {
    const alphas = new Set();
    const pattern = conformancePattern(256, 256, role);
    for (let i = 0; i < 256 * 256; i++) alphas.add(pattern.data[i * 4 + 3]);
    assert.ok(alphas.has(0), `${role} must include alpha 0 — where JS continues and the GPU returns dst`);
    assert.ok(alphas.has(255), `${role} must include alpha 255 — where ao == 1`);
  }
});

test('green and blue are not copies of red', () => {
  // The six non-separable modes read all three channels at once. A grey pixel
  // exercises none of setSat's or clipColor's branches.
  const pattern = conformancePattern(64, 64, 'backdrop');
  let differing = 0;
  for (let i = 0; i < 64 * 64; i++) {
    const o = i * 4;
    if (pattern.data[o] !== pattern.data[o + 1] || pattern.data[o] !== pattern.data[o + 2]) differing++;
  }
  assert.ok(differing > 64 * 64 * 0.9, `only ${differing} of ${64 * 64} pixels are non-grey`);
});

test('all 26 modes render through the JS oracle and produce pixels', () => {
  for (const mode of CONFORMANCE_MODES) {
    const out = renderProject(conformanceProject(mode, 64), { scale: 1 });
    assert.equal(out.width, 64, `${mode}: wrong canvas size`);
    assert.ok(out.data.some((v) => v !== 0), `${mode}: rendered nothing at all`);
  }
  assert.equal(CONFORMANCE_MODES.length, 26);
});

test('a render compared against itself is a PASS at maxDelta 0', () => {
  // Proves the comparison harness is not itself reporting spurious differences
  // before it is ever pointed at a GPU.
  const out = renderProject(conformanceProject('overlay', 64), { scale: 1 });
  const stat = compareRenders(out, out);
  assert.equal(stat.maxDelta, 0);
  assert.equal(verdictFor(stat), 'PASS');
});

test('the verdict table', () => {
  assert.equal(verdictFor({ comparable: true, percentReal: 0, maxDelta: 1 }), 'PASS');
  assert.equal(verdictFor({ comparable: true, percentReal: 0.05, maxDelta: 2 }), 'WARN');
  assert.equal(verdictFor({ comparable: true, percentReal: 0.05, maxDelta: 3 }), 'FAIL');
  assert.equal(verdictFor({ comparable: true, percentReal: 0.5, maxDelta: 2 }), 'FAIL');
  assert.equal(verdictFor({ comparable: false, reason: '2x2 vs 3x3' }), 'FAIL');
  assert.equal(verdictFor(null), 'FAIL');
});
```

Add `conformancePattern`, `conformanceProject`, `compareRenders`, `verdictFor` and `CONFORMANCE_MODES` to the existing import at the top of `test/gpu.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: FAIL — `does not provide an export named 'conformancePattern'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/conformance.js`:

```js
/**
 * Deterministic inputs and the pass rule for the GPU conformance route.
 *
 * Lives in src/ rather than in the app for one reason: the JS half runs as a
 * Node test, so the oracle the GPU is measured against is itself covered by
 * `npm test`. The GPU half runs on a device, at /conformance.
 *
 * The 21 PSD fixtures exercise only the modes Photoshop's own feature tests
 * happen to use -- most of the 26 are not among them, and a broken setSat would
 * sail straight through a fixtures-only suite. This synthetic matrix is what
 * actually covers the mode table.
 */
import { createBuffer, compareBuffers, flattenOnto, SUPPORTED_BLEND_MODES } from './composite.js';
import { createProject } from './edit.js';

/** Both extremes are present: 0 is where JS `continue`s, 255 is where ao == 1. */
const ALPHA_BANDS = [0, 1, 64, 127, 128, 200, 254, 255];

export const CONFORMANCE_SIZE = 256;

/** All 26, so the route's table has a row per implemented mode. */
export const CONFORMANCE_MODES = SUPPORTED_BLEND_MODES;

/**
 * A full-canvas pattern that sweeps all four channels.
 *
 * @param {number} [width]
 * @param {number} [height]
 * @param {'backdrop'|'source'} [role]
 */
export function conformancePattern(width = CONFORMANCE_SIZE, height = CONFORMANCE_SIZE, role = 'backdrop') {
  const buffer = createBuffer(width, height);
  const source = role === 'source';

  for (let y = 0; y < height; y++) {
    // Offset between the roles so a pixel rarely carries the same alpha in both:
    // ao == 1, ao == 0 and everything between all need exercising.
    const alpha = ALPHA_BANDS[((source ? (y >> 5) + 4 : y >> 5) & 7)];

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // RED is the exhaustive sweep: backdrop.r = x, source.r = y, so across a
      // 256x256 buffer every one of the 65 536 (backdrop, source) byte pairs
      // occurs exactly once. `hard mix`'s b + s == 255 diagonal is 256 of them.
      buffer.data[i] = (source ? y : x) & 255;
      // Green and blue are deliberately unlike red. The six non-separable modes
      // read all three channels at once, and a grey pixel exercises none of
      // setSat's or clipColor's branches.
      buffer.data[i + 1] = (source ? x * 7 + 33 : y * 13 + 91) & 255;
      buffer.data[i + 2] = (source ? x + y * 5 : x * 3 + y) & 255;
      buffer.data[i + 3] = alpha;
    }
  }

  return buffer;
}

/**
 * Two full-canvas layers: a `normal` backdrop and a source in `mode`.
 *
 * Built through createProject rather than as object literals so the layers have
 * exactly the shape toLayer() produces and cannot drift from it.
 */
export function conformanceProject(mode, size = CONFORMANCE_SIZE) {
  return createProject({
    width: size,
    height: size,
    children: [
      {
        name: 'backdrop', left: 0, top: 0, right: size, bottom: size,
        blendMode: 'normal', proxyData: conformancePattern(size, size, 'backdrop'),
      },
      {
        name: 'source', left: 0, top: 0, right: size, bottom: size,
        blendMode: mode, proxyData: conformancePattern(size, size, 'source'),
      },
    ],
  }, `conformance-${mode}.psd`);
}

/**
 * Compare two renders the way test/composite.mjs already does.
 *
 * flattenOnto FIRST, always. GPU and JS write different RGB beneath fully
 * transparent pixels -- JS `continue`s and leaves zero, while the GPU's
 * `as <= 0` path writes the backdrop's stored RGB straight through. Comparing
 * raw reports large differences in pixels nobody can see; that mistake once made
 * a correct compositor look 5/21 right instead of 12/21.
 */
export const compareRenders = (a, b) => compareBuffers(flattenOnto(a), flattenOnto(b), 1);

/**
 * Tolerance 1 is a floor, not a licence.
 *
 * GLSL ES 3.00 has no `precise` qualifier, so a compiler may reassociate float
 * expressions and bit-exactness cannot be promised, only measured. The caller
 * prints percent, percentReal, maxDelta and meanDelta beside this verdict, so a
 * shader that is uniformly one greylevel wrong reads as suspicious (high
 * percent, meanDelta 1) rather than simply green.
 *
 * Do NOT raise the tolerance to make the transformed pass go green. Bilinear
 * filter divergence is reported in its own pass for exactly that reason.
 */
export function verdictFor(stat) {
  if (!stat || !stat.comparable) return 'FAIL';
  if (stat.percentReal === 0) return 'PASS';
  if (stat.percentReal < 0.1 && stat.maxDelta <= 2) return 'WARN';
  return 'FAIL';
}
```

Add to `src/index.js`:

```js
export {
  conformancePattern, conformanceProject, compareRenders, verdictFor,
  CONFORMANCE_MODES, CONFORMANCE_SIZE,
} from './conformance.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/gpu.mjs`
Expected: PASS — `45 passed`

Run: `npm test`
Expected: unchanged through `26 passed`, then `45 passed`

- [ ] **Step 5: Commit**

```bash
git add src/conformance.js src/index.js test/gpu.mjs
git diff --staged
git commit -m "Add the synthetic 26-mode conformance matrix and pass rule"
```

---

### Task 8: Tier selection

**Files:**
- Create: `src/gpu/detect.js`
- Modify: `src/index.js`
- Test: `test/gpu.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `TIER_WORKER_GPU = 1`, `TIER_MAIN_GPU = 2`, `TIER_JS = 3`
  - `CONTEXT_ATTRIBUTES` — frozen, straight-alpha WebGL2 attributes
  - `selectTier(caps) -> {tier: 1|2|3, verdict: string}` where `caps = {offscreenCanvas?, transferControl?, webgl2?, probe?: {ok, reason?} | null, override?: number | null}`
  - `tierOverrideFrom(search: string) -> 1 | 2 | 3 | null`
  - `probeCapabilities() -> caps` — the cheap main-thread half; no shaders

`selectTier` is pure, so `npm test` covers the whole decision. That matters more
than it sounds: the boundary between tier 1 and tier 2 is
`transferControlToOffscreen`, **not** `OffscreenCanvas`. They are separate
features — Safari shipped the constructor before the transfer method (16.4,
2023) — and probing the constructor alone would put older iOS Safari in tier 1
and hand it a canvas it cannot present.

`selectTier` also **refuses a GPU tier when `probe` is null**. `getContext('webgl2') !== null`
says nothing about whether the driver's shader compiler works, and the failure
that hides is an all-black canvas on one phone model. 1B-2 fills the `probe`
slot with a compile/link/1×1-readback check; until then this plan runs tier 3, on
purpose.

- [ ] **Step 1: Write the failing tests**

Append to `test/gpu.mjs`, before the final `console.log`:

```js
console.log('\ntier selection\n');

const FULL = { offscreenCanvas: true, transferControl: true, webgl2: true, probe: { ok: true } };

test('a tier override wins over every capability', () => {
  for (const tier of [1, 2, 3]) {
    const decision = selectTier({ ...FULL, override: tier });
    assert.equal(decision.tier, tier);
    assert.match(decision.verdict, /forced/);
  }
  assert.equal(selectTier({ webgl2: false, override: 1 }).tier, 1, 'an override bypasses the probe too');
});

test('an out-of-range override is ignored', () => {
  for (const bad of [0, 4, -1, 1.5, '2', null, undefined])
    assert.equal(selectTier({ ...FULL, override: bad }).tier, TIER_WORKER_GPU, `override ${bad} leaked through`);
});

test('no WebGL2 lands on the JS tier, and says so', () => {
  const decision = selectTier({ offscreenCanvas: true, transferControl: true, webgl2: false });
  assert.equal(decision.tier, TIER_JS);
  assert.match(decision.verdict, /WebGL2/);
});

test('a failed probe lands on the JS tier and carries the driver reason', () => {
  const decision = selectTier({ ...FULL, probe: { ok: false, reason: 'link failed: hue' } });
  assert.equal(decision.tier, TIER_JS);
  assert.match(decision.verdict, /link failed: hue/, 'the harness has to be able to show why');
});

test('an unprobed context never reaches a GPU tier', () => {
  // getContext('webgl2') !== null says nothing about whether the shader
  // compiler works. Trusting it renders black on the phones that matter.
  const decision = selectTier({ ...FULL, probe: null });
  assert.equal(decision.tier, TIER_JS);
  assert.match(decision.verdict, /probe/);
});

test('OffscreenCanvas without transferControlToOffscreen is tier 2, not tier 1', () => {
  // Two separate features. Safari shipped the constructor before the transfer
  // method (16.4, 2023); probing the constructor alone gives older iOS Safari a
  // canvas it cannot present.
  const decision = selectTier({ ...FULL, transferControl: false });
  assert.equal(decision.tier, TIER_MAIN_GPU);
  assert.match(decision.verdict, /transferControlToOffscreen/);

  assert.equal(selectTier({ ...FULL, offscreenCanvas: false, transferControl: false }).tier, TIER_MAIN_GPU);
});

test('the full capability set reaches tier 1', () => {
  const decision = selectTier(FULL);
  assert.equal(decision.tier, TIER_WORKER_GPU);
  assert.ok(decision.verdict.length > 0);
});

test('probeCapabilities reports no GPU in Node, and selectTier agrees', () => {
  const caps = probeCapabilities();
  assert.equal(caps.webgl2, false);
  assert.equal(caps.probe, null);
  assert.equal(selectTier(caps).tier, TIER_JS);
  assert.equal(tierOverrideFrom('?tier=2'), 2);
  assert.equal(tierOverrideFrom('?tier=9'), null);
  assert.equal(tierOverrideFrom('?other=1'), null);
  assert.equal(tierOverrideFrom(''), null);
  assert.equal(tierOverrideFrom(undefined), null);
});
```

Add `selectTier`, `tierOverrideFrom`, `probeCapabilities`, `TIER_WORKER_GPU`, `TIER_MAIN_GPU` and `TIER_JS` to the existing import at the top of `test/gpu.mjs`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/gpu.mjs`
Expected: FAIL — `does not provide an export named 'selectTier'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/gpu/detect.js`:

```js
/**
 * Which of the three render tiers this device gets, and why.
 *
 * Split deliberately: selectTier is pure and covered by `npm test`, while the
 * parts that need a real context are thin wrappers around it. Node has no
 * WebGL, so the decision logic is the only piece of tier selection a Node suite
 * can hold -- and it is the piece most likely to be wrong.
 */

/** WebGL2 in a worker: the worker owns the canvas via transferControlToOffscreen. */
export const TIER_WORKER_GPU = 1;
/** WebGL2 on the main thread, rendering straight to the visible canvas. */
export const TIER_MAIN_GPU = 2;
/** JS compositing plus the sandwich cache, wherever the pixels already are. */
export const TIER_JS = 3;

/**
 * Straight (unassociated) alpha end to end, matching blendInto.
 *
 * `failIfMajorPerformanceCaveat` is deliberately absent: it is inconsistently
 * implemented across browsers and would risk demoting working devices. Keeping
 * software WebGL2 out of tiers 1 and 2 is a named open question, not a decision.
 */
export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  premultipliedAlpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
});

/**
 * @param {{offscreenCanvas?: boolean, transferControl?: boolean, webgl2?: boolean,
 *          probe?: {ok: boolean, reason?: string} | null,
 *          override?: number | null}} [caps]
 * @returns {{tier: 1|2|3, verdict: string}} `verdict` is shown verbatim on /harness.
 */
export function selectTier(caps = {}) {
  const {
    offscreenCanvas = false, transferControl = false, webgl2 = false,
    probe = null, override = null,
  } = caps;

  if (override === TIER_WORKER_GPU || override === TIER_MAIN_GPU || override === TIER_JS)
    return { tier: override, verdict: `forced by ?tier=${override}` };

  if (!webgl2) return { tier: TIER_JS, verdict: 'no WebGL2 context' };

  // getContext('webgl2') !== null says nothing about whether the driver's shader
  // compiler works. Without a probe that compiled, linked and READ BACK a real
  // blend, a GPU tier is a guess -- and the failure it hides is an all-black
  // canvas on one phone model.
  if (!probe) return { tier: TIER_JS, verdict: 'shader probe not run' };
  if (!probe.ok) return { tier: TIER_JS, verdict: `shader probe failed: ${probe.reason || 'unknown'}` };

  if (!offscreenCanvas)
    return { tier: TIER_MAIN_GPU, verdict: 'no OffscreenCanvas — WebGL2 on the main thread' };

  // OffscreenCanvas and transferControlToOffscreen are SEPARATE features: Safari
  // shipped the constructor before the transfer method (16.4, 2023). Probing the
  // constructor alone would put older iOS Safari in tier 1 and give it a canvas
  // it cannot present.
  if (!transferControl)
    return {
      tier: TIER_MAIN_GPU,
      verdict: 'OffscreenCanvas without transferControlToOffscreen — WebGL2 on the main thread',
    };

  return { tier: TIER_WORKER_GPU, verdict: 'WebGL2 in a worker' };
}

/** `?tier=1|2|3` -> a number; anything else -> null. Pure, so it is tested. */
export function tierOverrideFrom(search) {
  const value = Number(new URLSearchParams(search || '').get('tier'));
  return value === TIER_WORKER_GPU || value === TIER_MAIN_GPU || value === TIER_JS ? value : null;
}

/**
 * The cheap main-thread half of detection.
 *
 * No shaders: it answers "is a GPU tier even worth probing", and reports the
 * device's own limits so a real phone can tell us what it supports rather than
 * us guessing. `probe` is left null on purpose -- selectTier refuses a GPU tier
 * until the authoritative probe has filled it in.
 *
 * The throwaway context is released immediately. Browsers cap contexts per page
 * and evict the oldest, and the compositor owns the only one that matters.
 */
export function probeCapabilities() {
  const caps = {
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    transferControl:
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
    webgl2: false,
    maxTextureSize: 0,
    maxViewport: 0,
    probe: null,
  };

  if (typeof document === 'undefined') return caps;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  if (!gl) return caps;

  caps.webgl2 = true;
  caps.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  caps.maxViewport = Math.min(...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  return caps;
}
```

Add to `src/index.js`:

```js
export {
  selectTier, tierOverrideFrom, probeCapabilities, CONTEXT_ATTRIBUTES,
  TIER_WORKER_GPU, TIER_MAIN_GPU, TIER_JS,
} from './gpu/detect.js';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node test/gpu.mjs`
Expected: PASS — `53 passed`

Run: `npm test`
Expected: `shim OK` → `21 files | parsed 21 | failed 0` → `<0.5% diff: 12   <10%: 5   >=10%: 4` → `21 passed` → `26 passed` → `53 passed`

- [ ] **Step 5: Commit**

```bash
git add src/gpu/detect.js src/index.js test/gpu.mjs
git diff --staged
git commit -m "Add tier selection with a probe slot the GPU plan fills"
```

---

### Task 9: Harness capability readout

**Files:**
- Modify: `app/src/app/harness/harness.page.ts`

**Interfaces:**
- Consumes: `probeCapabilities`, `selectTier`, `tierOverrideFrom` (Task 8)
- Produces: a capability panel on `/harness`, and the `?tier=` override wired end to end

> **This task cannot be verified by `npm test`.** Per project rules the user runs
> the build. Step 3 hands verification over explicitly.

Two of the spec's open questions — does the Capacitor WebView have
`transferControlToOffscreen` + WebGL2, and what `MAX_TEXTURE_SIZE` do the target
devices report — are answered by a page that reads three globals and one
`getParameter`. Answering them before 1B-2 is written is worth more than the
twenty lines it costs.

- [ ] **Step 1: Add the readout**

In `app/src/app/harness/harness.page.ts`, extend the imports:

```ts
import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { PsdLoaderService } from '../services/psd-loader.service';
import { renderProject } from '@engine/render.js';
import { probeCapabilities, selectTier, tierOverrideFrom } from '@engine/gpu/detect.js';
```

Add to the template, immediately above the `<input type="file" …>` line:

```html
      <!-- What this device could support. The GPU tiers themselves arrive with
           the compositor; until its shader probe runs, selectTier refuses them
           on purpose, so this reports tier 3 with "shader probe not run". -->
      <pre class="bg-slate-100 p-3 overflow-x-auto">{{ capabilities() }}</pre>
```

Add to the class body, beside the other signals:

```ts
  capabilities = signal('');

  constructor() {
    const caps = probeCapabilities();
    const decision = selectTier({ ...caps, override: tierOverrideFrom(location.search) });
    this.capabilities.set(JSON.stringify({
      tier: decision.tier,
      why: decision.verdict,
      offscreenCanvas: caps.offscreenCanvas,
      transferControlToOffscreen: caps.transferControl,
      webgl2: caps.webgl2,
      maxTextureSize: caps.maxTextureSize,
      maxViewport: caps.maxViewport,
    }, null, 1));
  }
```

- [ ] **Step 2: Confirm the engine path resolves**

`@engine/*` maps to `../src/*` (`app/tsconfig.json`), so `@engine/gpu/detect.js`
resolves to `src/gpu/detect.js`. This is the first import from a **subdirectory**
of the engine — read `app/tsconfig.json` and confirm the mapping is
`"@engine/*": ["../src/*"]` (a wildcard, not a fixed list) before handing over.

- [ ] **Step 3: Hand verification to the user**

Do **not** run the build. Ask the user to run:

```bash
cd a:/test-rnd/app && npm start
```

…open `/harness`, and report the capability panel verbatim, from a desktop
browser **and** from the Android device. Then ask them to open
`/harness?tier=2` and confirm `why` reads `forced by ?tier=2`.

The three fields to report back are `transferControlToOffscreen`, `webgl2` and
`maxTextureSize` — the first two decide whether tier 1 or tier 2 is the common
case, and the third decides whether `TILE_CAP`'s 2048 estimate is anywhere near
the hardware. Record the answers in the spec's *Open questions* section before
1B-2 is written.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/harness/harness.page.ts
git diff --staged
git commit -m "Report device WebGL2 capabilities and the selected tier on /harness"
```

---

### Task 10: Drag through the sandwich cache

**Files:**
- Modify: `app/src/app/harness/harness.page.ts`

**Interfaces:**
- Consumes: `createSandwichCache`, `renderSandwiched`, `sandwichStateFor` (Task 6); `hitTest`, `setLayer` (existing); `renderProject` (existing)
- Produces: a draggable canvas on `/harness` with a rolling ms/frame readout and the sandwich state

> **This task cannot be verified by `npm test`.** It is the deliverable that
> makes the plan's work visible: the user drags a layer on a 20-layer document
> and reports the observed ms/frame. This plan does not predict that number.

- [ ] **Step 1: Add the drag state and helpers**

In `app/src/app/harness/harness.page.ts`, extend the imports:

```ts
import { hitTest, setLayer } from '@engine/edit.js';
import { createSandwichCache, renderSandwiched, sandwichStateFor } from '@engine/sandwich.js';
```

Add to the class body:

```ts
  frameMs = signal('');
  sandwich = signal('');

  private project: any = null;
  private cache = createSandwichCache();
  private dragging = -1;
  private grabX = 0;
  private grabY = 0;
  private originX = 0;
  private originY = 0;
  private frames: number[] = [];

  /** Canvas point -> document coordinates. Layer geometry is document space. */
  private toDocument(event: PointerEvent) {
    const box = this.cv().nativeElement.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * this.project.width,
      y: ((event.clientY - box.top) / box.height) * this.project.height,
    };
  }

  /** The buffer -> canvas step, shared by the load path and every drag frame. */
  private present(buffer: { width: number; height: number; data: Uint8ClampedArray }) {
    const canvas = this.cv().nativeElement;
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    // createImageData rather than `new ImageData(buffer.data, …)`: the engine is
    // untyped JS, so its buffer types as Uint8ClampedArray<ArrayBufferLike>,
    // which the ImageData constructor rejects.
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(buffer.width, buffer.height);
    image.data.set(buffer.data);
    ctx.putImageData(image, 0, 0);
  }

  onPointerDown(event: PointerEvent) {
    if (!this.project) return;
    const point = this.toDocument(event);
    const layer = hitTest(this.project, point.x, point.y);
    if (!layer) return;

    this.dragging = this.project.layers.indexOf(layer);
    this.grabX = point.x;
    this.grabY = point.y;
    this.originX = layer.x;
    this.originY = layer.y;
    this.frames.length = 0;

    const state = sandwichStateFor(this.project, this.dragging);
    // Both states are correct. `below` is the slower one: it re-blends every
    // layer above the selection live, because a non-normal mode up there cannot
    // be cached onto a transparent buffer and stay exact.
    this.sandwich.set(
      `${state} — layer ${this.dragging + 1} of ${this.project.layers.length}` +
      (state === 'below' ? ' (a non-normal mode sits above; above is re-blended live)' : ''),
    );
    (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent) {
    if (this.dragging < 0) return;
    const point = this.toDocument(event);
    const layer = this.project.layers[this.dragging];

    // coalesceKey 'drag' makes the gesture one undo step — and, because the
    // coalescing branch bypasses commit(), leaves project.revision alone so the
    // sandwich cache survives the whole drag.
    setLayer(this.project, layer.id, {
      x: Math.round(this.originX + point.x - this.grabX),
      y: Math.round(this.originY + point.y - this.grabY),
    }, 'drag');

    const started = performance.now();
    this.present(renderSandwiched(this.cache, this.project, this.dragging, {
      scale: this.project.proxyScale,
    }));
    this.frames.push(performance.now() - started);
    if (this.frames.length > 30) this.frames.shift();

    const mean = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
    this.frameMs.set(
      `${mean.toFixed(1)} ms/frame over ${this.frames.length} frames · ${this.cache.builds} cache build(s) · tier 3 (JS)`,
    );
  }

  onPointerUp() {
    if (this.dragging < 0) return;
    this.dragging = -1;
    // The cache is drag-scoped. Its cached `above` half quantises to 8 bits
    // twice, so a mid-drag frame can differ from a full render by one greylevel.
    // One exact re-render on drag end settles it, and the next gesture rebuilds.
    this.cache = createSandwichCache();
    this.present(renderProject(this.project, { scale: this.project.proxyScale }));
  }
```

- [ ] **Step 2: Wire the template and the load path**

Replace the `<canvas>` line in the template with:

```html
      <canvas #cv
        class="border border-slate-300 max-w-full touch-none"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp()"
        (pointercancel)="onPointerUp()"></canvas>
```

`touch-none` (`touch-action: none`) is not cosmetic: without it a touch drag
scrolls the page instead of moving the layer.

Add above the canvas, below the existing `<pre>{{ info() }}</pre>` block:

```html
      @if (sandwich()) { <p class="text-slate-600">sandwich: {{ sandwich() }}</p> }
      @if (frameMs()) { <p class="text-slate-900 font-bold">{{ frameMs() }}</p> }
```

In `onPick`, replace the block from `const buffer = renderProject(...)` to the
end of the method with:

```ts
    // Render at proxy scale: geometry is in document space, so this is what
    // draws the proxy pixels at their natural size.
    this.project = project;
    this.cache = createSandwichCache();
    this.dragging = -1;
    this.frames.length = 0;
    this.sandwich.set('');
    this.frameMs.set('');
    this.present(renderProject(project, { scale: project.proxyScale }));
```

- [ ] **Step 3: Hand verification to the user**

Do **not** run the build. Ask the user to run:

```bash
cd a:/test-rnd/app && npm start
```

…open `/harness`, load a PSD with at least 20 layers, and drag a layer near the
bottom of the stack. Ask them to report:

1. The `ms/frame` figure, from desktop **and** from the Android device.
2. Whether `cache build(s)` stays at **1** for the whole gesture. If it climbs
   with every frame the cache is being invalidated per frame and the feature is
   doing nothing — that is a bug in the revision-bump placement from Task 5, not
   a tuning problem.
3. The `sandwich:` state, and whether it reads `below` on a document whose upper
   layers use a non-`normal` mode.
4. Whether the layer snaps back into place on pointer-up (it should not move at
   all — the exact re-render must land on the same pixels).

The spec's "~100 ms" is arithmetic, not a measurement, and the sandwich buffers
are full-canvas (1024², ~1 Mpx each) while the 20 measured layers were of unknown
and probably smaller size. **The real figure is likely higher.** Record whatever
the device reports; do not reconcile it against the estimate.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/harness/harness.page.ts
git diff --staged
git commit -m "Drag a layer through the sandwich cache with a ms/frame readout"
```

---

## What this plan does not cover

Deferred to **Plan 1B-2** (GPU compositor and conformance route), which depends on
every interface above:

| Spec section | What 1B-2 owns |
|---|---|
| *Tier selection*, step 2 | The authoritative probe: create the context, compile and link `normal` and `hue`, render one 1×1 blend into an RGBA8 FBO, `readPixels`, compare against the JS byte, read `MAX_TEXTURE_SIZE` / `MAX_VIEWPORT_DIMS` / `HIGH_FLOAT.precision`. Fills `selectTier`'s `probe` field. |
| *The composite pass* | `src/gpu/compositor.js`: one WebGL2 context, ping-pong RGBA8 FBOs, one draw per layer, `NEAREST` iff the destination rect equals the texture size, pinned unpack state, textures uploaded from the raw typed array. |
| *Text, OffscreenCanvas and the worker* | The texture cache keyed on `renderedKey` / `pixelsRevision`, never on layer id. |
| *Tiling for MAX_TEXTURE_SIZE* | Tile-edge query, `TILE_CAP`, sub-rect uploads via `UNPACK_ROW_LENGTH` / `UNPACK_SKIP_ROWS` / `UNPACK_SKIP_PIXELS`, and the one-texel halo on transformed layers. |
| *Where the pixels live* | The 1A decode worker becomes the render worker; tier is chosen **before** decode; `PsdLoaderService` stops calling `worker.terminate()` on `done`. |
| *Risks* → context loss | `webglcontextlost` handled with `preventDefault`, one restore attempt, then tier 3 for the session; `?lose=1` to simulate it. |
| *Conformance route* | `/conformance` with Table A (the 26-mode matrix built by `src/conformance.js`), Table B (the 21 fixtures via a `webkitdirectory` picker, untransformed and at `proxyScale * 0.61`), and Table C (tier 1 vs tier 2 on a text fixture). |
| *Tiling*, *TILE_CAP* | The harness printing the chosen tile edge and the resulting texture footprint. |
| *VERTEX_SHADER* comment | The **Y flip in the present pass**. `vDstPx.y` is a row index; readback needs no flip, a visible canvas does. |

Deferred to **Plan 1C** (export): full-resolution streaming export, spill-to-disk
on reorder, progress UI. 1B-2's tiled compositor and readback are what it drives.

Not in any of the three, and recorded in `docs/BACKLOG.md`: **layer masks and
clipping**, which `renderProject` implements for neither. The GPU compositor
reproduces that gap faithfully rather than diverging from its own oracle, which
is also why conformance compares GPU against the JS project renderer and not
against Photoshop's embedded composite.
