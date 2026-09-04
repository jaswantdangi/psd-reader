import fs from 'fs';
import assert from 'node:assert/strict';
import {
  readDocument, createProject, setLayer, reorderLayer, undo, redo,
  hitTest, renderProject, resample, toProjectJson, applyProjectJson,
  BLEND_MODES, SUPPORTED_BLEND_MODES,
} from '../src/index.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

const bytes = new Uint8Array(fs.readFileSync('fixtures/effects.src.psd'));
const doc = await readDocument(bytes, { pixels: 'eager', metadata: false });
const project = createProject(doc, 'effects.src.psd');

const textBytes = new Uint8Array(fs.readFileSync('fixtures/text.src.psd'));
const textProject = createProject(await readDocument(textBytes, { pixels: 'eager', metadata: false }), 'text.src.psd');

console.log('\nedit model\n');

test('flattens the tree into an ordered layer list', () => {
  assert.ok(project.layers.length > 0);
  assert.equal(project.width, doc.width);
});

test('layers start at their original bounds', () => {
  const l = project.layers[0];
  // Documentation, not a trap: since sourceW/H are derived from the same bounds
  // as w/h, this cannot fail. There is no discriminating assertion available on
  // an eager load, where proxyW/H, sourceW/H and pixels.width all coincide by
  // construction. The assertion that can actually catch a regression lives in
  // test/proxy.mjs, against a genuinely downscaled fixture.
  assert.equal(l.w, l.sourceW);
  assert.equal(l.h, l.sourceH);
});

test('move is undoable', () => {
  const l = project.layers[0];
  const x0 = l.x;
  setLayer(project, l.id, { x: x0 + 25 });
  assert.equal(l.x, x0 + 25);
  assert.ok(undo(project));
  assert.equal(l.x, x0);
  assert.ok(redo(project));
  assert.equal(l.x, x0 + 25);
  undo(project);
});

test('resize is non-destructive — original pixels never change', () => {
  const l = project.layers[0];
  const before = l.pixels.data.slice(0, 64);
  const w0 = l.w, h0 = l.h;
  setLayer(project, l.id, { w: Math.round(w0 * 0.2), h: Math.round(h0 * 0.2) });
  setLayer(project, l.id, { w: w0, h: h0 });
  assert.deepEqual(l.pixels.data.slice(0, 64), before, 'source pixels were mutated');
  assert.equal(l.w, w0);
  undo(project); undo(project);
});

test('a drag coalesces into one undo step', () => {
  const l = project.layers[0];
  const x0 = l.x;
  const depth = project.history.length;
  for (let i = 1; i <= 20; i++) setLayer(project, l.id, { x: x0 + i }, 'drag');
  assert.equal(project.history.length, depth + 1, 'expected exactly one history entry');
  assert.equal(l.x, x0 + 20);
  undo(project);
  assert.equal(l.x, x0);
});

test('reorder moves a layer and undoes cleanly', () => {
  const order = project.layers.map((l) => l.id);
  reorderLayer(project, 0, 2);
  assert.notDeepEqual(project.layers.map((l) => l.id), order);
  assert.equal(project.layers[2].id, order[0]);
  undo(project);
  assert.deepEqual(project.layers.map((l) => l.id), order);
});

test('blend mode and opacity are settable', () => {
  const l = project.layers[0];
  setLayer(project, l.id, { blendMode: 'multiply', opacity: 0.5 });
  assert.equal(l.blendMode, 'multiply');
  assert.equal(l.opacity, 0.5);
  undo(project);
  assert.equal(l.blendMode, 'normal');
});

test('hit test finds the top opaque layer and misses empty space', () => {
  const l = project.layers[project.layers.length - 1];
  const cx = Math.floor(l.x + l.w / 2), cy = Math.floor(l.y + l.h / 2);
  assert.ok(hitTest(project, cx, cy), 'expected a hit inside a layer');
  assert.equal(hitTest(project, -50, -50), null, 'expected a miss outside the canvas');
});

// -------------------------------------------------------------- masks and taps
//
// `hitTest` thresholded the layer's own pixel alpha and never consulted
// `layer.mask`, so a layer masked down to a small shape stayed selectable
// across its whole bounding box -- and swallowed the taps meant for whatever
// is actually drawn underneath it.
//
// vector-and-mask.src.psd is used rather than a shape invented to make the
// assertion true: its single layer is opaque colour under a real Photoshop
// mask, and the two points below were read off the RENDER, not off the mask.
const maskProject = createProject(
  await readDocument(new Uint8Array(fs.readFileSync('fixtures/vector-and-mask.src.psd')),
    { pixels: 'eager', metadata: false }),
  'vector-and-mask.src.psd');
