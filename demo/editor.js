import {
  readDocument, createProject, setLayer, reorderLayer, undo, redo, hitTest,
  renderProject, measureText, toProjectJson, applyProjectJson,
  BLEND_MODES, FONT_STACKS,
} from '/src/index.js';

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle('hidden', !on);
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const canvas = $('canvas');
const overlay = $('overlay');
const ctx = canvas.getContext('2d');
const octx = overlay.getContext('2d');

let project = null;
let selectedId = null;
let viewScale = 1;
let dragQuality = 1;      // dropped below 1 if a full-quality render can't keep up
let drag = null;          // { mode, handle, startX, startY, origin }

const HANDLE = 8;         // hit radius in screen pixels
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// ---------------------------------------------------------------- rendering

function handlePositions(layer) {
  const x = layer.x * viewScale, y = layer.y * viewScale;
  const w = layer.w * viewScale, h = layer.h * viewScale;
  return {
    nw: [x, y], n: [x + w / 2, y], ne: [x + w, y],
    e: [x + w, y + h / 2], se: [x + w, y + h],
    s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2],
  };
}

function paintOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!project) return;

  const layer = project.layers.find((l) => l.id === selectedId);
  if (!layer) return;

  const x = layer.x * viewScale, y = layer.y * viewScale;
  const w = layer.w * viewScale, h = layer.h * viewScale;

  octx.strokeStyle = '#0f172a';
  octx.lineWidth = 1;
  octx.setLineDash([4, 3]);
  octx.strokeRect(x + 0.5, y + 0.5, w, h);
  octx.setLineDash([]);

  const points = handlePositions(layer);
  for (const key of HANDLES) {
    const [hx, hy] = points[key];
    octx.fillStyle = '#ffffff';
    octx.strokeStyle = '#0f172a';
    octx.beginPath();
    octx.rect(hx - 4.5, hy - 4.5, 9, 9);
    octx.fill();
    octx.stroke();
  }
}

let renderQueued = false;
function scheduleRender(quality = 1) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    paintCanvas(quality);
    paintOverlay();
  });
}

function paintCanvas(quality) {
  if (!project) return;
  const scale = viewScale * quality;
  const started = performance.now();
  const buffer = renderProject(project, { scale });
  const elapsed = performance.now() - started;

  // If a full-quality frame can't hit ~30fps, drop resolution while dragging.
  if (quality === 1) dragQuality = elapsed > 28 ? 0.5 : 1;

  canvas.width = buffer.width;
  canvas.height = buffer.height;
  ctx.putImageData(new ImageData(buffer.data, buffer.width, buffer.height), 0, 0);

  const displayW = Math.round(project.width * viewScale);
  const displayH = Math.round(project.height * viewScale);
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';
}

function fitView() {
  const available = Math.max(320, ($('workspace').clientWidth - (window.innerWidth >= 1024 ? 320 : 0)) - 56);
  const availableH = Math.max(240, $('workspace').clientHeight - 56);
  viewScale = Math.min(available / project.width, availableH / project.height, 1);

  const displayW = Math.round(project.width * viewScale);
  const displayH = Math.round(project.height * viewScale);
  overlay.width = displayW;
  overlay.height = displayH;
  overlay.style.width = displayW + 'px';
  overlay.style.height = displayH + 'px';
  $('stage').style.width = displayW + 'px';
  $('stage').style.height = displayH + 'px';
}

// ---------------------------------------------------------------- canvas input

const toDoc = (e) => {
  const rect = overlay.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / viewScale, y: (e.clientY - rect.top) / viewScale };
};

function handleAt(layer, e) {
  const rect = overlay.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const points = handlePositions(layer);
  for (const key of HANDLES) {
    const [hx, hy] = points[key];
    if (Math.abs(px - hx) <= HANDLE && Math.abs(py - hy) <= HANDLE) return key;
  }
  return null;
}

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

overlay.addEventListener('pointermove', (e) => {
  if (drag) return;
  const layer = project?.layers.find((l) => l.id === selectedId);
  const key = layer ? handleAt(layer, e) : null;
  const point = toDoc(e);
  overlay.style.cursor = key ? CURSORS[key] : (project && hitTest(project, point.x, point.y) ? 'move' : 'default');
});

overlay.addEventListener('pointerdown', (e) => {
  if (!project) return;
  const { x, y } = toDoc(e);
  const selected = project.layers.find((l) => l.id === selectedId);

  // Handles take priority — they sit on the layer's edge.
  const key = selected ? handleAt(selected, e) : null;
  if (key) {
    overlay.setPointerCapture(e.pointerId);
    drag = { mode: 'resize', handle: key, startX: x, startY: y, origin: { x: selected.x, y: selected.y, w: selected.w, h: selected.h } };
    return;
  }

  const hit = hitTest(project, x, y);
  select(hit ? hit.id : null);
  if (!hit) return;

  overlay.setPointerCapture(e.pointerId);
  drag = { mode: 'move', startX: x, startY: y, origin: { x: hit.x, y: hit.y } };
});

