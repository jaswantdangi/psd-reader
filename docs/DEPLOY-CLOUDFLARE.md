# Deploying on Cloudflare

Two of the four artifacts run on Cloudflare. The other two belong to Google and
Adobe, and no amount of Cloudflare configuration changes that.

| Artifact | Where | Command |
|---|---|---|
| **Web app** | Cloudflare Pages | `cd app && npm run pages:deploy` |
| **Sync relay** | Workers + Durable Objects | `npx wrangler deploy` (repo root) |
| **Android app** | Play Console | not Cloudflare |
| **UXP plugin** | Adobe UDT / Marketplace | not Cloudflare |

The editor itself is **entirely client-side** — no backend, no database, no
auth, no user data at rest. The relay stores nothing and holds no secret except
an optional stats token. That removes a whole category of deployment work, and
it is why Pages alone is enough for the app.

---

## 1. The relay (Workers + Durable Objects)

### Prerequisites

- A Cloudflare account and `npx wrangler login`.
- Nothing else. There is deliberately **no `nodejs_compat` flag**: the whole
  import graph is pure ESM with zero Node built-ins. `server/pairing.js` was
  changed from `node:crypto.randomInt` to `crypto.getRandomValues` precisely so
  the pairing policy — which *is* the security model — has one implementation
  rather than one per runtime.

### Configure

Edit `wrangler.toml`:

```toml
[vars]
RELAY_ALLOWED_ORIGINS = "https://your-app.pages.dev"
```

**This is required and the Worker refuses to start without it.** On Node that
refusal is conditional on the bind being reachable; a Worker has no unreachable
bind to be the exception, so it is unconditional. Exact origins, comma
separated, no wildcards.

Then the one secret, which must never go in `wrangler.toml`:

```
npx wrangler secret put RELAY_STATS_TOKEN
```

Without it `GET /stats` is unreachable, which is the correct default. There is
no loopback exemption here the way there is on Node, because nothing calling a
Worker is provably on the same machine.

### Deploy and verify

```
npx wrangler dev        # local workerd — DO THIS FIRST, see below
npx wrangler deploy
curl https://<worker>.workers.dev/health
curl -H "Authorization: Bearer $TOKEN" https://<worker>.workers.dev/stats
```

`/health` deliberately does **not** wake the Durable Object, so an uptime check
does not keep it resident.

### What you are trading away

**Backpressure.** `server/relay.js` stops reading its sender when the
destination's `bufferedAmount` passes a high-water mark — measured at 5 of 400
frames read against a stalled peer, peak buffered 0.5 MB against a 1.1 MB
bound. **The Workers WebSocket API exposes no `bufferedAmount` and no way to
pause a reader.** There is no equivalent and `worker/hub.js` does not pretend
to have one; `/stats` omits the backpressure fields entirely rather than
reporting zeroes, because a zero would read as "never under pressure" instead
of "not measured".

What stands in its place is the decaying byte budget: a sender may burst up to
`RELAY_MAX_SESSION_BYTES` and then sustains only
`RELAY_SESSION_BYTE_REFILL` bytes a second. That bounds throughput, which is
most of what backpressure protected, but not the runtime's own send queue.

Two smaller differences, both deliberate:

- **The byte cap is per direction, not per session.** There is no shared session
  object that survives hibernation without a storage write per frame. Events
  only travel one way, so for the path carrying any volume the two are the same
  number.
- **The rate-limit key gets *better*.** Cloudflare sets `CF-Connecting-IP` at
  the edge and a client cannot forge it, so none of Node's
  `X-Forwarded-For`/trusted-proxy machinery is needed. `RELAY_TRUSTED_PROXIES`
  has nothing to do here and is not read.

### Not verified

**No part of `worker/` has run on workerd.** `test/worker.mjs` (33 assertions)
drives the Durable Object's message handling with fake sockets and fake
storage. That covers the *policy* — who may send what, when, to whom, and what
is refused — and nothing about whether Cloudflare accepts the `WebSocketPair`,
whether attachments survive a real hibernation, or whether the alarm fires.
`npx wrangler dev` is the only thing that answers those. Run it before
believing any of this.

---

## 2. The web app (Pages)

```
cd app && npm run pages:deploy
```

`app/public/_headers` and `app/public/_redirects` are already configured: SPA
fallback to `index.html` at status 200, content-hashed JS/CSS cached
immutably, `index.html` never cached — caching it leaves browsers requesting
chunk names a later deploy has removed, which surfaces as a random white
screen.

### Point it at the relay

`app/src/index.html` carries:

```html
<meta name="psd-relay" content="ws://localhost:8787">
```

Read at **runtime**, not baked in at build time, so one artifact serves local
development, a Pages preview and production, and the Android wrapper needs no
build of its own to point elsewhere. For a deployment, change it to
`wss://<worker>.workers.dev` — either in the source before building, or with a
Pages build step that rewrites the published `index.html`.

Pointing it at a relay that has not been told about this origin fails closed:
the Worker refuses any origin outside `RELAY_ALLOWED_ORIGINS`.

### One thing to re-check

`_headers` deliberately sets no `Cross-Origin-Opener-Policy` /
`Embedder-Policy`, on the stated grounds that the app does not use
`SharedArrayBuffer` — its workers pass data by transfer. **That comment predates
the background-removal work**, which pulls in `@huggingface/transformers`. If
that library ends up using threaded WASM it will need cross-origin isolation,
and the header decision has to be revisited. Verify before relying on it.

---

## 3. What Cloudflare cannot do

**The Android app** goes to Play Console. Release signing is not configured yet
— no keystore properties, no `signingConfigs` — so no installable release build
exists today. Two device-specific traps are known and untested: the tab bar
under the Android gesture bar, and the stretched splash.

Note one connection: the app opens `wss://` to the relay **from Android**. A CA
missing from an older Android system trust store produces a `status: 0` /
`ERR_CONNECTION_REFUSED` failure that works in Chrome on the same device and
fails in the WebView. Cloudflare's edge certificates chain to widely trusted
roots, which avoids this — but verify on an Android 12 device rather than
assuming.

**The UXP plugin** goes to Adobe. `plugin/manifest.json` currently allowlists
`ws://localhost:8787` only; it needs the real Worker host, **exact** — UXP 7.4+
rejects wildcard TLDs. Marketplace distribution needs a packaged `.ccx` and
Adobe review; UDT developer mode works now for internal use.

---

## Order

1. `npx wrangler dev` and pair against it locally. This is the first time any of
   `worker/` will have executed.
2. `npx wrangler deploy`, then `/health` and `/stats`.
3. Set `RELAY_ALLOWED_ORIGINS` to the Pages domain; set `<meta name="psd-relay">`
   to the Worker; deploy Pages.
4. Point `plugin/manifest.json` at the Worker and load it in UDT.
5. Android signing, then a phone build.

Steps 1–5 all need a real Cloudflare account and, from 4 onward, Photoshop.