const maskLayer = maskProject.layers[0];
const maskRender = renderProject(maskProject);
const drawnAlpha = (x, y) => maskRender.data[(y * maskRender.width + x) * 4 + 3];

/** Masked away: opaque pixels, mask 0, nothing on the canvas. */
const HIDDEN = { x: 43, y: 35 };
/** Masked in: opaque pixels, mask 255, solid on the canvas. */
const SHOWN = { x: 35, y: 35 };

test('the fixture really does carry a mask that hides drawn pixels', () => {
  // Without this the next test could pass on a fixture whose mask covers
  // everything, which is the same as carrying no mask at all.
  assert.ok(maskLayer.mask, 'vector-and-mask.src.psd must carry a layer mask');
  assert.equal(maskLayer.mask.disabled, false, 'and it must be switched ON in the file');
  const px = maskLayer.pixels;
  const sx = Math.floor(((HIDDEN.x - maskLayer.x) / maskLayer.w) * px.width);
  const sy = Math.floor(((HIDDEN.y - maskLayer.y) / maskLayer.h) * px.height);
  assert.equal(px.data[(sy * px.width + sx) * 4 + 3], 255, 'HIDDEN sits on opaque pixels');
  assert.equal(maskLayer.mask.data[sy * maskLayer.mask.width + sx], 0, 'that the mask erases');
  assert.equal(drawnAlpha(HIDDEN.x, HIDDEN.y), 0, 'so the renderer draws nothing there');
  assert.equal(drawnAlpha(SHOWN.x, SHOWN.y), 255, 'and draws solid colour at SHOWN');
});

test('a point the mask hides is not selectable', () => {
  assert.equal(hitTest(maskProject, HIDDEN.x, HIDDEN.y)?.name ?? null, null,
    'the renderer draws nothing here - picking the layer anyway is the bug');
});

test('a point the mask keeps is still selectable', () => {
  assert.equal(hitTest(maskProject, SHOWN.x, SHOWN.y)?.id, maskLayer.id);
});

test('a disabled mask behaves as no mask at all', () => {
  // Photoshop saves switched-off masks. Applying one is as wrong as ignoring
  // an enabled one, just in the other direction: the layer is fully drawn, so
  // it must be fully pickable.
  maskLayer.mask.disabled = true;
  try {
    assert.equal(hitTest(maskProject, HIDDEN.x, HIDDEN.y)?.id, maskLayer.id,
      'a switched-off mask must not remove the layer from the pick');
  } finally {
    maskLayer.mask.disabled = false;
  }
  assert.equal(hitTest(maskProject, HIDDEN.x, HIDDEN.y)?.name ?? null, null,
    'and switching it back on restores the hole');
});

// Hand-built from here, because no fixture stacks a masked layer over another
// one - and reaching what is underneath a hole is the user-visible point of
// the whole fix.
const plane = (w, h, fn) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  return { width: w, height: h, data };
};
const solidLeaf = (name, [left, top, right, bottom], rgb, extra = {}) => ({
  name, left, top, right, bottom,
  imageData: plane(right - left, bottom - top, () => [rgb[0], rgb[1], rgb[2], 255]),
  ...extra,
});
/** A greyscale mask node on its own bounds, in the shape ag-psd reports one. */
const greyMask = ([left, top, right, bottom], fn, extra = {}) => ({
  left, top, right, bottom, defaultColor: 0,
  imageData: plane(right - left, bottom - top, (x, y) => { const v = fn(x, y); return [v, v, v, 255]; }),
  ...extra,
});

// 40x40. `under` fills the canvas; `over` covers it too, but its mask keeps
// only the right half, so the left half is a hole straight through to `under`.
const holeDoc = () => ({
  width: 40, height: 40,
  children: [
    solidLeaf('under', [0, 0, 40, 40], [30, 30, 30]),
    solidLeaf('over', [0, 0, 40, 40], [200, 60, 60],
      { mask: greyMask([0, 0, 40, 40], (x) => (x < 20 ? 0 : 255)) }),
  ],
});

