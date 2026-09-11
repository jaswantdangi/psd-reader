# Handoff: Photoshop Sync (edits + fonts), the Engine, and the Cloudflare Deployment

**Generated**: 2026-09-11 13:30 UTC
**Repo**: `github.com/jaswantdangi/psd-reader` — **private**, owned by GitHub user `jaswantdangi`
**Branch**: `phase-1-engine-gpu-memory` — HEAD `68748e5`, pushed, CI **green** on it
**Status**: In Progress — everything built and tested; **the next step needs a human with Photoshop**

> **Read this first.** `HANDOFF.md` in this repo belongs to a **different, concurrent
> session** (AI background removal: `src/segment/`, `app/**/cutout*`, `bg-remove.worker.ts`).
> This document has its own filename so the two never collide. Neither supersedes the other.

## Live

| | URL | Deployed version |
|---|---|---|
| **App** | https://psd-editor.pages.dev — Cloudflare Pages | **Predates font sync.** Needs a build + deploy (see Resume step 1) |
| **Relay** | https://psd-sync-relay.jaswantdangi00.workers.dev — Workers + Durable Objects | `cfad7479-8d67-46c6-98d0-a44ff734f10e` = HEAD's `worker/` |

Cloudflare account is `jaswantdangi00@gmail.com` — **a different account from GitHub's
`jaswantdangi`**.

## Goal

