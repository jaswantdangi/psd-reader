/**
 * A PSD text layer's type-engine data: the transform it is drawn under, and
 * the typeface it names.
 *
 * ag-psd gives us `layer.text` — the string, a style, a 2x3 transform. Two
 * things in there were being thrown away by the model, and both are visible on
 * screen:
 *
 *   1. **`style.fontSize` is the PRE-transform size.** Photoshop draws
 *      `fontSize x scale`. `fixtures/float-color.src.psd`'s "outer glow" says
 *      66.66666 and is drawn at 16.6, because its matrix scales by 0.249.
 *      Reading `fontSize` alone drew it four times too large; a file that
 *      scales UP draws its headline far too small.
 *   2. **The typeface name.** The model substituted `FONT_STACKS[0]` for every
 *      text layer, so a serif headline became Arial and nothing said so.
 *
 * ## Why this file also parses the raw block, when ag-psd already decodes it
 *
 * It does NOT parse it on the read path — that would be a second decode of
 * something already in hand, paid for by every file that is opened. The parser
 * below exists as an ORACLE: `test/text-engine.mjs` reads the same bytes a
 * second, independent way and demands the two answers agree, because the font
 * name is the thing we are about to show a user and "the library said so" is
 * not evidence.
 *
 * It earned that place immediately. A throwaway regex spike (`spike/font-probe.mjs`)
 * reported real font names for four fixtures. Read structurally, three of those
 * four are wrong:
 *
 *   - `werps.src.psd` — reported ["Roboto-Regular", "MyriadPro-Regular"]. It has
 *     `/EngineDict` in its bytes and NO live text layer: not one of its seven
 *     layer records carries a TySh block, and ag-psd exposes no `text` on any of
 *     them. A whole-file scan cannot tell a layer's engine data from a stray
 *     copy of one.
 *   - `text.src.psd`, `text-box.src.psd` — reported "MyriadPro-Regular". Their
 *     style runs name no font at all. The spike scanned from `/StyleRun` for
 *     8000 characters "up to /ParagraphRun", but /ParagraphRun comes BEFORE
 *     /StyleRun in every one of these files, so the window ran past the layer's
 *     runs entirely and picked up `/Font 1` from ResourceDict's document-level
 *     StyleSheetSet. FontSet[1] there happens to be MyriadPro-Regular, which is
 *     what made the wrong answer look right.
 *
 * So across the corpus exactly ONE layer names a real typeface —
 * float-color.src.psd's "outer glow", AachenBTBold — and ag-psd already
 * resolves it correctly, because `decodeEngineData` indexes `/Font` into
 * `ResourceDict.FontSet` exactly as the format says. The production path
 * therefore reads ag-psd's `style.font.name` and this file's job is to know
 * that is right.
 *
 * ## What the placeholder means
 *
 * `AdobeInvisFont` is not a typeface. Photoshop writes it at FontSet index 0,
 * and ag-psd substitutes `FontSet[0]` whenever a run names no font — so
 * "AdobeInvisFont" reaches us both when the file says index 0 and when the file
 * says nothing. Either way the answer is "this file does not tell us", and
 * reporting it as a font name would be a lie with a plausible shape.
 *
 * No dependencies, no DOM, no ag-psd. Same code in a browser, a worker and Node.
 */

// ---------------------------------------------------------------- substitution

/**
 * Font stacks the renderer can actually draw on a phone.
 *
 * A PSD stores font NAMES, never font FILES. `MyriadPro-Regular` is licensed
 * and absent from most machines, so knowing the name never becomes a matching
 * glyph — it only lets us choose a better substitute and say what we did.
 */
export const FONT_STACKS = [
  'Arial, Helvetica, sans-serif',
  'Helvetica, Arial, sans-serif',
  '"Segoe UI", system-ui, sans-serif',
  'Verdana, Geneva, sans-serif',
  'Tahoma, sans-serif',
  '"Times New Roman", Times, serif',
  'Georgia, serif',
  '"Courier New", Courier, monospace',
  'Impact, sans-serif',
];

