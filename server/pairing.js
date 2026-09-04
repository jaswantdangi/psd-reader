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
 */
import { randomInt } from 'node:crypto';
import { PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from '../src/sync/protocol.js';

/** ~32^6 = 1.07e9 codes; the rate limit is what makes that enough. */
function mintCode() {
  let code = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) code += PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)];
  return code;
}

/**
 * The desk that hands out codes and redeems them.
 *
 * @param {object} options
 * @param {number} options.ttlMs             how long an issued code lives
 * @param {number} options.rateLimitMax      redemption attempts per IP per window
 * @param {number} options.rateLimitWindowMs the window
 * @param {function} [options.now]           injectable clock
 */
export function createPairingDesk({ ttlMs, rateLimitMax, rateLimitWindowMs, now = Date.now }) {
  /** code -> { owner, expiresAt }. Never persisted; the process is the store. */
  const codes = new Map();
  /** ip -> { count, resetAt } */
  const attempts = new Map();

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

  /**
   * Redeem a code. The attempt is counted BEFORE the lookup, so a lucky guess
   * on the last try is still refused -- otherwise the limit only slows down
   * being wrong, which is not the thing worth slowing down.
   *
   * A code that has already been spent comes back as `no-such-code` rather than
   * as its own reason: telling a guesser that a code once existed narrows their
   * search for free.
   */
  function redeem(code, ip) {
    if (!allow(ip)) return { ok: false, code: 'rate-limited', message: 'too many pairing attempts' };
    const entry = codes.get(code);
    if (!entry) return { ok: false, code: 'no-such-code', message: 'that pairing code is not valid' };
    if (now() >= entry.expiresAt) {
      codes.delete(code);
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

  return { issue, redeem, revokeFor, sweep, allow, size: () => codes.size };
}
