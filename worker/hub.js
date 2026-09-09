/**
 * The relay as a Durable Object.
 *
 * Same protocol, same pairing policy, different transport. `server/relay.js`
 * stays the Node deployment; this is the Cloudflare one, and the two share the
 * things that must never diverge — `src/sync/protocol.js` for the wire and
 * `server/pairing.js` for the codes and the rate limits, which ARE the
 * security model.
 *
 * # Why one Durable Object
 *
 * A pairing code must be findable by whoever types it, and the person typing
 * it arrives on a different connection from the person who was given it. That
 * makes the code table a single point of truth. One DO instance is that point.
 * It is also the scaling limit: every session in the deployment runs through
 * one object. That is fine for the volume this feature has (two sockets per
 * user, events measured in hundreds of bytes) and it is the first thing to
 * revisit if it ever is not — by routing on a code prefix to a DO per shard.
 *
 * # Hibernation, and why state is where it is
 *
 * The DO is evicted between bursts. Three kinds of state, three homes:
 *
 *   - CODES AND RATE LIMITS -> `ctx.storage`. If these lived in memory an
 *     eviction would lose an issued code, which is annoying, and RESET AN
 *     ATTACKER'S BUDGET, which is not. `snapshot()`/`restore()` on the desk
 *     exist for exactly this.
 *   - SESSION MEMBERSHIP -> the socket's own attachment. `ctx.getWebSockets()`
 *     survives hibernation, so the sockets themselves carry who they are and
 *     the session rebuilds from them with no bookkeeping to go stale.
 *   - BYTE BUDGET -> the sending socket's attachment. See the note on
 *     `spend()` for how this differs from the Node relay, and why.
 *
 * # What is LOST relative to `server/relay.js`
 *
 * **Backpressure.** The Node relay stops reading its sender when the
 * destination's `bufferedAmount` passes a high-water mark — measured at 5 of
 * 400 frames read against a stalled peer, peak buffered 0.5 MB. The Workers
 * WebSocket API exposes no `bufferedAmount` and no way to pause a reader, so
 * there is no equivalent and this file does not pretend to have one.
 *
 * What stands in its place is the DECAYING BYTE BUDGET: a sender may burst up
 * to `maxSessionBytes` and then sustains only `sessionByteRefillBytesPerSec`.
 * That bounds throughput, which is most of what backpressure was protecting,
 * but it does NOT bound the runtime's own send queue. A peer that stops
 * reading entirely is Cloudflare's problem here rather than ours.
 */

import { parseMessage, errorFrame } from '../src/sync/protocol.js';
import { createPairingDesk } from '../server/pairing.js';
import { originAllowed } from '../server/net.js';
import { resolveWorkerConfig } from './config.js';

const GOING_AWAY = 1001;
const POLICY = 1008;

/** Storage keys. Two, so an eviction cannot half-restore. */
const DESK_KEY = 'desk';

