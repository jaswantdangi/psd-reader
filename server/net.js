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
