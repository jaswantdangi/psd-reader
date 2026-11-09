# psd-reader

Reads Photoshop PSD/PSB files in the browser, and composites their layers at exact position and order.

Built on [`ag-psd`](https://github.com/Agamnentzar/ag-psd) for structure, plus hand-written parsers for the metadata ag-psd doesn't read — the ICC colour profile, EXIF and IPTC.

## Why

`ag-psd` is excellent and surfaces **343 of 343** layer block keys across 21 real Photoshop files. But it reads no ICC profile, no EXIF and no IPTC, and it doesn't composite. This fills those gaps and adds a compositor.

Measured against Photoshop's own embedded composite on the same 21 files:

| | Files |
|---|---|
| Pixel-exact (<0.5% differ) | **12** |
| Within 10% | 5 |
| Above 10% | 4 |

Every remaining difference traces to a specific unimplemented feature — layer effects, adjustment layers, smart filters, blend-if ranges, artboard backgrounds, layer comps. All are reported as warnings at runtime rather than hidden.

## Install

```bash
npm install
node scripts/fetch-fixtures.mjs   # downloads the 21-file test corpus (~13 MB)
npm test
```

## Use

```js
import { readDocument, compositeDocument } from './src/index.js';

const doc = await readDocument(bytes);   // Uint8Array | ArrayBuffer

doc.width, doc.height, doc.bitsPerChannel, doc.colorMode
doc.children          // layer tree — children[0] is the BOTTOM layer
doc.layers            // flattened
doc.metadata.icc      // { description, colorSpace, version, intent, raw, … }
doc.metadata.exif     // parsed via exifr
doc.metadata.iptc     // { caption, byline, keywords, copyrightNotice, … }
doc.metadata.xmp      // raw XML string
doc.warnings          // what could not be recovered, and why it matters
```

### Pixels

Three modes, because memory is the binding constraint in a browser tab:

```js
// Structure and metadata only — cheapest.
await readDocument(bytes);

// Decode every layer and keep it. Peak scales with the document.
await readDocument(bytes, { pixels: 'eager' });

// Decode one layer at a time, hand it over, release it.
// Peak stays at roughly file size + one layer.
await readDocument(bytes, {
  pixels: 'stream',
  onLayer(layer, pixels) {
    // copy what you need — the buffer is released as soon as this returns
  },
});
```

Streaming 343 MB of pixel data costs about **35 MB** over doing nothing.

### Compositing

```js
import { compositeDocument, compareBuffers, flattenOnto, differenceBuffer } from './src/index.js';

const doc  = await readDocument(bytes, { pixels: 'eager', embedded: true });
const ours = compositeDocument(doc);        // our own layer stack
const theirs = doc.embeddedComposite;       // the preview Photoshop saved

// Compare what a viewer sees, not the RGB hiding under transparent pixels.
const stat = compareBuffers(flattenOnto(ours), flattenOnto(theirs));
stat.percentReal   // % differing beyond rounding — this is the number that means something
```

Supports position, order, opacity, visibility, layer masks, groups, clipping runs, and 20 separable plus 6 non-separable blend modes.

If you only need an accurate preview and not a live one, skip the compositor entirely — `doc.embeddedComposite` is what Photoshop rendered, exact by definition.

## Demo

```bash
npm run serve      # http://localhost:5173
```

Drop in a PSD. Shows the layer tree with positions, recovered metadata, and three preview tabs: Photoshop's composite, ours, and the amplified difference between them.

No bundler — the demo uses an import map and a small shim, since `ag-psd` ships UMD for browsers.

## Editor

```bash
npm run serve      # http://localhost:5173/demo/editor.html
```

A simple editor over the same pipeline:

- **Move and resize** any layer — drag on canvas, drag the handles, or type exact numbers. Shift constrains the aspect ratio; arrow keys nudge.
- **Text** — retype the content, change size, colour, font, alignment, bold/italic.
- **Layers** — reorder by dragging the list, toggle visibility, set blend mode and opacity.
- **Undo/redo** — Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z. A drag is a single undo step, not four hundred.
- **Export** — PNG of the flattened result, or a project JSON that replays your edits onto the same source PSD.

Transforms are **non-destructive**: a layer keeps its original pixels and `x/y/w/h` are applied at render time, so scaling down and back up loses nothing.

### Editor limits

- **Retyped text will not match Photoshop.** The PSD names its font as a placeholder (`AdobeInvisFont`) and does not embed the font file, so re-drawn text uses the browser's renderer and a system font. Affected layers are badged `re-drawn` in the layer list and flagged in the inspector. Moving, recolouring and resizing text without changing the string keeps Photoshop's own pixels and stays pixel-accurate.
- **Groups are flattened** so every layer stays individually editable. Lossless for pass-through groups at full opacity; anything else changes the render, and the editor says so on open.
- **No saving back to .psd** — see the read-only note above. Project JSON plus the original file is the round-trip path.

## Tests

```bash
npm test              # all four
npm run test:shim     # browser shim covers every ag-psd import
npm run test:read     # 21 fixtures parse; metadata matches an independent block scan
npm run test:composite  # our composite vs Photoshop's, per file
npm run test:edit     # edit model: undo, non-destructive resize, reorder, round-trip
```

`test:shim` runs first because a missing shim export blanks the demo page while every Node test still passes.

## Known limits

- **Pattern definitions (`Patt`) cannot be read.** Present in all 21 test files, supported by no library on any platform. Layers using pattern fills will not render correctly. The reader warns about this.
- **ICC is identified, not applied.** Nothing converts colour, so CMYK and wide-gamut documents display wrong. `metadata.icc.raw` holds the profile for a CMS.
- **The whole file must fit in memory.** `ag-psd` has no streaming reader, so very large PSBs won't open in a tab.
- **Read-only.** Writing was evaluated and dropped: ag-psd's writer peaks at 3.5–4.2× the decoded pixel data and silently drops `Patt`.
- **Decoding and compositing run on the main thread.** Both belong in a worker.
- 32-bit float documents composite through 8-bit maths.

## Layout

```
src/
  reader.js       readDocument() — the entry point
  composite.js    layer compositor + comparison helpers
  resources.js    raw image-resource block extraction (no dependencies)
  icc.js          ICC profile parser
  iim.js          IPTC-NAA parser
  canvas.js       worker-safe pixel backend; keeps Canvas out of the decode path
  edit.js         editable project model — commands, undo/redo, hit testing
  render.js       renders an edited project; bilinear resampling, text raster
demo/             inspector + editor, no build step
test/             four suites
scripts/          fixture downloader
```

## Licence

The test fixtures are downloaded from [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT) and are not redistributed here.

## License
ISC — see [LICENSE](LICENSE).
