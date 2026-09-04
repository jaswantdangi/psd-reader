# Handoff: Clipping, Blend If, GPU Tier, Sync Relay, Test Coverage

**Generated**: 2026-09-04 (updated same day, second pass)
**Branch**: `phase-1-engine-gpu-memory` — HEAD `cd3c491`, **never pushed** (see Not Yet Done)
**Status**: In Progress — all engine work green; **four headline claims never verified
on real hardware**: the GPU tier, the phone, the UXP plugin, and the Workers relay

> **Read this first.** `HANDOFF.md` in this repo belongs to a **different, concurrent
> session** working on AI background removal (`src/segment/`, `app/**/cutout*`,
> `bg-remove.worker.ts`). It was uncommitted when this file was written, so it was
> deliberately not overwritten. This document covers a separate line of work on the
> same branch. Both are real; neither supersedes the other.

## Goal

Close every remaining correctness, coverage and deployability gap in the PSD engine
that could be closed without a phone or a GPU — then hand back the two that cannot.

## Completed

- [x] **Clipping masks** — preview, sandwich cache, reorder, full-res export. 8 export shapes at 0 divergence
- [x] **Clipping proven on a real PSD** — written in memory via `writePsd`, read back through the streaming loader
- [x] **`hitTest` respects masks** — was selectable across full pixel bounds through masked-out regions
- [x] **Blend If** — inspector (`ce41ef0`), renderer (`70acac5`), carried out of the file (`5fefd11`), gated off GPU (`1fe2057`). `blend-if.src.psd` **25.80% → 1.26%**, maxΔ 226 → 3
- [x] **GPU draw planner** (`003f3eb`) and **WebGL2 renderer** (`992be50`) — `test/gpu.mjs` 53 → 133
- [x] **Conformance route** (`9d85c75`) — the only way to verify the GPU renders correctly
- [x] **Sync relay** — pairing, routing, backpressure, TLS, origin allowlist, proxy-safe rate limit, heartbeat. 50 tests against a real server on a real port
- [x] **`src/segment/` tests** — 87 assertions, first ever for that module; **found 4 real defects, all fixed** (`66b6ace`)
- [x] **Angular app tests** — 2 → 138. `ng test` had been **broken since 25 Aug**
- [x] **Accuracy table now fails the build** (`1706bdf`) — per-fixture ceilings; was printed and never enforced
- [x] **False vector-mask warning removed** (`7a18510`) — fired on all 8 vector layers, every one bit-exact
- [x] **Android platform added** (`ea0d66d`)

### Second pass — committed as 41dc7cb, a7e02f1, d6a655e, cd3c491

- [x] **Artboards** — `applyArtboard` in `src/composite.js`. `artboards.src.psd` **9.79% → 0.00%**, maxΔ 255 → 0, bit-exact. Buckets `12/6/3` → **13/5/3**
- [x] **`layer-comps` diagnosed** — not a compositing gap at all. See Failed Approaches
- [x] **Relay: global cross-key attempt ceiling** — `globalRateLimitMax`, default 10,000 failures/min, charged only on failures that passed the per-key gate
- [x] **Relay: `maxSessionBytes` decays** — a burst allowance over a sustained rate, not a lifetime quota. Rate derived from the cap
- [x] **Relay: `GET /stats`** — loopback-only, or a bearer token; a refused read is byte-identical to any other path
- [x] **`tree` frame added to the protocol** — the handshake `matchLayers` needs had no frame that could carry it
- [x] **`src/sync/photoshop.js`** — every plugin decision that does not need a host, tested without one
- [x] **UXP plugin written** — `plugin/`. **Never run inside Photoshop**
- [x] **App side of sync** — `SyncService` receives a `tree`, reconciles once through `matchLayers`, applies events via `ProjectService`, and refuses what it cannot place. `SyncSheet` shows the code, the match report and what will never sync. App **138 → 165**
- [x] **`ProjectService.removeLayer` / `.setFrame`** — the engine had both; the app had a path to neither, so `delete` and `crop` events had nowhere to land
- [x] **Smart filters disclosed and named** — `smart-filters-2` sat at 46.38% with a BLANK cause column. It is one **Liquify** filter, on `placedLayer.filter.list`. A mesh warp, not a blur someone could add
- [x] **The relay runs on Cloudflare Workers** — `worker/`, a Durable Object. Shares `src/sync/protocol.js` and `server/pairing.js` with the Node relay rather than copying the security model. 33 tests. **Never run on workerd**
- [x] **`server/pairing.js` is runtime-portable** — `crypto.getRandomValues` with rejection sampling instead of `node:crypto.randomInt`, plus `snapshot()`/`restore()` so an eviction cannot reset an attacker's rate-limit budget
- [x] **The relay URL is no longer hardcoded** — `<meta name="psd-relay">`, read at runtime, so one artifact serves local dev, a Pages preview, production and the Android wrapper
- [x] **`docs/DEPLOY-CLOUDFLARE.md`** — what deploys where, what it costs, and what Cloudflare cannot host

