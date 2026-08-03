import { extentsIntersect, type TileExtent } from './pyramidOsgb';

/**
 * Tiles at this tier or coarser are the whole-country overview (100 km square
 * chunks, ~26 of them for England). They are the fallback of last resort, they
 * cost very little to hold, and refetching them is exactly the stutter we are
 * trying to remove — so they are never evicted once loaded.
 */
export const PINNED_TIER_METRES = 100_000;

/**
 * Byte ceiling for retained-but-not-desired tiles. These pin entries in the
 * decoded texture cache, so the budget is a slice of that cache rather than
 * memory on top of it.
 */
export const DEFAULT_RETAINED_BUDGET_BYTES = 192 * 1024 * 1024;

export function isPinnedTier(extentMetres: number): boolean {
  return extentMetres >= PINNED_TIER_METRES;
}

/**
 * Depth bias pushing a retained tile behind its replacements.
 *
 * While a fallback is showing, the tiles that have already arrived are drawn
 * over the same ground, and the two surfaces are near-coincident over most of
 * it — close enough that z-fighting doubles every contour. Biasing the fallback
 * away from the camera makes the newer surface win wherever they nearly agree;
 * where they genuinely differ the fallback still shows through, which is
 * correct, because there the new data has not arrived yet.
 */
export const FALLBACK_POLYGON_OFFSET_FACTOR = 4;
export const FALLBACK_POLYGON_OFFSET_UNITS = 16;

/**
 * Largest mask resolution per axis, and the size the scratch buffer is cut to.
 *
 * 256 covers the widest ratio any pyramid here reaches: the renormalised zarr
 * store's level 4 is a 256 km chunk over 1 km leaves. 64 KB per masked tile at
 * full size, and only tiles that span that far are given it.
 */
export const MAX_COVERAGE_MASK_RESOLUTION = 256;

/**
 * Cells per axis for masking `extent` with `covers`.
 *
 * A cell is only masked when a cover fills it completely — under-masking shows
 * a coarse tile through, over-masking punches a hole in one, and a hole is
 * worse. So the resolution has to be fine enough that the *smallest* cover
 * fills whole cells, and this derives it rather than assuming a number.
 *
 * A fixed 100 was right for the v2 pyramid by arithmetic accident: its top
 * tier is 100 km over 1 km leaves, exactly 100 cells of exactly one leaf. The
 * zarr pyramid runs 4× per level to a 256 km chunk, where 100 cells are
 * 2.56 km each — wider than the 1 km leaves meant to cover them, so every one
 * of them rounded away to nothing and the level-4 tile drew over ready 1 m
 * terrain.
 */
export function coverageMaskResolution(
  extent: TileExtent,
  covers: readonly CoverageEntry[],
  max = MAX_COVERAGE_MASK_RESOLUTION,
): number {
  const width = extent.eastMax - extent.eastMin;
  const height = extent.northMax - extent.northMin;
  let finest = Infinity;
  for (const cover of covers) {
    if (!cover.ready) continue;
    finest = Math.min(
      finest,
      cover.extent.eastMax - cover.extent.eastMin,
      cover.extent.northMax - cover.extent.northMin,
    );
  }
  if (!Number.isFinite(finest) || finest <= 0) return 1;
  // Ratios in a pyramid are whole numbers, so this lands on cover edges
  // exactly; ceil only matters for a ragged extent, where erring finer keeps
  // the full-cell rule conservative.
  const needed = Math.ceil(Math.max(width, height) / finest);
  return Math.min(max, Math.max(1, needed));
}

/** An active tile competing to replace retained coverage. */
export type CoverageEntry = {
  readonly extent: TileExtent;
  /**
   * Has terrain on screen. Only a ready tile may mask out the fallback beneath
   * it — masking on the strength of a tile that failed would punch a hole.
   */
  readonly ready: boolean;
  /** Ready, or failed and never coming — either way it is done waiting. */
  readonly settled: boolean;
  /**
   * Whether this tile is on screen, or has not been frustum-tested yet. Loads
   * are only scheduled for on-screen tiles, so an off-screen tile can sit
   * unsettled indefinitely; letting it block would leave a fallback drawing
   * under ready terrain forever.
   */
  readonly awaited: boolean;
};

