/**
 * Matching the font NAMES a PSD stores to the font FILES a user supplies.
 *
 * ## The problem this solves, and the one it deliberately does not
 *
 * A PSD names a typeface and never carries it. `src/engine-data.js` reads that
 * name honestly — `AachenBTBold`, `MyriadPro-Regular` — and `fontStackFor`
 * picks the nearest thing a phone can definitely draw, which the text sheet
 * then discloses as a substitution. That is the correct behaviour for a name
 * nobody can resolve, and it is where fidelity stops.
 *
 * The thing that actually unblocks fidelity is not a better shaper. The browser
 * already embeds HarfBuzz and `canvas.fillText` shapes through it, so bundling
 * a WASM shaping engine would ship a megabyte to duplicate the runtime's own.
 * What is missing is the FILE. Hand the browser one via `FontFace` and the
 * renderer needs nothing new: `ctx.font` names the family and the glyphs are
 * the file's own, correctly shaped, for zero extra bytes.
 *
 * This module is the part of that with no DOM in it — deciding whether a file
 * a user picked answers a name the document asked for. All the loading lives in
 * `app/`.
 *
 * ## Why the matcher is two tiers and stops
 *
 * The tempting design scores every candidate and returns the best. It is the
 * wrong shape for this problem. A wrong typeface applied silently LOOKS like a
 * working feature, so the user never goes and finds the right file; a disclosed
 * substitute looks worse and is actionable. So there is the whole normalised
 * name, then the family stem, and nothing after that. `Robotica` does not
 * answer `Roboto`, however small the edit distance, and `resolveFont` returns
 * null rather than a confident guess.
 *
 * Style words are split off the stem rather than ignored, because a family
 * match with the wrong weight is still worth having — Roboto Bold beats Arial
 * for a document asking for Roboto — but only if the caller can SAY the weight
 * is wrong. Hence `styleMatched`, which every caller is expected to surface.
 *
 * No dependencies, no DOM, no ag-psd. Same code in a browser, a worker and Node.
 */
import { fontStackFor } from './engine-data.js';

/** What `FontFace` can parse, and therefore all we will accept. */
export const FONT_FILE_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];

/** For a file input's `accept`. Kept next to the list it has to agree with. */
export const FONT_FILE_ACCEPT = FONT_FILE_EXTENSIONS.join(',');

/**
 * The style words we will split off a family stem.
 *
 * Six, matching what PostScript names actually end with, and no more. Every
 * addition is a chance to eat a family word — a foundry can call a face
 * `Book`, `Display` or `Text`, and a stem that has been over-trimmed matches
 * families it has nothing to do with. Longest first, so `BoldItalic` is one
 * style rather than a family called Bold.
 */
const STYLE_WORDS = [
  ['bolditalic', { weight: 'bold', italic: true }],
  ['regular', { weight: 'regular' }],
  ['italic', { italic: true }],
  ['black', { weight: 'black' }],
  ['light', { weight: 'light' }],
  ['bold', { weight: 'bold' }],
];

/** Comparison form: letters and digits only, so `Myriad Pro` and `MyriadPro` meet. */
const squash = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Split a font name into the family stem and the style it names.
 *
 * Strips style words from the END, repeatedly, so `Roboto-Italic-Bold` and
 * `Roboto-BoldItalic` reach the same answer. It will NOT strip to nothing: a
 * face genuinely called `Black` keeps `black` as its stem, because an empty
 * stem matches every family at once, which is the precise failure this whole
 * module exists to avoid.
 *
 * @param {string} name  a PostScript font name or a file's base name
 * @returns {{normalised:string, stem:string, weight:string, italic:boolean, styleKey:string}}
 */
export function splitFontName(name) {
  const normalised = squash(name);
  let stem = normalised;
  let weight = 'regular';
  let italic = false;

  for (let stripped = true; stripped;) {
    stripped = false;
    for (const [word, style] of STYLE_WORDS) {
      if (!stem.endsWith(word)) continue;
      const rest = stem.slice(0, -word.length);
      if (!rest) continue;                      // never strip a name down to nothing
      stem = rest;
      if (style.weight) weight = style.weight;
      if (style.italic) italic = true;
      stripped = true;
      break;
    }
  }

  return { normalised, stem, weight, italic, styleKey: italic ? `${weight}-italic` : weight };
}