## Not Yet Done

- [ ] **`origin` points at a repository that does not exist.** `github.com/jaswantdangi/psd-reader` resolves for none of the three accounts `gh` can see (`jaswantdangi`, `dangijaswant`, `hellomipl`). The branch is **181 commits ahead with no upstream** and has never been pushed. Creating a repo publishes all of it, and the owner/visibility choice is not one to make on someone's behalf — so it was left. `git push -u origin phase-1-engine-gpu-memory` is the whole fix once it exists
- [ ] **Run `npx wrangler dev`** — the first time any of `worker/` will have executed. See `docs/DEPLOY-CLOUDFLARE.md`
- [ ] **Run the GPU conformance page** — no GLSL in this repo has *ever* been compiled
- [ ] **Run the UXP plugin** — written this pass, never loaded. `plugin/README.md` ranks the five seams most likely to be wrong
- [ ] **Run on a phone** — Phase 1's definition of done requires it; never happened
- [ ] **Phase 0** — design system + the five real screens. Deferred at project start, never resumed
- [ ] **End-to-end handshake** — every piece now exists and no PSD has ever synced. Both halves are written against the same protocol module; what has never happened is the two of them in the same room
- [ ] **`effects` 23.03% — layer styles.** Nine sub-features, not one: the fixture is a sampler with one style per layer. Divergence attributed by region: inner shadow 3372 px, drop shadow 2447, outer+inner glow 1471, gradientOverlay+satin 768, bevel 706, stroke 473, gradientOverlay 472, solidFill **0 (disabled in the file)**. The five biggest all need Photoshop's blur kernel, which is not publicly specified — that is research, not implementation. Note the trap: **Color Overlay is disabled in the only fixture that has it**, so building it would change zero pixels and be unverifiable, exactly like the rasteriser above
- [ ] **`smart-filters-2` 46.38% — one Liquify filter.** Needs a mesh-warp engine. The mesh itself is on `placedLayer.filter.list[0].filter.liquifyMesh`
- [ ] **Artboards in the editor renderer** — `composite.js` clips and fills; `renderProject` does not. `renderProject` walks the FLAT `project.layers`, so the artboard rect has to be carried onto each leaf during `flatten()` — which lives in `src/edit.js:374`, **held by the other session**. Deliberately not touched
- [ ] `boolean` 0.18% — two single-pixel rows where our antialias coverage reads ~16% against Photoshop's 50%. Small, but unattributed, so a suspected bug rather than a known gap
- [ ] Untested app files held by the other session: `canvas-stage.ts`, `segment.service.ts`, `bg-remove.worker.ts`

## Failed Approaches (Don't Repeat These)

**Do not build a vector path rasteriser for fidelity.** An agent was dispatched to do
this on the claim that `shapes.src.psd` / `gradient.src.psd` were in the `>=10%` bucket.
They are at **0.00% real, maxΔ 0 — bit-exact**. The brief had misread the `raw %` column
(RGB hiding under transparent pixels) for `real %`. All 21 fixtures were then scanned:
**14 vector-bearing layers, every one already rasterised by Photoshop.** No fixture
exists where a rasteriser changes an output pixel, and substituting ours for
Photoshop's could only make the accuracy table *worse*. A rasteriser is still wanted for
crisp zoom / editable shapes / upscaled export — a different feature, needing a fixture
saved with *Maximize Compatibility* **off** before it can be measured at all.