test('the layer below is reached through a hole in the mask', () => {
  const p = createProject(holeDoc(), 'hole.psd');
  const [under, over] = p.layers;
  assert.equal(hitTest(p, 30, 20)?.id, over.id, 'the masked-in half still picks the top layer');
  assert.equal(hitTest(p, 10, 20)?.id, under.id,
    'through the hole the tap must reach what is actually drawn there');
});

test('tap-cycling still walks down the pile', () => {
  // How the canvas cycles a repeated tap: the engine's own rule applied to a
  // SHORTER stack (project.service.ts `hitTestBelow`). A shallow project has
  // to keep working - and a clipping base has to still be findable inside it,
  // which it is, because a run's base is always at or below its members.
  const p = createProject(holeDoc(), 'hole.psd');
  const [under, over] = p.layers;
  const below = (x, y, index) => hitTest({ ...p, layers: p.layers.slice(0, index) }, x, y);
  assert.equal(hitTest(p, 30, 20)?.id, over.id);
  assert.equal(below(30, 20, 1)?.id, under.id, 'the second tap reaches the layer beneath');
  assert.equal(below(30, 20, 0)?.name ?? null, null, 'and the third finds nothing left to walk to');
});

console.log('\nrender\n');

test('renders at document resolution', () => {
  const out = renderProject(project);
  assert.equal(out.width, project.width);
  assert.equal(out.height, project.height);
});

test('scale produces a proportionally smaller buffer', () => {
  const out = renderProject(project, { scale: 0.5 });
  assert.equal(out.width, Math.round(project.width * 0.5));
});

test('moving a layer changes the rendered output', () => {
  const before = renderProject(project, { scale: 0.5 });
  const l = project.layers[project.layers.length - 1];
  setLayer(project, l.id, { x: l.x + 40 });
  const after = renderProject(project, { scale: 0.5 });
  assert.notDeepEqual(Array.from(after.data), Array.from(before.data), 'render did not change');
  undo(project);
});

test('hidden layers are excluded', () => {
  const l = project.layers[project.layers.length - 1];
  const before = renderProject(project, { scale: 0.4 });
  setLayer(project, l.id, { visible: false });
  const after = renderProject(project, { scale: 0.4 });
  assert.notDeepEqual(Array.from(after.data), Array.from(before.data));
  undo(project);
});

test('resample preserves dimensions and returns the source when unchanged', () => {
  const src = project.layers[0].pixels;
  assert.equal(resample(src, src.width, src.height), src);
  const half = resample(src, Math.max(1, src.width >> 1), Math.max(1, src.height >> 1));
  assert.equal(half.width, Math.max(1, src.width >> 1));
});

console.log('\npersistence\n');

test('project json round-trips through a fresh read', async () => {
  const l = project.layers[0];
  setLayer(project, l.id, { x: l.x + 17, opacity: 0.42, blendMode: 'screen' });
  const json = JSON.parse(JSON.stringify(toProjectJson(project)));

  const doc2 = await readDocument(bytes, { pixels: 'eager', metadata: false });
  const restored = applyProjectJson(createProject(doc2, 'effects.src.psd'), json);

  assert.equal(restored.layers[0].x, project.layers[0].x);
  assert.equal(restored.layers[0].opacity, 0.42);
  assert.equal(restored.layers[0].blendMode, 'screen');
  undo(project);
});

test('rejects a project file from a different document', () => {
  const json = toProjectJson(project);
  json.layers = json.layers.slice(0, 1);
  assert.throws(() => applyProjectJson(project, json), /Layer count differs/);
});


// ---------------------------------------------------------------------------
// Scaled text must be re-shaped at its final size, not bitmap-scaled.
// Node has no canvas, so stub just enough of one to observe what we ask it to do.
// ---------------------------------------------------------------------------
console.log('\ntext scaling\n');

const calls = [];

/**
 * A stubbed text engine, modelling a plausible Latin face:
 *
 *   advance     10px per character, whatever the size, so the width arithmetic
 *               in these assertions stays legible
 *   cap height  0.70em -- the INK ascent of capitals, and zero ink below the
 *               baseline, which is what "TEST" actually looks like
 *   font box    0.90em above the baseline plus 0.20em below it, so one line
 *               advance is 1.10em
 *
 * These proportions are an ASSUMPTION about what a browser returns, not a
 * measurement of one: Node has no text engine, and nothing here proves Chrome
 * agrees with any of these numbers. What it does prove is that measureText
 * reads the ink fields AT ALL and composes them into a box the way it claims
 * to -- which is the part that was wrong. The real-browser numbers need a
 * browser.
 */
