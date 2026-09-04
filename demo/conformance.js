/**
 * The GPU conformance route.
 *
 * WHY THIS PAGE IS THE DELIVERABLE, and not the test suite. Node has no WebGL,
 * so `npm test` can prove the renderer issues the right COMMANDS and nothing
 * about the pixels those commands produce. Every claim of parity between the
 * GPU and JS tiers is made here, on a real device, against
 * `renderProject` — the same oracle the 21-fixture accuracy table uses.
 *
 * Serve the repo (`npm run serve`) and open
 *
 *     http://localhost:5173/demo/conformance.html
 *
 * A GOOD RESULT is the tier badge reading TIER 1 or TIER 2, and every row of
 * Tables A, C and D reading PASS with real % 0.00 — except
 * `steep-transformed`, which is expected to WARN or FAIL and says why in its
 * own row. A row that is green while the badge says TIER 3 means nothing at
 * all: the page then rendered JS against itself, and says so in the note.
 *
 * Nothing is imported from `src/index.js`: that barrel pulls in the PSD reader
 * and ag-psd, which this page never touches.
 */
import { renderProject } from '/src/render.js';
import { createBuffer } from '/src/composite.js';
import { createProject } from '/src/edit.js';
import {
  CONFORMANCE_SIZE, CONFORMANCE_MODES, CONFORMANCE_ADJUSTMENTS, CONFORMANCE_CLIPS,
  conformanceProject, conformanceAdjustProject, conformanceClipProject, conformancePattern,
  compareRenders, verdictFor, conformanceNoteFor,
} from '/src/conformance.js';
import { selectTier, tierOverrideFrom, CONTEXT_ATTRIBUTES, TIER_JS } from '/src/gpu/detect.js';
import { probeShaders } from '/src/gpu/probe.js';
import { buildDrawPlan } from '/src/gpu/plan.js';
import { createGpuRenderer } from '/src/gpu/renderer.js';

const $ = (id) => document.getElementById(id);
const text = (el, value) => { el.textContent = value; };
/** Hand the frame back so the progress line actually paints between rows. */
const breathe = () => new Promise((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------------------------ context

const canvas = document.createElement('canvas');
let gl = null;
try { gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES); } catch { gl = null; }

const caps = {
  offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  transferControl: typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
  webgl2: !!gl,
  maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0,
  probe: null,
  override: tierOverrideFrom(location.search),
};

// The probe runs on THIS context, the one the renderer will use. Probing a
// throwaway would answer a question about a different context, and browsers cap
// contexts per page and evict the oldest.
if (gl) caps.probe = probeShaders(gl);

const { tier, verdict } = selectTier(caps);
const useGpu = tier !== TIER_JS && !!gl;
const renderer = useGpu ? createGpuRenderer(gl) : null;

// A lost context mid-run must stop the run, not silently start comparing a
// stale buffer against itself.
let contextLost = false;
canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); contextLost = true; });

// ------------------------------------------------------------------ header

{
  const badge = $('tier-badge');
  badge.textContent = `Tier ${tier}`;
  badge.className = 'rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide ' +
    (useGpu ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800');
  text($('tier-verdict'), verdict);
  text($('tier-note'), conformanceNoteFor(tier, verdict));

  const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const facts = [
    ['WebGL2', gl ? 'yes' : 'no'],
    ['GPU', debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : '—')],
    ['MAX_TEXTURE_SIZE', caps.maxTextureSize || '—'],
    ['OffscreenCanvas', caps.offscreenCanvas ? (caps.transferControl ? 'yes, transferable' : 'yes, not transferable') : 'no'],
    ['Probe', caps.probe ? (caps.probe.ok ? `passed (max Δ ${caps.probe.maxDelta})` : caps.probe.reason) : 'not run'],
    ['Device pixel ratio', window.devicePixelRatio],
  ];
  $('device').innerHTML = facts.map(([k, v]) =>
    `<div><dt class="text-slate-500">${k}</dt><dd class="mt-0.5 break-words font-medium text-slate-800">${v}</dd></div>`
  ).join('');
}

// ------------------------------------------------------------------ compare

/**
 * Render one project on both tiers and compare.
 *
 * The JS render is ALWAYS run, including on the JS tier — where the second
 * render is JS as well, and the row is a regression baseline rather than a
 * comparison. The note above the tables says so in those words; a page that
 * quietly compared a buffer against itself and printed PASS would be worse than
 * one that printed nothing.
 */
