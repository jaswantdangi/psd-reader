/**
 * Does the deployed relay accept a WebSocket that requests a subprotocol?
 *
 *   node tools/subprotocol-probe.mjs
 *
 * If a client asks for a subprotocol and the server does not confirm it, the
 * client MUST fail the connection -- and it fails exactly the way every UXP
 * report of this describes: `onerror` immediately, empty error, no status.
 *
 * Adobe's own WebSocket example passes one (`new WebSocket(url, "wss")`), so a
 * plugin arriving with one is not hypothetical. This proves the relay handles
 * both shapes.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const RELAY = process.env.RELAY_URL ?? 'wss://psd-sync-relay.jaswantdangi00.workers.dev';

const CASES = [
  ['no subprotocol', undefined],
  ['subprotocol "wss"', 'wss'],
  ['subprotocol "json"', 'json'],
  ['two, first wins', ['alpha', 'beta']],
];

console.log(`\nSubprotocol probe · ${RELAY}\n`);
let failed = 0;

for (const [label, protocols] of CASES) {
  const ws = protocols === undefined ? new WebSocket(RELAY) : new WebSocket(RELAY, protocols);

  const outcome = await new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); try { ws.close(); } catch { /* already */ } resolve(v); };
    const t = setTimeout(() => done('TIMEOUT'), 8000);
    ws.on('open', () => done(`OPEN (server chose ${JSON.stringify(ws.protocol || '')})`));
    ws.on('unexpected-response', (_, res) => done(`refused, HTTP ${res.statusCode}`));
    ws.on('error', (e) => done(`ERROR: ${e.message}`));
  });

  if (!outcome.startsWith('OPEN')) failed++;
  console.log(`  ${label.padEnd(22)} -> ${outcome}`);
}

console.log(`\n${failed ? `${failed} FAILED` : 'all shapes accepted'}\n`);
process.exit(failed ? 1 : 0);
