/**
 * The browser loads ag-psd through demo/shims/ag-psd.js, which must list every
 * symbol by name because ESM exports are static. Nothing in Node exercises that
 * file, so a missing name only shows up as a blank page in the browser.
 *
 * This checks the shim against both sides: what src/ imports, and what the
 * bundle actually provides.
 */
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let failures = 0;
const fail = (msg) => { console.error('  FAIL  ' + msg); failures++; };

// --- what the UMD bundle really exports (what the browser will have) ---------
const bundle = require('../node_modules/ag-psd/dist/bundle.js');
const bundleExports = new Set(Object.keys(bundle));

// --- what the shim re-exports ------------------------------------------------
const shimSource = fs.readFileSync(new URL('../demo/shims/ag-psd.js', import.meta.url), 'utf8');
const shimExports = new Set([...shimSource.matchAll(/^export const (\w+)/gm)].map((m) => m[1]));

// --- what src/ imports from 'ag-psd' ----------------------------------------
const srcDir = new URL('../src/', import.meta.url);
const imported = new Map(); // name -> file

// Walk subdirectories too. This used to read src/ one level deep, which meant
// anything added under src/<subdir>/ escaped the guard entirely — a new file
// there could import an ag-psd symbol the shim does not re-export, and the
// demo pages would blank with every test still green.
function collectSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) collectSources(new URL(`${entry.name}/`, dir), out);
    else if (entry.name.endsWith('.js')) out.push(new URL(entry.name, dir));
  }
  return out;
}

for (const url of collectSources(srcDir)) {
  const text = fs.readFileSync(url, 'utf8');
  const label = decodeURIComponent(url.href.slice(srcDir.href.length));
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]ag-psd['"]/g))
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) imported.set(name, label);
    }
}

console.log(`\nag-psd bundle exports : ${bundleExports.size}`);
console.log(`shim re-exports       : ${shimExports.size}`);
console.log(`src/ imports          : ${imported.size}  (${[...imported.keys()].join(', ')})\n`);

for (const [name, file] of imported) {
  if (!shimExports.has(name))
    fail(`src/${file} imports "${name}" from ag-psd, but demo/shims/ag-psd.js does not export it — the browser will throw.`);
  if (!bundleExports.has(name))
    fail(`src/${file} imports "${name}", which the ag-psd UMD bundle does not provide.`);
}

for (const name of shimExports)
  if (!bundleExports.has(name))
    fail(`shim exports "${name}" but the bundle has no such symbol — it would be undefined at runtime.`);

// --- load the shim for real, the way the browser will -----------------------
globalThis.agPsd = bundle;
try {
  const loaded = await import('../demo/shims/ag-psd.js');
  for (const name of imported.keys())
    if (typeof loaded[name] === 'undefined') fail(`shim loaded, but "${name}" came back undefined.`);
  console.log('  shim loads and resolves every imported symbol');
} catch (e) {
  fail('shim failed to load: ' + e.message);
}

console.log(failures ? `\n${failures} problem(s)\n` : '\nshim OK\n');
process.exit(failures ? 1 : 0);
