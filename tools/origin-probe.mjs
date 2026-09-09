/**
 * What does the deployed relay do for each Origin a UXP plugin might send?
 *
 *   node tools/origin-probe.mjs
 *
 * A UXP plugin is not a web page. It has no document origin, so whatever it
 * puts in the `Origin` header -- or omits -- decides whether the relay's
 * allowlist lets it in. The allowlist exists to stop arbitrary web pages
 * opening sockets; it was never meant to stop the plugin.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const RELAY = process.env.RELAY_URL ?? 'wss://psd-sync-relay.jaswantdangi00.workers.dev';

const CASES = [
  ['no Origin header at all', undefined],
  ['Origin: null (the string)', 'null'],
  ['Origin: the app', 'https://psd-editor.pages.dev'],
  ['Origin: a plugin-ish value', 'plugin://com.psdreader.sync'],
  ['Origin: a file URL', 'file://'],
  ['Origin: something else', 'https://evil.test'],
];

console.log(`\nOrigin probe · ${RELAY}\n`);

for (const [label, origin] of CASES) {
  const headers = origin === undefined ? {} : { Origin: origin };
  const ws = new WebSocket(RELAY, { headers });

  const outcome = await new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); try { ws.close(); } catch { /* already */ } resolve(v); };
    const t = setTimeout(() => done('timeout'), 8000);
    ws.on('open', () => done('OPEN — accepted'));
    ws.on('unexpected-response', (_, res) => done(`refused, HTTP ${res.statusCode}`));
    ws.on('error', (e) => done(`error: ${e.message}`));
  });

  console.log(`  ${label.padEnd(30)} -> ${outcome}`);
}

console.log('');
process.exit(0);
