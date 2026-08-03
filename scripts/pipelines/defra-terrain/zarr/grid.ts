import type { TileExtent } from '../v2/osgb.ts';
import type { PyramidLevel } from '../v2/types.ts';

/**
 * The full OSGB National Grid sheet (EPSG:27700). Arrays are sized to the
 * whole sheet whatever the dataset actually covers — Zarr leaves absent chunks
 * unwritten, so an England-only store costs nothing extra for the Scottish
 * rows and gains them later without a reshape.
 */
export const NATIONAL_EXTENT: TileExtent = {
  eastMin: 0,
  eastMax: 700_000,
  northMin: 0,
  northMax: 1_300_000,
};

export type LevelGrid = {
  readonly level: number;
  /** Ground size of one chunk — the OSGB tier its codestream was cut to. */
  readonly chunkMetres: number;
  /** Pixels per side in the stored codestream. */
  readonly chunkPixels: number;
  /** Nominal resolution as declared in `tileMatrixSet`. */
  readonly nominalResolutionMetres: number;
  /**
   * What the pixels actually measure. `pixelDimensions` rounds, so level 2's
   * "32 m" is really 10000/313 = 31.949 m. Recording the true figure keeps the
   * coordinate transform honest rather than resampling to make it tidy.
   */
  readonly resolutionMetres: number;
  /** Whole-sheet array size, [y, x] in pixels. */
  readonly shape: readonly [number, number];
  readonly chunkShape: readonly [number, number];
  /** Chunk counts over the whole sheet, [y, x]. */
  readonly chunkGrid: readonly [number, number];
  /** Inner chunks per shard, [y, x]; null when the level is not sharded. */
  readonly shardChunks: readonly [number, number] | null;
  readonly shardShape: readonly [number, number] | null;
  readonly shardMetres: number | null;
};

/**
 * Shard size per chunk tier. Sharding exists here to cut file count, so the
 * target is a few thousand files rather than 150k, at a size that is still
 * comfortable to write, resume and range-read:
 *
 * - 1 km chunks → 10 km shards: 100 leaves, order 100 MB.
 * - 5/10 km chunks → 100 km shards: 400 / 100 chunks, tens of MB.
 * - 100 km chunks are already one per square; sharding would wrap a single
 *   chunk in an index for nothing.
 */
export function defaultShardMetres(chunkMetres: number): number | null {
  if (chunkMetres >= 100_000) return null;
  if (chunkMetres <= 1_000) return 10_000;
  return 100_000;
}

function divideExactly(total: number, part: number, what: string): number {
  const count = total / part;
  if (!Number.isInteger(count)) {
    throw new Error(`${what}: ${total} is not a whole number of ${part}`);
  }
  return count;
}

export function levelGrid(
  level: PyramidLevel,
  shardMetres: number | null = defaultShardMetres(level.tierMetres),
): LevelGrid {
  const chunkMetres = level.tierMetres;
  const chunkPixels = Math.round(chunkMetres / level.resolutionMetres);
  if (chunkPixels < 1) {
    throw new Error(`level ${level.level}: resolution ${level.resolutionMetres} m exceeds tier ${chunkMetres} m`);
  }
  const chunksX = divideExactly(
    NATIONAL_EXTENT.eastMax - NATIONAL_EXTENT.eastMin,
    chunkMetres,
    `level ${level.level} easting`,
  );
  const chunksY = divideExactly(
    NATIONAL_EXTENT.northMax - NATIONAL_EXTENT.northMin,
    chunkMetres,
    `level ${level.level} northing`,
  );

  let shardChunks: readonly [number, number] | null = null;
  if (shardMetres !== null) {
    const perSide = divideExactly(shardMetres, chunkMetres, `level ${level.level} shard`);
    if (perSide > 1) shardChunks = [perSide, perSide];
  }

  return {
    level: level.level,
    chunkMetres,
    chunkPixels,
    nominalResolutionMetres: level.resolutionMetres,
    resolutionMetres: chunkMetres / chunkPixels,
    shape: [chunksY * chunkPixels, chunksX * chunkPixels],
    chunkShape: [chunkPixels, chunkPixels],
    chunkGrid: [chunksY, chunksX],
    shardChunks,
    shardShape: shardChunks ? [shardChunks[0] * chunkPixels, shardChunks[1] * chunkPixels] : null,
    shardMetres: shardChunks ? shardMetres : null,
  };
}

/**
 * Chunk coordinate for a chunk covering `extent`, as [y, x].
 *
 * Row 0 is the **north** edge. The stored codestreams are north-first (the
 * tile shader flips v when sampling), so the array's y axis has to run the
 * same way — that is the whole reason the existing bytes can be reused
 * without a decode.
 */
export function chunkCoordForExtent(
  grid: LevelGrid,
  extent: TileExtent,
): readonly [number, number] {
  const x = Math.round((extent.eastMin - NATIONAL_EXTENT.eastMin) / grid.chunkMetres);
  const y = Math.round((NATIONAL_EXTENT.northMax - extent.northMax) / grid.chunkMetres);
  if (x < 0 || x >= grid.chunkGrid[1] || y < 0 || y >= grid.chunkGrid[0]) {
    throw new Error(
      `chunk at ${extent.eastMin},${extent.northMin} is outside the national grid at level ${grid.level}`,
    );
  }
  return [y, x];
}

export type ShardPlacement = {
  /** Which shard the chunk belongs to, [y, x]. */
  readonly shard: readonly [number, number];
  /** Position within that shard, [y, x]. */
  readonly local: readonly [number, number];
};

export function shardPlacement(
  grid: LevelGrid,
  chunkCoord: readonly [number, number],
): ShardPlacement {
  if (!grid.shardChunks) {
    return { shard: chunkCoord, local: [0, 0] };
  }
  const [perY, perX] = grid.shardChunks;
  return {
    shard: [Math.floor(chunkCoord[0] / perY), Math.floor(chunkCoord[1] / perX)],
    local: [chunkCoord[0] % perY, chunkCoord[1] % perX],
  };
}

/** Zarr v3 default chunk key encoding, `c/<y>/<x>`. */
export function chunkKey(coord: readonly [number, number]): string {
  return `c/${coord[0]}/${coord[1]}`;
}
