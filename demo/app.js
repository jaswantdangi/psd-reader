import { readDocument, compositeDocument, compareBuffers, differenceBuffer, flattenOnto } from '/src/index.js';

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle('hidden', !on);
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const COLOR_MODE = ['Bitmap', 'Grayscale', 'Indexed', 'RGB', 'CMYK', '—', '—', 'Multichannel', 'Duotone', 'Lab'];

const CHECKER =
  'background-image:linear-gradient(45deg,#e2e8f0 25%,transparent 25%,transparent 75%,#e2e8f0 75%),' +
  'linear-gradient(45deg,#e2e8f0 25%,transparent 25%,transparent 75%,#e2e8f0 75%);' +
  'background-size:8px 8px;background-position:0 0,4px 4px';

/** Buffers for the three preview views, kept so tab switching is instant. */
const views = { embedded: null, ours: null, diff: null };
let activeView = 'ours';

function stat(label, value, hint) {
  return `<div class="bg-white px-3 py-2">
    <dt class="text-xs text-slate-500">${label}</dt>
    <dd class="mt-0.5 text-sm font-medium text-slate-900">${value}</dd>
    ${hint ? `<dd class="text-xs text-slate-400">${hint}</dd>` : ''}
  </div>`;
}

function panel(title, rows) {
  if (!rows.length) return '';
  return `<div class="rounded-lg border border-slate-200 bg-white">
    <h3 class="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">${title}</h3>
    <dl class="divide-y divide-slate-50">
      ${rows.map(([k, v]) => `<div class="flex gap-3 px-3 py-1.5">
        <dt class="w-28 shrink-0 text-xs text-slate-500">${k}</dt>
        <dd class="min-w-0 flex-1 break-words text-xs text-slate-800">${v}</dd>
      </div>`).join('')}
    </dl>
  </div>`;
}

/** Canvas here is DISPLAY only — the decode and composite paths never touch it. */
function paint(canvas, buffer) {
  if (!buffer) return;
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.getContext('2d').putImageData(new ImageData(buffer.data, buffer.width, buffer.height), 0, 0);
}

function thumbnail(pixels, max = 40) {
  if (!pixels || !pixels.width || !pixels.height) return '';
  try {
    const src = document.createElement('canvas');
    src.width = pixels.width;
    src.height = pixels.height;
    src.getContext('2d').putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);

    const scale = Math.min(max / pixels.width, max / pixels.height, 1);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(pixels.width * scale));
    out.height = Math.max(1, Math.round(pixels.height * scale));
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL();
  } catch {
    return '';
  }
}

function setView(name) {
  if (!views[name]) return;
  activeView = name;
  paint($('preview'), views[name]);
  for (const tab of document.querySelectorAll('.view-tab')) {
    const on = tab.dataset.view === name;
    tab.classList.toggle('bg-slate-900', on);
    tab.classList.toggle('text-white', on);
    tab.classList.toggle('text-slate-600', !on);
    tab.setAttribute('aria-selected', String(on));
  }
  $('preview-note').textContent =
    name === 'embedded' ? 'The flattened preview Photoshop wrote when the file was saved. Exact by definition.'
    : name === 'ours' ? 'Built by stacking the layers ourselves — exact position, order, opacity, blend mode and masks.'
    : 'Absolute difference between the two, amplified 8× so small errors are visible. Black means identical.';
}

/** Walk the tree in render order so rows read bottom-to-top like the file. */
function collectRows(children, depth = 0, rows = []) {
  for (const layer of children || []) {
    rows.push({
      name: layer.name || '(unnamed)',
      depth,
      group: !!layer.children,
      w: (layer.right ?? 0) - (layer.left ?? 0),
      h: (layer.bottom ?? 0) - (layer.top ?? 0),
      x: layer.left ?? 0,
      y: layer.top ?? 0,
      blend: layer.blendMode || 'normal',
      opacity: Math.round((layer.opacity ?? 1) * 100),
      hidden: layer.hidden === true,
      clipping: layer.clipping === true,
      thumb: layer.children ? '' : thumbnail(layer.imageData),
    });
    if (layer.children) collectRows(layer.children, depth + 1, rows);
  }
  return rows;
}