overlay.addEventListener('pointermove', (e) => {
  if (!drag || !project) return;
  const { x, y } = toDoc(e);
  const dx = x - drag.startX, dy = y - drag.startY;
  const layer = project.layers.find((l) => l.id === selectedId);
  if (!layer) return;

  if (drag.mode === 'move') {
    setLayer(project, layer.id, { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) }, 'drag-' + layer.id);
  } else {
    const o = drag.origin;
    let { x: nx, y: ny, w: nw, h: nh } = o;
    if (drag.handle.includes('e')) nw = o.w + dx;
    if (drag.handle.includes('s')) nh = o.h + dy;
    if (drag.handle.includes('w')) { nx = o.x + dx; nw = o.w - dx; }
    if (drag.handle.includes('n')) { ny = o.y + dy; nh = o.h - dy; }
    if (e.shiftKey && nw > 0 && nh > 0) {                   // keep aspect ratio
      const ratio = o.w / o.h;
      if (Math.abs(nw / o.w - 1) > Math.abs(nh / o.h - 1)) nh = nw / ratio; else nw = nh * ratio;
    }
    setLayer(project, layer.id, {
      x: Math.round(nx), y: Math.round(ny),
      w: Math.max(1, Math.round(nw)), h: Math.max(1, Math.round(nh)),
    }, 'drag-' + layer.id);
  }

  refreshInspectorValues();
  updateHistoryButtons();
  scheduleRender(dragQuality);
});

function endDrag(e) {
  if (!drag) return;
  drag = null;
  try { overlay.releasePointerCapture(e.pointerId); } catch {}
  scheduleRender(1);
}
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- layer panel

function renderLayerPanel() {
  const list = $('layers');
  // Panel shows top layer first; the model is bottom-first.
  const items = project.layers.map((layer, index) => ({ layer, index })).reverse();

  list.innerHTML = items.map(({ layer, index }) => `
    <li draggable="true" data-index="${index}" data-id="${layer.id}"
        class="group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs
               ${layer.id === selectedId ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}">
      <button type="button" data-toggle="${layer.id}" title="${layer.visible ? 'Hide' : 'Show'} layer"
        class="shrink-0 rounded p-0.5 ${layer.visible ? '' : 'opacity-40'}">${layer.visible ? '👁' : '⃠'}</button>
      <span class="min-w-0 flex-1 truncate ${layer.visible ? '' : 'line-through opacity-50'}">${esc(layer.name)}</span>
      ${layer.kind === 'text' ? '<span class="shrink-0 rounded bg-slate-200 px-1 text-[10px] font-medium text-slate-700">T</span>' : ''}
      ${layer.rerendered ? '<span title="Re-drawn by this editor — will not match Photoshop\'s rendering" class="shrink-0 rounded bg-amber-200 px-1 text-[10px] font-medium text-amber-900">re-drawn</span>' : ''}
    </li>`).join('');

  for (const li of list.querySelectorAll('li')) {
    li.addEventListener('click', (e) => {
      if (e.target.dataset.toggle) return;
      select(Number(li.dataset.id));
    });
    li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', li.dataset.index));
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('ring-2', 'ring-slate-400'); });
    li.addEventListener('dragleave', () => li.classList.remove('ring-2', 'ring-slate-400'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('ring-2', 'ring-slate-400');
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = Number(li.dataset.index);
      if (Number.isInteger(from) && Number.isInteger(to)) {
        reorderLayer(project, from, to);
        renderLayerPanel();
        updateHistoryButtons();
        scheduleRender(1);
      }
    });
  }

  for (const button of list.querySelectorAll('[data-toggle]')) {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const layer = project.layers.find((l) => l.id === Number(button.dataset.toggle));
      setLayer(project, layer.id, { visible: !layer.visible });
      renderLayerPanel();
      updateHistoryButtons();
      scheduleRender(1);
    });
  }
}

// ---------------------------------------------------------------- inspector

const field = (label, inner) =>
  `<label class="mb-2 block"><span class="mb-1 block text-[11px] font-medium text-slate-500">${label}</span>${inner}</label>`;

const INPUT = 'w-full rounded border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500';

