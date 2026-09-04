# PSD Reader Sync — the Photoshop plugin

The Photoshop half of sync. The relay (`server/`) and the protocol
(`src/sync/`) were built and tested first; this is the piece that had never
existed.

## Status: written, never run

**No part of this has been executed inside Photoshop.** It is written against
the UXP and Photoshop DOM documentation. Do not read "the tests pass" as "the
plugin works" — the tests cover `src/sync/photoshop.js`, which is every
decision this plugin makes *except* the ones that need a host.

The seams most likely to be wrong are marked `VERIFY:` in `main.js`. In rough
order of how likely they are to bite:

1. **`layerIdFrom(descriptor)`** — reading the layer id out of a notification's
   `_target` reference chain. A wrong id here is the exact failure the identity
   model exists to prevent: a real change applied to the wrong layer. The code
   sends nothing rather than guess, so the visible symptom of getting this
   wrong is silence, not corruption.
2. **`propsFor(change, descriptor)`** — the descriptor shape per event. Every
   branch is from documentation; none has been observed.
3. **`action.addNotificationListener`** — the array-plus-one-handler form is
   Photoshop 24+. Older builds took one event per call.
4. **`layer.bounds` on groups and on layers with effects** — some versions
   report effect-inclusive bounds. Those would not match the app's bounds, and
   the layer would drop to a looser match tier or fail to match at all.
5. **`import` beside `require`** — repo modules come in as ES modules, host
   modules through `require`. If the panel fails to load at all, start here.

## What it does

1. Takes the 6-character code the app displays, and pairs through the relay.
2. Enumerates the layer tree — `layerID`, name, kind, bounds, group path — and
   sends it once, as a `tree` frame. The app runs `matchLayers` against its own
   file and pins the result for the session.
3. Subscribes to Photoshop notifications, translates each through
   `changeForNotification`, coalesces bursts, and forwards the mappable ones.
4. **Shows the ones it cannot send.** Brush strokes, filters, adjustments, mask
   painting and layer effects have no operation that represents them. The panel
   counts them per kind rather than hiding them, because a sync that silently
   discards half someone's work is worse than one that says it did.

## Setup

### 1. The relay must be running

```
node server/index.js
```

Binds `127.0.0.1:8787` by default. See `server/config.js` for TLS and
deployment; nothing here needs any of it for local development.

### 2. The relay's address must be in `manifest.json`

```json
"requiredPermissions": { "network": { "domains": ["ws://localhost:8787"] } }
```

Exact origins only. **UXP 7.4+ rejects wildcard TLDs**, so `wss://*.example.com`
will not load — list the host you actually deploy. Changing this needs a plugin
reload, not just a panel refresh.

### 3. Load it

Adobe UXP Developer Tool → *Add Plugin* → pick `plugin/manifest.json` → *Load*.
Then Photoshop → Plugins → PSD Reader Sync.

Distribution is developer-mode via UDT. The marketplace needs Adobe review, and
nothing here is ready for that.

### 4. Pair

Open the same PSD in both Photoshop and the app — sync moves **events, not
documents**, so neither side sends the file and both must already have it. Read
the code off the app, type it into the panel, press Connect.

## Notes

- **A code is single use and lives five minutes.** A second attempt needs a new
  one from the app.
- **Pairing attempts are rate limited**, per IP and across all of them. Ten
  wrong codes a minute from one machine is the per-IP budget; see
  `globalRateLimitMax` in `server/config.js` for the other.
- **Plain CSS, not Tailwind.** UXP renders with its own engine over a subset of
  CSS and cannot fetch a stylesheet from a CDN — `network.domains` is an
  allowlist for the relay, and widening it to a CDN to style a four-control
  panel would be the wrong trade.
- **The plugin never writes to the document.** Sync is one-way by design, which
  is why there is no `executeAsModal` anywhere in it.
