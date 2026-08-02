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

/** An active tile competing to replace retained coverage. */
export type CoverageEntry = {
  readonly extent: TileExtent;
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