**Do not try to score `layer-comps` to zero, and do not implement layer comps expecting
it to move.** Its 10.84% is one layer's visibility, not a compositing gap: hide "Layer 3"
and we match Photoshop at **0.00% / maxΔ 0 over the whole canvas**. The file contradicts
itself. Four hypotheses were tested and all four are dead: (1) the composite reflects a
different comp state — no, the `lastApplied` comp `510999610` lists Layer 3
`enabled: true`, matching the layer records exactly; (2) ag-psd misreads the hidden bit —
no, the raw flag byte is `0x08`, and ag-psd reads only `0x02`; (3) the layer is empty or
masked — no, it has a real 1073-byte alpha channel, `maskDataLen=0`, and its additional-info
keys are `luni lnsr lyid clbl infx knko lspf lclr shmd fxrp`, with no `lsct`, `lfx2` or
`FMsk`; (4) `layer-comps.expected.psd` holds the truth — no, it was saved separately and
agrees with the embedded composite *exactly*, so the disagreement reproduces across saves.
`test/composite.mjs` used to file this under "unimplemented features, not bugs"; that
claim was wrong and has been corrected in place.

**Do not implement Blend If in GLSL.** It is deliberately *gated off* the GPU tier —
`buildDrawPlan` refuses such a document by name and falls back to JS. A slow correct
frame beats a fast wrong one, and implementing it in a shader removes that fallback.

**Do not trust `app.seen() === 0` in relay cap tests.** One test asserted it while
requiring on the next line that the session tear down. Teardown *notifies the peer* from
the same statement the `vanished peer` test depends on, so exactly one frame is the
point. Assert the **payload** never crosses instead.

**Do not assert on the wording of `CONFORMANCE_TABLE_D_NOTE`.** `test/adjust.mjs` matched
the literal string `"JS against itself"`; the note was reworded to something strictly
clearer and the build broke. It now asserts meaning, not prose.

**`readDocument` alone will not give you pixels.** It releases each layer's `imageData`
the moment `onLayer` returns — by design, it is the memory discipline. `createProject`
then sees layers with no pixels and drops all of them (silently returning 0 layers).
Use `loadProjectProxy(...)`, or `readDocument(bytes, { pixels: 'eager', embedded: true,
metadata: false })` for the compositor oracle. This trap was hit three times in one hour.

**`git add` then a separate `git commit` is racy here.** Concurrent agents share one git
index, so another agent's staged files ride along. It happened three times: `ea0d66d`
contains `server/relay.js`, `3788b4b` contains `test/gpu.mjs`, and one app-test commit
briefly held `src/gpu/*.js`. **Use `git commit -- <paths>`** — staging and committing in
one invocation. Content is correct in all three; only the messages under-describe.
History was not rewritten because another session is live on the branch.

## Key Decisions

