/**
 * Relay configuration. Every value comes from the environment with a default,
 * and there are no secrets here -- the pairing code IS the security model, and
 * it is minted per session rather than configured.
 *
 * The host default is loopback on purpose. Binding a public interface has to be
 * a deliberate act by whoever deploys this, not something a forgotten default
 * does on its behalf.
 */

import { isLoopbackHost, parseOriginList, parseIpList } from './net.js';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,

  /** Design: a pairing code is valid for five minutes and used once. */
  pairTtlMs: 5 * 60 * 1000,
  /** An idle session is not free -- it holds two sockets and a routing entry. */
  sessionTtlMs: 60 * 60 * 1000,
  /** How often expired codes and idle sessions are reaped. */
  sweepMs: 30 * 1000,

  /**
   * Per-message cap. Sized for the one large frame the rescoped protocol still
   * carries: `imaging.getPixels` for ONE layer at proxy resolution. Not for a
   * document -- documents never cross this wire.
   */
  maxMessageBytes: 8 * 1024 * 1024,
  /** Per-session cap. Protects a shared process, not one user's tab. */
  maxSessionBytes: 256 * 1024 * 1024,
  /**
   * The point at which the relay stops reading its sender. Peak memory per
   * session is this plus whatever the receiver had already parsed -- one chunk,
   * never one stream.
   *
   * This is DERIVED from `maxMessageBytes` unless it is set explicitly (see
   * `HIGH_WATER_FRACTION`). The literal below is what that derivation produces
   * for the default message cap, and is here so the shape of the config object
   * is complete before anything is resolved.
   */
  highWaterBytes: 1024 * 1024,

  /**
   * Pairing attempts per client key per window, and the window.
   *
   * This is not a politeness limit. The pairing code is the entire security
   * model, so this number is what a brute force has to get through. Sized
   * against that, with the alphabet and length from `src/sync/protocol.js`:
   *
   *   32^6                       = 1,073,741,824 codes
   *   10 attempts / 60 s         = 50 attempts inside one code's 5-minute life
   *   P(hit), one key, one code  = 50 / 1.07e9 ~= 1 in 21.5 million
   *
   * From ONE source that is about 141 years of continuous guessing to reach an
   * even chance -- 14.9 million code lifetimes at five minutes each. Getting
   * there inside a single code's life instead takes roughly **14.9 million
   * distinct client keys** guessing in parallel.
   *
   * Which is exactly why `RELAY_TRUSTED_PROXIES` matters more than this number
   * does. Raising the limit weakens it linearly; getting the KEY wrong collapses
   * it outright, in either direction -- one shared bucket for the world, or a
   * fresh bucket per forged header.
   */
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 1000,

  /**
   * The addresses whose `X-Forwarded-For` this relay believes. Empty means the
   * header is ignored completely and the immediate peer is the key.
   *
   * Nothing is inferred and nothing is assumed private: an unlisted peer's
   * header is not read at all, however plausible the address in it looks.
   */
  trustedProxies: [],

  /**
   * TLS. PATHS, never contents -- a private key does not belong in an
   * environment variable that every child process inherits. Both or neither;
   * one alone is a misconfiguration, not a half-measure.
   *
   * The design specifies `wss://`. There are exactly two honest ways to be it:
   * terminate here (set these two), or terminate at a reverse proxy in front of
   * this process and say so with `RELAY_BEHIND_PROXY`. See `assertNoSilentDowngrade`.
   */
  tlsCertPath: '',
  tlsKeyPath: '',

  /**
   * "TLS terminates upstream; this process speaks plain ws:// to the proxy on a
   * private hop." It is a claim the operator makes, deliberately, and the only
   * thing it buys is permission to bind a non-loopback interface without a cert
   * here. It must never be inferred -- inferring it is how a public plaintext
   * relay happens.
   */
  behindProxy: false,

  /**
   * Which browser origins may open a socket. Comma-separated in the
   * environment, exact match, no wildcards -- a wildcard here is how an
   * allowlist becomes decorative.
   *
   * Empty means unset, and unset admits everything. That is deliberate for a
   * loopback relay on a developer's machine, and it is why `resolveConfig`
   * refuses to start with it unset anywhere the relay is actually reachable.
   */
  allowedOrigins: [],
};