const CHAR_ADVANCE = 10, CAP_HEIGHT = 0.7, FONT_ASCENT = 0.9, FONT_DESCENT = 0.2;
const stubMetrics = (s, size) => ({
  width: s.length * CHAR_ADVANCE,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: s.length * CHAR_ADVANCE,
  actualBoundingBoxAscent: s === '' ? 0 : size * CAP_HEIGHT,
  actualBoundingBoxDescent: 0,
  fontBoundingBoxAscent: size * FONT_ASCENT,
  fontBoundingBoxDescent: size * FONT_DESCENT,
});

globalThis.document = {
  createElement() {
    const el = { width: 0, height: 0 };
    el.getContext = () => ({
      set font(v) { calls.push(['font', v]); this._size = parseFloat(/([\d.]+)px/.exec(v)?.[1]) || 10; },
      get font() { return ''; },
      fillStyle: '',
      set textBaseline(v) { calls.push(['textBaseline', v]); },
      get textBaseline() { return ''; },
      textAlign: '',
      setTransform: (...a) => calls.push(['setTransform', ...a]),
      fillText: (...a) => calls.push(['fillText', ...a]),
      measureText(s) { return stubMetrics(s, this._size); },
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    });
    return el;
  },
};

const { rasteriseTextAt, measureText: measure, drawLayerInto, createBuffer, wrapsInBox } =
  await import('../src/index.js');

const textLayer = {
  kind: 'text', rerendered: true,
  text: { content: 'ABCD', fontFamily: 'Arial', fontSize: 20, color: '#ff0000',
          align: 'left', bold: false, italic: false },
};

test('rasterises at the requested size, not the natural one', () => {
  const natural = measure(textLayer.text);
  assert.equal(natural.width, 40, 'stub should measure 4 chars at 10px');

  const out = rasteriseTextAt(textLayer, 400, 125);
  assert.equal(out.width, 400);
  assert.equal(out.height, 125);
  assert.equal(out.data.length, 400 * 125 * 4);
});

test('scales the canvas transform instead of resampling a bitmap', () => {
  calls.length = 0;
  const natural = measure(textLayer.text);
  rasteriseTextAt(textLayer, natural.width * 4, natural.height * 4);

  const transform = calls.find((c) => c[0] === 'setTransform');
  assert.ok(transform, 'expected setTransform to be used');
  assert.equal(Math.round(transform[1]), 4, 'horizontal scale should be 4x');
  assert.equal(Math.round(transform[4]), 4, 'vertical scale should be 4x');
});

test('a box of the wrong aspect fits the glyphs inside it rather than squashing them', () => {
  // sx and sy were independent here -- w/natural.width by h/natural.height --
  // and that is what squashed a PSD text layer the moment it went live: the
  // box was Photoshop's INK extent and our measurement a LINE BOX, so the two
  // ratios differed by ~1.4x with nothing resized at all. Both are ink extents
  // now, but a corner drag still does not lock aspect, so one scale -- the
  // smaller of the two -- is what keeps glyph shape in any rectangle.
  calls.length = 0;
  const natural = measure(textLayer.text);
  rasteriseTextAt(textLayer, natural.width * 10, natural.height * 4);

  const t = calls.find((c) => c[0] === 'setTransform');
  assert.equal(t[1], t[4], 'one scale, on both axes');
  assert.equal(t[1], 4, 'the axis with the least room decides it');
  assert.deepEqual([t[2], t[3]], [0, 0], 'no shear');
  assert.deepEqual([t[5], t[6]], [0, 0], 'left-aligned glyphs sit against the left edge');
});

test('the slack in an over-wide box goes where the alignment says', () => {
  const natural = measure(textLayer.text);
  const drawn = natural.width * 4;                       // uniform scale is 4x

  for (const [align, expected] of [['left', 0], ['center', (natural.width * 10 - drawn) / 2],
                                   ['right', natural.width * 10 - drawn]]) {
    calls.length = 0;
    rasteriseTextAt({ ...textLayer, text: { ...textLayer.text, align } },
      natural.width * 10, natural.height * 4);
    const t = calls.find((c) => c[0] === 'setTransform');
    assert.equal(t[5], expected, align + '-aligned text is anchored wrong');
  }
});

