# Photoshop Sync — UXP Plugin and Node Relay

**Date**: 2026-09-03
**Status**: Design approved (relay model), not yet planned or built

---

> **Rescoped 2026-09-03.** No document handover. Both sides open the same file
> independently and only **events** cross the wire, so the 150 MB transfer, the
> chunking, the backpressure and the storage question below are all moot — the
> relay is a small JSON router. Direction is **Photoshop → app only**, and
> **Photoshop is authoritative**: when its event contradicts an unsynced app edit,
> Photoshop wins. That removes conflict resolution entirely and means no
> `batchPlay` replay, which was where the adjustment-mapping wall stood.
>
> Two things this does not remove, and they are now the whole problem:
>
> **Layer identity.** An event says "layer 7 moved". Both sides must agree which
> layer that is, and today they cannot — see *The identity handshake* below.
>
> **Pixel changes have no command.** Moving, reordering, opacity, blend mode,
> visibility, rename, retype and crop all map to existing commands and cost a few
> hundred bytes. A brush stroke, a filter, or an adjustment layer does not — there
> is no command that represents it. Mirroring those needs the layer's pixels via the
> `imaging` API, at proxy resolution, per layer. That is a second mechanism, and the
> plugin must know which kind of change it saw.

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

## The identity handshake — build this first

An event says *"layer 7 moved to x=40"*. Applying it requires both sides to agree
which layer 7 is, and **they do not**:

- The app has `id` (an app-local counter) and `sourceIndex` (position among the
  file's **leaf** nodes).
- Photoshop has a stable per-session `layerID`, and enumerates **groups as layers**.

The backlog already records why index matching is unsafe: `reader.js` streams every
leaf while `flatten()` additionally drops leaves with neither pixels nor text, so
positional matching *"would silently misalign every layer after the first skipped
one"*. Groups widen the same gap.

A misaligned event does not error. It applies the right change to the **wrong
layer**, which reads as the app corrupting the user's document.

So identity is reconciled **once, at pairing**, and pinned for the session:

1. Plugin enumerates Photoshop's tree with `layerID`, name, bounds, kind, group path.
2. App sends its layers with `sourceIndex`, name, bounds, kind, `groupPath`.
3. Match on the **signature** — bounds plus kind plus name plus group path — never
   on index alone.
4. Anything not matched confidently is **reported and excluded**, not guessed. An
   unmatched layer simply does not sync; a wrongly matched one damages the document.

`toLayer` already carries `groupPath` and `sourceIndex`, so the app side of this
exists.

## What a Photoshop change costs to mirror

| Change in Photoshop | Mechanism | Size |
|---|---|---|
| move, transform, reorder, visibility, opacity, blend mode, rename | existing command | bytes |
| text content / size / colour / alignment | `set { text }` | bytes |
| crop, canvas size | `frame` | bytes |
| **brush, filter, adjustment layer, mask paint** | `imaging.getPixels` for that layer | MB, per layer |
| layer added | command **plus** pixels | MB |

The pixel path is bounded by one layer at proxy resolution — not the document — but
it is a genuinely different mechanism and needs its own debounce. Photoshop's
notification stream fires continuously during a brush stroke; pushing pixels per
event would saturate the socket.

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