| Decision | Rationale |
|---|---|
| Clipping is **positional**, not a group | A clipped layer clips to whatever is directly below it, as in Photoshop. Reorder just recomputes runs — no locking, no drag-the-group, no new UI concept |
| Clip runs are **atomic** in the sandwich cache | `below`/`above` are flattened composites; splitting a run puts the original bug back for the duration of every drag |
| Generated clipped fixture lives **outside `fixtures/`** | `run.mjs` and `composite.mjs` glob `fixtures/*.src.psd`. Its composite is written by *our* compositor, so scoring it there would hand the accuracy table a free pass |
| `writePsd` allowed in `tools/`, never `src/` | The ban is a *runtime* decision (3.5–4.2× peak, drops `Patt`). Neither applies to a 128px test document |
| Accuracy guard is **per-fixture**, not bucket counts | Buckets are counts: one fixture improving while another regresses leaves `12/6/3` unchanged. `maxDelta` checked too — `gradient` is 0.00% with maxΔ 1, so the percentage alone would miss a break |
| Blend If refused on GPU rather than shaded | See Failed Approaches |
| GPU renderer ships with a **browser conformance page**, not just tests | Node has no WebGL; a green suite there proves the renderer *builds* the right calls and nothing about what a driver does |
| Sync moves **events, not documents** | Both sides open the same file independently. Removes the 150 MB transfer, chunking, backpressure-on-document and the storage question entirely |
| Sync is **Photoshop → app only**, Photoshop authoritative | Removes conflict resolution, and removes `batchPlay` replay — which is where the adjustment-mapping wall stood |
| The app will **never write PSDs** | `ag-psd`'s writer peaks at 3.5–4.2× decoded pixels and silently drops `Patt`. There is no `writePsd` in `src/` and there should not be |
| Adjustments/HSL/filters/overlays **do not sync** | Our LUT model is not Photoshop's adjustment layers. Disclosed rather than approximated |
| Relay refuses to start rather than downgrade | A non-loopback bind with neither TLS nor an explicit proxy declaration throws in `resolveConfig`, before any socket exists |

## Current State

**Working**: `npm test` exits 0 — engine **983** assertions + app **165**.

```
21 files | <0.5%: 13   <10%: 5   >=10%: 3
All 21 fixtures within their accuracy ceilings.
49 · 21 · 28 · 24 · 28 · 133 · 108 · 100 · 110 · 61 · 49 · 64 · 87 · 24 · 64 · 33   +  165 app
```

Against the first pass's `909` the deltas are: layers `93 → 98` (artboards), sync
`44 → 64` (the `tree` frame and `src/sync/photoshop.js`), relay `50 → 64` (the global
ceiling, the byte-budget decay, the stats endpoint and `tree` routing).

**Broken**: nothing failing. But **pixel parity on the GPU has never been observed** —
no GLSL in this repo has ever been compiled. The 133 GPU assertions check the command
sequence against a recording fake. They did catch a real bug (a lazily-created 1×1
stand-in texture rebinds the active unit, so masks were silently ignored while
`uUseMask` said 1), which is the value they have — and the limit of it.

**Uncommitted Changes**: only the **other session's**, untouched throughout —
`HANDOFF.md`, `app/src/app/editor/{canvas-stage,cutout-panel}.ts`,
`app/src/app/services/segment.service.ts`, `app/src/app/workers/bg-remove.worker.ts`,
`docs/BACKLOG.md`, `src/edit.js`, `src/index.js`, `src/segment/{cutout,index,models}.js`,
untracked `src/segment/edge.js`. **Do not stage any of these.**

Everything from this pass is committed in four:

| Commit | What |
|---|---|
| `41dc7cb` | Artboards, the smart-filter disclosure, and the corrected `layer-comps` claim |
| `a7e02f1` | The `tree` frame, the three relay gaps, `src/sync/photoshop.js`, `plugin/` |
| `d6a655e` | The app side of sync — `SyncService`, `SyncSheet`, two `ProjectService` mutations |
| `cd3c491` | The relay on Workers + Durable Objects, and the Cloudflare deployment docs |

Every one used `git commit -- <paths>` with explicit files, never `git add <dir>`,
because the git index is shared with a live session. Untracked files needed a
narrow `git add` of exactly those paths first — done in the same invocation, so
nothing of theirs could ride along in between.

## Files to Know

