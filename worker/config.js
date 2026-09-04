/**
 * Relay configuration on Cloudflare Workers.
 *
 * `server/config.js` is not reusable here, and the reason is worth stating
 * rather than working around: almost every check in it is about BINDING A
 * SOCKET. "Is this host loopback", "is there a certificate", "is a proxy
 * declared" — a Worker binds nothing, and Cloudflare terminates TLS before
 * any of this code runs. Porting those checks verbatim would produce a file
 * full of conditions that can never be false, which reads as a safety layer
 * and is not one.
 *
 * So the rules are re-expressed for a runtime where the answer to "can a
 * stranger reach this?" is ALWAYS YES:
 *
 *   Node                                        Workers
 *   ------------------------------------------  --------------------------------
 *   origin allowlist required IF reachable      required, ALWAYS
 *   refuse plaintext on a public bind           Cloudflare terminates TLS; moot
 *   trusted-proxy list to key the rate limit    CF-Connecting-IP, unspoofable
 *   /stats open to loopback, else token         token ONLY -- no loopback exists
 *
 * The rate-limit key is the one that gets BETTER. On Node the whole
 * `X-Forwarded-For` / trusted-proxy dance exists because a header a client can
 * write must not be allowed to move its own bucket. Cloudflare sets
 * `CF-Connecting-IP` at the edge and a client cannot forge it, so the key is
 * simply correct, and `RELAY_TRUSTED_PROXIES` has nothing to do here.
 */

import { parseOriginList } from '../server/net.js';

/** Same shape and the same defaults as `server/config.js`, minus what cannot apply. */
export const WORKER_DEFAULTS = {
  pairTtlMs: 5 * 60 * 1000,
  sessionTtlMs: 60 * 60 * 1000,
  sweepMs: 30 * 1000,
  maxMessageBytes: 8 * 1024 * 1024,
  maxSessionBytes: 256 * 1024 * 1024,
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 1000,
  globalRateLimitMax: 10_000,
  globalRateLimitWindowMs: 60 * 1000,
};

/** Full budget refills in this many seconds. Mirrors `SESSION_REFILL_SECONDS`. */
const SESSION_REFILL_SECONDS = 256;

const num = (raw, fallback) => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`expected a non-negative number, got "${raw}"`);
  return Math.floor(n);
};

export function resolveWorkerConfig(env = {}) {
  const config = {
    ...WORKER_DEFAULTS,
    pairTtlMs: num(env.RELAY_PAIR_TTL_MS, WORKER_DEFAULTS.pairTtlMs),
    sessionTtlMs: num(env.RELAY_SESSION_TTL_MS, WORKER_DEFAULTS.sessionTtlMs),
    sweepMs: num(env.RELAY_SWEEP_MS, WORKER_DEFAULTS.sweepMs),
    maxMessageBytes: num(env.RELAY_MAX_MESSAGE_BYTES, WORKER_DEFAULTS.maxMessageBytes),
    maxSessionBytes: num(env.RELAY_MAX_SESSION_BYTES, WORKER_DEFAULTS.maxSessionBytes),
    rateLimitMax: num(env.RELAY_RATE_LIMIT_MAX, WORKER_DEFAULTS.rateLimitMax),
    rateLimitWindowMs: num(env.RELAY_RATE_LIMIT_WINDOW_MS, WORKER_DEFAULTS.rateLimitWindowMs),
    globalRateLimitMax: num(env.RELAY_GLOBAL_RATE_LIMIT_MAX, WORKER_DEFAULTS.globalRateLimitMax),
    globalRateLimitWindowMs: num(env.RELAY_GLOBAL_RATE_LIMIT_WINDOW_MS, WORKER_DEFAULTS.globalRateLimitWindowMs),
    allowedOrigins: parseOriginList(env.RELAY_ALLOWED_ORIGINS ?? ''),
    statsToken: String(env.RELAY_STATS_TOKEN ?? '').trim(),
  };

  config.sessionByteRefillBytesPerSec = num(
    env.RELAY_SESSION_BYTE_REFILL,
    Math.max(1, Math.floor(config.maxSessionBytes / SESSION_REFILL_SECONDS)),
  );

  // On Node this refusal is conditional on the bind being reachable. Here there
  // is no unreachable bind to be the exception, so it is unconditional -- an
  // allowlist that admits every page is worse than none, because it reads in
  // review as a control that exists.
  if (!config.allowedOrigins.length) {
    throw new Error(
      'refusing to start: RELAY_ALLOWED_ORIGINS is unset. A Worker is reachable from every '
      + 'browser on the internet, so any page in any tab could open a socket to it. Set it to '
      + 'the exact origins the app is served from, comma separated.',
    );
  }
  if (config.maxMessageBytes > config.maxSessionBytes) {
    throw new Error('maxMessageBytes must not exceed maxSessionBytes, or a session caps on its first frame');
  }
  return config;
}
