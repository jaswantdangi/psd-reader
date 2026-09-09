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

/** `RELAY_TRUSTED_PROXIES=10.0.0.1, 10.0.0.2` -> a normalized list. */
export function parseIpList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  return raw.map(normalizeIp).filter(Boolean);
}

/**
 * The key the pairing rate limit counts against.
 *
 * The pairing code is the entire security model, so this key is the whole of
 * what stands between a six-character code and a brute force. There are two
 * ways to get it wrong and they fail in opposite directions:
 *
 * - Key on `remoteAddress` behind a proxy and EVERY client shares one bucket.
 *   One attacker spends the budget for the entire internet, and the limit stops
 *   protecting the thing it exists to protect while still looking like it does.
 * - Trust `X-Forwarded-For` unconditionally and a client picks its own key by
 *   inventing a header. That is strictly worse than never reading it: the limit
 *   is no longer merely coarse, it is bypassable by anyone who can type. A
 *   fresh key per request means an unlimited number of first attempts.
 *
 * So the header is read ONLY when the immediate peer is on the configured
 * trusted-proxy list, and even then the client is the RIGHTMOST entry that is
 * not itself a trusted proxy. A proxy APPENDS what it observed, so anything a
 * spoofing client invented sits to the LEFT of the address the first trusted
 * proxy actually saw. Walking from the right steps over the invented entries;
 * taking the leftmost -- the common shortcut -- would read exactly the part the
 * attacker controls.
 */
export function clientKeyFor(req, trustedProxies) {
  const remote = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (!trustedProxies.length || !trustedProxies.includes(remote)) return remote;

  const chain = String(req.headers?.['x-forwarded-for'] ?? '').split(',').map(normalizeIp).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!trustedProxies.includes(chain[i])) return chain[i];
  }
  // A trusted peer that forwarded nothing, or a chain of nothing but trusted
  // proxies. The proxy itself is the most specific honest answer available.
  return remote;
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
 *
 * The same reasoning, followed one step further, is why a NON-WEB origin is
 * admitted too. A page in a tab always presents `http://` or `https://` (or
 * the literal `null`, which is what a sandboxed or `file://` document sends).
 * Anything else -- `plugin://…`, a bare product string, whatever a host
 * application invents -- is by definition not a page in a tab, so refusing it
 * excludes no browser and only locks out native clients.
 *
 * That was not a hypothetical: the UXP plugin could not connect at all,
 * because it is not a web page and the allowlist was being applied to it as
 * though it were.
 */
const isBrowserOrigin = (normalized) => /^https?:\/\//.test(normalized) || normalized === 'null';

export function originAllowed(origin, allowedOrigins) {
  if (origin === undefined || origin === null) return true;
  if (!allowedOrigins.length) return true;
  const normalized = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalized)) return true;
  // Empty string behaves as absent: some clients send the header with no value.
  if (!normalized) return true;
  return !isBrowserOrigin(normalized);
}