test('a 10x scale-up re-shapes glyphs rather than enlarging pixels', () => {
  const natural = measure(textLayer.text);
  const small = rasteriseTextAt(textLayer, natural.width, natural.height);
  const large = rasteriseTextAt(textLayer, natural.width * 10, natural.height * 10);
  // Bitmap upscaling would have produced exactly 100x the source samples from
  // the same small render. Re-shaping produces its own buffer at full size.
  assert.equal(large.data.length, small.data.length * 100);
  assert.equal(large.width, natural.width * 10);
});

test('measureText reports the ink extent, not an invented line box', () => {
  // round(fontSize * 1.25) was a convention, not a font metric. Photoshop's
  // layer bounds are the INK extent of the glyphs, so measuring a LINE BOX
  // meant the first edit re-fitted the layer to a different quantity and the
  // text visibly changed size -- "size changes from the exact".
  const m = measure(textLayer.text);                    // 'ABCD' at 20px
  assert.equal(m.width, 40, 'four characters at 10px');
  assert.equal(m.height, 14, 'cap height at 20px -- not round(20 * 1.25) = 25');
  assert.equal(m.ascent, 14, 'ink top to first baseline');
  assert.equal(m.offsetX, 0, 'this face has no ink left of the pen');
});

test('line spacing comes from the font box, not from the ink height', () => {
  // Ink extent gives the glyphs' bounds, never the distance between baselines:
  // "AB" over "CD" would collide at 14px apart. fontBoundingBoxAscent +
  // Descent is the font's own line advance and is what separates them.
  const one = measure({ ...textLayer.text, content: 'AB' });
  const two = measure({ ...textLayer.text, content: 'AB\nCD' });

  assert.equal(two.lineHeight, 22, '(0.9 + 0.2) * 20, the font box -- not 0.7 * 20 of ink');
  assert.equal(one.height, 14, 'one line is its ink and nothing more');
  assert.equal(two.height, 36, 'ink ascent of the first line plus one line advance');
  assert.equal(two.height - one.height, two.lineHeight, 'each extra line costs exactly one advance');
});

test('a font box the platform does not report falls back to 1.2em, and says so', () => {
  // 1.2 is Photoshop's OWN autoLeading -- fixtures/text.src.psd carries
  // paragraphStyle.autoLeading: 1.2 -- and CSS 'normal' for Latin faces. It is
  // still a fallback: every current browser reports fontBoundingBox*, and this
  // branch exists for the ones that do not.
  const full = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        font: '', fillStyle: '', textBaseline: '', textAlign: '',
        setTransform() {}, fillText() {},
        measureText: (str) => ({ width: str.length * 10 }),   // advance only
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      }),
    }),
  };
  try {
    const m = measure({ ...textLayer.text, content: 'AB\nCD' });
    assert.equal(m.lineHeight, 24, 'round(20 * 1.2)');
    assert.equal(m.width, 20, 'the advance is the only width on offer');
    assert.equal(m.height, 48, 'exactly two fallback line boxes -- the old behaviour, at 1.2 rather than an invented 1.25');
  } finally { globalThis.document = full; }
});

test('glyphs are drawn from the baseline, at the ink ascent', () => {
  // textBaseline 'top' plus a line box is what made the box and the glyphs
  // disagree. The ink box has its own reference point: the first baseline sits
  // exactly `ascent` below the top of the box, and every later one one line
  // advance below that.
  calls.length = 0;
  const two = { ...textLayer, text: { ...textLayer.text, content: 'AB\nCD' } };
  const natural = measure(two.text);
  rasteriseTextAt(two, natural.width, natural.height);

  assert.ok(calls.some((c) => c[0] === 'textBaseline' && c[1] === 'alphabetic'),
    'ink metrics are measured from the baseline, so the draw has to use it');
  const ys = calls.filter((c) => c[0] === 'fillText').map((c) => c[3]);
  assert.deepEqual(ys, [14, 36], 'ascent, then ascent + one line advance');
});

