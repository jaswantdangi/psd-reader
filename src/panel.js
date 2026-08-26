/**
 * The layers panel's derived list.
 *
 * Pure over a project: filtering, searching, duplicate-name disambiguation,
 * badge computation and the empty-versus-filtered distinction. The component
 * renders what this returns and decides nothing.
 *
 * Rows come back TOP OF THE STACK FIRST. project.layers stores index 0 at the
 * bottom, matching the file; the panel shows the top layer at the top, matching
 * every other editor. This is the one place those orders are reconciled.
 *
 * There is deliberately NO SORT. The list order IS the z-order, so a sort would
 * either lie about the stack or silently reorder the document.
 *
 * Search is a client-side substring over an in-memory array. There is no server
 * and no pagination anywhere in this app, so the server-paginate/client-sort
 * trap cannot arise -- said out loud so nobody introduces pagination later and
 * creates it.
 */

/**
 * Every filter is an axis the model already carries. Derived from the field
 * list rather than invented, which is also how its completeness is checked.
 */
export const PANEL_FILTERS = ['hidden', 'text', 'masked', 'clipped', 'blended', 'faded', 'warned'];

/**
 * Badges, each null/false at its default value.
 *
 * A row that reads `raster · normal · 100%` is what every row would read, so it
 * says nothing and drowns the one row that differs.
 */
export const badgesFor = (layer) => ({
  text: layer.kind === 'text',
  mask: !!layer.mask,
  maskOff: !!layer.mask && layer.mask.disabled === true,
  clipped: layer.clipping === true,
  hidden: layer.visible === false,
  opacity: layer.opacity < 1 ? Math.round(layer.opacity * 100) : null,
  blendMode: layer.blendMode !== 'normal' ? layer.blendMode : null,
  groupPath: layer.groupPath || null,
  warned: layer.groupWarned === true,
});

const matchesFilter = (layer, filter) => {
  switch (filter) {
    case 'hidden': return layer.visible === false;
    case 'text': return layer.kind === 'text';
    case 'masked': return !!layer.mask;
    case 'clipped': return layer.clipping === true;
    case 'blended': return layer.blendMode !== 'normal';
    case 'faded': return layer.opacity < 1;
    case 'warned': return layer.groupWarned === true;
    default: return true;
  }
};

/**
 * The layer a clipped layer would clip to: the nearest one below that is not
 * itself clipped.
 *
 * Derived, never stored -- a reorder changes the answer, and a stored base
 * would go stale the moment the user dragged a row. Null when there is none,
 * which Photoshop permits and also renders unclipped.
 */
export function clipBaseFor(project, index) {
  for (let i = index - 1; i >= 0; i--)
    if (project.layers[i].clipping !== true) return project.layers[i];
  return null;
}

/**
 * @param {object} project
 * @param {{search?: string, filters?: string[], selectedId?: number|null}} [options]
 *   Filters combine with AND: each chip is a different axis, so "Hidden + Text"
 *   means hidden text layers.
 */
export function panelRows(project, options = {}) {
  const { search = '', filters = [], selectedId = null } = options;
  const needle = search.trim().toLowerCase();

  // Duplicate names are the norm in real PSDs -- a dozen `Layer 1`. Count first,
  // so only names that ACTUALLY collide get a discriminator.
  const counts = new Map();
  for (const layer of project.layers) counts.set(layer.name, (counts.get(layer.name) ?? 0) + 1);

  const rows = [];
  for (let i = project.layers.length - 1; i >= 0; i--) {
    const layer = project.layers[i];

    const haystack = [layer.name, layer.groupPath, layer.text?.content]
      .filter(Boolean).join(' ').toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    if (filters.length && !filters.every((f) => matchesFilter(layer, f))) continue;

    rows.push({
      layer,
      index: i,
      name: layer.name,
      /** Display only. Nothing writes layer.name -- a fake rename would enter the undo history. */
      discriminator: counts.get(layer.name) > 1 ? '#' + i : null,
      /**
       * A text layer is identified by what it SAYS. A layer named `Layer 7`
       * holding `SUMMER SALE` is unfindable by its name and obvious by its
       * content.
       */
      secondary: layer.kind === 'text' ? (layer.text?.content ?? '') : (layer.groupPath || ''),
      badges: badgesFor(layer),
      clipBase: layer.clipping ? (clipBaseFor(project, i)?.name ?? null) : null,
      selected: selectedId !== null && layer.id === selectedId,
    });
  }

  return {
    rows,
    total: project.layers.length,
    shown: rows.length,
    /**
     * Two states with OPPOSITE remedies: an empty document needs a different
     * file, a filtered-to-zero list needs the filters cleared. Showing the
     * onboarding copy to someone who mistyped a search is the classic bug here.
     */
    state: project.layers.length === 0 ? 'empty-document'
      : rows.length === 0 ? 'filtered-to-zero' : 'ok',
    /** How many leaves flatten() dropped, so the empty copy can explain itself. */
    skippedLeaves: project.skippedLeaves ?? 0,
    /**
     * The selection SURVIVES filtering -- it stays selected and stays outlined
     * on the canvas. The panel offers a "clear the filter" affordance instead
     * of silently deselecting, which would lose the user's place.
     */
    selectionHidden: selectedId !== null && !rows.some((r) => r.layer.id === selectedId),
  };
}
