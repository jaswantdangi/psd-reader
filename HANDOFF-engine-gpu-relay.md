# Handoff: Artboards, Photoshop Sync, and the Cloudflare Deployment

**Generated**: 2026-09-04
**Repo**: `github.com/jaswantdangi/psd-reader` — **private**, owned by GitHub user `jaswantdangi`
**Branch**: `phase-1-engine-gpu-memory` — HEAD `0c95bd1`, pushed, tracking `origin/`
**Status**: In Progress — deployed and working end to end **except inside Photoshop**

> **Read this first.** `HANDOFF.md` in this repo belongs to a **different, concurrent
> session** working on AI background removal (`src/segment/`, `app/**/cutout*`,
> `bg-remove.worker.ts`). It is uncommitted and was deliberately never touched — which
> is why this document has its own filename. Both are real; neither supersedes the other.

## Live

| | URL |
|---|---|
| **App** | https://psd-editor.pages.dev — Cloudflare Pages, production |
| **Relay** | https://psd-sync-relay.jaswantdangi00.workers.dev — Workers + Durable Objects |

Cloudflare account is `jaswantdangi00@gmail.com` — **a different account from GitHub's
`jaswantdangi`**. Worth knowing before you go hunting for the deployment.

## Goal

Finish the PSD engine's remaining correctness gaps, build the Photoshop sync feature end
to end, and deploy it — then hand back only what genuinely cannot be verified here.

## Completed

- [x] **Artboards** — `applyArtboard` in `src/composite.js`. `artboards.src.psd` **9.79% → 0.00%**, maxΔ 255 → 0, bit-exact. Buckets `12/6/3` → **13/5/3**
- [x] **Smart filters disclosed and named** — `smart-filters-2` sat at 46.38% with a BLANK cause column. One **Liquify** filter, on `placedLayer.filter.list`
- [x] **`layer-comps` diagnosed** — not a compositing gap at all. See Failed Approaches
- [x] **Relay hardening** — global cross-key attempt ceiling, decaying `maxSessionBytes`, `GET /stats`
- [x] **`tree` frame added to the protocol** — the handshake `matchLayers` needs had no frame that could carry it
- [x] **`src/sync/photoshop.js`** — every plugin decision that does not need a host, tested without one
- [x] **UXP plugin written** — `plugin/`. **Never run inside Photoshop**
- [x] **App side of sync** — `SyncService` + `SyncSheet`, reached from the chain icon in the editor header. App **138 → 165**
- [x] **`ProjectService.removeLayer` / `.setFrame`** — the engine had both; the app had a path to neither
- [x] **The relay runs on Cloudflare Workers** — `worker/`, a Durable Object, sharing `src/sync/protocol.js` and `server/pairing.js` with the Node relay rather than copying the security model
- [x] **Deployed and verified live** — 10 checks against the deployed Worker over `wss://`
- [x] **`npm run sync:live`** — the whole sync path end to end against the deployed relay, everything real except Photoshop. **ALL PASSED**
- [x] **CI** (`.github/workflows/test.yml`) — engine green on a clean runner
- [x] **Android release signing configured** — no key created; see Warnings
- [x] **Docs** — `docs/HOW-SYNC-WORKS.md` (plain language, Mermaid diagrams), `docs/DEPLOY-CLOUDFLARE.md`

## Not Yet Done

- [x] **The UXP plugin loads and connects** — confirmed by a real run in Photoshop. It then
  dropped with `peer-gone` straight after pairing, and that was **a relay bug, not a plugin
  one.** Socket ids came from an in-memory counter (`s${this.nextId++}`), but a Durable
  Object's constructor **re-runs on every wake**, so the counter restarted at 1. An app that
  connected before an eviction and a plugin that connected after it could both be `s1`, and
  `onPair`'s `find(id === owner)` then returned whichever `ctx.getWebSockets()` listed first —
  an order Cloudflare does not specify. When that was the plugin, it paired **with itself**,
  the app was never told, and the plugin's first frame found no peer. Fixed with
  `crypto.randomUUID()`. `test/worker.mjs` reproduces it red in both socket orders. **A live
  repro did NOT reproduce it**: it takes an eviction *and* an unlucky order, and Cloudflare
  evicts on its own schedule — so the unit test is the proof, not the live run.
  **A real Photoshop run then showed it directly**, which is stronger than either: two
  `recv paired` lines on one socket, the tree sent twice, then `peer-gone`. The relay sends
  one `paired` per side, so receiving both means it addressed both to the plugin. That run
  (2026-09-09 14:49 UTC) was on relay `17297bd7`; the fix went live as `1bdcec59` on
  2026-09-10 08:27 UTC. The plugin now refuses a second `paired` and names the cause
