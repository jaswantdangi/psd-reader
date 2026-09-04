/**
 * Copies the shared sync modules into `plugin/vendor/`.
 *
 *   node scripts/vendor-plugin.mjs
 *
 * WHY THIS EXISTS. `plugin/main.js` needs the protocol and the Photoshop-side
 * decisions, and those live in `src/sync/`. It cannot simply import
 * `../src/sync/protocol.js`: UXP treats the folder holding `manifest.json` as
 * the plugin root, and reaching above it is not something a loaded plugin can
 * rely on. The failure mode is the worst kind, too -- the panel does not load
 * at all, with no obvious reason.
 *
 * WHY THE COPIES ARE COMMITTED. The alternative is gitignoring them and
 * running this script first, which makes the plugin silently broken on a fresh
 * clone until someone remembers. UDT loads the folder straight off disk and
 * runs no npm scripts, so "remember to build first" is a trap, not a workflow.
 * They are committed, and `test/sync.mjs` fails if they drift from `src/`.
 *
 * So there is still exactly ONE source of truth. These are build output that
 * happens to be checked in, and the test is what keeps that honest.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The three files, and nothing else. `photoshop.js` imports `./protocol.js`
 * and `protocol.js` imports `./identity.js`, so the relative imports keep
 * working unchanged once all three sit in the same directory.
 */
const MODULES = ['protocol.js', 'identity.js', 'photoshop.js'];

const from = path.join(process.cwd(), 'src', 'sync');
const to = path.join(process.cwd(), 'plugin', 'vendor');

const BANNER = (name) => `// GENERATED — do not edit.
// Copied from src/sync/${name} by scripts/vendor-plugin.mjs.
// Edit the original; test/sync.mjs fails if these two ever drift apart.

`;

fs.mkdirSync(to, { recursive: true });

let changed = 0;
for (const name of MODULES) {
  const source = fs.readFileSync(path.join(from, name), 'utf8');
  const target = path.join(to, name);
  const next = BANNER(name) + source;
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

  if (current === next) {
    console.log(`  ${name} … unchanged`);
    continue;
  }
  fs.writeFileSync(target, next);
  console.log(`  ${name} … written`);
  changed++;
}

console.log(`\n${changed} updated, ${MODULES.length - changed} already current`);