const ENV = {
  host: 'RELAY_HOST',
  port: 'RELAY_PORT',
  tlsCertPath: 'RELAY_TLS_CERT',
  tlsKeyPath: 'RELAY_TLS_KEY',
  behindProxy: 'RELAY_BEHIND_PROXY',
  allowedOrigins: 'RELAY_ALLOWED_ORIGINS',
  pairTtlMs: 'RELAY_PAIR_TTL_MS',
  sessionTtlMs: 'RELAY_SESSION_TTL_MS',
  sweepMs: 'RELAY_SWEEP_MS',
  maxMessageBytes: 'RELAY_MAX_MESSAGE_BYTES',
  maxSessionBytes: 'RELAY_MAX_SESSION_BYTES',
  highWaterBytes: 'RELAY_HIGH_WATER_BYTES',
  rateLimitMax: 'RELAY_RATE_LIMIT_MAX',
  rateLimitWindowMs: 'RELAY_RATE_LIMIT_WINDOW_MS',
  trustedProxies: 'RELAY_TRUSTED_PROXIES',
};

/**
 * The high water mark is a fraction of ONE message, not an absolute size.
 *
 * It has to be, because it is the point at which the relay stops reading. If it
 * sat above the message cap the relay would buffer more than one message before
 * pausing, and "peak memory per session is one chunk" would stop being true --
 * which is the whole reason the mark exists. An eighth leaves the pause room to
 * engage well inside the frame that trips it.
 */
const HIGH_WATER_FRACTION = 8;

