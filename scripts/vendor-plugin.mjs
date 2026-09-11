/**
 * Copies the shared sync modules into `plugin/vendor/`, AS COMMONJS.
 *
 *   node scripts/vendor-plugin.mjs
 *
 * # Why a transform and not a copy
 *
 * **UXP does not support ES modules.** There is no `<script type="module">`
 * and no `import`; the runtime is CommonJS, and everything comes in through
 * `require()`. A panel whose script uses `import` does not throw a useful
 * error -- it simply never runs, and the panel appears empty or not at all.
 * That is the single most likely reason a UXP plugin "does not load".
 *
 * `src/` is ESM, because everything else in this repo is. So the vendoring
 * step converts. The conversion is deliberately tiny and total, not clever:
 *
 *   import { a, b } from './x.js';   ->  const { a, b } = require('./x.js');
 *   export const NAME = ...          ->  const NAME = ...
 *   export function NAME(...)        ->  function NAME(...)
 *                                    +   module.exports = { NAME, ... }
 *
 * Those are the only three forms `src/sync/` uses, and `assertOnlyKnownForms`
 * below refuses to write anything if a fourth ever appears -- because a
 * silently half-converted module is far worse than a failed build step.
 *
 * # Why the output is committed
 *
 * UDT loads the plugin folder straight off disk and runs no npm scripts, so
 * "remember to build first" would be a trap rather than a workflow. The copies
 * are committed and `test/sync.mjs` fails if they drift.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * `photoshop.js` requires `./protocol.js`, which requires `./identity.js`, so
 * the relative specifiers keep resolving once all three sit together.
 */
const MODULES = ['protocol.js', 'identity.js', 'photoshop.js', 'font-file.js'];

const from = path.join(process.cwd(), 'src', 'sync');
const to = path.join(process.cwd(), 'plugin', 'vendor');

/**
 * Refuse anything this transform does not understand.
 *
 * `export default`, `export {}`, `export *` and bare `import x from` all mean
 * the output would be wrong in a way nothing downstream would notice until
 * Photoshop failed to load the panel. Better to fail here, loudly.
 */
function assertOnlyKnownForms(name, source) {
  const bad = [
    [/^export default/m, 'export default'],
    [/^export\s*\{/m, 'export { ... }'],
    [/^export\s*\*/m, 'export *'],
    [/^import\s+[A-Za-z_$]/m, 'default import'],
    [/^import\s+['"]/m, 'side-effect import'],
  ];
  for (const [pattern, what] of bad) {
    if (pattern.test(source)) {
      throw new Error(
        `src/sync/${name} uses ${what}, which scripts/vendor-plugin.mjs cannot convert to CommonJS.\n`
        + 'Either rewrite it as a named const/function export, or extend the transform — but do not\n'
        + 'leave it half-converted: UXP fails silently on a module it cannot load.',
      );
    }
  }
}

function toCommonJs(name, source) {
  assertOnlyKnownForms(name, source);

  const exported = [];
  const body = source
    .replace(/^import\s*\{([^}]+)\}\s*from\s*'([^']+)';$/gm, (_, names, spec) => `const {${names}} = require('${spec}');`)
    .replace(/^export\s+const\s+([A-Za-z_$][\w$]*)/gm, (_, id) => { exported.push(id); return `const ${id}`; })
    .replace(/^export\s+function\s+([A-Za-z_$][\w$]*)/gm, (_, id) => { exported.push(id); return `function ${id}`; });

  if (!exported.length) throw new Error(`src/sync/${name} produced no exports — the transform is wrong`);

  return `// GENERATED — do not edit.
// Converted from src/sync/${name} to CommonJS by scripts/vendor-plugin.mjs,
// because UXP has no ES module support. Edit the original; test/sync.mjs
// fails if these drift apart.

${body}
module.exports = { ${[...new Set(exported)].join(', ')} };
`;
}

fs.mkdirSync(to, { recursive: true });

/**
 * `{"type": "commonjs"}`, scoped to this folder.
 *
 * The repo root declares `"type": "module"`, so without this Node would read
 * `plugin/vendor/*.js` as ESM and their `require()` calls would resolve
 * against the process CWD instead of the file. UXP does not care either way --
 * its `require` is its own -- but Node caring is the point: it is what lets
 * `test/sync.mjs` actually `require()` these and prove they load, rather than
 * trusting that a regex produced valid CommonJS.
 */
const scope = path.join(to, 'package.json');
const scopeJson = `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`;
if (!fs.existsSync(scope) || fs.readFileSync(scope, 'utf8') !== scopeJson) {
  fs.writeFileSync(scope, scopeJson);
  console.log('  package.json … written (declares this folder CommonJS)');
}

let changed = 0;
for (const name of MODULES) {
  const source = fs.readFileSync(path.join(from, name), 'utf8');
  const target = path.join(to, name);
  const next = toCommonJs(name, source);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

  if (current === next) { console.log(`  ${name} … unchanged`); continue; }
  fs.writeFileSync(target, next);
  console.log(`  ${name} … written (${next.match(/^module\.exports/m) ? 'CommonJS' : '??'})`);
  changed++;
}

console.log(`\n${changed} updated, ${MODULES.length - changed} already current`);
