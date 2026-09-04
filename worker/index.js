/**
 * Worker entrypoint. Everything real happens in the Durable Object.
 *
 * This file exists to answer one question — WHICH object — and the answer is
 * always the same one. A pairing code has to be findable by whoever types it,
 * and they arrive on a different connection from the person who was given it,
 * so the code table cannot be sharded by connection. One named instance is
 * that single point of truth.
 *
 * See `hub.js` for why that is acceptable and what to do when it stops being.
 */

import { RelayHub } from './hub.js';

export { RelayHub };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // A cheap liveness probe that does not wake the Durable Object. Useful for
    // an uptime check that should not itself keep the object resident.
    if (url.pathname === '/health') {
      return new Response('ok\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    const id = env.RELAY_HUB.idFromName('relay');
    return env.RELAY_HUB.get(id).fetch(request);
  },
};