/** Keys whose environment value is taken as written rather than as a number. */
const STRING_KEYS = new Set(['host', 'tlsCertPath', 'tlsKeyPath']);
const BOOL_KEYS = new Set(['behindProxy']);
/** Keys whose environment value is a comma-separated list. */
const LIST_KEYS = new Set(['allowedOrigins', 'trustedProxies']);

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function fromEnv(key, env) {
  const raw = env[ENV[key]];
  if (raw === undefined || raw === '') return undefined;
  if (STRING_KEYS.has(key)) return raw.trim();
  if (LIST_KEYS.has(key)) return raw;
  if (BOOL_KEYS.has(key)) {
    const v = raw.trim().toLowerCase();
    if (TRUE.has(v)) return true;
    if (FALSE.has(v)) return false;
    throw new Error(`${ENV[key]} must be one of 1/0/true/false/yes/no, got "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${ENV[key]} must be a non-negative number, got "${raw}"`);
  return Math.floor(n);
}

/**
 * The startup refusal.
 *
 * A relay that quietly served `ws://` on a public interface because nobody set
 * a cert is the worst outcome available here: it looks like the design, the
 * pairing code and every frame after it cross in clear, and nothing in the
 * running system says so. So the process does not start.
 *
 * Loopback is exempt because it is not reachable from anywhere else, and it is
 * the default. Making local development require a certificate would push people
 * toward turning the check off, which is how checks stop existing.
 */
function assertNoSilentDowngrade(config) {
  const hasCert = !!config.tlsCertPath;
  const hasKey = !!config.tlsKeyPath;
  if (hasCert !== hasKey) {
    throw new Error(`${ENV.tlsCertPath} and ${ENV.tlsKeyPath} must be set together -- one alone cannot serve TLS`);
  }
  if (isLoopbackHost(config.host) || hasCert || config.behindProxy) return;
  throw new Error(
    `refusing to start: ${ENV.host}="${config.host}" is not loopback and there is no TLS. `
    + `The design specifies wss://, so either set ${ENV.tlsCertPath} and ${ENV.tlsKeyPath} to terminate here, `
    + `or set ${ENV.behindProxy}=1 if TLS terminates at a reverse proxy in front of this process. `
    + 'Serving ws:// on a public interface would put the pairing code and every frame after it in clear.',
  );
}

/**
 * Can a stranger's browser reach this relay?
 *
 * True for a non-loopback bind, and equally true for a loopback bind that a
 * reverse proxy publishes to the internet -- which is the whole point of
 * `RELAY_BEHIND_PROXY`. It is not only a TLS statement; it is the operator
 * saying "this process is exposed", and every check that only matters when
 * exposed keys off it.
 */
const isReachable = (config) => !isLoopbackHost(config.host) || config.behindProxy;

/**
 * The origin allowlist may only be unset where nobody else can reach the relay.
 *
 * Unset admits every page, and an allowlist that admits every page is worse
 * than none at all: it reads, in the config and in review, as a control that
 * exists. So a reachable relay with no allowlist does not start. A developer's
 * loopback relay keeps admitting everything, because there is no browser on
 * another machine that can get to it.
 */
function assertOriginPolicy(config) {
  if (!isReachable(config) || config.allowedOrigins.length > 0) return;
  throw new Error(
    `refusing to start: this relay is reachable from outside this machine and ${ENV.allowedOrigins} is unset, `
    + 'so any web page in any tab could open a socket to it. '
    + `Set ${ENV.allowedOrigins} to the exact origins the app is served from, comma separated.`,
  );
}

/**
 * Behind a proxy, the rate limit has to have something to key on.
 *
 * Every connection then arrives from the proxy's address. Without a trusted
 * proxy list the header is (correctly) ignored, so all of them share one
 * bucket: a single attacker exhausts the budget for every real user, and the
 * limit that is supposed to be standing in front of a six-character code is
 * instead standing in front of nobody.
 *
 * That is not a configuration worth starting in, so it does not start. The fix
 * is one variable, and it is the variable that makes the whole model work.
 */
function assertRateLimitKeyIsMeaningful(config) {
  if (!config.behindProxy || config.trustedProxies.length > 0) return;
  throw new Error(
    `refusing to start: ${ENV.behindProxy} is set but ${ENV.trustedProxies} is empty, `
    + 'so every client would arrive from the proxy address and share one pairing rate-limit bucket. '
    + `Set ${ENV.trustedProxies} to the address(es) of the proxy in front of this process.`,
  );
}

/**
 * Defaults, then environment, then explicit overrides. Overrides win so tests
 * can drive a relay with small caps without touching the process environment.
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const config = { ...DEFAULTS };
  let highWaterIsExplicit = false;
  for (const key of Object.keys(ENV)) {
    const value = fromEnv(key, env);
    if (value === undefined) continue;
    config[key] = value;
    if (key === 'highWaterBytes') highWaterIsExplicit = true;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || !(key in config)) continue;
    config[key] = value;
    if (key === 'highWaterBytes') highWaterIsExplicit = true;
  }

  // Lower the message cap and the mark follows it down. Otherwise a small cap
  // leaves the mark stranded above every frame the relay will ever see, and the
  // pause never engages.
  if (!highWaterIsExplicit) {
    config.highWaterBytes = Math.max(1, Math.floor(config.maxMessageBytes / HIGH_WATER_FRACTION));
  }

  if (config.maxMessageBytes > config.maxSessionBytes) {
    throw new Error('maxMessageBytes must not exceed maxSessionBytes, or a session caps on its first frame');
  }
  if (config.highWaterBytes >= config.maxMessageBytes) {
    throw new Error('highWaterBytes must be below maxMessageBytes, or the relay buffers more than one message before it pauses');
  }
  // A list from the environment arrives as a string and from a test as an
  // array. Normalising here means every consumer sees exactly one shape.
  config.allowedOrigins = parseOriginList(config.allowedOrigins);
  config.trustedProxies = parseIpList(config.trustedProxies);

  assertNoSilentDowngrade(config);
  assertOriginPolicy(config);
  assertRateLimitKeyIsMeaningful(config);
  return config;
}
