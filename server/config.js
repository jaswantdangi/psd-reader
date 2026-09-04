/**
 * Relay configuration. Every value comes from the environment with a default,
 * and there are no secrets here -- the pairing code IS the security model, and
 * it is minted per session rather than configured.
 *
 * The host default is loopback on purpose. Binding a public interface has to be
 * a deliberate act by whoever deploys this, not something a forgotten default
 * does on its behalf.
 */

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
   */
  highWaterBytes: 1024 * 1024,

  /** Pairing attempts per IP per window. A guessable code is the whole model. */
  rateLimitMax: 10,
  rateLimitWindowMs: 60 * 1000,
};

const ENV = {
  host: 'RELAY_HOST',
  port: 'RELAY_PORT',
  pairTtlMs: 'RELAY_PAIR_TTL_MS',
  sessionTtlMs: 'RELAY_SESSION_TTL_MS',
  sweepMs: 'RELAY_SWEEP_MS',
  maxMessageBytes: 'RELAY_MAX_MESSAGE_BYTES',
  maxSessionBytes: 'RELAY_MAX_SESSION_BYTES',
  highWaterBytes: 'RELAY_HIGH_WATER_BYTES',
  rateLimitMax: 'RELAY_RATE_LIMIT_MAX',
  rateLimitWindowMs: 'RELAY_RATE_LIMIT_WINDOW_MS',
};

function fromEnv(key, env) {
  const raw = env[ENV[key]];
  if (raw === undefined || raw === '') return undefined;
  if (key === 'host') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${ENV[key]} must be a non-negative number, got "${raw}"`);
  return Math.floor(n);
}

/**
 * Defaults, then environment, then explicit overrides. Overrides win so tests
 * can drive a relay with small caps without touching the process environment.
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(ENV)) {
    const value = fromEnv(key, env);
    if (value !== undefined) config[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && key in config) config[key] = value;
  }
  if (config.highWaterBytes >= config.maxSessionBytes) {
    throw new Error('highWaterBytes must be below maxSessionBytes, or a session caps before it can ever pause');
  }
  return config;
}
