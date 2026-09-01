/**
 * Reading a designer's handover folder — a PSD and the fonts it names — as one file.
 *
 * ## The gap this closes
 *
 * A PSD stores font NAMES and never font FILES. `src/engine-data.js` recovers
 * the name, `src/fonts.js` matches a file a user supplies against it, and the
 * Fonts sheet discloses whatever is still substituted. That chain works and
 * leaves one human step in the middle: the user has to know which files to go
 * and find, and then find them. Nobody hands over a bare PSD — a handover is a
 * folder, document and typefaces together — so taking that folder as a zip
 * removes the hunting rather than making it prettier.
 *
 * ## Why nothing here decompresses anything
 *
 * This module is handed the manifest a zip's central directory already carries:
 * `{ path, size }` per entry, where `size` is the UNCOMPRESSED size the archive
 * declares. It decides which entry is the document, which are fonts, what is
 * ignored and what is refused — and it does so before a single byte is
 * inflated, which is the only order in which a zip bomb can be refused at all.
 * Checking after inflating is not a check, it is a post-mortem.
 *
 * The consequence is that this file has no DOM, no dependency and no zip reader
 * in it. The app pairs it with fflate (~8 kB), which reads the central
 * directory, hands the manifest here, and then inflates only the entries this
 * answer names. The engine stays dependency-free and the whole decision stays
 * testable in Node against paths typed by hand.
 *
 * ## The declared size is a claim, not a fact
 *
 * A hostile archive can understate `size` in its central directory. That is
 * survivable and deliberately not re-litigated here: the bytes that come out
 * are then handed to the ordinary loader, whose own `guardFileSize` runs on the
 * REAL length. A lie buys an attacker one inflate up to the entry cap and then
 * meets the same refusal. What the declared size buys us is refusing the honest
 * 10 GB bomb — the common case — for free.
 */
import { FONT_FILE_EXTENSIONS } from './fonts.js';
import { guardFileSize, memoryBudgetBytes } from './budget.js';

const MB = 1024 * 1024;

/** What the reader takes as the document. Matches the file input's `accept`. */
export const PSD_FILE_EXTENSIONS = ['.psd', '.psb'];

/** The container itself. */
export const BUNDLE_FILE_EXTENSIONS = ['.zip'];

/** For the file input, next to the PSDs it already accepted. */
export const BUNDLE_FILE_ACCEPT = [...PSD_FILE_EXTENSIONS, ...BUNDLE_FILE_EXTENSIONS].join(',');

/**
 * How many entries an archive may declare before we stop reading it.
 *
 * Not a memory bound — a manifest of names is small — but a bound on the shape
 * of thing we are willing to call a handover. A folder with a PSD and a type
 * family in it has tens of entries. An archive with tens of thousands is
 * somebody's backup or somebody's bomb, and in both cases the right answer is
 * to say so rather than to spend a minute walking it.
 *
 * The refusal says "more than N" and never a count, because the caller is
 * expected to STOP collecting once it holds N + 1. Building a million-element
 * manifest in order to discover that it has a million elements is exactly the
 * cost this cap exists to avoid, so a number here would be the length of a
 * deliberately truncated list.
 */
export const BUNDLE_ENTRY_CAP = 512;

/**
 * How much room above the PSD budget the fonts get.
 *
 * The unpack cap is deliberately DERIVED from the device's PSD budget rather
 * than being a constant of its own. A fixed cap would eventually contradict
 * `memoryBudgetBytes` — a document this device can open, refused for arriving
 * in a zip — and a guard that contradicts another guard is one the user cannot
 * act on. 64 MB is a whole type family with room to spare.
 */
export const BUNDLE_FONT_HEADROOM_BYTES = 64 * MB;

/** The most this device will unpack, in total, for one handover. */
export const bundleByteCap = (budgetBytes) => budgetBytes + BUNDLE_FONT_HEADROOM_BYTES;

const megabytes = (bytes) => Math.round(bytes / MB);

const endsWithAny = (name, extensions) => {
  const lower = String(name ?? '').toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
};

/** Is this the container, rather than a document? Drives which opener runs. */
export const isBundleFileName = (name) => endsWithAny(name, BUNDLE_FILE_EXTENSIONS);

/**
 * Zip paths are `/`-separated by spec and `\`-separated by several real zippers.
 * Normalising once here means every later test — traversal, sidecars, basename
 * — is written against one separator instead of two.
 */
const normalisePath = (path) => String(path ?? '').replace(/\\/g, '/');

const baseNameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Paths we will not read, however harmless they look.
 *
 * Nothing in this app writes a file, so a traversing path is not the classic
 * filesystem escape. It is still refused rather than reasoned about: the
 * argument for its safety depends on every future caller also never writing,
 * and that is not an invariant a path check should be resting on. An entry
 * whose name climbs out of its own archive is not part of a handover.
 */
const isUnsafePath = (path) =>
  path.startsWith('/')
  || /^[a-z]:\//i.test(path)
  || path.split('/').includes('..');

/**
 * The debris macOS puts in every archive it makes.
 *
 * `__MACOSX/` holds an AppleDouble shadow for each real file, named `._` plus
 * the original name — so a folder with ONE `art.psd` produces an archive with
 * two entries ending in `.psd`. Without this the classifier would report an
 * ambiguity that does not exist and ask the user to choose between their file
 * and its resource fork, which is worse than the hunting this feature removes.
 */
const isMacSidecar = (path) => {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  return segments.includes('__MACOSX') || name === '.DS_Store' || name.startsWith('._');
};