/** Does this file name end in something `FontFace` can parse? */
export function isFontFileName(fileName) {
  const lower = String(fileName ?? '').toLowerCase();
  return FONT_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** `Roboto-Regular.ttf` -> `Roboto-Regular`. Longest extension first, so `.woff2` beats `.woff`. */
function baseNameOf(fileName) {
  const name = String(fileName ?? '');
  const lower = name.toLowerCase();
  const ext = [...FONT_FILE_EXTENSIONS].sort((a, b) => b.length - a.length)
    .find((e) => lower.endsWith(e));
  return ext ? name.slice(0, -ext.length) : name;
}

/**
 * Everything about a picked file that can be decided before reading its bytes.
 *
 * The `family` handed to `new FontFace(family, buffer)` is the file's own base
 * name, not a synthetic id: it is what the text sheet shows the user, and
 * `psdfont-roboto-bold` is not a typeface anybody recognises. It is always
 * QUOTED where it reaches CSS (`cssFontFamilyFor`), which is what keeps a file
 * called `serif.ttf` a family name rather than the generic keyword.
 *
 * THROWS rather than returning a half-usable plan. A file with no letters or
 * digits in its name has no family to register under, and putting an
 * unreachable face in the browser's font database is worse than refusing.
 *
 * @typedef {object} FontRecord
 * @property {string} fileName    the file the user picked, verbatim
 * @property {string} family      what `new FontFace(family, ...)` is given
 * @property {string} normalised  the whole name, letters and digits only
 * @property {string} stem        the family, with style words split off
 * @property {string} weight
 * @property {boolean} italic
 * @property {string} styleKey
 * @property {string} key         `stem|styleKey` — the registry's key
 *
 * @param {string} fileName
 * @returns {FontRecord}
 */
export function planFont(fileName) {
  const name = String(fileName ?? '');
  if (!isFontFileName(name))
    throw new Error(`${name || 'That file'} is not a font file. Pick a ${FONT_FILE_EXTENSIONS.join(', ')} file.`);

  // Quotes and backslashes are stripped rather than escaped: `cssFontFamilyFor`
  // wraps the family in double quotes, and a file called `My"Face.ttf` would
  // otherwise close the string early and hand the renderer a broken font
  // shorthand, which canvas ignores in full — every text layer would silently
  // revert to the default face.
  const family = baseNameOf(name).replace(/["'\\]/g, '').trim();
  const split = splitFontName(family);
  if (!split.normalised)
    throw new Error(`${name} has no family name in it — nothing could be matched against the document.`);

  return { fileName: name, family, ...split, key: `${split.stem}|${split.styleKey}` };
}

// ---------------------------------------------------------------- the registry

/**
 * The fonts this session has actually loaded, and the files that would not load.
 *
 * Keyed by family stem AND style, so `Roboto-Regular` and `Roboto-Bold` are two
 * entries rather than a collision — they are two faces, and a document can want
 * both. Two files that reduce to the SAME stem and style are a collision, and
 * `registerFont` resolves it below.
 */
export function createFontRegistry() {
  return { faces: new Map(), failures: new Map(), aliases: new Map() };
}

/**
 * Bind one file to one PSD font name, overruling the matcher.
 *
 * ## Why this exists next to a deliberately dumb matcher
 *
 * The two tiers below are right for GUESSING, and the note at the top of
 * test/fonts.mjs explains why a third fuzzy tier would be worse than none. But
 * dumb-and-honest leaves a real document unservable: a PSD asking for
 * `HelveticaNeue` and a legitimately licensed `HelvNeue_Rm.otf` share no stem,
 * so no amount of matching connects them and the row says "no file loaded"
 * forever, however many times the user picks the right file.
 *
 * An assignment is not a third tier of guessing. It is a FACT supplied by the
 * only party who can know it, and it is why this does not weaken the argument
 * against fuzzy matching — nothing here is inferred.
 *
 * Keyed by the NORMALISED name, so a user who assigns `HelveticaNeue` has also
 * answered `Helvetica Neue` and `helvetica_neue`. Those are the same name
 * written three ways, and making them three separate chores would be a bug.
 *
 * @param {object} registry
 * @param {string} psdFontName  the name the document asks for
 * @param {string} key          `record.key` of a face already registered
 */
export function assignFont(registry, psdFontName, key) {
  const want = splitFontName(psdFontName);
  if (!want.normalised || !key) return registry;
  registry.aliases.set(want.normalised, key);
  return registry;
}

/**
 * Record a face that has loaded.
 *
 * ## Two files claiming the same family and style
 *
 * The later one WINS, and the earlier one is returned as `replaced` so the
 * caller can say so and drop the old `FontFace` from `document.fonts`. Picking
 * a file is a deliberate act — the user means the one they just chose — but a
 * silent swap leaves them unable to tell which of their two files is drawing,
 * which is the same class of bug as a silent substitution. Winning and saying
 * so is the pair that works.
 *
 * @param {object} registry
 * @param {FontRecord} plan
 * @returns {{record:FontRecord, replaced:FontRecord|null}}
 */
export function registerFont(registry, plan) {
  const replaced = registry.faces.get(plan.key) ?? null;
  const record = { ...plan };
  registry.faces.set(plan.key, record);
  // A file that loads is no longer a file that failed. Leaving the old
  // complaint up is a lie about the current state.
  registry.failures.delete(plan.fileName);
  return { record, replaced };
}

/**
 * Record a file the browser refused.
 *
 * Deliberately does NOT touch `faces`: a face that never parsed must never be
 * resolvable, or the renderer is handed a family the font database does not
 * have and canvas silently falls back — which looks exactly like the
 * substitution this feature exists to remove.
 *
 * Keyed by file name, so picking the same broken file twice is one complaint.
 */
export function recordFontFailure(registry, fileName, message) {
  const entry = { fileName: String(fileName ?? ''), message: String(message ?? '') };
  registry.failures.set(entry.fileName, entry.message);
  return entry;
}

/** Every loaded face, in the order it was first registered. */
export const loadedFonts = (registry) => [...registry.faces.values()];

/** Every file that would not load, as `{fileName, message}`. */
export const fontFailures = (registry) =>
  [...registry.failures.entries()].map(([fileName, message]) => ({ fileName, message }));

/**
 * The loaded face that answers a PSD's font name, or null.
 *
 * Two tiers and no third:
 *
 *   1. `name` — the whole normalised name agrees, style words included.
 *      `Myriad Pro Regular.otf` answers `MyriadPro-Regular`.
 *   2. `stem`  — the family agrees. The face whose style also agrees is
 *      preferred; failing that the first registered face of the family is
 *      returned with `styleMatched: false`, which the caller must disclose.
 *
 * A name that reduces to nothing, or that no stem answers, returns null. That
 * is not a failure to be papered over — it is the document telling the user
 * exactly which file to go and find.
 *
 * @returns {{record:FontRecord, family:string, styleMatched:boolean, how:'name'|'stem'}|null}
 */
export function resolveFont(registry, psdFontName) {
  const want = splitFontName(psdFontName);
  if (!want.stem) return null;

  const records = loadedFonts(registry);

  /*
   * An assignment is checked FIRST, and beats a name match.
   *
   * It is the later, more specific instruction: a user who has explicitly said
   * "draw this name with that file" has overruled whatever the matcher would
   * have found, and silently preferring the guess would make the control look
   * broken. `styleMatched` is true because nobody guessed — the weight warning
   * exists to say "we may be wrong about this", and repeating it where the user
   * chose the file trains them to ignore it everywhere else.
   *
   * An alias pointing at a face that is no longer loaded — reachable whenever a
   * later pick replaces a file with the same family and style — falls through
   * to the ordinary tiers rather than resolving to nothing.
   */
  const assigned = registry.aliases?.get(want.normalised);
  if (assigned) {
    const record = records.find((r) => r.key === assigned);
    if (record) return { record, family: record.family, styleMatched: true, how: 'assigned' };
  }

  const byName = records.find((r) => r.normalised === want.normalised);
  if (byName)
    return { record: byName, family: byName.family, styleMatched: byName.styleKey === want.styleKey, how: 'name' };

  const family = records.filter((r) => r.stem === want.stem);
  if (!family.length) return null;

  const styled = family.find((r) => r.styleKey === want.styleKey);
  const record = styled ?? family[0];
  return { record, family: record.family, styleMatched: !!styled, how: 'stem' };
}

// ---------------------------------------------------------------- CSS

/**
 * The value to put in `layer.text.fontFamily`.
 *
 * The loaded family FIRST, always quoted, then the substitute stack behind it.
 * The quoting is not cosmetic: unquoted, a file called `serif.ttf` names the
 * generic keyword and the user's file never draws. The stack behind it is the
 * fallback for the window between `document.fonts.add` and the face being
 * ready, and for the case where the face is later dropped.
 */
export const cssFontFamilyFor = (record, fallbackStack) =>
  `"${record.family}", ${fallbackStack}`;

/**
 * The exact value a layer asking for `sourceFont` gets when the face is applied.
 *
 * Exact matters. "Is this layer drawing the loaded face?" cannot be answered by
 * comparing the FIRST family in its stack: a user who loads `Georgia.ttf` for a
 * document that asks for `Georgia` would collide with the substitute stack
 * `Georgia, serif`, and the layer would be reported as drawing their file while
 * actually drawing the system's. Narrow, but it is a confidently wrong answer
 * about a font, which is the one thing this module is built to refuse.
 *
 * One derivation, used by the applier and the report alike, so the string they
 * compare cannot drift apart.
 */
export const loadedFontFamilyFor = (record, sourceFont) =>
  cssFontFamilyFor(record, fontStackFor(sourceFont));


// ---------------------------------------------------------------- reporting

/**
 * What this document's typefaces are, and which of them are real.
 *
 * The text sheet already discloses the substitution for ONE layer. That is not
 * enough on a real file: a poster with five typefaces needs a list of the names
 * to go and find, or the user is opening every text layer in turn to collect
 * them by hand.
 *
 * `applied` is reported separately from `match` on purpose. A face can be
 * loaded and still not be drawing — the user may have picked a stack by hand on
 * that layer — and reporting "loaded" as though it were "in use" would be the
 * same kind of confident wrong answer this module refuses everywhere else.
 *
 * @param {Array} layers  project layers; only `kind === 'text'` ones are read
 * @returns {{fonts:Array, wanted:number, loaded:number, substituted:number,
 *            unnamed:number, failures:Array}}
 */
export function fontDemand(layers, registry) {
  const fonts = new Map();
  let unnamed = 0;

  for (const layer of layers ?? []) {
    if (layer?.kind !== 'text' || !layer.text) continue;
    const name = layer.text.sourceFont;
    if (!name) { unnamed++; continue; }

    let entry = fonts.get(name);
    if (!entry) {
      const match = resolveFont(registry, name);
      entry = {
        name,
        layers: [],
        applied: 0,
        match: match && {
          family: match.family, fileName: match.record.fileName,
          styleMatched: match.styleMatched, how: match.how,
          /** The exact `fontFamily` a layer wanting this name gets when applied. */
          applies: loadedFontFamilyFor(match.record, name),
        },
      };
      fonts.set(name, entry);
    }
    entry.layers.push(layer.name);
    if (entry.match && layer.text.fontFamily === entry.match.applies) entry.applied++;
  }

  const list = [...fonts.values()];
  return {
    fonts: list,
    wanted: list.length,
    loaded: list.filter((f) => f.match).length,
    substituted: list.filter((f) => !f.match).length,
    unnamed,
    failures: fontFailures(registry),
  };
}