test('a Photoshop line break is a line break', () => {
  // Photoshop stores breaks as CR (\r), not LF. NONE of the 21 fixtures
  // exercises this -- every one carries the single-line "TEST" -- so the layer
  // below is SYNTHETIC, and deliberately so: the alternative is asserting
  // nothing at all about the one separator every PSD actually uses.
  const of = (content) => measure({ ...textLayer.text, content });

  assert.deepEqual(of('AB\rCD').lines, ['AB', 'CD'], 'CR is how Photoshop writes a break');
  assert.deepEqual(of('AB\nCD').lines, ['AB', 'CD'], 'LF is what a textarea hands back');
  assert.deepEqual(of('AB\r\nCD').lines, ['AB', 'CD'], 'CRLF is ONE break, not two');
  assert.deepEqual(of('AB\rCD\nEF\r\nGH').lines, ['AB', 'CD', 'EF', 'GH'], 'mixed separators');

  // The reported symptom: the breaks look right until the layer goes live,
  // then collapse to one line. Same string, same box, whichever separator.
  assert.equal(of('AB\rCD').height, of('AB\nCD').height, 'CR and LF must measure identically');
  assert.ok(of('AB\rCD').height > of('ABCD').height, 'two lines are taller than one');
});

/**
 * Paragraph (box) text wraps; point text does not.
 *
 * PSD text is one of two shapes and ag-psd reports which. Point text breaks at
 * the characters the author typed and nowhere else. BOX text is laid out inside
 * a rectangle the author drew, and Photoshop wraps it to that rectangle's
 * width — so every visual line break in a paragraph layer is one Photoshop
 * COMPUTED, not one stored in the string. Nothing here wrapped, so a headline
 * that reads as three lines in Photoshop arrived as one long line the instant
 * we took over rendering. The user called that "line breaks not preserved";
 * the CR-versus-LF fix above is a different bug that shares the symptom.
 *
 * The stub advances 10px per character at any size, so a box width of 100 is
 * ten characters — spaces included, because a stub space is a 10px character
 * like any other.
 */
const boxText = (content, boxWidth) =>
  ({ ...textLayer.text, content, shapeType: 'box', boxWidth });

test('point text is never wrapped, whatever box width is hanging off it', () => {
  // The branch has to key on shapeType, not on the mere presence of a width.
  const m = measure({ ...textLayer.text, content: 'ONE TWO THREE FOUR FIVE', boxWidth: 100 });
  assert.equal(m.lines.length, 1, 'point text breaks only where the author typed a break');
  assert.equal(wrapsInBox({ ...textLayer.text, boxWidth: 100 }), false);
});

test('box text wraps to the box width, on measured widths', () => {
  const m = measure(boxText('ONE TWO THREE FOUR FIVE', 129));
  assert.deepEqual(m.lines, ['ONE TWO', 'THREE FOUR', 'FIVE']);
  assert.equal(m.width, 100, 'the block is as wide as its widest LINE, not as the box');
  assert.equal(m.height, 14 + 2 * 22, 'first line ink plus two font-box advances');
});

test('a box with no usable width does not wrap — and does not loop', () => {
  for (const width of [undefined, null, 0, -5, NaN]) {
    const m = measure(boxText('ONE TWO THREE', width));
    assert.equal(m.lines.length, 1, `boxWidth ${width} must fall back to no wrapping`);
    assert.equal(wrapsInBox(boxText('ONE TWO THREE', width)), false);
  }
});

test('explicit breaks and wrapping coexist — split first, then wrap each paragraph', () => {
  // Both mechanisms are real and neither replaces the other: Photoshop wraps a
  // paragraph AND honours the Return the author pressed inside it.
  assert.deepEqual(measure(boxText('ONE TWO THREE\nFOUR', 100)).lines,
    ['ONE TWO', 'THREE', 'FOUR']);
  assert.deepEqual(measure(boxText('ONE TWO THREE\rFOUR', 100)).lines,
    ['ONE TWO', 'THREE', 'FOUR'], "Photoshop's own separator is CR");
  assert.deepEqual(measure(boxText('AB\n\nCD', 100)).lines, ['AB', '', 'CD'],
    'an empty paragraph is still a line — it advances the baseline');
});

test('a word wider than the box overflows its line rather than being dropped or broken', () => {
  // Three behaviours were available: break mid-word, drop it, or let it
  // overhang. Photoshop overhangs when it cannot hyphenate, and we do not
  // hyphenate at all — so a mid-word break would invent a break Photoshop never
  // makes, and dropping is never an option. The greedy loop consumes one token
  // per iteration whatever the widths, so an unfittable word cannot spin it.
  const m = measure(boxText('AB LONGWORD CD', 40));
  assert.deepEqual(m.lines, ['AB', 'LONGWORD', 'CD'], 'kept whole, on a line of its own');
  assert.equal(m.width, 80, 'the block reports the overhang honestly rather than clipping to 40');
});

