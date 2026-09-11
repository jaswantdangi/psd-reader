# Font Sync — Photoshop PC → App, Through the Relay

**Date**: 2026-09-11
**Status**: Design approved, not yet planned or built

---

## The problem

A PSD stores font **names** (`MyriadPro-Regular`), never font **files**. The app
already matches names to files (`src/fonts.js`) and draws a loaded file through
`FontFace` (`FontsService`). The only way a file gets in today is the user picking
it by hand, or it arriving in a zip with the PSD. So a synced document shows its
text in a substitute until someone goes and finds every font file.

The fonts are sitting on the Photoshop PC. The app runs on a **different device**
(phone, tablet or another computer), so the files have to travel through the
relay.

## What the user sees

- **Photoshop plugin**: a **Choose fonts folder** button. The user picks
  `C:\Windows\Fonts` once, and their per-user fonts folder if they have fonts
  there. The choice is remembered across Photoshop restarts.
- **App, after pairing**: the Fonts sheet fills itself in. Each font the document
  is missing shows one of:
  - **Synced from Photoshop** — the text layers redraw in the real typeface.
  - **Kept on this device** — loaded from the device cache, nothing was sent.
  - **Not found in your fonts folders** — most likely an Adobe Fonts activation.
    Install it on this device, or load the file by hand.
  - **Can't sync** — a font collection (`.ttc`), a file over 32 MB, or no fonts
    folder chosen yet, with that reason written out.
- **Fonts sheet**: "Fonts synced from your PC are kept on this device until you
  remove them" and a **Remove synced fonts (N MB)** button.

## Decisions

| Decision | Rationale |
|---|---|
| **The app asks; the plugin answers** | The app already knows exactly which names it is substituting (`fontDemand`). Only those travel, so a font the app already has is never re-sent. The alternative — the plugin pushing every font the document uses at pairing — re-sends everything, every session. |
| **Folders picked once, not full-disk access** | UXP keeps access to a picked folder through a persistent token. Full-disk access (`localFileSystem: "fullAccess"`) would be zero clicks but asks the user to trust the plugin with the entire disk and is harder through Marketplace review. The user chose folder picking. |
| **The file is identified by its own name table, not its file name** | Photoshop's API lists fonts (`app.fonts`: `postScriptName`, `family`, `style`) but exposes no path. A file name is a guess (`HelvNeue_Rm.otf`); the `name` table's PostScript name (nameID 6) is the same string the PSD stores. File names are used only to decide which files to open FIRST, never to decide a match. |
| **Synced fonts are cached on the device** | Chosen by the user, so the next session needs no re-send. IndexedDB, capped at 150 MB, least-recently-used evicted, removable in one tap. |
| **Hand-picked fonts stay uncached** | `FontsService` deliberately holds no licensed file past the tab. Synced fonts come from the user's own PC over their own pairing, which is the case the user asked to cache. Extending caching to hand-picked files is a separate decision, left open below. |
| **Adobe Fonts activations are excluded** | Creative Cloud stores them hidden and encrypted in `CoreSync/plugins/livetype`, and their licence does not permit copying them to another device. The plugin does not look there; the app says why they did not arrive. |
| **Font collections (`.ttc`) are refused in v1** | `FontFace` cannot load a collection. Extracting one face into a standalone file is possible but is its own piece of work. Windows ships some system fonts this way, so the refusal is stated per font, not silent. |
| **The relay still stores nothing** | Chunks stream through RAM, exactly like events. The only copy at rest is the one on the user's own device, which they can remove. |
| **Integrity is checked end to end** | The plugin sends the file's SHA-256 and size; the app verifies both after reassembly and discards a file that does not match rather than handing `FontFace` a truncated font. |

## Flow

```
App (phone)                          Relay                  Photoshop plugin (PC)
  tree arrives → fontDemand
  cached names → loaded from IndexedDB
  still missing: [MyriadPro-Regular, AachenBT-Bold]
  ── font-request {names} ──────────▶─────────────────────▶ for each name:
                                                             index lookup → file
                                                             (scan chosen folders
                                                              if not indexed yet)
  ◀── font-chunk {name, i/n, data} ◀──────────────────────── read file, 512 KiB chunks
  ◀── font-missing {name, reason} ◀────────────────────────── when it cannot
  reassemble → verify size + sha256
  → FontsService.assignTo(name, file)   (binds the exact PSD name)
  → FontCache.put(name, file)
  → text layers redraw
```

## Protocol

Three new frame types in `src/sync/protocol.js`, validated like every other
frame (fields checked, undeclared fields stripped).

| Frame | Direction | Fields | Limits |
|---|---|---|---|
| `font-request` | app → plugin | `names: string[]` | 1–64 names, each 1–128 chars |
| `font-chunk` | plugin → app | `name`, `fileName`, `index`, `count`, `bytes`, `sha256`, `data` (base64) | `data` ≤ 512 KiB decoded (≈ 700 000 chars); `count` ≤ 64; `bytes` ≤ 32 MiB; `0 ≤ index < count` |
| `font-missing` | plugin → app | `name`, `reason`, `detail?` | `reason` ∈ `no-folder`, `not-found`, `collection`, `too-large`, `unreadable` |

`font-request` is the first frame other than `error` to travel app → plugin, so
both relays gain a direction rule for it: `worker/hub.js` (`onUpstream`'s
counterpart for the app role) and `server/relay.js` (next to the existing
`wrong-direction` refusals). `font-chunk` and `font-missing` travel the existing
plugin → app path and spend the existing byte budget.