- [ ] **Confirm edits actually flow.** Connecting is verified; turning Photoshop events into
  correct frames is not. Two seams remain: `layerIdFrom` (reading the layer id out of a
  notification) and `propsFor` (the payload per change). Both log the raw descriptor the first
  time each kind appears, so one real editing session settles them
- [ ] **CI's `app` job is RED, and the branch does not compile from a clean clone.**
  `app/src/app/editor/editor.page.ts:965` calls `this.seg.tool.set('')`, and the
  **committed** `segment.service.ts` has no `tool` property — it exists only in the other
  session's **uncommitted** working copy (line 61). `git show 6b576cb:app/.../editor.page.ts`
  already has the call, so this predates every commit here. Invisible locally because every
  build patches it from the working tree. **The fix is one line and belongs to that session**
- [ ] **Run the GPU conformance page** — no GLSL in this repo has *ever* been compiled.
  `npm run serve`, then `http://localhost:5173/demo/conformance.html` → **Run all tables**
- [ ] **Run on a phone** — Phase 1's definition of done. Depends on the GPU tier working
- [ ] **Phase 0** — design system + five real screens. Deferred at project start, never resumed
- [ ] **`effects` 23.03% — layer styles.** Nine sub-features. Divergence by region: inner
  shadow 3372 px, drop shadow 2447, glows 1471, gradientOverlay+satin 768, bevel 706,
  stroke 473, gradientOverlay 472, solidFill **0 (disabled in the file)**
- [ ] **`smart-filters-2` 46.38%** — one Liquify filter; needs a mesh-warp engine. The mesh
  is at `placedLayer.filter.list[0].filter.liquifyMesh`
- [ ] **Artboards in the editor renderer** — `composite.js` clips and fills; `renderProject`
  does not, because it walks the FLAT `project.layers`. The rect must be carried onto each
  leaf in `flatten()` at `src/edit.js:374` — **held by the other session**
- [ ] `boolean` 0.18% — two single-pixel rows where our antialias coverage reads ~16%
  against Photoshop's 50%. Unattributed, so a suspected bug
- [ ] **No protocol version negotiation.** `hello` carries a version and `paired` reports the
  peer's, but nothing compares them. A `tree` frame was added this session, so an old plugin
  against a new app is already possible — and would fail as "paired, then silence"

## Failed Approaches (Don't Repeat These)

**Do not build a vector path rasteriser for fidelity.** An agent was dispatched to do this
on the claim that `shapes.src.psd` / `gradient.src.psd` were in the `>=10%` bucket. They
are at **0.00% real, maxΔ 0 — bit-exact**. The brief had misread the `raw %` column (RGB
hiding under transparent pixels) for `real %`. All 21 fixtures were scanned: **14
vector-bearing layers, every one already rasterised by Photoshop.**

**Do not build Color Overlay expecting the `effects` number to move.** Same trap, found
again this session: `solidFill` is **disabled** in the only fixture that has it, so
implementing it changes **zero pixels** and cannot be verified. Its region contributes 0 of
the 9,211 divergent pixels.

**Do not try to score `layer-comps` to zero.** Its 10.84% is one layer's visibility, not a
compositing gap: hide "Layer 3" and we match Photoshop at **0.00% / maxΔ 0**. Four
hypotheses tested, all dead: (1) the composite reflects a different comp state — no, the
`lastApplied` comp `510999610` lists Layer 3 `enabled: true`; (2) ag-psd misreads the hidden
bit — no, the raw flag byte is `0x08` and ag-psd reads only `0x02`; (3) the layer is empty or
masked — no, real 1073-byte alpha channel, `maskDataLen=0`, no `lsct`/`lfx2`/`FMsk`;
(4) `layer-comps.expected.psd` holds the truth — no, saved separately and agrees with the
embedded composite exactly. The file disagrees with itself.