test('the render cache key follows the box width', () => {
  // renderedKey is what stops a re-rasterise every frame. A width missing from
  // it means a re-wrapped layer keeps drawing the OLD line breaks until
  // something else in the key happens to move.
  const layer = {
    kind: 'text', rerendered: true, visible: true, opacity: 1, blendMode: 'normal',
    x: 0, y: 0, w: 100, h: 60,
    text: boxText('ONE TWO THREE', 100),
  };
  const dest = createBuffer(100, 60);
  drawLayerInto(dest, layer, 1);
  const first = layer.renderedKey;
  assert.ok(first, 'the layer should have rasterised and cached');

  drawLayerInto(dest, layer, 1);
  assert.equal(layer.renderedKey, first, 'an unchanged layer must not re-rasterise');

  layer.text = boxText('ONE TWO THREE', 200);
  drawLayerInto(dest, layer, 1);
  assert.notEqual(layer.renderedKey, first, 'a wider box is a different set of line breaks');
});

test('resizing a text layer switches it to live rendering', () => {
  const tl = textProject.layers.find((l) => l.kind === 'text');
  assert.ok(tl, 'text.src.psd must contain a text layer');
  assert.equal(tl.rerendered, false, 'should start on Photoshop pixels');
  setLayer(textProject, tl.id, { w: tl.w * 3, h: tl.h * 3, rerendered: true });
  assert.equal(tl.rerendered, true);
  undo(textProject);
  assert.equal(tl.rerendered, false, 'undo should restore Photoshop pixels');
});

test('changing text clears the render cache key, not just the pixels', () => {
  const tl = textProject.layers.find((l) => l.kind === 'text');
  assert.ok(tl, 'text.src.psd must contain a text layer');
  tl.rendered = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  tl.renderedKey = 'stale';
  setLayer(textProject, tl.id, { text: { content: 'changed' } });
  assert.equal(tl.renderedKey, null, 'a stale key would return null pixels and hide the layer');
  undo(textProject);
});

test('a multi-line string survives measure, save and reopen', () => {
  // The whole round trip: content as a PSD carries it, retyped through a
  // textarea (whose value is always LF), measured, written to a project file
  // and read back. One separator has to come out the far end.
  const tl = textProject.layers.find((l) => l.kind === 'text');
  setLayer(textProject, tl.id, { text: { content: 'AB\nCD' } });

  const json = JSON.parse(JSON.stringify(toProjectJson(textProject)));
  setLayer(textProject, tl.id, { text: { content: 'wiped' } });
  applyProjectJson(textProject, json);

  assert.equal(tl.text.content, 'AB\nCD', 'the break must survive the save file');
  assert.deepEqual(measure(tl.text).lines, ['AB', 'CD'], 'and still measure as two lines');
});

/**
 * A text layer in the shape `createProject` reads, so the transform disclosures
 * run against the real `toLayer()` without needing a fixture that carries a
 * rotation. No fixture does: all four text layers in the corpus are upright and
 * uniformly scaled, which is exactly why these two paths shipped unwarned.
 * The NUMBERS that come from a file are asserted in test/text-engine.mjs.
 */
const textDoc = (transform, style = {}) => ({
  width: 100, height: 100, warnings: [],
  children: [{
    name: 'Headline', left: 10, top: 10, right: 90, bottom: 40,
    text: { text: 'Hi', transform, style: { fontSize: 40, ...style } },
  }],
});

test('a rotated text layer is disclosed rather than drawn upright in silence', () => {
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const project = createProject(textDoc([c, s, -s, c, 0, 0]), 'rotated.psd');
  const warning = project.warnings.find((w) => /rotated/.test(w));
  assert.ok(warning, 'rotation is thrown away by hypot() — saying so is the whole fix');
  assert.match(warning, /"Headline" is rotated 30°/);
  assert.equal(project.layers[0].text.fontSize, 40, 'the SIZE is still right; only the angle is lost');
});

test('a stretched text layer is disclosed, and its size follows the vertical axis', () => {
  const project = createProject(textDoc([2, 0, 0, 0.5, 0, 0]), 'stretched.psd');
  const warning = project.warnings.find((w) => /stretched/.test(w));
  assert.ok(warning, 'a non-uniform scale means genuinely stretched glyphs we cannot draw');
  assert.match(warning, /400% as wide as it is tall/);
  assert.match(warning, /narrower than Photoshop/);
  // 40 x 0.5, not 40 x the average of 2 and 0.5 — an average is a size neither
  // axis has, and it would hide the stretch in the same move.
  assert.equal(project.layers[0].text.fontSize, 20);
});

