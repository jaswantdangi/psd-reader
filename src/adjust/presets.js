/**
 * The named filters, as data.
 *
 * A preset is a BUNDLE OF THE SAME PARAMETERS Adjust and HSL already expose --
 * not a separate mechanism, not a shader, not an asset. Four consequences:
 *
 *   - Zero render cost. A preset folds into the same composed LUT (and, when it
 *     uses one, the same single HSL evaluation). A filter is not an extra pass.
 *   - Presets stay editable after applying. Tap Ember, then open Adjust and
 *     pull the contrast back. PixelPerfect cannot do that; here it falls out.
 *   - Intensity is one multiply toward neutral. No new op.
 *   - Undo is a single setLayer restoring the PREVIOUS parameters rather than
 *     neutral, which is the obvious wrong implementation.
 *
 * EVERY NUMBER HERE IS AUTHORED FROM SCRATCH. PixelPerfect's repository has no
 * LICENSE file, so its assets are all-rights-reserved -- and so are its filter
 * parameters, which are as much its author's work as its PNGs. Copying numbers
 * out of a GLSL shader and calling them data would be copying.
 *
 * NO LOOK HERE IS BUILT ON BLUR OR GRAIN, because no Phase 3 operation has a
 * pixel radius. Light leaks, duotone washes and colour grades are reachable;
 * bokeh, dust, scratches, lens flare and film grain are not, and saying so is
 * better than shipping a near-miss under a familiar name.
 *
 * COST: nine of these are class-A only and cost a table lookup. FIVE carry an
 * HSL block and cost the expensive per-pixel pass -- sepia, noir, harbor,
 * meadow, peach. The Filter sheet should say which.
 */
import { CLASS_A_ORDER, createAdjust, normaliseHsl } from './ops.js';

const band = (index, h, s, l) => ({ index, h, s, l });

/** Sparse band edits, expanded to the full eight by normaliseHsl. */
const bands = (...edits) => {
  const out = Array.from({ length: 8 }, () => ({ h: 0, s: 0, l: 0 }));
  for (const e of edits) out[e.index] = { h: e.h, s: e.s, l: e.l };
  return out;
};

export const PRESETS = [
  { id: 'ember',     label: 'Ember',     exposure: 2,  temperature: 22,  tint: -6,  brightness: 4,  contrast: 18 },
  { id: 'dusk',      label: 'Dusk',      exposure: -4, temperature: -18, tint: 6,   brightness: -6, contrast: 12 },
  { id: 'frost',     label: 'Frost',     exposure: 6,  temperature: -26, tint: -4,  brightness: 10, contrast: -6 },
  { id: 'clay',      label: 'Clay',      exposure: 2,  temperature: 14,  tint: 4,   brightness: 0,  contrast: -12 },
  { id: 'linen',     label: 'Linen',     exposure: 4,  temperature: 6,   tint: 0,   brightness: 12, contrast: -14 },
  { id: 'oxide',     label: 'Oxide',     exposure: -3, temperature: 18,  tint: -10, brightness: 0,  contrast: 26 },
  { id: 'ash',       label: 'Ash',       exposure: -2, temperature: 0,   tint: 0,   brightness: 2,  contrast: -20 },
  { id: 'ink',       label: 'Ink',       exposure: -8, temperature: -10, tint: 0,   brightness: 0,  contrast: 30 },
  { id: 'sunbleach', label: 'Sunbleach', exposure: 8,  temperature: 10,  tint: 2,   brightness: 14, contrast: -18 },

  // ---- the five that also cost the expensive per-pixel pass ----
  { id: 'sepia',  label: 'Sepia',  exposure: 0, temperature: 30,  tint: 4,   brightness: 4,  contrast: 8,
    hsl: { saturation: -80, bands: bands() } },
  { id: 'noir',   label: 'Noir',   exposure: 0, temperature: 0,   tint: 0,   brightness: -4, contrast: 34,
    hsl: { saturation: -100, bands: bands() } },
  { id: 'harbor', label: 'Harbor', exposure: 0, temperature: -22, tint: -12, brightness: 0,  contrast: 10,
    hsl: { saturation: 0, bands: bands(band(4, 0, 18, 4), band(5, -6, 14, 0)) } },
  { id: 'meadow', label: 'Meadow', exposure: 0, temperature: -6,  tint: -16, brightness: 0,  contrast: 6,
    hsl: { saturation: 0, bands: bands(band(3, -8, 24, 8)) } },
  { id: 'peach',  label: 'Peach',  exposure: 0, temperature: 16,  tint: 6,   brightness: 8,  contrast: -4,
    hsl: { saturation: 0, bands: bands(band(0, 2, 8, 4), band(1, 4, 12, 6)) } },
];

export const PRESET_IDS = PRESETS.map((p) => p.id);

/**
 * A preset's parameters as a frozen adjustment object.
 *
 * `intensity` scales every parameter toward neutral. That is all a strength
 * slider is -- one multiply on ten numbers, before the LUT is built, so it
 * costs nothing per pixel and needs no operation of its own.
 *
 * At intensity 0 the result is neutral, which setAdjust stores as `null`:
 * 0% of a filter is no filter, and the preset id going with it is correct.
 *
 * @param {string} id
 * @param {number} [intensity]  0..1
 */
export function presetAdjust(id, intensity = 1) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return createAdjust();

  const k = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1;
  const partial = { preset: id };
  for (const op of CLASS_A_ORDER) partial[op] = (preset[op] ?? 0) * k;

  if (preset.hsl) {
    const full = normaliseHsl(preset.hsl);
    partial.hsl = {
      saturation: full.saturation * k,
      bands: full.bands.map((b) => ({ h: b.h * k, s: b.s * k, l: b.l * k })),
    };
  }

  return createAdjust(partial);
}