| File | Why It Matters |
|---|---|
| `src/composite.js` | The correctness oracle for the whole project. `parseBlendIf` / `blendIfFactor` / `rangeFactor` live here as the **single** implementation |
| `src/render.js` | Editor renderer. Must agree with `composite.js` exactly — `drawClipRunInto`, `clipRunStart`, `clipRunEnd`, `clipAlphaMap` |
| `test/composite.mjs` | Accuracy harness **and** the per-fixture ceilings that now fail the build |
| `src/gpu/plan.js` | `buildDrawPlan` — pure, Node-checkable. Also holds the Blend If gate |
| `src/gpu/renderer.js` | Executes the plan on WebGL2. **Unverified against a real driver** |
| `demo/conformance.html` | The only thing that can prove the GPU path correct |
| `server/config.js` | `resolveConfig` — refuses unsafe startup combinations |
| `src/sync/identity.js` | Matches Photoshop layers to app layers **by signature, never by index**. The whole sync feature rests on this |
| `src/sync/photoshop.js` | Every plugin decision that does not need Photoshop — kind collapse, tree walk, notification translation, burst coalescing. Written to keep `plugin/main.js` as small as possible, because that file cannot be tested |
| `plugin/main.js` | The only code in the repo that cannot run without Photoshop. Every uncertain seam is marked `VERIFY:` |
| `plugin/README.md` | What is unverified, ranked by how likely it is to be wrong. Read before loading it |
| `app/src/app/services/sync.service.ts` | The app half. Receives `tree`, pins one `matchLayers` result, applies events through `ProjectService` and refuses the rest out loud |
| `app/src/app/editor/sync-sheet.ts` | Five states, one job each. The pairing code is the largest thing on screen because it is the only thing a person carries between two machines |
| `server/pairing.js` | Codes, the per-ip limit, the cross-key ceiling. The pairing code is the entire security model, and this is the ONE file **both** transports share, so it cannot diverge. Runtime-portable on purpose |
| `worker/hub.js` | The relay as a Durable Object. Its header states where each kind of state lives under hibernation, and exactly what backpressure it cannot have |
| `worker/config.js` | Why `server/config.js` was re-expressed rather than ported: almost every check in it is about binding a socket, and a Worker binds nothing |
| `docs/DEPLOY-CLOUDFLARE.md` | What deploys where, what the Workers transport costs, and the two artifacts Cloudflare cannot host |
| `src/sync/protocol.js` | Wire format, validation, and which Photoshop changes can even be represented |
| `docs/superpowers/specs/2026-09-03-photoshop-sync-relay-design.md` | The sync design. **Read the rescope note at the top first** — it narrows the job enormously |
| `tools/clipping-fixture.mjs` | Generates the only clipped PSD in the corpus, in memory |
| `docs/BACKLOG.md` | Durable record of everything deferred. **Append-only; the other session edits it too** |

## Code Context

**Clip runs — reuse these, never re-derive run boundaries:**
```js
import { clipRunStart, clipRunEnd, clipAlphaMap, drawClipRunInto } from './render.js';
// A run is [start, end). drawClipRunInto returns the index after the run it drew.
for (let i = 0; i < layers.length; ) i = drawClipRunInto(frame, layers, i, scale, { stats });
```

**Blend If — one descriptor, parsed once, applied inside `blendInto`:**
```js
parseBlendIf(layer)  // -> null (zero allocation) when ranges are default; 20 of 21 fixtures
blendInto(dest, src, rect, opacity, mode, clipAlpha, blendIf)
```
Feather ramp is `(v - b0 + 0.5) / (b1 - b0 + 1)` — read off the fixture. The textbook
`(v - b0)/(b1 - b0)` runs 0.7/255 low near the black stop: 1.76% instead of 1.26%.

**GPU plan shape:**
```js
buildDrawPlan(project, { scale, maxTextureSize, budgetBytes })
// -> { ok, reason, width, height, groups, bytes, steps }
// step kinds: 'draw' | 'group-begin' | 'clip-alpha' | 'group-end'
// ok:false + reason  =>  fall back to the JS tier. Never render anyway.
```

**The house test helper is SYNCHRONOUS** (`test/*.mjs`):
```js
const test = (name, fn) => { try { fn(); passed++; } catch (e) { /* FAIL */ } };
```
An `async` body hands it a promise, the `catch` never fires, and **a failing assertion
reports as a pass**. Do async setup once at module top level with `await`.

## PSD Sync — what exists, and what building it actually needs

**Only the browser half exists.** Nothing runs inside Photoshop, so no PSD has ever
synced. Do not read "relay: 50 tests green" as "sync works".

