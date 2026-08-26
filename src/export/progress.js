/**
 * Export progress weights.
 *
 * `layers` is the only phase with honest interior granularity -- it is n of N
 * real decodes. `parse` and `encode` are single synchronous calls with no yield
 * point inside them, so they are marked indeterminate: the UI must show a
 * spinner-like state there rather than a fake creep, because a bar that
 * pretends to move during a 3 s freeze is worse than one that admits it.
 *
 * Bounds are integer PERCENTS, not fractions, so the arithmetic is exact.
 * Fractional spans put 0.15 + (0.85 - 0.15) at 0.8500000000000001 and turn
 * every boundary into an epsilon comparison.
 */
export const EXPORT_PHASES = [
  { name: 'read',     from: 0,  to: 10,  determinate: true },
  { name: 'parse',    from: 10, to: 15,  determinate: false },
  { name: 'layers',   from: 15, to: 85,  determinate: true },
  { name: 'drain',    from: 85, to: 90,  determinate: true },
  { name: 'readback', from: 90, to: 92,  determinate: true },
  { name: 'encode',   from: 92, to: 98,  determinate: false },
  { name: 'write',    from: 98, to: 100, determinate: true },
];

const phase = (name) => {
  const found = EXPORT_PHASES.find((p) => p.name === name);
  if (!found) throw new Error(`unknown export phase "${name}"`);
  return found;
};

/** @returns {number} overall progress in 0..1. */
export function phaseFraction(name, done = 0, total = 0) {
  const { from, to } = phase(name);
  const through = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (from + (to - from) * through) / 100;
}

export function isDeterminate(name) {
  return phase(name).determinate;
}
