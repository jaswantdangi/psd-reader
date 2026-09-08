# PSD Reader Sync — the Photoshop plugin

The Photoshop half of sync. The relay and the protocol were built and verified
first; this is the piece that runs inside Photoshop.

## v0.2 — rebuilt after the first attempt failed to load

The first version did not load, and the reasons were structural rather than
subtle. They are worth stating, because every one of them is a rule for UXP
plugins generally:

| What was wrong | Why it was fatal |
|---|---|
| `import` / `<script type="module">` | **UXP has no ES module support.** A panel script using `import` does not raise a useful error — it never runs, and you get an empty panel or none at all. Everything is `require()` now |
| `"host": [{...}]` — an array | Adobe's manifest v5 example is an **object**. A manifest that fails validation never reaches your code |
| `addNotificationListener([{event: 'set'}], cb)` | The documented form is a **string array** — `addNotificationListener(['all'], cb)`. The object form subscribed to nothing, so no event would ever have arrived |
| `import '../src/sync/protocol.js'` | UXP treats the folder holding `manifest.json` as the plugin root. Reaching above it may fail to load with no explanation |
| `innerHTML` | UXP's DOM is not a browser DOM. Everything is `createElement` / `textContent` now |

`test/sync.mjs` asserts all five, so none of them can come back silently.

## Debugging — read this first

The original complaint was "no proper debugging". Two answers:

**1. The panel logs to itself.** Every failure — including uncaught errors and
rejected promises — is written to the log box at the bottom of the panel. You
do not need a debugger attached to see why something failed. There is a **Copy
log** button.

**2. `Run diagnostics`** prints what the host API *actually* returns:
Photoshop and UXP versions, the document, and the real shape of
`layer.id` / `layer.name` / `layer.kind` / `layer.bounds`. Those are the values
the plugin currently has to assume. **Run it once and the assumptions become
facts** — paste the output and the remaining guesses can be corrected.

**3. UDT's own debugger**, when you want breakpoints: in UXP Developer Tool,
the `•••` menu next to the loaded plugin → **Debug** (opens Chrome DevTools) or
**Logs** (console output without the debugger).

If the panel does not appear at all, the fault is in `manifest.json` or in the
first few lines of `main.js`, before the log exists. UDT shows manifest
validation errors in its own window.

## Setup

**1. The relay is already live** at
`wss://psd-sync-relay.jaswantdangi00.workers.dev`, allowlisted in
`manifest.json`. For local development run `npx wrangler dev` and type
`ws://localhost:8787` into the panel's relay field — that host is allowlisted
too.

Exact origins only. **UXP 7.4+ rejects wildcard TLDs**, so `wss://*.example.com`
will not load at all.

**2. Load it.** UXP Developer Tool → **Add Plugin** → pick
`plugin/manifest.json` → **Load**. Then Photoshop → **Plugins** → *PSD Reader
Sync*. (Plugins appear under the Plugins menu, not Window.)

Distribution is developer-mode via UDT. The marketplace needs Adobe review.

**3. Open the same PSD in both** Photoshop and the app. Sync moves **events,
not documents**, so neither side sends the file and both must already have it.

**4. Pair.** Read the six-character code off the app, type it into the panel,
press Connect.

## `vendor/` — why the modules are duplicated

`main.js` requires `./vendor/`, not `../src/sync/`, for the plugin-root reason
above. `scripts/vendor-plugin.mjs` copies three files in **and converts them
from ESM to CommonJS**, because UXP cannot load ES modules.

They are **committed**: UDT loads this folder straight off disk and runs no npm
scripts, so "remember to build first" would be a trap. After editing
`src/sync/`:

```
npm run plugin:vendor
```

`test/sync.mjs` `require()`s the generated files for real, checks they export
exactly what `src/sync/` exports, and checks they behave identically — so a
broken transform fails in `npm test` rather than inside Photoshop.

## What is still unverified

**This has not been confirmed against a running Photoshop.** The structural
failures above are fixed and asserted by tests, but these depend on the host's
actual behaviour:

1. **`layerIdFrom(descriptor)`** — reading the layer id out of a notification's
   `_target` chain. A wrong id would apply a real change to the wrong layer, so
   it returns `null` and sends **nothing** rather than guess. When it does, it
   logs the descriptor. **Symptom of it being wrong: changes not arriving —
   never damaged artwork.**
2. **`propsFor(change, descriptor)`** — the payload shape per event. The first
   descriptor of each kind is logged once per session so these can be corrected
   from a real run.
3. **`layer.bounds` on groups and on layers with effects** — some versions
   report effect-inclusive bounds, which would not match the app's and would
   drop those layers to a looser match tier.

All three are answered by one session with `Run diagnostics` and a few edits.

## Notes

- **A code is single use and lives five minutes.** A second attempt needs a new
  one from the app.
- **Pairing attempts are rate limited** — ten wrong codes a minute per machine,
  and a global ceiling across everyone.
- **The plugin never writes to the document.** Sync is one-way by design, which
  is why there is no `executeAsModal` anywhere in it.