| Piece | State |
|---|---|
| `src/sync/protocol.js` — wire format, validation, change classification | Built, in `test/sync.mjs` (64 tests) |
| `src/sync/identity.js` — signature-based layer matching | Built, pinned against all 21 fixtures |
| `src/sync/photoshop.js` — kind collapse, tree walk, notification translation, coalescing | Built, tested without Photoshop |
| `server/` — pairing, routing, backpressure, TLS, origin, heartbeat, stats | Built, 64 tests, loopback-only |
| `tree` frame — the layer tree on the wire | Built and routed. **Added this pass: the handshake the spec calls "build this first" had no frame that could carry it** |
| **UXP plugin (the Photoshop side)** | **Written, never run.** `plugin/` |
| **End-to-end handshake** | **Still never run.** No PSD has synced |

```js
MESSAGE_TYPES   = ['hello', 'pair', 'paired', 'tree', 'event', 'error']
TREE            = { type:'tree', document:{name,width,height},
                    layers:[{layerID,name,kind,bounds:{left,top,right,bottom},groupPath:[]}] }
PAIR_CODE       = 6 chars from '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'  // no 0/O, no 1/I
MATCH_TIERS     = ['exact', 'renamed', 'regrouped']
CHANGE_KINDS    = ['move','transform','reorder','opacity','blendMode','visibility',
                   'rename','retype','crop','canvasSize','delete','add',
                   'brush','filter','adjustment','maskPaint','layerEffect']
UNMAPPABLE_CHANGES = ['brush','filter','adjustment','maskPaint','layerEffect']
```

**The identity problem is the whole problem.** An event says *"layer 7 moved"*, and the
two sides do not agree what layer 7 is: the app has `sourceIndex` (position among the
file's **leaf** nodes, after `flatten()` has dropped leaves with neither pixels nor
text), while Photoshop has a per-session `layerID` and **counts groups as layers**. A
misaligned event does not error — it applies the right change to the **wrong layer**,
which reads as the app corrupting the user's document. Hence `matchLayers`, which
matches on bounds + kind + name + groupPath and **reports anything it cannot match
confidently rather than guessing**.

**The 5 unmappable kinds are the second wall.** A move or a rename is a few hundred
bytes and maps onto an existing command. A brush stroke, filter or adjustment layer has
**no command that represents it** — mirroring those needs the layer's pixels via
Photoshop's `imaging` API, at proxy resolution, per layer. That is a second mechanism
with its own debounce, because Photoshop's notification stream fires continuously during
a single stroke.

**The plugin now exists — all five steps are written, none is verified:**
1. ✅ Manifest with `network.domains` pinned to `ws(s)://localhost:8787`. Wildcard TLDs
   are rejected at UXP 7.4+, so a deployed host must be listed exactly
2. ✅ Panel takes the 6-character code and connects. The code is validated against
   `PAIR_CODE_ALPHABET` locally first, so a typo costs a glance rather than one of ten
   attempts against the rate limit
3. ✅ Tree enumerated and sent as a `tree` frame. `doc.layers` is **top-down**, so
   `hostLayers` reverses it — everything in this repo reads `children[0]` as the bottom
4. ✅ Notifications subscribed, translated by `changeForNotification`, coalesced over
   80 ms, mappable ones forwarded. Unmappable ones are **counted per kind in the panel**,
   never dropped silently
5. ✅ Developer-mode via UDT, documented in `plugin/README.md`

**What is NOT done: running any of it.** `plugin/README.md` ranks the five seams by how
likely they are to be wrong; the top one is `layerIdFrom(descriptor)`, reading the layer
id out of a notification's `_target` chain. It returns `null` rather than guessing, and
the caller sends nothing when it does — so the symptom of getting it wrong is **silence,
not a corrupted document**. That was the deliberate choice at every uncertain point.

**The app side now exists** — `SyncService` plus `SyncSheet`, reachable from the chain
icon in the editor header, 27 tests. The socket is faked there and nothing else is: every
frame goes through the real `parseMessage`, `matchLayers` and `translateEvent`, and every
surviving command is applied by the real `ProjectService` to a real project.

Three rules it enforces, each of which is a decision rather than an implementation detail:

