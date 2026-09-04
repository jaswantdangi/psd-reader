/**
 * Pairing codes and the rate limit that makes them safe.
 *
 * A code is the entire security model: whoever types it gets routed onto
 * someone's Photoshop session. So it is short-lived, single use, drawn from a
 * CSPRNG over the protocol's own alphabet, and guessing is throttled per IP.
 *
 * The alphabet and length are NOT restated here -- they come from
 * `src/sync/protocol.js`, which is also what validates an inbound `pair` frame.
 * One definition, so an issued code can never fall outside what validation
 * accepts.
 *
 * Nothing in this file is Node-specific, deliberately. It is the one piece of
 * `server/` the Cloudflare Worker also runs, so `worker/` gets the same
 * pairing policy rather than a second copy of it -- and a second copy of the
 * thing that IS the security model is the last place a divergence should be
 * allowed to hide. `globalThis.crypto` is the only ambient it touches, and it
 * is present in Node 19+ and in workerd alike.
 */
import { PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from '../src/sync/protocol.js';

/**
 * A uniformly random index into the alphabet.
 *
 * Rejection sampling rather than `byte % n`. With today's 32-character
 * alphabet the modulo would happen to be exact -- 256 is 8 x 32 -- but that is
 * a property of the alphabet, not of the code, and the day someone drops a
 * character from it the bias would appear silently in the one number that has
 * to stay uniform.
 */
function uniformIndex(n) {
  const limit = Math.floor(256 / n) * n;
  const byte = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(byte);
    if (byte[0] < limit) return byte[0] % n;
  }
}

/** ~32^6 = 1.07e9 codes; the rate limit is what makes that enough. */
function mintCode() {
  let code = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) code += PAIR_CODE_ALPHABET[uniformIndex(PAIR_CODE_ALPHABET.length)];
  return code;
}

/**
 * The desk that hands out codes and redeems them.
 *
 * @param {object} options
 * @param {number} options.ttlMs             how long an issued code lives
 * @param {number} options.rateLimitMax      redemption attempts per IP per window
 * @param {number} options.rateLimitWindowMs the window
 * @param {number} [options.globalMax]       failed attempts across ALL ips per window; 0 disables
 * @param {number} [options.globalWindowMs]  that window
 * @param {function} [options.now]           injectable clock
 */
export function createPairingDesk({
  ttlMs, rateLimitMax, rateLimitWindowMs,
  globalMax = 0, globalWindowMs = rateLimitWindowMs, now = Date.now,
}) {
  /** code -> { owner, expiresAt }. Never persisted; the process is the store. */
  const codes = new Map();
  /** ip -> { count, resetAt } */
  const attempts = new Map();
  /** The one budget every ip draws from. See `globalRateLimitMax` in config.js. */
  let global = { count: 0, resetAt: 0 };
  /** How many redemptions the global ceiling has refused, for stats(). */
  let globalRefusals = 0;

  /** Issue a code bound to the socket that will be paired INTO it. */
  function issue(owner) {
    let code = mintCode();
    while (codes.has(code)) code = mintCode();
    codes.set(code, { owner, expiresAt: now() + ttlMs });
    return code;
  }

  /**
   * Spend one attempt for `ip`.
   * @returns {boolean} false once the budget for this window is gone.
   */
  function allow(ip) {
    const at = now();
    const entry = attempts.get(ip);
    if (!entry || at >= entry.resetAt) {
      attempts.set(ip, { count: 1, resetAt: at + rateLimitWindowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= rateLimitMax;
  }

  /** Is the cross-key budget spent? Asked before the lookup, never after. */
  function globalExhausted() {
    if (!globalMax) return false;
    return now() < global.resetAt && global.count >= globalMax;
  }

  /**
   * Spend one unit of the cross-key budget. Called ONLY where an attempt that
   * passed the per-ip gate turned out to be wrong, so a successful pairing
   * costs nothing and ordinary use never draws the budget down.
   */
  function chargeGlobal() {
    if (!globalMax) return;
    const at = now();
    if (at >= global.resetAt) global = { count: 1, resetAt: at + globalWindowMs };
    else global.count += 1;
  }

  /**
   * Redeem a code. The attempt is counted BEFORE the lookup, so a lucky guess
   * on the last try is still refused -- otherwise the limit only slows down
   * being wrong, which is not the thing worth slowing down.
   *
   * A code that has already been spent comes back as `no-such-code` rather than
   * as its own reason: telling a guesser that a code once existed narrows their
   * search for free. The global ceiling answers with the SAME reason the per-ip
   * limit does, for the same purpose -- which of the two budgets is empty is
   * not something a guesser gets to measure.
   */
  function redeem(code, ip) {
    if (!allow(ip)) return { ok: false, code: 'rate-limited', message: 'too many pairing attempts' };
    if (globalExhausted()) {
      globalRefusals += 1;
      return { ok: false, code: 'rate-limited', message: 'too many pairing attempts' };
    }
    const entry = codes.get(code);
    if (!entry) {
      chargeGlobal();
      return { ok: false, code: 'no-such-code', message: 'that pairing code is not valid' };
    }
    if (now() >= entry.expiresAt) {
      codes.delete(code);
      chargeGlobal();
      return { ok: false, code: 'code-expired', message: 'that pairing code has expired' };
    }
    codes.delete(code); // single use, spent on redemption
    return { ok: true, owner: entry.owner };
  }

  /** An app that closes its tab takes its unredeemed code with it. */
  function revokeFor(owner) {
    for (const [code, entry] of codes) if (entry.owner === owner) codes.delete(code);
  }

  /** Drop expired codes and stale rate-limit windows so neither set grows. */
  function sweep() {
    const at = now();
    for (const [code, entry] of codes) if (at >= entry.expiresAt) codes.delete(code);
    for (const [ip, entry] of attempts) if (at >= entry.resetAt) attempts.delete(ip);
  }

  /**
   * The desk's whole state as plain data, and back again.
   *
   * A Durable Object can be evicted between two pairing attempts. If the codes
   * and the rate-limit buckets lived only in this closure they would come back
   * empty -- which loses an issued code (merely annoying) and RESETS AN
   * ATTACKER'S BUDGET (not annoying at all). So the Worker persists them.
   *
   * The Node relay never calls these: its process is the store, and it holds a
   * live socket in `owner`, which does not serialise. The Worker keeps a socket
   * ID there instead, which is the whole reason `owner` is opaque to this file.
   */
  const snapshot = () => ({
    codes: [...codes],
    attempts: [...attempts],
    global,
    globalRefusals,
  });

  const restore = (state) => {
    if (!state) return;
    codes.clear();
    for (const [code, entry] of state.codes ?? []) codes.set(code, entry);
    attempts.clear();
    for (const [ip, entry] of state.attempts ?? []) attempts.set(ip, entry);
    global = state.global ?? { count: 0, resetAt: 0 };
    globalRefusals = state.globalRefusals ?? 0;
  };

  return {
    issue, redeem, revokeFor, sweep, allow, snapshot, restore,
    size: () => codes.size,
    /** Counts only: how much of the cross-key budget is spent, and refusals so far. */
    globalSpent: () => (now() < global.resetAt ? global.count : 0),
    globalRefusals: () => globalRefusals,
  };
}
