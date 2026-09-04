import { BLEND_MODES } from '@engine/edit.js';
import { BLEND_GROUPS, asOptions } from './layer-sheet';

/**
 * The blend picker's grouping.
 *
 * The groups are display metadata — the engine has no label for them — but
 * MEMBERSHIP is derived from `BLEND_MODES` by filtering. That is the invariant
 * worth holding: a mode the engine adds must land somewhere the user can reach,
 * and the failure mode of a hand-written list is that it silently does not.
 */
describe('BLEND_GROUPS', () => {
  const grouped = BLEND_GROUPS.flatMap((group) => group.modes);

  it('shows every mode the engine has', () => {
    expect([...grouped].sort()).toEqual([...BLEND_MODES].sort());
  });

  it('puts each mode in exactly one group', () => {
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('offers no empty group', () => {
    for (const group of BLEND_GROUPS) expect(group.modes.length).toBeGreaterThan(0);
  });

  it('leads with Normal, because that is what a layer starts as', () => {
    expect(BLEND_GROUPS[0].label).toBe('Normal');
    expect(BLEND_GROUPS[0].modes).toEqual(['normal']);
  });

  /**
   * The one that would actually catch a regression: a mode no group claims
   * falls into a final `Other` group rather than disappearing from the picker.
   * `BLEND_GROUPS` is built at module load, so this proves the rule on the
   * builder's own inputs.
   */
  it('has no unclaimed mode today, and would surface one as Other', () => {
    const labels = BLEND_GROUPS.map((group) => group.label);
    expect(labels).not.toContain('Other');

    const claimed = new Set(grouped);
    expect(BLEND_MODES.filter((mode: string) => !claimed.has(mode))).toEqual([]);
  });
});

describe('asOptions', () => {
  it('uses the mode id as its own label — the picker capitalises, the engine does not', () => {
    expect(asOptions(['multiply', 'soft light'])).toEqual([
      { id: 'multiply', label: 'multiply' },
      { id: 'soft light', label: 'soft light' },
    ]);
  });

  it('maps an empty list to an empty picker', () => {
    expect(asOptions([])).toEqual([]);
  });
});
