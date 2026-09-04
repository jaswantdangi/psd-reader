/**
 * Relay entrypoint.
 *
 * Everything comes from the environment with a loopback default -- see
 * `config.js`. Binding a public interface is a deliberate act, not a default.
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