function compareOne(project, planOptions = {}) {
  const js = renderProject(project);
  if (!useGpu || contextLost) return { stat: compareRenders(js, renderProject(project)), note: null };

  const plan = buildDrawPlan(project, {
    maxTextureSize: caps.maxTextureSize,
    ...planOptions,
  });
  if (!plan.ok) return { stat: null, note: `refused: ${plan.reason}` };

  const out = renderer.render(plan);
  if (!out.ok) return { stat: null, note: out.reason };

  const gpu = createBuffer(plan.width, plan.height);
  if (!renderer.readInto(gpu)) return { stat: null, note: 'rendered, but could not be read back' };

  return { stat: compareRenders(js, gpu), note: null };
}

// ------------------------------------------------------------------- tables

const TABLES = [
  {
    id: 'A', title: 'Table A — the 26 blend modes',
    blurb: 'Two full-canvas layers. Red sweeps every one of the 65 536 (backdrop, source) byte pairs ' +
      'exactly once, across eight alpha bands including 0 and 255.',
    rows: () => CONFORMANCE_MODES.map((mode) => ({
      id: mode, label: mode, build: (size) => conformanceProject(mode, size),
    })),
  },
  {
    id: 'C', title: 'Table C — clip runs',
    blurb: 'The path no two-layer document touches: a second ping-pong pair, an R8 alpha reduction, ' +
      'the plane bound per member, and the base’s opacity and mode spent once at the end.',
    rows: () => CONFORMANCE_CLIPS.map((entry) => ({
      id: entry.id, label: entry.label, build: (size) => conformanceClipProject(entry, size),
    })),
  },
  {
    id: 'D', title: 'Table D — the adjustment matrix',
    blurb: '`neutral` must be BIT-IDENTICAL to no adjustment. `steep-transformed` is EXPECTED to ' +
      'diverge: a steep LUT is a step function, and LINEAR sampling on mobile carries ~8 subtexel ' +
      'bits, so the pass amplifies a filter divergence that is measured and accepted, not a bug.',
    rows: () => CONFORMANCE_ADJUSTMENTS.map((entry) => ({
      id: entry.id, label: entry.label, build: (size) => conformanceAdjustProject(entry, size),
      expected: entry.id === 'steep-transformed' ? 'divergence expected — see the blurb' : null,
    })),
  },
];

const BADGE = {
  PASS: 'bg-emerald-100 text-emerald-800',
  WARN: 'bg-amber-100 text-amber-800',
  FAIL: 'bg-rose-100 text-rose-800',
  '—': 'bg-slate-200 text-slate-600',
};

const num = (v, digits = 2) => (typeof v === 'number' ? v.toFixed(digits) : '—');

function renderTableShell(table) {
  const section = document.createElement('section');
  section.className = 'rounded-lg border border-slate-200 bg-white';
  section.innerHTML = `
    <div class="border-b border-slate-100 px-4 py-3">
      <h2 class="text-sm font-semibold">${table.title}</h2>
      <p class="mt-1 text-xs leading-relaxed text-slate-500">${table.blurb}</p>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full min-w-[42rem] text-left text-xs">
        <thead class="border-b border-slate-100 text-slate-500">
          <tr>
            <th scope="col" class="px-4 py-2 font-medium">Case</th>
            <th scope="col" class="px-3 py-2 font-medium">Verdict</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">any %</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">real %</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">max Δ</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">mean Δ</th>
          </tr>
        </thead>
        <tbody id="rows-${table.id}" class="divide-y divide-slate-50"></tbody>
      </table>
    </div>`;
  return section;
}

function paintRow(body, row, result) {
  const verdict = result.stat ? verdictFor(result.stat) : '—';
  const stat = result.stat || {};
  const tr = document.createElement('tr');
  tr.className = verdict === 'FAIL' ? 'bg-rose-50/40' : '';
  tr.innerHTML = `
    <th scope="row" class="px-4 py-2 font-normal text-slate-800">
      ${row.label}
      ${row.expected ? `<span class="mt-0.5 block text-[11px] text-slate-500">${row.expected}</span>` : ''}
      ${result.note ? `<span class="mt-0.5 block text-[11px] text-rose-700">${result.note}</span>` : ''}
    </th>
    <td class="px-3 py-2"><span class="rounded px-1.5 py-0.5 font-semibold ${BADGE[verdict]}">${verdict}</span></td>
    <td class="px-3 py-2 text-right tabular-nums text-slate-600">${num(stat.percent)}</td>
    <td class="px-3 py-2 text-right tabular-nums ${stat.percentReal ? 'font-semibold text-rose-700' : 'text-slate-600'}">${num(stat.percentReal)}</td>
    <td class="px-3 py-2 text-right tabular-nums text-slate-600">${stat.maxDelta ?? '—'}</td>
    <td class="px-3 py-2 text-right tabular-nums text-slate-600">${num(stat.meanDelta)}</td>`;
  body.appendChild(tr);
  return verdict;
}

