/**
 * Relay configuration. Every value comes from the environment with a default,
 * and there are no secrets here -- the pairing code IS the security model, and
 * it is minted per session rather than configured.
 *
 * The host default is loopback on purpose. Binding a public interface has to be
 * a deliberate act by whoever deploys this, not something a forgotten default
 * does on its behalf.
 */

import { isLoopbackHost } from './net.js';

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

  /** Pairing attempts per IP per window. A guessable code is the whole model. */
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 1000,

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
};

const ENV = {
  host: 'RELAY_HOST',
  port: 'RELAY_PORT',
  tlsCertPath: 'RELAY_TLS_CERT',
  tlsKeyPath: 'RELAY_TLS_KEY',
  behindProxy: 'RELAY_BEHIND_PROXY',
  pairTtlMs: 'RELAY_PAIR_TTL_MS',
  sessionTtlMs: 'RELAY_SESSION_TTL_MS',
  sweepMs: 'RELAY_SWEEP_MS',
  maxMessageBytes: 'RELAY_MAX_MESSAGE_BYTES',
  maxSessionBytes: 'RELAY_MAX_SESSION_BYTES',
  highWaterBytes: 'RELAY_HIGH_WATER_BYTES',
  rateLimitMax: 'RELAY_RATE_LIMIT_MAX',
  rateLimitWindowMs: 'RELAY_RATE_LIMIT_WINDOW_MS',
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

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function fromEnv(key, env) {
  const raw = env[ENV[key]];
  if (raw === undefined || raw === '') return undefined;
  if (STRING_KEYS.has(key)) return raw.trim();
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
  assertNoSilentDowngrade(config);
  return config;
}