## Components

### `src/sync/font-file.js` (new, pure, vendored into the plugin)

- `fontNamesIn(bytes)` → `{ postscriptName, family, subfamily }` from the sfnt
  `name` table (platform 3/1 UTF-16BE preferred, platform 1/0 Mac Roman
  fallback), for `0x00010000`, `'true'` and `'OTTO'` files. `{ collection: true }`
  for `'ttcf'`. `{ unsupported: 'woff' }` for WOFF/WOFF2. `null` for anything
  that is not a font. Never throws.
- `candidateOrder(psName, fileNames)` → the file names reordered so the ones
  that resemble the PostScript name are opened first. An ordering hint only: the
  name table decides the match, so this is not a second matcher beside
  `src/fonts.js`.
- `bytesToBase64` / `base64ToBytes` — UXP's `btoa` over binary data is not
  something to rely on, and the app needs the inverse.
- `chunkFont(bytes, name, fileName, sha256)` → the `font-chunk` frames.

Added to `MODULES` in `scripts/vendor-plugin.mjs`. It imports nothing outside
`src/sync/`, so the vendored copy resolves.

### Plugin (`plugin/main.js`, `index.html`, `manifest.json`)

- `manifest.json`: `requiredPermissions.localFileSystem: "request"` (pickers only).
- **Choose fonts folder** → `localFileSystem.getFolder()` →
  `createPersistentToken` → token stored in `localStorage`. A list of chosen
  folders with a remove control. On boot, tokens are restored through
  `getEntryForPersistentToken`; a token that no longer resolves is shown as
  "folder no longer available — choose it again", never dropped silently.
- **Index**: `postscriptName → {folder, fileName, size, modified}`, stored in the
  plugin data folder. An entry is trusted only while the file's size and
  modified date are unchanged.
- **On `font-request`**: for each name, index lookup; on a miss, scan the chosen
  folders in `candidateOrder`, reading each file and indexing everything it
  learns, and stop as soon as every requested name is found. Requests are served
  one at a time; a request arriving mid-scan is queued.
- Every outcome is logged in the panel log: which file answered which name, and
  why each missing one is missing.

### App

- **`FontCacheService`** (new, IndexedDB): `get(names)`, `put(name, fileName,
  bytes)`, `totalBytes()`, `clear()`. 150 MB cap, LRU by last use.
- **`SyncService`**: after `onTree`, takes the substituted names from
  `FontsService`, loads any the cache holds, sends `font-request` for the rest.
  Collects `font-chunk`s per name; on the last one verifies size and SHA-256,
  builds a `File`, calls `FontsService.assignTo(name, [file])` and caches it.
  A transfer that goes 30 s without a chunk is dropped and reported as
  interrupted. `font-missing` is recorded with its reason.
- **`FontsService`**: exposes the substituted names; on opening a project,
  loads any the cache holds, so a document reopened without syncing still draws
  its synced fonts.
- **Fonts sheet**: per-font status (synced / from this device / not found / can't
  sync + reason) and **Remove synced fonts (N MB)**.

## Costs

- **Transfer**: missing fonts only, at ≈1.33× file size (base64). Typical fonts
  are 50 KB–2 MB; a large CJK face is 10–20 MB. Well inside the relay's 8 MB
  per-frame cap (chunks are ≈ 0.7 MB) and 256 MB session budget, and inside
  Cloudflare's 32 MiB WebSocket receive limit. Durable Object WebSocket messages
  bill at a 20:1 request ratio, so a normal document is a handful of billed
  requests.
- **First scan on the PC**: UXP reads a file whole, so a first scan of a large
  Windows fonts folder reads each candidate font file until the requested names
  are found. Likely-named files go first and the scan stops early, and the index
  makes every later lookup a single file read. The first-scan time must be
  measured on a real fonts folder and stated, not estimated.
- **Device storage**: up to 150 MB of IndexedDB.

## What does not sync (disclosed per font, never silent)

- Adobe Fonts activations — licence, and not in the chosen folders.
- Font collections (`.ttc`) — `FontFace` cannot load them yet.
- WOFF / WOFF2 — not found in OS font folders in practice; refused if met.
- Files over 32 MB.

## Testing

- `test/font-file.mjs`: name-table reading from sfnt bytes built in the test
  (Windows and Mac name records, TrueType and CFF headers, a collection, a WOFF
  signature, garbage and truncated input), `candidateOrder`, base64 round trips,
  chunking and reassembly.
- `test/sync.mjs`: validation of the three frames and their limits.
- `test/worker.mjs` and `test/relay.mjs`: `font-request` routes app → plugin
  only; `font-chunk`/`font-missing` plugin → app only; chunks spend the budget.
- `test/plugin.mjs`: the fake-UXP harness gains a fake `localFileSystem` with a
  folder of generated fonts — request in, chunks out, reassembled bytes equal to
  the original; every `font-missing` reason; a stale persistent token.
- `app/.../sync.service.spec.ts` and a `FontCacheService` spec: request after
  tree, cache hit sends nothing, SHA mismatch discards, 30 s interruption.
- **Needs a real run**: the folder picker, persistent tokens across a Photoshop
  restart, `entry.getMetadata()`'s shape, and the first-scan time.

## Open

- Should hand-picked fonts use the same device cache? Today they deliberately
  do not; synced fonts will. One cache for both would be simpler for the user and
  is a reversal of a recorded decision, so it is left for the user to make.
- Extracting a single face from a `.ttc` so Windows collection fonts can sync.
