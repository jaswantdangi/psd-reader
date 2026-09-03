# Photoshop Sync — UXP Plugin and Node Relay

**Date**: 2026-09-03
**Status**: Design approved (relay model), not yet planned or built

---

## What this is

A UXP plugin inside Photoshop, a Node relay, and the existing browser app, so a
document can move from Photoshop into the editor and edits can be replayed back.

```
Photoshop ──UXP plugin──┐
                        ├── wss:// ── Node relay ── wss:// ── browser app
                    batchPlay         (pair + route)          psd-editor.pages.dev
                    imaging API
```

## The two facts that shape the whole design

**1. The app cannot write PSDs, and never will.** There is no `writePsd` anywhere
in `src/`. That was decided during the R&D: ag-psd's writer peaks at 3.5–4.2×
decoded pixels and silently drops `Patt`, corrupting pattern fills.

So edits do **not** travel back as a file. They travel as **commands**. The editor
is already command-based — `set`, `reorder`, `insert`, `remove`, `frame`, each with
an inverse — and those map onto Photoshop `batchPlay` action descriptors. Syncing
operations rather than documents sidesteps the write problem entirely.

**2. The relay must never understand a PSD.** Everything that parses, renders or
edits a document lives in `src/`, is covered by 556 assertions, and runs identically
in a browser and in Node. The server pairs and routes. If it ever grows a second
implementation of anything in `src/`, that is the defect — two implementations of
one thing is the failure mode this project has hit repeatedly and caught by pinning
them together.

## Decisions

| Decision | Rationale |
|---|---|
| **Pure relay, nothing at rest** | Bytes stream through RAM and are never written to disk or logged. Preserves most of the app's "files never leave your machine" property, and a breach exposes no stored documents |
| Both sides must be online | The cost of the above. A closed browser tab means the send fails and is retried, rather than parking a user's artwork on our infrastructure |
| Commands travel app → Photoshop | Not files — see fact 1 |
| Adjustments and overlays do **not** sync | Our LUT model is not Photoshop's adjustment layers. There is no faithful translation, so it is disclosed rather than approximated |
| Relay is stateless per document | Session state only: which two sockets are paired, and how far a transfer has got |
| One relay implementation, no PSD logic | See fact 2 |

## Architecture

### Pairing

A plugin instance and a browser session must find each other without accounts.

- The **app** displays a short code (6 characters, unambiguous alphabet — no `0/O`,
  `1/I`), valid for 5 minutes, single use.
- The **plugin** panel takes that code and connects.
- The relay pairs them and issues both a session token for the duration.

Rate-limit pairing attempts per IP. A guessable code is the whole security model,
so it must be short-lived, single-use, and slow to brute force.

### Transport

One WebSocket per side. JSON control frames, binary data frames.

```
hello      { role: 'plugin' | 'app', version }
pair       { code }
paired     { sessionId, peer: {...} }
doc-start  { name, bytes, width, height, sha256 }
doc-chunk  <binary>
doc-end    { sha256 }
command    { type: 'set' | 'reorder' | 'insert' | 'remove' | 'frame', ... }
error      { code, message }
```

### The engineering constraint that matters

**A naive relay buffers the whole document in RAM.** A 150 MB PSD, ten concurrent
sessions, and the process is holding 1.5 GB. Node's `ws` will buffer without bound
if you write faster than the peer reads.

So the relay must **stream chunk-by-chunk with backpressure**: read a chunk, write
it, and stop reading until `bufferedAmount` drains. Peak memory per session is one
chunk, not one document. This is the same discipline `loadProjectProxy` already
applies to decoding — one layer at a time, released immediately — and for the same
reason.

Enforce a hard per-message cap and a per-session byte cap. The app's existing
`guardFileSize` refuses documents too large for the device; the relay needs its own
limit, because it protects a shared process rather than one user's tab.

### What syncs, and what cannot

| Edit | Maps to Photoshop? |
|---|---|
| move, resize, reorder, visibility, opacity, blend mode | Yes — direct `batchPlay` |
| crop / frame | Yes |
| text content, size, colour, alignment | Yes |
| insert / remove layer | Yes |
| **adjustments, HSL, filters, overlays** | **No** — our own LUT model |
| **cut-out masks** | Partially — a mask raster can be placed, the model cannot |

The unmappable set must be **stated in the UI**, not silently dropped. A sync that
quietly discards half a user's work is worse than one that refuses it.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Relay buffers whole documents, OOMs under load | High | Chunked streaming with backpressure; per-session caps; load test before shipping |
| Pairing code brute-forced onto someone's session | High | Short expiry, single use, rate limit, sufficient entropy |
| Command replay diverges from what the app shows | High | The app is the source of truth for its own render; replay is best-effort and reports what it could not apply |
| A user assumes adjustments synced | Medium | Explicit disclosure of the unmappable set |
| UXP manifest `network.domains` cannot use wildcard TLDs (7.4+) | Low | Pin the exact relay host |
| Plugin distribution requires Adobe review for public release | Medium | Developer-mode install via UDT for internal use; marketplace only if it ships publicly |

## Open questions

- Which relay host? Cloudflare is already in use for the app, and Durable Objects
  handle WebSockets natively — but the decision was Node, so a small Node service on
  Fly/Render/a VPS is assumed. Revisit only if operational cost matters.
- Does the plugin push on document change, or on an explicit button? Push-on-change
  needs debouncing; Photoshop's notification stream is noisy.
- What happens to an in-flight transfer when the browser reloads? Simplest honest
  answer is that it fails and is retried.

## Not doing

PSD **writing**, in any form. Persistent storage. Accounts. Live bidirectional
editing with conflict resolution — there is no operational-transform model on either
side, and pretending otherwise produces silent divergence.