**Do not implement Blend If in GLSL.** Deliberately *gated off* the GPU tier —
`buildDrawPlan` refuses such a document by name and falls back to JS.

**`readDocument` alone will not give you pixels.** It releases each layer's `imageData` the
moment `onLayer` returns. Use `loadProjectProxy(...)`, or `readDocument(bytes, { pixels:
'eager', embedded: true, metadata: false })` for the compositor oracle.

**Do not import above `plugin/` from the plugin.** UXP treats the folder holding
`manifest.json` as the plugin root; reaching above it can make the panel fail to load with
no error. `scripts/vendor-plugin.mjs` copies the three modules in, and `test/sync.mjs` fails
if they drift or if an import climbs out again.

**Do not run two `wrangler dev` instances at once.** They share one local `.wrangler`
Durable Object SQLite state; touching `wrangler.toml` then kills the second with
`SQLITE_BUSY` on reload. Reads like a runtime bug, is not one.

**`git add` then a separate `git commit` is racy here.** Concurrent agents share one git
index. **Use `git commit -- <paths>`** — all 17 commits this session did, and none of the
other session's files were ever staged.

**A 404 from a permissions boundary looks exactly like a 404 from absence.** `gh repo view`
reported this repo did not exist. It did — privately, owned by `jaswantdangi`, while `gh`'s
active account was `dangijaswant`, which cannot see it. There are **four** accounts logged
in; an earlier `gh auth status | head -10` truncated the list and hid two of them.

## Key Decisions

| Decision | Rationale |
|---|---|
| Sync moves **events, not documents** | Both sides open the same file. Removes transfer, chunking, storage and conflict resolution entirely |
| Sync is **Photoshop → app only** | Photoshop is authoritative. `error` is the only frame routed both ways |
| `matchLayers` matches **by signature, never by index** | Photoshop counts groups and mints per-session ids; the app has a flat list with empty leaves dropped. A misaligned event applies a real change to the **wrong layer** rather than erroring |
| The mapping is pinned **once at pairing** | Re-matching per event would match against a document earlier events had already changed |
| An event before a `tree` is **refused, never queued** | Without a mapping, "layer 7 moved" names nothing |
| Unmappable changes are **counted on screen** | A sync that silently discards half a user's work is worse than one that refuses it |
| `tree.document` is **required** | Nothing else can tell "the matcher is broken" from "you have a different file open" |
| Workers relay **loses backpressure**, and says so | No `bufferedAmount` exists there. `/stats` omits the fields rather than reporting zeroes |
| Worker byte cap is **per direction**, not per session | No shared object survives hibernation without a storage write per frame; events travel one way anyway |
| `server/pairing.js` is **runtime-portable and shared** | It IS the security model; a second copy is the last place a divergence should hide |
| `plugin/vendor/` is **committed build output** | UDT loads the folder off disk and runs no npm scripts, so "remember to build first" is a trap. A test guards the drift |
| No Android upload key was created | It cannot be regenerated. Lose it and Play never accepts another build of `com.digitaaz.psdeditor` |

## Current State

**Working**: `npm run test:engine` exits 0 — **985** assertions.

```
21 files | <0.5%: 13   <10%: 5   >=10%: 3
All 21 fixtures within their accuracy ceilings.
49 · 21 · 28 · 24 · 28 · 133 · 108 · 100 · 110 · 61 · 49 · 66 · 87 · 24 · 64 · 33
```

`npm run sync:live` — **ALL PASSED** against the deployed relay.

**CI**: `engine` ✅ green on a clean runner · `app` ❌ red, see Not Yet Done.

**Broken / unverified**:
- **`plugin/main.js` has never executed.** Six `VERIFY:` markers
- **The app's real WebSocket has never opened.** `SyncService` has 27 tests, but they replace
  `socketFactory` with a fake. The deployed app connecting to the deployed relay is untested
- **No GLSL has ever been compiled.** The 133 GPU assertions check the command sequence
  against a recording fake