function renderInspector() {
  const panel = $('inspector');
  const layer = project?.layers.find((l) => l.id === selectedId);

  if (!layer) {
    panel.innerHTML = '<p class="text-xs text-slate-500">Select a layer on the canvas or in the list.</p>';
    return;
  }

  const numeric = (key, label) =>
    `<label class="block"><span class="mb-1 block text-[11px] font-medium text-slate-500">${label}</span>
      <input type="number" data-prop="${key}" value="${Math.round(layer[key])}" class="${INPUT}"></label>`;

  panel.innerHTML = `
    <p class="mb-3 truncate text-xs font-semibold text-slate-800">${esc(layer.name)}</p>

    <div class="mb-3 grid grid-cols-2 gap-2">
      ${numeric('x', 'X')} ${numeric('y', 'Y')}
      ${numeric('w', 'Width')} ${numeric('h', 'Height')}
    </div>

    ${field('Blend mode', `<select data-prop="blendMode" class="${INPUT}">
      ${BLEND_MODES.map((m) => `<option value="${m}"${m === layer.blendMode ? ' selected' : ''}>${m}</option>`).join('')}
    </select>`)}

    <label class="mb-3 block">
      <span class="mb-1 flex justify-between text-[11px] font-medium text-slate-500">
        <span>Opacity</span><span id="opacity-value">${Math.round(layer.opacity * 100)}%</span>
      </span>
      <input type="range" min="0" max="100" value="${Math.round(layer.opacity * 100)}" data-prop="opacity" class="w-full">
    </label>

    ${layer.kind !== 'text' ? '' : `
      <div class="mt-3 border-t border-slate-200 pt-3">
        <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Text</p>
        ${field('Content', `<textarea data-text="content" rows="3" class="${INPUT}">${esc(layer.text.content)}</textarea>`)}
        <div class="grid grid-cols-2 gap-2">
          ${field('Size', `<input type="number" min="1" data-text="fontSize" value="${layer.text.fontSize}" class="${INPUT}">`)}
          ${field('Colour', `<input type="color" data-text="color" value="${layer.text.color}" class="h-[26px] w-full rounded border border-slate-300">`)}
        </div>
        ${field('Font', `<select data-text="fontFamily" class="${INPUT}">
          ${FONT_STACKS.map((f) => `<option value="${esc(f)}"${f === layer.text.fontFamily ? ' selected' : ''}>${esc(f.split(',')[0].replace(/"/g, ''))}</option>`).join('')}
        </select>`)}
        ${field('Align', `<select data-text="align" class="${INPUT}">
          ${['left', 'center', 'right'].map((a) => `<option value="${a}"${a === layer.text.align ? ' selected' : ''}>${a}</option>`).join('')}
        </select>`)}
        <div class="flex gap-3 text-xs text-slate-600">
          <label class="flex items-center gap-1"><input type="checkbox" data-text="bold"${layer.text.bold ? ' checked' : ''}> Bold</label>
          <label class="flex items-center gap-1"><input type="checkbox" data-text="italic"${layer.text.italic ? ' checked' : ''}> Italic</label>
        </div>
        ${layer.rerendered ? `<p class="mt-2 rounded bg-amber-50 p-2 text-[11px] leading-snug text-amber-800">
          This layer is now drawn by the browser, not Photoshop. The PSD names its font as a placeholder and does not
          embed the font file, so the result will not match the original rendering.</p>` : ''}
      </div>`}
  `;

  for (const input of panel.querySelectorAll('[data-prop]')) {
    input.addEventListener('input', () => {
      const key = input.dataset.prop;
      const value = key === 'opacity' ? Number(input.value) / 100
        : key === 'blendMode' ? input.value
        : Math.round(Number(input.value) || 0);
      if (key === 'opacity') $('opacity-value').textContent = Math.round(value * 100) + '%';
      setLayer(project, layer.id, { [key]: key === 'w' || key === 'h' ? Math.max(1, value) : value },
        input.type === 'range' ? 'slider-' + layer.id + '-' + key : undefined);
      updateHistoryButtons();
      scheduleRender(input.type === 'range' ? dragQuality : 1);
    });
  }

  for (const input of panel.querySelectorAll('[data-text]')) {
    input.addEventListener('input', () => {
      const key = input.dataset.text;
      const value = input.type === 'checkbox' ? input.checked
        : key === 'fontSize' ? Math.max(1, Number(input.value) || 1)
        : input.value;

      const changes = { text: { [key]: value } };

      // Retyping or restyling changes how much room the text needs — grow the
      // box to match, or the layer would clip its own glyphs.
      const probe = { ...layer.text, [key]: value };
      const metrics = measureText(probe);
      if (metrics) { changes.w = metrics.width; changes.h = metrics.height; }

      setLayer(project, layer.id, changes, key === 'content' ? 'typing-' + layer.id : undefined);
      renderLayerPanel();
      updateHistoryButtons();
      scheduleRender(1);
    });
  }
}

/** Update inspector inputs during a drag without rebuilding the DOM (which would steal focus). */
function refreshInspectorValues() {
  const layer = project?.layers.find((l) => l.id === selectedId);
  if (!layer) return;
  for (const key of ['x', 'y', 'w', 'h']) {
    const input = $('inspector').querySelector(`[data-prop="${key}"]`);
    if (input && document.activeElement !== input) input.value = Math.round(layer[key]);
  }
}

// ---------------------------------------------------------------- app

function select(id) {
  selectedId = id;
  renderLayerPanel();
  renderInspector();
  paintOverlay();
}

function updateHistoryButtons() {
  $('undo').disabled = !project || project.history.length === 0;
  $('redo').disabled = !project || project.future.length === 0;
}

async function open(bytes, name) {
  show($('empty'), false);
  show($('workspace'), false);
  show($('error'), false);
  $('loading').classList.remove('hidden');
  $('loading').classList.add('flex');
  $('loading-text').textContent = `Reading ${name}…`;

  try {
    const doc = await readDocument(bytes, { pixels: 'eager', metadata: false });
    project = createProject(doc, name);
    selectedId = null;

    $('loading').classList.add('hidden');
    $('loading').classList.remove('flex');
    show($('workspace'), true);

    $('doc-info').textContent = `${name} — ${doc.width}×${doc.height}, ${project.layers.length} layers`;
    show($('warnings'), project.warnings.length > 0);
    $('warnings-list').innerHTML = project.warnings.map((w) => `<li>${esc(w)}</li>`).join('');

    for (const id of ['export-png', 'save-project']) $(id).disabled = false;

    fitView();
    renderLayerPanel();
    renderInspector();
    updateHistoryButtons();
    scheduleRender(1);
  } catch (e) {
    $('loading').classList.add('hidden');
    $('loading').classList.remove('flex');
    $('error-text').textContent = e.message;
    show($('error'), true);
    console.error(e);
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- toolbar ---
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) open(new Uint8Array(await file.arrayBuffer()), file.name);
});

$('sample').addEventListener('click', async () => {
  const name = 'text.src.psd';
  const res = await fetch('/fixtures/' + name);
  if (!res.ok) { $('error-text').textContent = `sample not found (${res.status})`; show($('error'), true); return; }
  open(new Uint8Array(await res.arrayBuffer()), name);
});

$('undo').addEventListener('click', () => {
  if (undo(project)) { renderLayerPanel(); renderInspector(); updateHistoryButtons(); scheduleRender(1); }
});
$('redo').addEventListener('click', () => {
  if (redo(project)) { renderLayerPanel(); renderInspector(); updateHistoryButtons(); scheduleRender(1); }
});

$('export-png').addEventListener('click', () => {
  const buffer = renderProject(project, { scale: 1 });
  const out = document.createElement('canvas');
  out.width = buffer.width;
  out.height = buffer.height;
  out.getContext('2d').putImageData(new ImageData(buffer.data, buffer.width, buffer.height), 0, 0);
  out.toBlob((blob) => download(blob, project.fileName.replace(/\.ps[db]$/i, '') + '.png'), 'image/png');
});

$('save-project').addEventListener('click', () => {
  const json = JSON.stringify(toProjectJson(project), null, 2);
  download(new Blob([json], { type: 'application/json' }), project.fileName.replace(/\.ps[db]$/i, '') + '.project.json');
});

$('load-project').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !project) return;
  try {
    applyProjectJson(project, JSON.parse(await file.text()));
    selectedId = null;
    renderLayerPanel();
    renderInspector();
    updateHistoryButtons();
    scheduleRender(1);
  } catch (err) {
    $('error-text').textContent = err.message;
    show($('error'), true);
  }
  e.target.value = '';
});

document.addEventListener('keydown', (e) => {
  if (!project) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  const meta = e.ctrlKey || e.metaKey;

  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey ? redo(project) : undo(project)) {
      renderLayerPanel(); renderInspector(); updateHistoryButtons(); scheduleRender(1);
    }
    return;
  }
  if (typing || !selectedId) return;

  const step = e.shiftKey ? 10 : 1;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (nudge) {
    e.preventDefault();
    const layer = project.layers.find((l) => l.id === selectedId);
    setLayer(project, layer.id, { x: layer.x + nudge[0], y: layer.y + nudge[1] }, 'nudge-' + layer.id);
    refreshInspectorValues();
    updateHistoryButtons();
    scheduleRender(1);
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  if (!project) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { fitView(); scheduleRender(1); }, 120);
});