/** Photoshop's index-0 placeholder. Never a typeface, whatever it looks like. */
export const PLACEHOLDER_FONT = 'AdobeInvisFont';

/** Comparison form: letters only, so `Georgia-Bold` and `Georgia` meet. */
const squash = (name) => String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Weight and foundry suffixes, stripped only AFTER an exact match has been
 * tried — `roman` is a style word in `TimesRoman` and a family word in
 * `TimesNewRoman`, and the exact match settles that before this can get it
 * wrong.
 */
const SUFFIXES = /(regular|bolditalic|semibold|demibold|extrabold|ultrabold|bold|italic|oblique|light|medium|black|heavy|thin|book|condensed|narrow|extended|display|caption|subhead|mt|ps|bt|std|pro|ce|ms)+$/;

/** The first family in each stack, in comparison form. */
const STACK_BY_FAMILY = new Map(
  FONT_STACKS.map((stack) => [squash((stack.split(',')[0] ?? '').replace(/["']/g, '')), stack]),
);

const MONO = /mono|courier|consol|typewriter|code|prestige/;
// Checked BEFORE serif, or every "sans-serif" and "OpenSans" lands in it.
const SANS = /sans|grotes[kq]|gothic|helvetic|arial|verdana|tahoma|segoe|calibri|futura|frutiger|myriad|roboto|lato|inter|univers|avenir|nimbus|franklin|akzidenz/;
const SERIF = /serif|times|roman|garamond|caslon|baskerville|bodoni|didot|minion|georgia|palatino|cambria|constantia|utopia|charter|century|clarendon|antiqua|slab|elzevir/;

/**
 * The closest stack we can actually draw, for a name we cannot load.
 *
 * A small, honest heuristic and nothing more: an exact family match where we
 * happen to have the same family, then serif / sans / mono by keyword, then the
 * default. It is a substitution, not a match, which is why every caller is
 * expected to SAY so — see `text.sourceFont` on the layer and the text sheet.
 *
 * Its limits are real and should not be papered over by adding entries per
 * fixture: `AachenBTBold` is a slab serif and nothing in that NAME says so, so
 * it lands on the default sans. A name-based rule cannot know a shape.
 */
export function fontStackFor(name) {
  const squashed = squash(name);
  if (!squashed) return FONT_STACKS[0];

  const exact = STACK_BY_FAMILY.get(squashed) ?? STACK_BY_FAMILY.get(squashed.replace(SUFFIXES, ''));
  if (exact) return exact;

  if (MONO.test(squashed)) return '"Courier New", Courier, monospace';
  if (SANS.test(squashed)) return FONT_STACKS[0];
  if (SERIF.test(squashed)) return 'Georgia, serif';
  return FONT_STACKS[0];
}

/**
 * The typeface the FILE names, or null when it names none.
 *
 * @param {{font?: {name?: string}}} [style]  ag-psd's `layer.text.style`
 */
export function sourceFontName(style) {
  const name = style?.font?.name;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === PLACEHOLDER_FONT) return null;
  return trimmed;
}

// ---------------------------------------------------------------- the transform

/** Below this the two axes are the same scale — float-color's differ by 0.04%. */
const UNIFORM_TOLERANCE = 0.005;
/** Degrees. Photoshop writes 0 exactly for an untransformed layer. */
const ANGLE_TOLERANCE = 0.05;

const DEGREES = 180 / Math.PI;

/**
 * Decompose a PSD text transform `[a, b, c, d, tx, ty]`.
 *
 * The matrix maps `x' = a*x + c*y + tx`, `y' = b*x + d*y + ty`, so column one
 * is the image of the x-axis and column two the image of the y-axis:
 * `scaleX = hypot(a, b)`, `scaleY = hypot(c, d)`.
 *
 * `hypot` recovers the lengths and DISCARDS the directions, which is why
 * `rotation` and `skew` are reported rather than left implicit: a rotated layer
 * whose scale we got right still renders upright, and drawing it upright at the
 * correct size is not correctness, it is a wrong picture with right numbers in
 * it. The caller is expected to surface them.
 *
 * A transform we cannot read falls back to IDENTITY, never to zero: a scale of
 * 0 computes a font size of 0 and draws nothing at all, which is the one
 * failure mode worse than the bug.
 *
 * @param {number[]} [transform]
 * @returns {{scaleX:number, scaleY:number, rotation:number, skew:number,
 *            uniform:boolean, rotated:boolean, identity:boolean}}
 *   `rotation` and `skew` are degrees.
 */
export function textTransformOf(transform) {
  const identity = { scaleX: 1, scaleY: 1, rotation: 0, skew: 0, uniform: true, rotated: false, identity: true };

  if (!Array.isArray(transform) || transform.length < 4) return identity;
  const [a, b, c, d] = transform;
  if (![a, b, c, d].every((n) => typeof n === 'number' && Number.isFinite(n))) return identity;

  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  if (!(scaleX > 0) || !(scaleY > 0)) return identity;

  // Angle of the x-axis image, and how far the y-axis image departs from
  // perpendicular to it. Both are zero for a pure scale.
  const rotation = Math.atan2(b, a) * DEGREES;
  const skew = Math.atan2(-c, d) * DEGREES - rotation;

  const rotated = Math.abs(rotation) > ANGLE_TOLERANCE || Math.abs(skew) > ANGLE_TOLERANCE;
  const uniform = Math.abs(scaleX / scaleY - 1) <= UNIFORM_TOLERANCE;

  return {
    scaleX, scaleY, rotation: rotated ? rotation : 0, skew: rotated ? skew : 0,
    uniform, rotated,
    identity: !rotated && uniform && Math.abs(scaleX - 1) <= UNIFORM_TOLERANCE
      && Math.abs(scaleY - 1) <= UNIFORM_TOLERANCE,
  };
}

/**
 * The size Photoshop actually draws: the style's size times the transform's
 * VERTICAL scale.
 *
 * Vertical, not an average of the two axes. A font size is a vertical measure —
 * it is the em box — so on a genuinely stretched layer (`scaleX !== scaleY`,
 * which is legal and means stretched glyphs) the vertical axis is the one that
 * answers "what size is this text". Averaging would invent a size that neither
 * axis has and hide the stretch in the same move; the stretch is reported by
 * `textTransformOf().uniform` instead, and this renderer cannot draw it.
 */
export function effectiveFontSize(style, transform) {
  const base = style?.fontSize;
  if (typeof base !== 'number' || !Number.isFinite(base)) return 0;
  return base * textTransformOf(transform).scaleY;
}

// ------------------------------------------------- the raw block (test oracle)

const LARGE_KEYS = new Set([
  'LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph',
  'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD', 'cinf',
]);

const sig = (dv, offset, length = 4) => {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(dv.getUint8(offset + i));
  return out;
};

/**
 * Every layer record carrying a type-tool block, with its raw EngineData.
 *
 * Walks the layer records structurally — the only way to know that a stretch of
 * `/EngineDict` bytes belongs to a live text LAYER rather than to a smart
 * object, a warp, or a copy left in a resource. That distinction is the whole
 * difference between this and a regex; see the note at the top of the file for
 * the three fixtures a regex gets wrong.
 *
 * THROWS on a structure it cannot follow. Returning `[]` would be
 * indistinguishable from a file with no text in it, and a silent wrong answer
 * about a font is exactly what this module exists to prevent.
 *
 * @param {Uint8Array} bytes  Whole PSD/PSB file.
 * @returns {{name:string, rect:{left:number,top:number,right:number,bottom:number},
 *            transform:number[], engineData:Uint8Array}[]}
 */
export function readTextEngineLayers(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;

  if (sig(dv, o) !== '8BPS') throw new Error('Not a PSD/PSB file (bad signature)');
  o += 4;
  const version = dv.getUint16(o);
  if (version !== 1 && version !== 2) throw new Error(`Unknown PSD version ${version}`);
  const psb = version === 2;
  o += 2;
  o += 6 + 2 + 4 + 4 + 2 + 2;   // reserved, channels, height, width, depth, colour mode
  o += 4 + dv.getUint32(o);     // colour mode data
  o += 4 + dv.getUint32(o);     // image resources

  // Layer and mask information, then the layer info section inside it.
  o += psb ? 8 : 4;
  const layerInfoLength = psb ? Number(dv.getBigUint64(o)) : dv.getUint32(o);
  o += psb ? 8 : 4;
  if (!layerInfoLength) return [];   // 16/32-bit documents keep layers in Lr16/Lr32; none here does
  const layerInfoEnd = o + layerInfoLength;

  const count = Math.abs(dv.getInt16(o));
  o += 2;

  const out = [];
  for (let i = 0; i < count; i++) {
    if (o + 18 > layerInfoEnd) throw new Error(`Layer record ${i} runs past the layer info section`);

    const top = dv.getInt32(o), left = dv.getInt32(o + 4);
    const bottom = dv.getInt32(o + 8), right = dv.getInt32(o + 12);
    o += 16;
    const channels = dv.getUint16(o);
    o += 2 + channels * (psb ? 10 : 6);              // channel count, then channel info

    const blendSig = sig(dv, o);
    if (blendSig !== '8BIM') throw new Error(`Layer record ${i}: expected 8BIM, found "${blendSig}"`);
    o += 4 + 4 + 1 + 1 + 1 + 1;                      // blend key, opacity, clipping, flags, filler

    const extraLength = dv.getUint32(o);
    o += 4;
    const extraEnd = o + extraLength;
    if (extraEnd > layerInfoEnd) throw new Error(`Layer record ${i}: extra data runs past the section`);

    o += 4 + dv.getUint32(o);                        // layer mask data
    o += 4 + dv.getUint32(o);                        // layer blending ranges

    const nameLength = dv.getUint8(o);
    let name = sig(dv, o + 1, nameLength);
    o += 1 + nameLength;
    o += (4 - ((1 + nameLength) % 4)) % 4;           // Pascal name is padded to a multiple of 4

    let engineData = null;
    let transform = null;
    while (o + 12 <= extraEnd) {
      const infoSig = sig(dv, o);
      if (infoSig !== '8BIM' && infoSig !== '8B64') break;   // resynced to extraEnd below either way
      const key = sig(dv, o + 4);
      const large = infoSig === '8B64' || (psb && LARGE_KEYS.has(key));
      let p = o + 8;
      const length = large ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
      p += large ? 8 : 4;
      if (p + length > extraEnd) throw new Error(`Layer record ${i}: "${key}" claims ${length} bytes it does not have`);

      if (key === 'luni') {
        const chars = dv.getUint32(p);
        name = new TextDecoder('utf-16be').decode(bytes.subarray(p + 4, p + 4 + chars * 2));
      } else if (key === 'TySh') {
        transform = Array.from({ length: 6 }, (_, k) => dv.getFloat64(p + 2 + k * 8));
        engineData = engineDataIn(bytes, p, length);
        if (!engineData) throw new Error(`Layer record ${i}: TySh block carries no EngineData`);
      }

      o = p + length + (length % 2);                 // additional info is padded to a multiple of 2
    }
    o = extraEnd;

    if (engineData) out.push({ name, rect: { left, top, right, bottom }, transform, engineData });
  }

  return out;
}

/**
 * The `EngineData` value inside a TySh block.
 *
 * Found by its descriptor framing rather than by searching for the ten
 * characters: a key is a uint32 length followed by that many characters, and a
 * raw-data value is the type `tdta` followed by its own uint32 length. Matching
 * all three at once — length 10, the name, the type — is what stops a stray
 * occurrence of the word inside the string data from being taken for the key,
 * and the length prefix then bounds the slice exactly instead of guessing where
 * it ends.
 */
function engineDataIn(bytes, start, length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = start + length;
  for (let i = start; i + 22 <= end; i++) {
    if (dv.getUint32(i) !== 10) continue;
    if (sig(dv, i + 4, 10) !== 'EngineData') continue;
    if (sig(dv, i + 14) !== 'tdta') continue;
    const size = dv.getUint32(i + 18);
    if (i + 22 + size > end) throw new Error(`EngineData claims ${size} bytes past the end of its TySh block`);
    return bytes.subarray(i + 22, i + 22 + size);
  }
  return null;
}

// ---- the EngineData dictionary format ---------------------------------------

const WHITESPACE = new Set([32, 10, 13, 9]);
const isDigit = (b) => (b >= 48 && b <= 57) || b === 46 || b === 45;

/**
 * Parse the text form of EngineData into plain objects, arrays, numbers,
 * booleans and strings.
 *
 * A tokeniser rather than a regex, because the format has three features a
 * regex silently mis-reads:
 *
 *   - **Strings are UTF-16BE behind a `\xFE\xFF` BOM.** `/Name (...)` is not
 *     ASCII; a name with a CJK or RTL character is not even close.
 *   - **`(` `)` and `\` are escaped at BYTE level, before the UTF-16 decode.**
 *     A font called `Fun)Face` is written with a backslash in the middle of a
 *     UTF-16 code unit, so `\(([^)]*)\)` truncates it AND `[^)]*` cannot span
 *     the escape.
 *   - **It nests.** `/FontSet` in `ResourceDict` and `/FontSet` in
 *     `DocumentResources` are two different arrays and only one of them is the
 *     one a StyleRun indexes into. Bracket counting finds the first; structure
 *     finds the right one.
 *
 * @param {Uint8Array} data  the raw EngineData bytes
 */
export function parseEngineData(data) {
  if (!(data instanceof Uint8Array)) throw new Error('parseEngineData needs the raw engine data bytes');

  let i = 0;
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;      // Photoshop pads the block with NULs

  const skipSpace = () => { while (i < end && WHITESPACE.has(data[i])) i++; };

  skipSpace();
  if (!(data[i] === 0x3c && data[i + 1] === 0x3c))
    throw new Error('Not engine data — expected a dictionary at the start of the block');

  /** One byte of string content, resolving a backslash escape. */
  const textByte = () => {
    let b = data[i++];
    if (b === 0x5c) b = data[i++];
    return b;
  };

  const readString = () => {
    i++;                                             // the opening (
    if (data[i] === 0x29) { i++; return ''; }        // an empty string carries no BOM
    if (data[i] !== 0xfe || data[i + 1] !== 0xff)
      throw new Error(`Engine data string at byte ${i} has no UTF-16 BOM`);
    i += 2;
    let out = '';
    while (i < end && data[i] !== 0x29) {
      const high = textByte();
      const low = textByte();
      out += String.fromCharCode((high << 8) | low);
    }
    if (i >= end) throw new Error('Engine data string is not terminated');
    i++;                                             // the closing )
    return out;
  };

  const readToken = () => {
    const start = i;
    while (i < end && !WHITESPACE.has(data[i]) && data[i] !== 0x2f
      && data[i] !== 0x3c && data[i] !== 0x3e && data[i] !== 0x5b && data[i] !== 0x5d) i++;
    let out = '';
    for (let k = start; k < i; k++) out += String.fromCharCode(data[k]);
    return out;
  };

  /** Everything after `<<` up to its matching `>>`. */
  const readDict = () => {
    i += 2;
    const out = {};
    for (;;) {
      skipSpace();
      if (i >= end) throw new Error('Engine data ended inside a dictionary');
      if (data[i] === 0x3e && data[i + 1] === 0x3e) { i += 2; return out; }
      if (data[i] !== 0x2f) throw new Error(`Engine data: expected a /Key at byte ${i}`);
      i++;
      const key = readToken();
      if (!key) throw new Error(`Engine data: empty key at byte ${i}`);
      skipSpace();
      out[key] = readValue();
    }
  };

  const readArray = () => {
    i++;
    const out = [];
    for (;;) {
      skipSpace();
      if (i >= end) throw new Error('Engine data ended inside an array');
      if (data[i] === 0x5d) { i++; return out; }
      out.push(readValue());
    }
  };

  function readValue() {
    skipSpace();
    if (data[i] === 0x3c && data[i + 1] === 0x3c) return readDict();
    if (data[i] === 0x5b) return readArray();
    if (data[i] === 0x28) return readString();
    if (data[i] === 0x2f) { i++; return '/' + readToken(); }   // a name used as a value
    if (isDigit(data[i])) {
      const token = readToken();
      const n = Number(token);
      if (!Number.isFinite(n)) throw new Error(`Engine data: "${token}" is not a number`);
      return n;
    }
    const token = readToken();
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null' || token === 'nil') return null;
    throw new Error(`Engine data: cannot read "${token}" at byte ${i}`);
  }

  return readDict();
}

/**
 * The font facts a text layer's engine data states, read from the block itself.
 *
 * Every run's `/Font` is an index into `ResourceDict.FontSet` and NOT into
 * `DocumentResources.FontSet`, which is a different array in the same block.
 * A run with no `/Font` key names no font: `fontIndex` is null and Photoshop —
 * and ag-psd after it — falls back to `FontSet[0]`, which is normally the
 * `AdobeInvisFont` placeholder. That is a real distinction and it is kept here,
 * because "the file says index 0" and "the file says nothing" look identical
 * once the fallback has been applied.
 *
 * Throws rather than filling a gap in: a font name is worthless unless it is
 * the file's own.
 *
 * @param {Uint8Array} engineData
 * @returns {{fontSet:string[], runs:{length:number|null, fontIndex:number|null,
 *            fontName:string|null, fontSize:number|null}[], runCount:number,
 *            font:string}}
 */
export function textEngineFacts(engineData) {
  const data = parseEngineData(engineData);

  const fontSet = data?.ResourceDict?.FontSet;
  if (!Array.isArray(fontSet) || !fontSet.length)
    throw new Error('Engine data has no ResourceDict.FontSet — nothing can resolve a font index');
  const names = fontSet.map((f, n) => {
    if (typeof f?.Name !== 'string') throw new Error(`FontSet entry ${n} has no /Name`);
    return f.Name;
  });

  const styleRun = data?.EngineDict?.StyleRun;
  if (!Array.isArray(styleRun?.RunArray))
    throw new Error('Engine data has no EngineDict.StyleRun.RunArray');
  const lengths = Array.isArray(styleRun.RunLengthArray) ? styleRun.RunLengthArray : [];

  const runs = styleRun.RunArray.map((run, n) => {
    const sheet = run?.StyleSheet?.StyleSheetData;
    if (!sheet) throw new Error(`Style run ${n} has no StyleSheetData`);
    const fontIndex = typeof sheet.Font === 'number' ? sheet.Font : null;
    if (fontIndex !== null && !(fontIndex >= 0 && fontIndex < names.length))
      throw new Error(`Style run ${n} indexes font ${fontIndex}, outside a FontSet of ${names.length}`);
    return {
      length: typeof lengths[n] === 'number' ? lengths[n] : null,
      fontIndex,
      fontName: fontIndex === null ? null : names[fontIndex],
      fontSize: typeof sheet.FontSize === 'number' ? sheet.FontSize : null,
    };
  });

  return {
    fontSet: names,
    runs,
    runCount: runs.length,
    // The layer's font is the first run's, which is what our one-style-per-layer
    // model can carry. The per-run names are above, unaveraged.
    font: runs[0]?.fontName ?? names[0],
  };
}