- **An `event` before a `tree` is refused, never queued.** Without a mapping, "layer 7
  moved" names nothing, and applying it later against a mapping that did not exist when it
  was sent is the misalignment the identity model exists to prevent.
- **`matchLayers` runs once and is pinned.** Re-running it per event would match against a
  document the earlier events had already changed — the mapping would move under itself.
- **Every refusal is sent back as an `error` frame**, which is why that is the one frame the
  relay routes both ways. The plugin panel counts them; the app sheet groups them by reason.

**What has still never happened is the two halves in the same room.** Both are written
against the same protocol module, so they agree by construction — which is exactly the
kind of agreement that survives until the first real run.

## Resume Instructions

1. **Verify the baseline before changing anything:**
   ```
   npm test
   ```
   - Expected: exit 0, `All 21 fixtures within their accuracy ceilings.`, engine counts
     `49 · 21 · 28 · 24 · 28 · 133 · 108 · 100 · 110 · 61 · 49 · 64 · 87 · 24 · 64 · 33`, app 165
   - If a fixture regressed: the harness names the file and whether `real` or `maxDelta`
     broke. It cannot be a rounding artefact — the ceilings are per-fixture

2. **Verify the GPU renders correctly (highest value, ~5 minutes):**
   ```
   npm run serve
   ```
   Open `http://localhost:5173/demo/conformance.html`, press **Run all tables**.
   - Expected: badge reads **Tier 1** or **Tier 2**, and Tables A (26 blend modes),
     C (10 clip runs) and D (14 adjustments) all **PASS at real % 0.00** — except
     `steep-transformed`, which is expected to diverge
   - **A green result under a Tier 3 badge means nothing** — the page then ran the JS
     renderer against itself and says so on screen
   - Also press **Time a 20-layer frame** (calls `gl.finish()`; times readback separately)
   - If tables fail: the renderer has never been driver-tested. Compare the failing
     mode's GLSL in `src/gpu/modes.js` against `SEPARABLE`/`NON_SEPARABLE` in
     `src/composite.js` — those are the reference implementations

3. **To pick up sync**, read the rescope note at the top of
   `docs/superpowers/specs/2026-09-03-photoshop-sync-relay-design.md` before anything
   else — it removes most of what the body of that document describes. Then start the
   relay and confirm it pairs before writing any Photoshop code:
   ```
   node server/index.js
   ```
   - Expected: binds `127.0.0.1`, logs a session id and counts only, never payloads
   - `curl http://127.0.0.1:8787/stats` reads it live from loopback with no token
   - `node test/relay.mjs` (64) and `node test/sync.mjs` (64) are the contract the
     plugin must satisfy — read them before changing the plugin, not after

4. **Load the plugin (~10 minutes, needs Photoshop 24+):**
   Read `plugin/README.md` first — it ranks what is most likely to be wrong. Then
   Adobe UXP Developer Tool → *Add Plugin* → `plugin/manifest.json` → *Load*.
   - Expected: the panel opens; entering the app's code moves the status line
     `Connecting… → Pairing… → Live — <file>, N layers sent`
   - `curl http://127.0.0.1:8787/stats` should then show one session with a non-zero
     `framesRead`. That is the fastest way to tell "the plugin sent nothing" apart from
     "the relay dropped it"
   - If the panel does not load at all: the mixed `import`/`require` in `main.js`
   - If it pairs but nothing arrives: `layerIdFrom` is returning `null`, which it does
     deliberately rather than guess. Log the raw descriptor and read `_target`