Photoshop → app sync that actually works in real Photoshop: the plugin connects and stays
connected, edits reach the app, and the fonts the PSD uses travel from the Photoshop PC to
the app on another device (the user's phone). Plus the PSD engine's correctness work.

## Completed

**Sync — connection (verified in real Photoshop by the user)**
- [x] Plugin rebuilt as CommonJS for UXP (no ESM), manifest v5 `host` object, staged logging, watchdog, `/whoami` preflight
- [x] Relay: origin allowlist admits non-browser origins (UXP sends none); subprotocol echoed
- [x] **Self-pairing after Durable Object hibernation** — socket ids came from an in-memory counter that reset on every wake; fixed with `crypto.randomUUID()` (`898084c`). A real Photoshop log showed it directly: two `recv paired` on one socket. Plugin now refuses a second `paired` and names it (`5ddeb6d`)
- [x] `peer-gone` now says which side left and how (close code)

**Sync — edits (`93c3110`), proven in a fake UXP, not yet in real Photoshop**
- [x] Layer identified from `_enum: 'ordinal' / 'targetEnum'` (the selection), `layerID` as number/array/`{_id}`, `_id`, or a `_name` (only if unique) — `layerTargetsFrom` in `src/sync/photoshop.js`
- [x] `delete` uses explicit ids only (after a delete the selection is a *different* layer)
- [x] `hide`/`show` subscribed; `test/sync.mjs` fails if any mapped event is not in `WATCHED`
- [x] An app refusal (`error` frame after pairing) no longer tears the session down
- [x] move/transform use `boundsNoEffects` of the moved layer
- [x] `test/plugin.mjs` runs the REAL `plugin/main.js` in a `vm` with fake DOM/WebSocket/timers/`photoshop`/`uxp`

**Font sync (`a9e38ae`..`68748e5`, 10 commits)** — spec `docs/superpowers/specs/2026-09-11-font-sync-design.md`, plan `docs/superpowers/plans/2026-09-11-font-sync.md`
- [x] `src/sync/font-file.js` — sfnt `name` table reader (TTF/`true`/`OTTO`, `.ttc` members, WOFF refused), `candidateOrder`, own base64 + SHA-256, `chunkFont`/`assembleFont`
- [x] Protocol: `font-request` (app→plugin), `font-chunk`, `font-missing` (plugin→app); `ONE_WAY_FRAMES` shared by both relays
- [x] Plugin: **Choose fonts folder…** (persistent token), index in `localStorage`, serves requests one at a time
- [x] App: `FontCacheService` (IndexedDB, 150 MB, LRU), `SyncService` request/reassemble/verify/install/cache, 30 s stall timeout, Fonts sheet status + **Remove synced fonts**
- [x] Worker redeployed; `node tools/font-relay-probe.mjs` passes live (880 KB font, 2 chunks, checksum ok, wrong direction refused)

**Engine / infra (earlier)**
- [x] Artboards bit-exact in `src/composite.js`; smart filters named; `layer-comps` diagnosed
- [x] Relay on Workers + DO; Node relay kept; CI; Android signing configured (no key); docs `docs/HOW-SYNC-WORKS.md`, `docs/DEPLOY-CLOUDFLARE.md`

## Not Yet Done

- [ ] **Build + deploy the app** — the live app predates font sync, so it never sends `font-request`. The user builds (project rule: agents do not run the build): `cd app && npm run pages:deploy`
- [ ] **A real Photoshop session, edits** — does a real build send the documented descriptor shapes? `layersFor`/`propsFor` log the raw descriptor whenever they cannot identify a layer. One session settles it
- [ ] **A real Photoshop session, fonts** — folder picker, persistent tokens across a restart, and **the first-scan time**: the panel logs `font lookup took N ms`. Read it off a run; do not estimate it
- [ ] **Run the GPU conformance page** — no GLSL has ever been compiled. `npm run serve` → `http://localhost:5173/demo/conformance.html` → **Run all tables**
- [ ] **Run on a phone** — Phase 1's definition of done; depends on the GPU tier
- [ ] **Reorder does not sync** — `propsFor('reorder')` returns null on purpose: the neighbour cannot be read yet, and `belowLayerID: null` means "move to bottom"
- [ ] `effects` 23.03% (layer styles), `smart-filters-2` 46.38% (Liquify mesh at `placedLayer.filter.list[0].filter.liquifyMesh`), `boolean` 0.18%
- [ ] **Artboards in the editor renderer** — `renderProject` walks the flat `project.layers`; the rect must be carried onto each leaf in `flatten()` (`src/edit.js`)
- [ ] **No protocol version negotiation** — an old plugin against a new app fails as "paired, then silence". Font sync makes this likelier: an old plugin ignores `font-request`, and the app then says "Photoshop did not answer — update the plugin" after 30 s
- [ ] Open decisions for the user: cache hand-picked fonts too? support `.ttc` by extracting one face? a "rescan fonts" button (an in-place replaced font file under the same name is not noticed)?

## Failed Approaches (Don't Repeat These)

**Plugin**
- **ES modules in UXP** — the panel silently never runs. CommonJS + `require` only; `plugin/vendor/` is the CJS copy of `src/sync/`
- **`addNotificationListener([{event:'set'}, …])`** — the object form subscribes to nothing. Plain string array
- **`innerHTML` in UXP** — not a browser DOM; use `createElement`/`textContent`
- **Reading the layer only from a numeric `_id`** — Photoshop almost always sends `_enum: ordinal / targetEnum`. Result: connected, nothing ever synced
- **Treating every `error` frame as fatal** — one unmatched layer ended the session
- **Using the selection for `delete`** — would delete the neighbour Photoshop selects afterwards
- **`Layer.bounds`** — includes effects; the app's bounds don't. Use `boundsNoEffects`
- **Testing the plugin only by reading its source** — every static check passed while it sent nothing. `test/plugin.mjs` runs it
- **Trusting a font's file name** (`HelvNeue_Rm.otf`) — read nameID 6 from the file

**Relay**
- **An in-memory id counter in a Durable Object** — the constructor re-runs on every wake. `crypto.randomUUID()`
- **A live repro of the self-pairing** — it needs an eviction AND an unlucky socket order; it did not reproduce. The unit test (both orders) is the proof
- **Refusing sockets with no `Origin`** — UXP sends none; the allowlist only ever constrained browsers
- **Not echoing `Sec-WebSocket-Protocol`** — a client that requests one fails the handshake

**Engine** (unchanged): do not build a vector rasteriser (fixtures are already bit-exact); Color Overlay moves zero pixels (`solidFill` disabled in the only fixture); `layer-comps`' 10.84% is the file disagreeing with itself; Blend If is gated off the GPU tier; `readDocument` alone releases pixels — use `loadProjectProxy` or `pixels:'eager'`.

**Tooling on this Windows machine**
- **`sed` edits** once wrote a NUL byte into `src/sync/photoshop.js`. Use the Edit tool
- **Shell heredocs/escapes** mangled template literals. Write commit messages to a file: `git commit -F <file> -- <paths>` with a quoted `'MSGEOF'` heredoc
- **`ng test --include=<one spec>` still type-checks EVERY spec** — a compile error in one spec fails the "unrelated" run
- **`gh` "Repository not found"** — wrong active account. `gh auth switch --user jaswantdangi` (four accounts are logged in)
- **Two `wrangler dev` at once** → `SQLITE_BUSY` on shared `.wrangler` state

## Key Decisions

| Decision | Rationale |
|---|---|
| Sync moves **events, not documents** | Both sides open the same file; no transfer, storage or conflicts |
| **Photoshop → app only**; exceptions: `error` both ways, `font-request` app → plugin | Photoshop is authoritative. Direction lives in ONE table, `ONE_WAY_FRAMES`, read by both relays |
| `matchLayers` **by signature, never by index**, pinned once at pairing | A misaligned event damages the wrong layer silently |
| Unidentifiable → **send nothing, log the descriptor** | A wrong layer is worse than no sync |
| Fonts: **the app asks, the plugin answers** | Only missing fonts travel; nothing already drawn is re-sent |
| Fonts: **folders picked once**, not `fullAccess` | The user chose least privilege |
| Fonts: **file identified by its name table** | Same string the PSD stores; file names are only an open-first hint |
| Fonts: **synced fonts cached on the device**, hand-picked not | The user asked for synced-font caching; hand-picked caching reverses a recorded decision, left open |
| Adobe Fonts / `.ttc` / >32 MB → **reported per font, never silent** | Licence / FontFace cannot load / cap |
| Own base64 + SHA-256 in `font-file.js` | UXP's `btoa`/`crypto.subtle` are undocumented; one implementation on both ends |
| `plugin/vendor/` is committed build output | UDT loads the folder off disk and runs no npm scripts |

## Current State

**Working** (all run this session):

| Suite | Result |
|---|---|
| `node test/font-file.mjs` | 16 passed |
| `node test/sync.mjs` | 81 passed |
| `node test/plugin.mjs` | 21 passed |
| `node test/worker.mjs` | 47 passed |
| `node test/relay.mjs` | 66 passed |
| app specs `font-cache` + `sync.service` + `fonts.service` | 3 files, 47 passed |
| `npx tsc -p app/tsconfig.app.json --noEmit` | 0 errors |
| `node tools/font-relay-probe.mjs` (live) | 4/4 ok |
| CI on `68748e5` | success |

Real Photoshop: the plugin **loads, pairs and stays connected** (user-confirmed, before `93c3110`).

**Unverified**: edits and fonts in real Photoshop; Angular templates of `fonts-sheet.ts` (checked only by a build); GLSL never compiled; full `npm run test:engine` not re-run end to end this session (its sync-related suites were).

**Uncommitted Changes**: none of this session's. Untracked `.angular/` and `docs/VSCO-md.md` are not ours — leave them.

## Files to Know

| File | Why It Matters |
|---|---|
| `plugin/main.js` | The Photoshop side. `layersFor`, `propsFor`, `onFrame`, fonts section (`findFonts`, `serveFonts`) |
| `plugin/index.html`, `plugin/manifest.json` | Panel UI; permissions (`network.domains`, `localFileSystem: "request"`) |
| `src/sync/photoshop.js` | Host-free plugin logic: `changeForNotification`, `layerTargetsFrom`, `coalesceEvents` |
| `src/sync/font-file.js` | Name-table reader, chunking, checksum |
| `src/sync/protocol.js` | Nine frame types, validation, `ONE_WAY_FRAMES`, `translateEvent` |
| `src/sync/identity.js` | `matchLayers` — signature matching |
| `worker/hub.js` / `server/relay.js` | The two relays; `onOneWay` in each |
| `app/src/app/services/sync.service.ts` | App half: tree → mapping → events; fonts (`syncFonts`, `onFontChunk`, `install`) |
| `app/src/app/services/font-cache.service.ts` | IndexedDB cache |
| `app/src/app/services/fonts.service.ts` | `assignTo`, `missingNames`, `loadCached` |
| `app/src/app/editor/fonts-sheet.ts` | Per-font sync status, Remove synced fonts |
| `test/plugin.mjs` | The fake-UXP harness — extend it before touching the plugin |
| `test/make-font.mjs` | Builds minimal fonts in memory (the repo holds no font files) |
| `tools/font-relay-probe.mjs`, `tools/live-sync-check.mjs`, `tools/peer-gone-probe.mjs` | Checks against the DEPLOYED relay |

## Code Context

```js
// MESSAGE_TYPES
['hello','pair','paired','tree','event','error','font-request','font-chunk','font-missing']

{ type: 'font-request', names: ['MyriadPro-Regular'] }                    // app -> plugin, 1-64 names
{ type: 'font-chunk', name, fileName, index, count, bytes, sha256, data }  // 512 KiB raw per chunk, count <= 64
{ type: 'font-missing', name, reason, detail }  // reason: no-folder | not-found | collection | too-large | unreadable

ONE_WAY_FRAMES['font-request'] // { from: 'app', notPaired: '...', wrongWay: '...' }

layerTargetsFrom(descriptor) // -> {ids:[…]} | {names:[…]} | {selected:true} | null
fontNamesIn(bytes)           // -> {postscriptName,family,subfamily} | {collection:true,fonts} | {unsupported:'woff'} | null
assembleFont(frames)         // -> {ok:true,bytes} | {ok:false,reason}
```

```ts
// SyncService
readonly fontSync: Signal<Record<string, { state: 'requested'|'receiving'|'synced'|'cached'|'missing'|'failed';
                                           detail: string; received?: number; count?: number }>>;
fontTimeoutMs = 30_000;
// FontsService
missingNames(): string[];  loadCached(names: string[]): Promise<string[]>;
```

- **Test helpers**: most `test/*.mjs` use a SYNCHRONOUS `test()` — an `async` body there reports failures as passes. `worker.mjs`, `relay.mjs` and now `plugin.mjs` queue tests and `await` them.
- **App specs** have no `FontFace` and no IndexedDB (jsdom). `FontsService.supported` is false there; `FontCacheService` falls back to `memoryFontBackend()`. Spies: `import { vi } from 'vitest'`.

## Resume Instructions

1. **Ask the user to build and deploy the app** (do not run the build yourself): `cd app && npm run pages:deploy`.
   - Expected: a new Pages deployment. Until then the live app never asks for fonts.
2. **Verify the baseline:**
   ```
   node test/font-file.mjs && node test/sync.mjs && node test/plugin.mjs && node test/worker.mjs && node test/relay.mjs
   node tools/font-relay-probe.mjs
   ```
   Expected: 16 / 81 / 21 / 47 / 66 passed; probe `font frames cross the live relay, each one way only`.
3. **Real Photoshop run (the user does it; you read the log):**
   UXP Developer Tool → unload + load `plugin/manifest.json` (it asks for the new folder permission) → **Choose fonts folder…** → `C:\Windows\Fonts` → pair with the app's code → move, rename, change opacity, hide a layer → open the app's Fonts sheet. Ask for **Copy log**.
   - Expected in the log: `FIRST notification received`, `sent N change(s)`, `the app asked for … font(s)`, `sent <name> from <file>`, `font lookup took N ms`.
   - `"<event>" -> <change>, but the descriptor names no layer` + `descriptor was: …` → a shape `layerTargetsFrom` does not know. Add it there with a test in `test/sync.mjs`, then a harness test in `test/plugin.mjs`.
   - `no require('uxp').storage` → the host lacks the storage module; fonts cannot be sent on that build.
   - App says "Photoshop did not answer — update the plugin" → the plugin loaded is older than `0f51917`.
4. Then the GPU conformance page and the phone run (Not Yet Done).

## Setup Required

- Node 24. `fixtures/` is gitignored: `node scripts/fetch-fixtures.mjs`
- Photoshop 23.3+ and the UXP Developer Tool
- Cloudflare: authenticated as `jaswantdangi00@gmail.com`. Relay: `npx wrangler deploy`
- GitHub: `gh auth switch --user jaswantdangi` before any push
- After editing `src/sync/`: `node scripts/vendor-plugin.mjs` (or `test/sync.mjs` fails on drift)

## Edge Cases & Error Handling

- Event before a tree → refused `not-reconciled`; unmatched layer → `unknown-layer`, sent back as a non-fatal error the plugin logs
- Unidentifiable layer / ambiguous name / payload not readable → plugin sends nothing, logs the descriptor once, counts it under "Not syncing"
- Second `paired` on one socket → plugin tears down and names the relay bug
- Font: no folder → `no-folder` per name; stale token → folder shown "no longer available", treated as absent; not in folders → `not-found` (Adobe Fonts named as likely); in `.ttc` → `collection`; > 32 MB → `too-large`; read error → `unreadable`
- Font: chunk missing / wrong file / checksum mismatch → app refuses the file and says why; no chunk for 30 s → "stopped part way"; no answer at all → "update the plugin"
- IndexedDB failure → cache miss, the font is simply requested again

## Warnings

- **Never touch `HANDOFF.md`** — the other session's. Commit with `git commit -F <msgfile> -- <exact paths>`; never `git add .`
- **Do not run the app build** to verify (user rule) — tell the user to build
- The deployed **app** is behind HEAD; the deployed **relay** matches HEAD
- `plugin/manifest.all-domains.json` is diagnostic only (`domains: "all"`) — never ship it
- A green suite does not mean Photoshop agrees: the fake UXP uses Adobe's *documented* shapes
- `13/5/3` fixture buckets are enforced; a new fixture needs a ceiling or the build fails