async function runAll() {
  const size = Number($('size').value) || CONFORMANCE_SIZE;
  $('run').disabled = true;
  $('bench').disabled = true;
  $('tables').innerHTML = '';
  $('summary').classList.add('hidden');

  const tally = { PASS: 0, WARN: 0, FAIL: 0, '—': 0 };
  let done = 0;
  const total = TABLES.reduce((n, t) => n + t.rows().length, 0);

  for (const table of TABLES) {
    const section = renderTableShell(table);
    $('tables').appendChild(section);
    const body = section.querySelector(`#rows-${table.id}`);

    for (const row of table.rows()) {
      text($('progress'), `Table ${table.id}: ${row.id} — ${++done} of ${total}`);
      await breathe();
      let result;
      try {
        result = compareOne(row.build(size));
      } catch (error) {
        result = { stat: null, note: `threw: ${error.message}` };
      }
      tally[paintRow(body, row, result)]++;
    }
  }

  text($('progress'), '');
  text($('sum-pass'), `${tally.PASS} PASS`);
  text($('sum-warn'), `${tally.WARN} WARN`);
  text($('sum-fail'), `${tally.FAIL + tally['—']} FAIL`);
  text($('sum-verdict'), useGpu
    ? (tally.FAIL + tally['—'] === 0
      ? 'GPU matches the JS oracle across every case run.'
      : 'At least one case diverges. Read the real % column before changing anything.')
    : 'JS against itself — this says nothing about the GPU path.');
  $('summary').classList.remove('hidden');
  $('run').disabled = false;
  $('bench').disabled = false;
}

// --------------------------------------------------------------- benchmark

/** Twenty full-canvas layers in a spread of modes, plus one clip run. */
const benchProject = (size) => createProject({
  width: size, height: size,
  children: Array.from({ length: 20 }, (_, i) => ({
    name: `bench-${i}`,
    left: (i * 7) % 32, top: (i * 11) % 32,
    right: size - ((i * 5) % 32), bottom: size - ((i * 3) % 32),
    blendMode: CONFORMANCE_MODES[i % CONFORMANCE_MODES.length],
    opacity: 0.4 + (i % 5) * 0.15,
    clipping: i === 7 || i === 13,
    proxyData: conformancePattern(size, size, i % 2 ? 'source' : 'backdrop'),
  })),
}, 'bench.psd');

const median = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];

async function runBench() {
  const size = Number($('size').value) || CONFORMANCE_SIZE;
  $('run').disabled = true;
  $('bench').disabled = true;
  text($('progress'), 'timing…');
  await breathe();

  const project = benchProject(size);
  const jsTimes = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    renderProject(project);
    jsTimes.push(performance.now() - t);
    await breathe();
  }

  const facts = [['Canvas', `${size} × ${size}, 20 layers`], ['JS renderProject', `${median(jsTimes).toFixed(1)} ms`]];

  if (useGpu) {
    const plan = buildDrawPlan(project, { maxTextureSize: caps.maxTextureSize });
    if (!plan.ok) {
      facts.push(['GPU', `refused: ${plan.reason}`]);
    } else {
      const buffer = createBuffer(plan.width, plan.height);
      const gpuTimes = [];
      const readTimes = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        renderer.render(plan);
        // Without finish() this measures how fast commands are QUEUED, which on
        // a GPU is a number close to zero and completely meaningless.
        gl.finish();
        const mid = performance.now();
        renderer.readInto(buffer);
        gpuTimes.push(mid - t);
        readTimes.push(performance.now() - mid);
        await breathe();
      }
      const gpuMs = median(gpuTimes);
      facts.push(
        ['GPU frame (incl. finish)', `${gpuMs.toFixed(1)} ms`],
        ['Readback', `${median(readTimes).toFixed(1)} ms`],
        ['Speed-up', `${(median(jsTimes) / Math.max(gpuMs, 0.001)).toFixed(1)}×`],
        ['GPU memory held', `${(renderer.bytes / (1024 * 1024)).toFixed(1)} MB`],
        ['Plan predicted', `${(plan.bytes / (1024 * 1024)).toFixed(1)} MB`],
        ['Programs compiled', renderer.programsCompiled],
      );
    }
  } else {
    facts.push(['GPU', 'no GPU tier on this device — nothing to compare']);
  }

  $('bench-out').innerHTML = facts.map(([k, v]) =>
    `<div><dt class="text-slate-500">${k}</dt><dd class="mt-0.5 font-medium text-slate-800">${v}</dd></div>`
  ).join('');
  $('bench-card').classList.remove('hidden');
  text($('progress'), '');
  $('run').disabled = false;
  $('bench').disabled = false;
}

$('run').addEventListener('click', runAll);
$('bench').addEventListener('click', runBench);
window.addEventListener('beforeunload', () => renderer && renderer.dispose());
