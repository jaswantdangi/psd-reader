/**
 * TLS material, and the only filesystem access anywhere in `server/`.
 *
 * # Why this file is allowed to touch `node:fs` when nothing else is
 *
 * "Nothing at rest" is a rule about what this process WRITES: no user frame,
 * no document, no payload is ever put somewhere it could be recovered from
 * later. Reading a certificate and a private key at startup, by path, from the
 * environment, is configuration -- the same act as reading `RELAY_PORT`, using
 * the only API Node offers for it. Node has no way to hand `https` a
 * certificate that does not begin with a file read.
 *
 * So the concession is kept as small as it can be made and then pinned by
 * test: exactly one file in `server/` may import `fs`, it may import exactly
 * `readFileSync`, and no write API appears anywhere in the directory. That is a
 * narrower guarantee than the blanket ban it replaces, not a looser one -- the
 * blanket ban could not tell a read from a write, and this can.
 *
 * The key never reaches a log, a frame, or `stats()`. It goes from here into
 * the TLS context and nowhere else.
 */
import { readFileSync } from 'node:fs';

/**
 * @returns {{cert: Buffer, key: Buffer} | null} null when no TLS is configured,
 *   which `resolveConfig` has already established is only legal on loopback or
 *   behind an acknowledged terminating proxy.
 * @throws if a configured path cannot be read -- refusing to start is the point.
 *   A relay that fell back to plaintext because a cert was missing would be the
 *   silent downgrade this whole path exists to prevent.
 */
export function loadTlsMaterial(config) {
  if (!config.tlsCertPath || !config.tlsKeyPath) return null;
  return {
    cert: readFileSync(config.tlsCertPath),
    key: readFileSync(config.tlsKeyPath),
  };
}
