/**
 * What does the plugin actually get told when the app side goes away?
 *
 *   node tools/peer-gone-probe.mjs
 *
 * Runs against the DEPLOYED relay, twice: once where the app closes cleanly
 * (a tab being closed), and once where it simply vanishes (a network drop or
 * a killed process). The plugin's `peer-gone` message used to be one fixed
 * sentence for both, which is why "connects, then stops with a peer error"
 * could not be diagnosed from the plugin's log. It should now say which side
 * left, and how.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const RELAY = process.env.RELAY_URL ?? 'wss://psd-sync-relay.jaswantdangi00.workers.dev';
const ORIGIN = 'https://psd-editor.pages.dev';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(RELAY, { headers: { Origin: ORIGIN } });
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.on('error', () => {});
  return {
    ws, frames,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
  };
}

async function scenario(label, leave) {
  const app = client();
  await app.open();
  app.send({ type: 'hello', role: 'app', version: '1.0.0' });
  await sleep(1200);
  const code = app.frames.find((f) => f.type === 'pair')?.code;
  if (!code) return { label, ok: false, message: 'app was never issued a code' };

  const plugin = client();
  await plugin.open();
  plugin.send({ type: 'hello', role: 'plugin', version: '0.2.0' });
  plugin.send({ type: 'pair', code });
  await sleep(1500);
  if (!plugin.frames.some((f) => f.type === 'paired')) return { label, ok: false, message: 'never paired' };

  leave(app.ws);
  await sleep(2500);

  const gone = plugin.frames.find((f) => f.code === 'peer-gone');
  try { plugin.ws.close(); } catch { /* already */ }
  return {
    label,
    ok: !!gone && /\bthe app\b/.test(gone.message),
    message: gone ? gone.message : '(no peer-gone received at all)',
  };
}

console.log(`\npeer-gone probe · ${RELAY}\n`);

const results = [
  await scenario('app closes cleanly (1001)', (ws) => ws.close(1001, 'going away')),
  await scenario('app vanishes, no close frame', (ws) => ws.terminate()),
];

for (const r of results) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.label}`);
  console.log(`       plugin was told: ${r.message}\n`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} FAILED\n` : 'the plugin is told which side left, and how\n');
setTimeout(() => process.exit(failed ? 1 : 0), 300);