export class RelayHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.config = resolveWorkerConfig(env);
    this.desk = null;
    this.originRefusals = 0;
    this.nextId = 1;
  }

  // ----------------------------------------------------------------- desk

  /**
   * The pairing desk, rehydrated from storage on first touch after a wake.
   *
   * `owner` in the desk is a socket ID here, not a socket. That is the whole
   * reason `server/pairing.js` treats it as opaque: the Node relay puts a live
   * connection there, and a live connection does not survive an eviction.
   */
  async deskNow() {
    if (this.desk) return this.desk;
    this.desk = createPairingDesk({
      ttlMs: this.config.pairTtlMs,
      rateLimitMax: this.config.rateLimitMax,
      rateLimitWindowMs: this.config.rateLimitWindowMs,
      globalMax: this.config.globalRateLimitMax,
      globalWindowMs: this.config.globalRateLimitWindowMs,
    });
    this.desk.restore(await this.ctx.storage.get(DESK_KEY));
    return this.desk;
  }

  async persistDesk() {
    if (this.desk) await this.ctx.storage.put(DESK_KEY, this.desk.snapshot());
  }

  // -------------------------------------------------------------- sockets

  /** Everything known about one socket. Lives on the socket, not in a map. */
  static state(ws) {
    try { return ws.deserializeAttachment() ?? {}; } catch { return {}; }
  }

  static setState(ws, next) {
    ws.serializeAttachment(next);
    return next;
  }

  /** The other socket in this session, or null. */
  peerOf(ws, sessionId) {
    if (!sessionId) return null;
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      if (RelayHub.state(other).sessionId === sessionId) return other;
    }
    return null;
  }

  send(ws, frame) {
    try { ws.send(JSON.stringify(frame)); } catch { /* already closing */ }
  }

  refuse(ws, code, message) {
    this.send(ws, errorFrame(code, message));
  }

  // ---------------------------------------------------------------- fetch

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/stats') return this.statsResponse(request);
    if (url.pathname === '/whoami') return this.whoami(request);
    if (request.headers.get('Upgrade') !== 'websocket') return this.notWebSocket();

    // Checked BEFORE a socket exists, exactly as the Node relay does it: an
    // origin that is not allowed never reaches pairing, so it never gets to
    // spend an attempt against the rate limit either.
    const origin = request.headers.get('Origin');
    if (!originAllowed(origin, this.config.allowedOrigins)) {
      this.originRefusals += 1;
      return new Response('origin not allowed', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable. The alternative keeps this object resident for the life of
    // every session, which for a relay is most of the day.
    this.ctx.acceptWebSocket(server);
    RelayHub.setState(server, {
      id: `s${this.nextId++}`,
      // Cloudflare sets this at the edge and a client cannot forge it, so the
      // rate-limit key needs none of the trusted-proxy machinery Node needs.
      key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      role: null,
      version: null,
      sessionId: null,
      bytes: 0,
      budget: 0,
      budgetAt: Date.now(),
      openedAt: Date.now(),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  notWebSocket() {
    return new Response('this endpoint speaks WebSocket only\n', {
      status: 426,
      headers: { 'content-type': 'text/plain' },
    });
  }

  /**
   * What origin did the relay actually receive, and would it be admitted?
   *
   * This exists because a rejected WebSocket upgrade tells the client NOTHING.
   * The handshake fails with a bare `error` event and no status, no body and
   * no reason, so a plugin that cannot connect has no way to learn whether it
   * was the address, the network, or the origin allowlist -- which is exactly
   * the position the UXP plugin was in.
   *
   * No token guards it, deliberately: it reflects the caller's own origin back
   * at them and says yes or no. A caller already knows its own origin, and the
   * allowlist itself is the app's public URL. There is nothing here to leak.
   */
  whoami(request) {
    const origin = request.headers.get('Origin');
    return new Response(`${JSON.stringify({
      origin: origin === null ? null : origin,
      sentOriginHeader: origin !== null,
      allowed: originAllowed(origin === null ? undefined : origin, this.config.allowedOrigins),
      hint: origin === null
        ? 'no Origin header was sent, which is always admitted'
        : 'a browser page origin must be in RELAY_ALLOWED_ORIGINS; anything else is admitted',
    })}\n`, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  // -------------------------------------------------------------- frames

  async webSocketMessage(ws, raw) {
    // A binary frame is refused before anything tries to read it: under the
    // rescope the wire is JSON only.
    if (typeof raw !== 'string') return this.refuse(ws, 'binary-refused', 'the relay routes JSON frames only');

    if (raw.length > this.config.maxMessageBytes) {
      // Length in UTF-16 units is an under-estimate of bytes, never an over-
      // estimate, so this can only refuse things that are genuinely too big.
      this.refuse(ws, 'message-too-large', `frames are capped at ${this.config.maxMessageBytes} bytes`);
      return;
    }

    const parsed = parseMessage(raw);
    if (!parsed.ok) return this.refuse(ws, parsed.error.code, parsed.error.message);

    const frame = parsed.message;
    const state = RelayHub.state(ws);

    switch (frame.type) {
      case 'hello': return this.onHello(ws, state, frame);
      case 'pair': return this.onPair(ws, state, frame);
      case 'tree':
      case 'event': return this.onUpstream(ws, state, frame);
      case 'error': return this.onErrorFrame(ws, state, frame);
      default:
        return this.refuse(ws, 'unexpected-frame', `a client does not send "${frame.type}"`);
    }
  }

  async onHello(ws, state, frame) {
    if (state.role) return this.refuse(ws, 'already-hello', 'this socket has already said hello');
    RelayHub.setState(ws, { ...state, role: frame.role, version: frame.version });

    if (frame.role !== 'app') return;
    const desk = await this.deskNow();
    const code = desk.issue(state.id);
    await this.persistDesk();
    // Sweep expired codes on a timer, so an unredeemed one does not sit in
    // storage until the object next happens to be woken for another reason.
    await this.ctx.storage.setAlarm(Date.now() + this.config.sweepMs);
    this.send(ws, { type: 'pair', code });
  }

  async onPair(ws, state, frame) {
    if (!state.role) {
      this.refuse(ws, 'expected-hello', 'send hello before pair');
      ws.close(POLICY, 'expected-hello');
      return;
    }
    if (state.sessionId) return this.refuse(ws, 'already-paired', 'this socket is already in a session');

    const desk = await this.deskNow();
    const result = desk.redeem(frame.code, state.key);
    await this.persistDesk();
    if (!result.ok) return this.refuse(ws, result.code, result.message);

    // The desk hands back the socket ID it was given at `issue`. Resolving it
    // to a live socket is this layer's job, and it can legitimately fail: the
    // app may have closed the tab while the code was still valid.
    const owner = this.ctx.getWebSockets().find((s) => RelayHub.state(s).id === result.owner);
    if (!owner || RelayHub.state(owner).sessionId) {
      return this.refuse(ws, 'no-such-code', 'that pairing code is not valid');
    }

    const sessionId = crypto.randomUUID();
    const ownerState = RelayHub.state(owner);
    RelayHub.setState(owner, { ...ownerState, sessionId });
    RelayHub.setState(ws, { ...RelayHub.state(ws), sessionId });

    this.send(owner, { type: 'paired', sessionId, peer: { role: state.role, version: state.version } });
    this.send(ws, { type: 'paired', sessionId, peer: { role: ownerState.role, version: ownerState.version } });
  }

  /** `tree` and `event`: Photoshop -> app only, and both spend the byte budget. */
  onUpstream(ws, state, frame) {
    if (!state.sessionId) {
      return this.refuse(ws, 'not-paired', frame.type === 'tree'
        ? 'pair before sending the layer tree'
        : 'pair before sending events');
    }
    if (state.role !== 'plugin') {
      return this.refuse(ws, 'wrong-direction', frame.type === 'tree'
        ? 'the layer tree travels Photoshop -> app only'
        : 'events travel Photoshop -> app only');
    }
    this.route(ws, state, frame);
  }

  /** `error` travels both ways: the app has to be able to say what it could not apply. */
  onErrorFrame(ws, state, frame) {
    if (!state.sessionId) return this.refuse(ws, 'not-paired', 'pair before reporting errors');
    this.route(ws, state, frame);
  }

  route(ws, state, frame) {
    const peer = this.peerOf(ws, state.sessionId);
    if (!peer) {
      this.send(ws, errorFrame('peer-gone', 'the paired peer is no longer connected'));
      ws.close(GOING_AWAY, 'peer-gone');
      return;
    }

    // The frame written is the one validateMessage REBUILT, not the object
    // that arrived, so fields a sender invented never reach the other side.
    const text = JSON.stringify(frame);
    if (!this.spend(ws, state, text.length)) return;
    try { peer.send(text); } catch { /* the close handler will tear it down */ }
  }

  /**
   * Charge a frame against the sender's byte budget.
   *
   * DIFFERENT FROM THE NODE RELAY, on purpose. There the budget belongs to the
   * session, held on a shared object. Here there is no shared object that
   * survives hibernation without a storage write per frame, so the budget
   * lives on the SENDING socket and the cap is per direction rather than per
   * session. Events only ever travel one way, so for the path that carries any
   * volume the two are the same number; what an app can additionally spend is
   * bounded separately by its own budget.
   */
  spend(ws, state, bytes) {
    const now = Date.now();
    const elapsed = Math.max(0, now - (state.budgetAt ?? now));
    const drained = Math.max(0, (state.budget ?? 0) - (elapsed / 1000) * this.config.sessionByteRefillBytesPerSec);

    if (drained + bytes > this.config.maxSessionBytes) {
      this.endSession(ws, state, 'session-cap', `session byte cap of ${this.config.maxSessionBytes} reached`);
      return false;
    }

    RelayHub.setState(ws, {
      ...state,
      budget: drained + bytes,
      budgetAt: now,
      bytes: (state.bytes ?? 0) + bytes,
    });
    return true;
  }

  endSession(ws, state, code, message) {
    const peer = this.peerOf(ws, state.sessionId);
    this.send(ws, errorFrame(code, message));
    if (peer) {
      this.send(peer, errorFrame(code, message));
      try { peer.close(POLICY, code); } catch { /* already gone */ }
    }
    try { ws.close(POLICY, code); } catch { /* already gone */ }
  }

  // ------------------------------------------------------------ lifecycle

  async webSocketClose(ws) {
    const state = RelayHub.state(ws);

    // An app that closes its tab takes its unredeemed code with it. Without
    // this the code stays valid for its full five minutes against a socket
    // that no longer exists.
    if (state.id) {
      const desk = await this.deskNow();
      desk.revokeFor(state.id);
      await this.persistDesk();
    }

    const peer = this.peerOf(ws, state.sessionId);
    if (peer) {
      this.send(peer, errorFrame('peer-gone', 'the paired peer is no longer connected'));
      try { peer.close(GOING_AWAY, 'peer-gone'); } catch { /* already gone */ }
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  /** Drop expired codes and stale rate-limit windows, then re-arm if anything is left. */
  async alarm() {
    const desk = await this.deskNow();
    desk.sweep();
    await this.persistDesk();
    if (desk.size() > 0) await this.ctx.storage.setAlarm(Date.now() + this.config.sweepMs);
  }

  // ---------------------------------------------------------------- stats

  /**
   * Token only.
   *
   * The Node relay lets a loopback peer read this without one, because a
   * loopback peer is provably on the same machine. Nothing on a Worker is, so
   * that exemption does not carry over — and a refused read gets byte-for-byte
   * what any other path gets, so the route does not announce itself.
   */
  async statsResponse(request) {
    const header = request.headers.get('Authorization') ?? '';
    if (!this.config.statsToken || !header.startsWith('Bearer ')) return this.notWebSocket();
    if (!timingSafeEqualStrings(header.slice(7), this.config.statsToken)) return this.notWebSocket();

    const desk = await this.deskNow();
    const sockets = this.ctx.getWebSockets().map((s) => RelayHub.state(s));
    const sessions = new Map();
    for (const s of sockets) {
      if (!s.sessionId) continue;
      const entry = sessions.get(s.sessionId) ?? { id: s.sessionId, bytes: 0, budgetBytes: 0, peers: 0 };
      entry.bytes += s.bytes ?? 0;
      entry.budgetBytes += Math.round(s.budget ?? 0);
      entry.peers += 1;
      sessions.set(s.sessionId, entry);
    }

    return new Response(`${JSON.stringify({
      runtime: 'workers',
      connections: sockets.length,
      pendingCodes: desk.size(),
      originRefusals: this.originRefusals,
      globalPairSpent: desk.globalSpent(),
      globalPairRefusals: desk.globalRefusals(),
      // No `pauses`, `peakBufferedBytes` or `senderPaused`: this runtime has no
      // bufferedAmount, so there is no backpressure to report. Reporting zeroes
      // would read as "never under pressure" rather than "not measured".
      sessions: [...sessions.values()],
    })}\n`, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
}

/**
 * Constant-time within a length class.
 *
 * `crypto.subtle.timingSafeEqual` is a Workers extension and is not in Node,
 * so this falls back to a constant-time XOR fold rather than importing
 * `node:crypto` and pulling a Node built-in into a Worker bundle.
 */
export function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