/**
 * Classify a zip's manifest: the document, the fonts, the ignored, the refused.
 *
 * @param {Array<{path:string, size:number}>} entries
 *   One per central-directory record. `size` is the UNCOMPRESSED size.
 * @param {object} [options]
 * @param {number} [options.budgetBytes]  what this device can decode; see src/budget.js
 * @param {string} [options.pick]  normalised path of the PSD to use, when the
 *   archive holds more than one and the user has answered which
 *
 * @returns {{
 *   ok: boolean,
 *   reason: null|'too-many-entries'|'too-large'|'no-psd'|'many-psds'|'psd-too-large',
 *   message: string|null,
 *   psd: {path:string, name:string, size:number}|null,
 *   psds: Array<{path:string, name:string, size:number}>,
 *   fonts: Array<{path:string, name:string, size:number}>,
 *   ignored: Array<{path:string, why:'directory'|'macos'|'unsafe-path'|'unsupported'}>,
 *   entryCount: number,
 *   totalBytes: number,
 *   byteCap: number,
 * }}
 */
export function classifyBundle(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const budgetBytes = typeof options.budgetBytes === 'number' && options.budgetBytes > 0
    ? options.budgetBytes
    : memoryBudgetBytes();
  const byteCap = bundleByteCap(budgetBytes);

  const base = {
    ok: false, reason: null, message: null,
    psd: null, psds: [], fonts: [], ignored: [],
    entryCount: list.length, totalBytes: 0, byteCap,
  };

  // ---- the two guards that must fire before any entry is looked at ---------

  if (list.length > BUNDLE_ENTRY_CAP) {
    return {
      ...base,
      reason: 'too-many-entries',
      message:
        `This zip declares more than ${BUNDLE_ENTRY_CAP} entries. A handover is a document `
        + 'and the fonts it names — an archive this large is a backup, or a bomb.',
    };
  }

  const totalBytes = list.reduce((sum, e) => sum + Math.max(0, Number(e?.size) || 0), 0);
  if (totalBytes > byteCap) {
    return {
      ...base,
      totalBytes,
      reason: 'too-large',
      message:
        `This zip holds ${megabytes(totalBytes)} MB of files once unpacked. This device can `
        + `unpack up to ${megabytes(byteCap)} MB — opening it would run out of memory.`,
    };
  }

  // ---- classification -----------------------------------------------------

  const psds = [];
  const fonts = [];
  const ignored = [];

  for (const raw of list) {
    const path = normalisePath(raw?.path);
    const size = Math.max(0, Number(raw?.size) || 0);
    if (!path) continue;

    if (path.endsWith('/')) { ignored.push({ path, why: 'directory' }); continue; }
    if (isMacSidecar(path)) { ignored.push({ path, why: 'macos' }); continue; }
    if (isUnsafePath(path)) { ignored.push({ path, why: 'unsafe-path' }); continue; }

    const name = baseNameOf(path);
    const file = { path, name, size };

    if (endsWithAny(name, PSD_FILE_EXTENSIONS)) psds.push(file);
    else if (endsWithAny(name, FONT_FILE_EXTENSIONS)) fonts.push(file);
    else ignored.push({ path, why: 'unsupported' });
  }

  const report = { ...base, totalBytes, psds, fonts, ignored };

  // ---- which document ------------------------------------------------------

  if (!psds.length) {
    return {
      ...report,
      reason: 'no-psd',
      message:
        'There is no .psd or .psb in this zip. Put the document and its font files in '
        + 'one folder and zip that folder.',
    };
  }

  // More than one, and no answer yet. NOT resolved by picking the first: the
  // two are usually a final and a draft, and opening the draft looks exactly
  // like the feature working until the user notices the wrong artwork.
  const chosen = psds.length === 1
    ? psds[0]
    : psds.find((p) => p.path === normalisePath(options.pick)) ?? null;

  if (!chosen) {
    return {
      ...report,
      reason: 'many-psds',
      message:
        `This zip holds ${psds.length} documents. Choose the one to open — nothing else `
        + 'in the archive changes either way.',
    };
  }

  // ---- the same memory guard every other PSD faces -------------------------

  const guard = guardFileSize(chosen.size, budgetBytes);
  if (!guard.ok) {
    return {
      ...report,
      reason: 'psd-too-large',
      message: `${chosen.name} is the PSD in this zip. ${guard.message}`,
    };
  }

  return { ...report, ok: true, psd: chosen };
}

/**
 * What the handover actually achieved, in the three lists a user needs.
 *
 * The temptation is to report only the good news — "loaded 4 fonts" — and let
 * the screen speak for the rest. It is the same failure as a silent
 * substitution: a document that renders in three real typefaces and one
 * fallback looks finished, and the user ships it. So `substituted` is returned
 * beside `used` every time, and `unused` with it, because a font in the zip
 * that no layer asked for is usually the sign that the wrong folder was zipped.
 *
 * @param {object} demand    `fontDemand(layers, registry)` — see src/fonts.js
 * @param {string[]} families  the families registered from THIS archive
 * @returns {{used:string[], unused:string[], substituted:string[]}}
 */
export function bundleFontOutcome(demand, families) {
  const answering = new Set();
  for (const font of demand?.fonts ?? []) if (font.match) answering.add(font.match.family);

  const fromZip = [...new Set(families ?? [])];
  return {
    used: fromZip.filter((family) => answering.has(family)),
    unused: fromZip.filter((family) => !answering.has(family)),
    substituted: (demand?.fonts ?? []).filter((f) => !f.match).map((f) => f.name),
  };
}
