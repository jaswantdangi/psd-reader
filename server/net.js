/**
 * The small, pure decisions the relay makes about a socket before it is a
 * session. Today: is this bind reachable from outside this machine.
 *
 * They live here rather than in `relay.js` because each one is a security
 * boundary that is easier to get wrong than to write, and because none of them
 * touch a socket -- they take strings and return strings, so a test can pin the
 * decision itself rather than a consequence of it two layers later.
 */

/**
 * `::ffff:127.0.0.1` and `127.0.0.1` are the same peer. A dual-stack listener
 * reports the first form, an IPv4 one the second, and a trusted-proxy list that
 * only matches one of them silently trusts nobody.
 */
export function normalizeIp(value) {
  const ip = String(value ?? '').trim().toLowerCase();
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip.startsWith('[') && ip.endsWith(']')) return ip.slice(1, -1);
  return ip;
}

/**
 * Is this bind address reachable only from this machine?
 *
 * Deliberately a small allowlist rather than a blocklist. `0.0.0.0`, `::` and
 * an unset host all reach the outside world, and every one of them has to come
 * out of here as "public" -- a wrong answer in that direction is the one that
 * puts a plaintext relay on the internet.
 */
export function isLoopbackHost(host) {
  const h = normalizeIp(host);
  if (h === 'localhost' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** `RELAY_ALLOWED_ORIGINS=https://a.example, https://b.example` -> a list. */
export function parseOriginList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  return raw.map(normalizeOrigin).filter(Boolean);
}

/** Origins compare case-insensitively, and carry no path or trailing slash. */
function normalizeOrigin(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Is this browser page allowed to open a socket?
 *
 * An empty list means UNSET, and unset admits everything. That is only safe
 * because `config.js` refuses to start with an unset list in every reachable
 * configuration -- so "unset" can only ever mean a loopback relay a developer
 * is running on their own machine, where requiring an allowlist would be a
 * ceremony people learn to switch off.
 *
 * A request with NO `Origin` header is admitted. Only browsers send one, and a
 * browser cannot lie about it; anything else -- the UXP plugin, a script, an
 * attacker with curl -- can simply omit it, so refusing on absence would lock
 * out the plugin while stopping nobody. This control exists to stop a WEB PAGE
 * from reaching the relay using someone's browser. Everything that is not a
 * browser still meets the pairing code and its rate limit, which is where that
 * threat is answered.
 */
export function originAllowed(origin, allowedOrigins) {
  if (origin === undefined || origin === null) return true;
  if (!allowedOrigins.length) return true;
  return allowedOrigins.includes(normalizeOrigin(origin));
}