export type RetainedEntry = {
  readonly key: string;
  readonly extent: TileExtent;
  readonly bytes: number;
  readonly pinned: boolean;
  /** Monotonic counter; lower means longer since the tile was last desired. */
  readonly retiredTick: number;
};

/**
 * Whether a retained tile should still be drawn.
 *
 * It earns its place only while something that supersedes it is still awaited:
 * once every active tile over that ground has settled, the retained copy is
 * stale detail sitting underneath better data, and it goes away. If nothing
 * active overlaps it at all, nothing wants that ground drawn.
 */
export function retainedStillNeeded(
  extent: TileExtent,
  covers: readonly CoverageEntry[],
): boolean {
  for (const cover of covers) {
    if (cover.settled || !cover.awaited) continue;
    if (extentsIntersect(cover.extent, extent)) return true;
  }
  return false;
}

/**
 * Rasterise which parts of a fallback tile are already covered by ready
 * terrain, so the shader can drop those fragments instead of leaving two
 * surfaces to fight over the same ground.
 *
 * Each ready cover fills the cells that sit wholly inside it, so coverage
 * accumulates: a 100 km fallback is masked by a field of 1 km leaves even
 * though no single leaf fills a cell on its own. Partly covered cells are left
 * drawing — conservative in the safe direction, since an unmasked cell means a
 * little fallback showing through while a wrongly masked one is a hole.
 *
 * Filling per cover rather than testing every cell against every cover keeps
 * this proportional to the area actually masked.
 *
 * Writes 255 (drop) or 0 (draw) into `out`, row-major with row 0 at the
 * southern edge, and returns true if anything at all is masked.
 */
export function rasteriseCoverageMask(
  extent: TileExtent,
  covers: readonly CoverageEntry[],
  out: Uint8Array,
  resolution = MAX_COVERAGE_MASK_RESOLUTION,
): boolean {
  out.fill(0);
  const stepEast = (extent.eastMax - extent.eastMin) / resolution;
  const stepNorth = (extent.northMax - extent.northMin) / resolution;
  if (!(stepEast > 0) || !(stepNorth > 0)) return false;
  // Cover edges are meant to land on cell edges; tolerate float drift there.
  const slack = 1e-6;
  let masked = false;

  for (const cover of covers) {
    if (!cover.ready) continue;
    const colStart = Math.max(
      0,
      Math.ceil((cover.extent.eastMin - extent.eastMin) / stepEast - slack),
    );
    const colEnd = Math.min(
      resolution,
      Math.floor((cover.extent.eastMax - extent.eastMin) / stepEast + slack),
    );
    if (colStart >= colEnd) continue;
    const rowStart = Math.max(
      0,
      Math.ceil((cover.extent.northMin - extent.northMin) / stepNorth - slack),
    );
    const rowEnd = Math.min(
      resolution,
      Math.floor((cover.extent.northMax - extent.northMin) / stepNorth + slack),
    );
    if (rowStart >= rowEnd) continue;

    for (let row = rowStart; row < rowEnd; row += 1) {
      out.fill(255, row * resolution + colStart, row * resolution + colEnd);
    }
    masked = true;
  }
  return masked;
}

/**
 * Retained tiles outside the current query bounds can never be uncovered by a
 * loading tile, so they are dead weight. Pinned tiers ignore this: holding the
 * national overview resident is the whole point.
 */
export function retainedShouldDrop(entry: RetainedEntry, queryBounds: TileExtent): boolean {
  if (entry.pinned) return false;
  return !extentsIntersect(entry.extent, queryBounds);
}

/**
 * Keys to evict, least recently desired first, until the pool fits the budget.
 * Pinned entries are excluded from both the total and the candidate list.
 */
export function selectRetainedEvictions(
  entries: readonly RetainedEntry[],
  budgetBytes: number,
): string[] {
  let total = 0;
  const candidates: RetainedEntry[] = [];
  for (const entry of entries) {
    if (entry.pinned) continue;
    total += entry.bytes;
    candidates.push(entry);
  }
  if (total <= budgetBytes) return [];

  candidates.sort((a, b) => a.retiredTick - b.retiredTick);
  const evicted: string[] = [];
  for (const entry of candidates) {
    if (total <= budgetBytes) break;
    evicted.push(entry.key);
    total -= entry.bytes;
  }
  return evicted;
}
