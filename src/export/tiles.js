/**
 * Tile arithmetic for the GPU export target.
 *
 * A 4961 px canvas cannot be one texture on a device whose MAX_TEXTURE_SIZE is
 * 4096, which is common on older Android GPUs. The tile accumulators together
 * ARE the output buffer, partitioned, so the tile edge only trades tile count
 * against the size of the single ping-pong scratch surface -- 2048 keeps that
 * at roughly 17 MB for the poster instead of roughly 67 MB at 4096.
 *
 * Pure arithmetic. Nothing here creates a context or uploads anything.
 */

/**
 * Ships at 2048 as a judgement call from GPU-memory arithmetic, NOT a
 * measurement. A device sweep should settle whether 4096 is safe where the
 * driver reports it; `tileEdgeFor` takes an explicit `cap` so that sweep does
 * not need a code change.
 */
export const EXPORT_TILE_CAP = 2048;

/**
 * MAX_TEXTURE_SIZE is not the binding limit on its own: a renderbuffer or a
 * viewport can be smaller, and a driver that reports 4096 textures with 2048
 * renderbuffers fails at framebuffer-complete time with an error that names
 * neither. Take the minimum of all of them.
 */
export function tileEdgeFor(limits = {}) {
  const {
    maxTextureSize = 0,
    maxRenderbufferSize = 0,
    maxViewportDims = [0, 0],
    cap = EXPORT_TILE_CAP,
  } = limits;

  const candidates = [maxTextureSize, maxRenderbufferSize, maxViewportDims[0], maxViewportDims[1], cap]
    .filter((n) => Number.isFinite(n) && n > 0);

  return candidates.length ? Math.max(1, Math.min(...candidates)) : cap;
}

/** Row-major tiles covering the canvas exactly once. Edge tiles are short. */
export function partitionTiles(width, height, edge) {
  const tiles = [];
  for (let y = 0; y < height; y += edge)
    for (let x = 0; x < width; x += edge)
      tiles.push({ x, y, width: Math.min(edge, width - x), height: Math.min(edge, height - y) });
  return tiles;
}

/** @returns the overlap of two rects, or null when they do not overlap at all. */
export function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