test('an upright, uniformly scaled text layer says nothing', () => {
  const project = createProject(textDoc([0.25, 0, 0, 0.25, 0, 0]), 'plain.psd');
  assert.deepEqual(project.warnings.filter((w) => /rotated|stretched/.test(w)), []);
  assert.equal(project.layers[0].text.fontSize, 10);
});

test("the file's own size and scale survive a save and reopen", () => {
  // The sheet shows "Photoshop: 66.7px at 25%" from these two fields. A project
  // file that dropped them would turn that disclosure into a blank on reopen.
  const project = createProject(textDoc([0.25, 0, 0, 0.25, 0, 0], { fontSize: 66.66666 }), 'plain.psd');
  const layer = project.layers[0];
  assert.equal(layer.text.sourceFontSize, 66.66666);
  assert.equal(layer.text.sourceScale, 0.25);
  assert.equal(layer.text.fontSize, 17, '66.66666 x 0.25 = 16.67, rounded');

  const json = JSON.parse(JSON.stringify(toProjectJson(project)));
  setLayer(project, layer.id, { text: { sourceFontSize: 1, sourceScale: 9 } });
  applyProjectJson(project, json);
  assert.equal(layer.text.sourceFontSize, 66.66666);
  assert.equal(layer.text.sourceScale, 0.25);
});

test('the UI offers exactly the blend modes the compositor implements', () => {
  // These drifted by eight modes once: the compositor handled 26, the UI listed
  // 18, so a file using `vivid light` rendered correctly while the user could
  // neither see nor preserve the mode. Asserting both directions — a hidden
  // mode is a lost feature, a phantom mode renders wrong.
  const hidden = SUPPORTED_BLEND_MODES.filter((m) => !BLEND_MODES.includes(m));
  const phantom = BLEND_MODES.filter((m) => !SUPPORTED_BLEND_MODES.includes(m));
  assert.deepEqual(hidden, [], 'implemented by the compositor but hidden from the user');
  assert.deepEqual(phantom, [], 'offered to the user but not implemented — would render wrong');
});


// ------------------------------------------ the vector-mask disclosure
// This warning fired on every vector-masked layer in the corpus and was false
// on every one of them: shapes.src.psd and vectors.src.psd hold 8 between
// them, all composited bit-exact against Photoshop. It asked whether a
// RASTERISED mask sat beside the path, but a Photoshop shape layer has no
// separate mask -- the path is already baked into its own pixels. So the
// question had to become what we would DRAW.
//
// Both directions are pinned. Deleting a warning is trivially "green", and a
// silence test alone could not tell that apart from a real fix.

/** A leaf as readDocument hands it over, with only the fields this asks about. */
const leaf = (over) => ({ name: 'shape', ...over });
const pixels = () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) });
const vectorWarnings = (node) =>
  [...createProject({ width: 4, height: 4, children: [node] }, 't.psd').warnings]
    .filter((w) => /vector/i.test(w));

test('a path with no pixels to draw is still disclosed', () => {
  const [warning] = vectorWarnings(leaf({ vectorMask: { paths: [] } }));
  assert.ok(warning, 'a live shape we cannot rasterise must still be reported');
  assert.match(warning, /no pixels/);
});

test('a path already baked into the layer pixels is not disclosed', () => {
  // The regression itself. Photoshop crops these to the shape's own bounds,
  // which is what makes them render correctly with no mask in sight.
  assert.deepEqual(vectorWarnings(leaf({ vectorMask: { paths: [] }, imageData: pixels() })), []);
});

test('a streamed load is judged on proxyData, not imageData', () => {
  // Asking only about imageData would put the false warning straight back for
  // every document that arrives through loadProjectProxy -- which is all of
  // them, in the app.
  assert.deepEqual(vectorWarnings(leaf({ vectorMask: { paths: [] }, proxyData: pixels() })), []);
});

test('a rasterised mask beside the path is still enough on its own', () => {
  assert.deepEqual(vectorWarnings(leaf({ vectorMask: { paths: [] }, mask: { imageData: {} } })), []);
});

delete globalThis.document;
console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}\n`);