5. **Run it on a phone** (Phase 1's definition of done):
   ```
   cd app && npm run build && npx cap sync android
   ```
   then open `app/android` in Android Studio and run.
   - Expected: a PSD opens and composites correctly
   - The JS tier is **651 ms/frame for 20 layers on desktop**, 3–5× that on a phone, so
     interactive dragging depends entirely on step 2 having passed

## Setup Required

- Node 24 (`node --version`). Several suites need `--max-old-space-size=6144`; already in the scripts
- `fixtures/` is **gitignored** — the 21-file corpus is local only. A fresh clone has no fixtures and `test/run.mjs` will report 0 files
- Relay (all optional, safe defaults, loopback-only): `RELAY_PORT`, `RELAY_HOST`,
  `RELAY_TLS_CERT`, `RELAY_TLS_KEY`, `RELAY_ALLOWED_ORIGINS`, `RELAY_TRUSTED_PROXIES`,
  `RELAY_BEHIND_PROXY`, `RELAY_MAX_MESSAGE_BYTES` (8 MiB), `RELAY_MAX_SESSION_BYTES` (256 MiB),
  `RELAY_GLOBAL_RATE_LIMIT_MAX` (10,000/min, 0 disables), `RELAY_GLOBAL_RATE_LIMIT_WINDOW_MS`,
  `RELAY_SESSION_BYTE_REFILL` (derived: cap ÷ 256 per second), `RELAY_STATS_TOKEN`
- No secrets anywhere; nothing is written to disk by the relay. `RELAY_STATS_TOKEN` is the
  one credential that exists, and without it `/stats` is loopback-only
- Photoshop 24+ and the Adobe UXP Developer Tool, to load `plugin/` at all

## Edge Cases & Error Handling

- **GPU plan over budget** → `ok: false` + `reason`; caller falls back to JS. Nothing throws
- **Context loss / shader compile failure** → degrades to JS carrying the driver log
- **Document uses Blend If** → GPU refuses by layer name, JS renders it
- **Relay peer stalls** → reading pauses until `bufferedAmount` drains. Measured: 104.9 MB
  at a stalled peer read **5 of 400 frames**, peak buffered 0.5 MB against a 1.1 MB bound
- **Relay peer vanishes** → survivor told `peer-gone`; heartbeat timeout says `peer-timeout`
- **Short mask into `decontaminate`** → now throws. It used to paint the image tail **black**
  with alpha 255 (NaN stored as 0 by `Uint8ClampedArray`), silently

## Warnings

- **`13/5/3` is now enforced** (it was `12/6/3` before artboards landed). It is not a
  comment any more — `test/composite.mjs` exits 1.
  If you improve a fixture, the run tells you to **tighten its ceiling**; a slack ceiling
  stops guarding the ground the fix just won
- **Blend If at 1.26% is not a bug to chase.** Photoshop *dithers the feather*, spreading
  one flat grey across ~5 adjacent values — including below the black stop where blend-if
  contributes nothing. The backdrop was verified exact first (maxΔ 1 over 741,924 px)
- **Adding a file to `fixtures/` now fails the build** until you give it a ceiling. That is
  deliberate — the corpus must not silently grow an unguarded file
- **Two sessions are live on this branch.** Read `git status` before every commit and use
  `git commit -- <paths>`
- **`src/segment/mask-ops.js` and `refine.js` are tested; `cutout.js`, `models.js`,
  `index.js`, `edge.js` are not** — they were mid-edit by the other session
- `test:segment` and `test:relay` have no individual npm scripts; they run only inside
  `test:engine`. Invoke directly with `node test/segment.mjs` / `node test/relay.mjs`
- **`plugin/` is written and unrun.** Do not let a green `npm test` imply otherwise: the
  suite covers `src/sync/photoshop.js`, which is deliberately everything the plugin decides
  *except* what needs a host. `plugin/main.js` itself has never executed
- **The global pairing ceiling is a real trade, not a free win.** Exhausting it denies
  *new pairings* to everyone until the window rolls — bounded, self-healing, and costing an
  attacker ~1,000 sustained addresses at the default. Established sessions are untouched.
  The alternative was a per-key limit that scales linearly with botnet size. Set
  `RELAY_GLOBAL_RATE_LIMIT_MAX=0` to take the other side of that trade
- **`maxSessionBytes` is no longer a lifetime quota.** It is a burst allowance over a
  sustained rate, so `stats().bytes` (lifetime) can now exceed the cap without anything
  being wrong. `budgetBytes` is what the cap actually reads
- **Artboards are applied in `composite.js` but NOT in `render.js`.** The editor still
  draws layers outside their board. Fixing it means carrying the artboard rect through
  `flatten()` in `src/edit.js` — held by the other session, so it was left alone