- **The Durable Object has never hibernated.** Local dev keeps it resident
- **`npm test`'s app half could not be re-run at the end** — the machine hit OOM with 255
  accumulated `node.exe` processes. Last clean run was 165/165; changes since are one
  attribute and comments in `index.html`. Believed unaffected, **not proven**

**Uncommitted Changes**: only the **other session's** — `HANDOFF.md`,
`app/src/app/editor/{canvas-stage,cutout-panel}.ts`, `app/src/app/services/segment.service.ts`,
`app/src/app/workers/bg-remove.worker.ts`, `docs/BACKLOG.md`, `src/edit.js`, `src/index.js`,
`src/segment/{cutout,index,models}.js`, untracked `src/segment/edge.js`. **Do not stage these.**

## Files to Know

| File | Why It Matters |
|---|---|
| `src/composite.js` | The correctness oracle. `applyArtboard`, `parseBlendIf`, `smartFiltersOn` |
| `test/composite.mjs` | Accuracy harness **and** the per-fixture ceilings that fail the build |
| `src/sync/identity.js` | Matches layers **by signature, never by index**. The whole feature rests on this |
| `src/sync/protocol.js` | Wire format and validation. Six frame types |
| `src/sync/photoshop.js` | Every plugin decision that does not need a host — tested without one |
| `plugin/main.js` | The only code here that cannot run without Photoshop. Six `VERIFY:` markers |
| `plugin/README.md` | What is unverified, **ranked**. Read before loading it |
| `app/src/app/services/sync.service.ts` | The app half. Pins one `matchLayers` result, refuses the rest out loud |
| `worker/hub.js` | The relay as a Durable Object. Header states what backpressure it cannot have |
| `server/pairing.js` | Codes and rate limits. The ONE file both transports share |
| `tools/live-sync-check.mjs` | End to end against the deployed relay. `npm run sync:live` |
| `docs/HOW-SYNC-WORKS.md` | Plain-language explainer with diagrams |
| `docs/DEPLOY-CLOUDFLARE.md` | What deploys where, and what Cloudflare cannot host |
| `demo/conformance.html` | The only thing that can prove the GPU path correct |

## Code Context

**The six frame types** (`MESSAGE_TYPES`):
```js
['hello', 'pair', 'paired', 'tree', 'event', 'error']

// tree — sent once, at pairing. `document` is required.
{ type: 'tree',
  document: { name, width, height },
  layers: [{ layerID, name, kind, bounds: {left,top,right,bottom}, groupPath: [] }] }

// event — Photoshop -> app only
{ type: 'event', change: 'move', layerID: 7, props: { x: 40, y: 12 } }
```

**The five changes that can never cross as operations:**
```js
UNMAPPABLE_CHANGES = ['brush', 'filter', 'adjustment', 'maskPaint', 'layerEffect']
// `add` is NOT here: it has a command (`insert`), it just needs pixels.
```

**Applying an event, app-side** — the shape `tools/live-sync-check.mjs` proves live:
```js
const mapping = matchLayers(treeFrame.layers, project.layers);   // once, pinned
const result = translateEvent(eventFrame, mapping, { order: project.layers.map(l => l.id) });
// -> { ok: true, command: {type:'set'|'reorder'|'remove'|'frame', ...} }
// -> { ok: false, reason: 'needs-pixels'|'unknown-layer'|'bad-props'|'unknown-change' }
```

**The house test helper is SYNCHRONOUS** (`test/*.mjs`) — an `async` body hands it a promise,
the `catch` never fires, and **a failing assertion reports as a pass**. `test/relay.mjs` and
`test/worker.mjs` are the exceptions and run their own `await` loop.

## Resume Instructions

1. **Verify the baseline:**
   ```
   npm run test:engine
   ```
   Expected: exit 0, `All 21 fixtures within their accuracy ceilings.`, counts
   `49 · 21 · 28 · 24 · 28 · 133 · 108 · 100 · 110 · 61 · 49 · 66 · 87 · 24 · 64 · 33`.

