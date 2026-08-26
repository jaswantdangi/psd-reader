/**
 * The class-A collapse.
 *
 * Every class-A op is a function `channel value -> channel value` that depends
 * on nothing but that channel's own value. A composition of such functions is
 * itself such a function -- so the ENTIRE class-A stack, however deep,
 * evaluates into one 3x256 lookup table, and the per-pixel cost becomes three
 * array indexes and three stores.
 *
 * That is the answer to the brief's cost question. Four adjustments on a layer
 * cost what one costs. 768 evaluations of the whole stack, once per parameter
 * change -- not per pixel, not per layer, not per frame.
 *
 * It is also the answer to the GPU/JS parity question for the majority of the
 * operation surface: the GPU uploads THESE EXACT 768 BYTES as a 256x1 RGBA
 * texture and reads them with texelFetch, so there is no shader arithmetic to
 * diverge. Divergence is not reduced there, it is structurally impossible.
 */
import { CLASS_A_ORDER, OPS, isNeutralHsl } from './ops.js';

/**
 * Compose the whole class-A stack into one table.
 *
 * @param {object|null} adjust
 * @returns {Uint8Array} 768 bytes: [r 0..255][g 0..255][b 0..255]
 */
export function buildLut(adjust) {
  const lut = new Uint8Array(768);

  for (let c = 0; c < 3; c++) {
    for (let v = 0; v < 256; v++) {
      let x = v;
      // EVERY op runs at EVERY entry, including the ones at their neutral
      // value. Skipping them would be a micro-optimisation that also makes the
      // identity-LUT assertion trivially true, instead of a real proof that
      // each op's declared neutral IS the identity. 3840 evaluations is nothing.
      for (const id of CLASS_A_ORDER) x = OPS[id].evaluate(x, c, adjust?.[id] ?? OPS[id].neutral);
      // Clamped ONCE, at the end of the composition -- not after each op, which
      // would clip five times and throw away highlights an exposure lift could
      // still have pulled back.
      lut[c * 256 + v] = x <= 0 ? 0 : x >= 255 ? 255 : Math.round(x);
    }
  }

  return lut;
}

/**
 * The cache key for a table.
 *
 * Class A and nothing else, because the table depends on class A and nothing
 * else. That makes the key COMPLETE by construction: it needs no source-pixel
 * identity and no destination dimensions, so the lut/lutKey pair cannot go
 * stale the way rendered/renderedKey can.
 */
export const lutDigest = (adjust) =>
  adjust ? CLASS_A_ORDER.map((id) => adjust[id] ?? OPS[id].neutral).join(',') : 'neutral';

/**
 * The layer's table, built on demand and cached.
 *
 * DERIVED, not part of the model: never persisted, never in a command, never in
 * undo. It is rebuilt from parameters whenever the digest changes -- an
 * estimated tens of microseconds, once per frame during a slider drag.
 */
export function lutFor(layer) {
  const key = lutDigest(layer.adjust);
  if (layer.lutKey !== key) {
    layer.lut = buildLut(layer.adjust);
    layer.lutKey = key;
  }
  return layer.lut;
}

/**
 * Whether the whole object is neutral, so the entire pass can be skipped.
 *
 * A layer with no adjustments must cost exactly what it costs today: one branch.
 *
 * Task 5 and Task 6 refine the hsl and overlay tests here from "is present" to
 * "is present AND not neutral".
 */
export function isNeutralAdjust(adjust) {
  if (!adjust) return true;
  for (const id of CLASS_A_ORDER)
    if ((adjust[id] ?? OPS[id].neutral) !== OPS[id].neutral) return false;
  if (adjust.hsl && !isNeutralHsl(adjust.hsl)) return false;
  return !adjust.overlay;
}

/**
 * The three cost terms, separately.
 *
 * Phase 1B and Phase 2 both established that a cost the user cannot see is a
 * bug. The debug readout's `lut: N / hsl: M` counters read this, so the terms
 * have to be separable at the source rather than summed into a total.
 *
 * Task 5 and Task 6 refine the hsl and overlay flags the same way.
 */
export const adjustCostOf = (adjust) => ({
  lut: !!adjust && CLASS_A_ORDER.some((id) => (adjust[id] ?? OPS[id].neutral) !== OPS[id].neutral),
  hsl: !!adjust?.hsl && !isNeutralHsl(adjust.hsl),
  overlay: !!adjust?.overlay,
});
