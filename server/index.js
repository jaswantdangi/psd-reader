/**
 * Relay entrypoint.
 *
 * Everything comes from the environment with a loopback default -- see
 * `config.js`. Binding a public interface is a deliberate act, not a default.
 *
 * # The two supported deployments
 *
 * The design specifies `wss://`. There are exactly two honest ways to be it,
 * and the process refuses to start in any third shape.
 *
 *   1. TERMINATE HERE.
 *        RELAY_HOST=0.0.0.0
 *        RELAY_TLS_CERT=/etc/ssl/relay/fullchain.pem
 *        RELAY_TLS_KEY=/etc/ssl/relay/privkey.pem
 *      `listen()` reports `wss://`. Paths, never contents -- a private key does
 *      not belong in an environment variable. Rotate by replacing the files and
 *      restarting; nothing here watches them.
 *
 *   2. TERMINATE UPSTREAM (nginx, Caddy, a cloud load balancer). This is the
 *      common one, and it is the one that needs care, because the relay is then
 *      speaking plain `ws://` and everything it can see about a client is
 *      whatever the proxy chose to tell it.
 *        RELAY_HOST=127.0.0.1              # bind the private hop, not the world
 *        RELAY_BEHIND_PROXY=1              # only needed if HOST is not loopback
 *        RELAY_TRUSTED_PROXIES=127.0.0.1   # who may set X-Forwarded-For
 *        RELAY_ALLOWED_ORIGINS=https://psd-editor.pages.dev
 *      The proxy must pass the upgrade through (`proxy_set_header Upgrade`,
 *      `Connection upgrade`), forward `Origin` unmodified, and append the real
 *      client to `X-Forwarded-For`. If it does not append, the rate limit --
 *      which is the whole thing standing between a six-character pairing code
 *      and a brute force -- degrades to one shared bucket for the internet.
 *
 * There is no third mode. A non-loopback bind with neither a certificate nor an
 * explicit `RELAY_BEHIND_PROXY=1` throws before a socket exists, because the
 * alternative is a public plaintext relay that looks exactly like a working one.
 */
import { createRelay } from './relay.js';

const relay = createRelay();
const url = await relay.listen();
console.log(`relay listening on ${url}`);

const stop = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