2. **Verify sync still works end to end (30 seconds, needs network):**
   ```
   npm run sync:live
   ```
   Expected: `ALL PASSED — through the deployed Cloudflare relay`. If the relay is
   unreachable, check the Worker is still deployed and the origin allowlist still names
   `https://psd-editor.pages.dev`.

3. **Run the plugin in Photoshop — the highest-value unknown (~10 minutes):**
   Read `plugin/README.md` first. Then UXP Developer Tool → *Add Plugin* →
   `plugin/manifest.json` → *Load*. Photoshop → Plugins → PSD Reader Sync.
   Open the same PSD on both sides, take the code from the app's chain icon, type it in.
   - Expected: `Connecting… → Pairing… → Live — <file>, N layers sent`
   - Panel never appears → the mixed `import`/`require` in `main.js`
   - Pairs but nothing arrives → `layerIdFrom` returning null, which it does deliberately
     rather than guess. Log the raw descriptor and read `_target`
   - Few layers matched → `layer.bounds` reporting effect-inclusive bounds

4. **Verify the GPU (~5 minutes):**
   ```
   npm run serve
   ```
   `http://localhost:5173/demo/conformance.html` → **Run all tables**.
   - Badge must read **Tier 1** or **Tier 2**. **Green under Tier 3 means nothing** — the
     page then ran the JS renderer against itself and says so on screen

5. **Run it on a phone** — depends on step 4 passing. The JS tier is 651 ms/frame for 20
   layers on desktop, 3–5× that on a phone.

## Setup Required

- Node 24. Several suites need `--max-old-space-size=6144`; already in the scripts
- `fixtures/` is **gitignored**. `node scripts/fetch-fixtures.mjs` gets all 30 —
  **21 `.src` and 9 `.expected`**. CI does this; a fresh clone must too
- Photoshop 24+ and the Adobe UXP Developer Tool, to load `plugin/`
- Cloudflare: already authenticated as `jaswantdangi00@gmail.com`.
  `npx wrangler deploy` (relay), `cd app && npm run pages:deploy` (app)
- GitHub: **four** accounts are logged in. This repo needs `jaswantdangi` —
  `gh auth switch --user jaswantdangi`
- `RELAY_STATS_TOKEN` is **not set**, so `/stats` is unreachable. That is the safe default:
  `npx wrangler secret put RELAY_STATS_TOKEN`

## Edge Cases & Error Handling

- **Event before a tree** → refused `not-reconciled`, never queued
- **Event for an unmatched layer** → refused `unknown-layer`, document untouched (verified live)
- **Brush/filter/adjustment/maskPaint/layerEffect** → refused `needs-pixels`, counted on screen
- **Different files open on the two sides** → dimensions compared, warning shown. Nothing can
  enforce it; no document ever crosses
- **Peer vanishes** → survivor told `peer-gone` and closed
- **Session byte cap** → a burst allowance over a sustained rate, not a lifetime quota
- **Pairing brute force** → 10/min per IP, 10,000 failures/min globally. Exhausting the global
  budget denies *new* pairings until the window rolls; established sessions are untouched
- **GPU plan over budget** → `ok: false` + reason; caller falls back to JS. Nothing throws

## Warnings

- **`plugin/` is written and unrun.** A green `npm test` does not imply otherwise — the suite
  covers `src/sync/photoshop.js`, which is deliberately everything the plugin decides
  *except* what needs a host
- **`13/5/3` is enforced.** Improve a fixture and the run tells you to tighten its ceiling
- **Adding a file to `fixtures/` fails the build** until you give it a ceiling
- **Two sessions are live on this branch.** `git status` before every commit; use
  `git commit -- <paths>`
- **After editing `src/sync/`, run `npm run plugin:vendor`** or `test/sync.mjs` fails
- **Artboards work in `composite.js` but NOT `render.js`** — the editor still draws layers
  outside their board
- **`maxSessionBytes` is no longer a lifetime quota**, so `stats().bytes` can exceed the cap
  without anything being wrong. `budgetBytes` is what the cap reads
- **The deployed artifacts predate the last three commits** — all docs/plugin-only, so the
  deployment is still correct. Re-cut with `npm run pages:deploy` / `npx wrangler deploy` if
  you want them to match HEAD exactly