async function render(bytes, label) {
  show($('result'), false);
  show($('error'), false);
  show($('loading'), true);
  $('loading-text').textContent = `Reading ${label}…`;

  const started = performance.now();

  try {
    const doc = await readDocument(bytes, { pixels: 'eager', embedded: true });
    const readMs = Math.round(performance.now() - started);

    $('loading-text').textContent = 'Compositing layers…';
    await new Promise((r) => requestAnimationFrame(r)); // let the label paint

    const compositeStart = performance.now();
    const ours = compositeDocument(doc);
    const compositeMs = Math.round(performance.now() - compositeStart);

    views.ours = ours;
    views.embedded = doc.embeddedComposite || null;
    views.diff = null;

    // Accuracy: compare what a viewer sees, flattened onto the same background.
    let accuracy = null;
    if (views.embedded) {
      const a = flattenOnto(ours);
      const b = flattenOnto(views.embedded);
      accuracy = compareBuffers(a, b);
      views.diff = differenceBuffer(a, b);
    }

    const badge = $('accuracy');
    if (accuracy && accuracy.comparable) {
      const pct = accuracy.percentReal;
      const good = pct < 0.5, ok = pct < 10;
      badge.textContent = good
        ? 'matches Photoshop'
        : `${pct.toFixed(1)}% of pixels differ`;
      badge.className = `rounded-full px-2 py-0.5 text-xs font-medium ${
        good ? 'bg-emerald-100 text-emerald-800' : ok ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
      }`;
    } else {
      badge.textContent = 'no embedded composite to compare';
      badge.className = 'rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600';
    }

    setView(views.embedded ? 'ours' : 'ours');

    $('summary').innerHTML = [
      stat('Dimensions', `${doc.width} × ${doc.height}`),
      stat('Colour mode', COLOR_MODE[doc.colorMode] ?? doc.colorMode),
      stat('Bit depth', `${doc.bitsPerChannel}-bit`),
      stat('Channels', doc.channels),
      stat('Layers', doc.layers.length),
      stat('Timing', `${readMs} + ${compositeMs} ms`, 'read + composite'),
    ].join('');

    const rows = collectRows(doc.children);
    $('layer-count').textContent = `(${rows.length}, bottom to top)`;
    $('layers').innerHTML =
      rows.map((r) => `<tr class="${r.hidden ? 'opacity-40' : ''}">
        <td class="px-3 py-1.5">${
          r.group
            ? '<div class="flex h-10 w-10 items-center justify-center rounded border border-slate-200 bg-slate-50 text-slate-400" title="group">▤</div>'
            : r.thumb
              ? `<img src="${r.thumb}" alt="" class="h-10 w-10 rounded border border-slate-200 object-contain" style="${CHECKER}">`
              : '<div class="h-10 w-10 rounded border border-dashed border-slate-200"></div>'
        }</td>
        <td class="px-3 py-1.5 font-medium text-slate-800" style="padding-left:${12 + r.depth * 16}px">
          ${r.clipping ? '<span class="text-slate-400" title="clipped to layer below">↳ </span>' : ''}${esc(r.name)}
          ${r.hidden ? '<span class="ml-1 text-xs font-normal text-slate-400">hidden</span>' : ''}
        </td>
        <td class="px-3 py-1.5 tabular-nums text-slate-600">${r.group ? '—' : `${r.w}×${r.h}`}</td>
        <td class="px-3 py-1.5 tabular-nums text-slate-500">${r.group ? '—' : `${r.x},${r.y}`}</td>
        <td class="px-3 py-1.5 text-slate-600">${esc(r.blend)}</td>
        <td class="px-3 py-1.5 tabular-nums text-slate-600">${r.opacity}%</td>
      </tr>`).join('') ||
      '<tr><td colspan="6" class="px-3 py-6 text-center text-sm text-slate-500">No layers</td></tr>';

    const m = doc.metadata || {};
    $('metadata').innerHTML =
      [
        m.icc && panel('ICC profile', [
          ['Description', esc(m.icc.description)],
          ['Colour space', `${esc(m.icc.colorSpace)} → ${esc(m.icc.connectionSpace)}`],
          ['Version', esc(m.icc.version)],
          ['Class', esc(m.icc.deviceClass)],
          ['Intent', esc(m.icc.intent)],
          ['Copyright', esc(m.icc.copyright)],
        ].filter(([, v]) => v)),
        m.exif && panel('EXIF', Object.entries(m.exif).slice(0, 12).map(([k, v]) => [esc(k), esc(v)])),
        m.iptc && panel('IPTC', Object.entries(m.iptc).map(([k, v]) => [esc(k), esc([].concat(v).join(', '))])),
        m.xmp && panel('XMP', [['Size', `${(m.xmp.length / 1024).toFixed(1)} KB of XML`]]),
      ].filter(Boolean).join('') ||
      '<p class="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-500">No ICC, EXIF or IPTC in this file.</p>';

    const allWarnings = [...doc.warnings, ...ours.warnings];
    show($('warnings'), allWarnings.length > 0);
    $('warnings-list').innerHTML = allWarnings.map((w) => `<li>${esc(w)}</li>`).join('');

    show($('loading'), false);
    show($('result'), true);
  } catch (e) {
    show($('loading'), false);
    $('error-text').textContent = e.message;
    show($('error'), true);
    console.error(e);
  }
}

for (const tab of document.querySelectorAll('.view-tab'))
  tab.addEventListener('click', () => setView(tab.dataset.view));

const load = async (file) => render(new Uint8Array(await file.arrayBuffer()), file.name);

$('file').addEventListener('change', (e) => {
  if (e.target.files[0]) load(e.target.files[0]);
});

$('sample').addEventListener('click', async () => {
  const name = 'effects.src.psd';
  try {
    const res = await fetch('/fixtures/' + name);
    if (!res.ok) throw new Error(`sample not found (${res.status}) — start the server from the project root`);
    render(new Uint8Array(await res.arrayBuffer()), name);
  } catch (e) {
    $('error-text').textContent = e.message;
    show($('error'), true);
  }
});

const zone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  zone.addEventListener(type, (e) => {
    e.preventDefault();
    zone.classList.add('border-slate-500', 'bg-slate-100');
  });
}
for (const type of ['dragleave', 'drop']) {
  zone.addEventListener(type, (e) => {
    e.preventDefault();
    zone.classList.remove('border-slate-500', 'bg-slate-100');
  });
}
zone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
});
