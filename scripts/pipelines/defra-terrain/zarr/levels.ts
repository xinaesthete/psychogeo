import { NATIONAL_EXTENT } from './grid.ts';

/**
 * The renormalised pyramid: one chunk shape at every level, resolution going
 * up by 4 each step.
 *
 * The v2 pyramid tied each level's chunk to an OSGB tier, which made the chunk
 * shape vary per level (1000², 625², 313², 800², 200²) and left level 2 at a
 * rounded 31.949 m. Nothing about Zarr wants that: a uniform chunk with an
 * exact integer factor makes the shard geometry, the coordinate transforms and
 * the downsample all fall out the same way at every level.
 *
 * 4× rather than 2×: it keeps the cadence the v2 levels already had (8×, 4×,
 * 3.9×, 4×) at ~6.7% pyramid overhead, where a 2× ladder would cost ~33% and
 * eat most of what the renormalisation saves.
 */
export const CHUNK_PIXELS = 1000;
export const LEVEL_FACTOR = 4;
export const BASE_CHUNK_METRES = 1000;
export const DEFAULT_LEVEL_COUNT = 5;

/** Inner chunks per shard, where a level has enough chunks to be worth sharding. */
export const SHARD_CHUNKS = 10;

export type RenormLevel = {
  readonly level: number;
  readonly resolutionMetres: number;
  /** Ground size of one chunk. */
  readonly chunkMetres: number;
  /** [y, x] chunk counts covering the national sheet. */
  readonly chunkGrid: readonly [number, number];
  /** [y, x] pixels. */
  readonly shape: readonly [number, number];
  readonly chunkShape: readonly [number, number];
  readonly shardChunks: readonly [number, number] | null;
  readonly shardShape: readonly [number, number] | null;
};

export function renormalisedLevel(level: number): RenormLevel {
  const factor = LEVEL_FACTOR ** level;
  const chunkMetres = BASE_CHUNK_METRES * factor;
  // Chunk counts, not sheet divisions: 1300 km is a whole number of 1 km and
  // 4 km chunks but not of 64 km ones, so the coarse levels round up and the
  // surplus stays unwritten. Every level shares the north-west origin, so a
  // coarse chunk still covers exactly 4×4 of the level below.
  const chunksX = Math.ceil((NATIONAL_EXTENT.eastMax - NATIONAL_EXTENT.eastMin) / chunkMetres);
  const chunksY = Math.ceil((NATIONAL_EXTENT.northMax - NATIONAL_EXTENT.northMin) / chunkMetres);
  const sharded = chunksX > SHARD_CHUNKS || chunksY > SHARD_CHUNKS;
  return {
    level,
    resolutionMetres: factor,
    chunkMetres,
    chunkGrid: [chunksY, chunksX],
    shape: [chunksY * CHUNK_PIXELS, chunksX * CHUNK_PIXELS],
    chunkShape: [CHUNK_PIXELS, CHUNK_PIXELS],
    shardChunks: sharded ? [SHARD_CHUNKS, SHARD_CHUNKS] : null,
    shardShape: sharded ? [SHARD_CHUNKS * CHUNK_PIXELS, SHARD_CHUNKS * CHUNK_PIXELS] : null,
  };
}

export function renormalisedLevels(count = DEFAULT_LEVEL_COUNT): RenormLevel[] {
  return Array.from({ length: count }, (_, level) => renormalisedLevel(level));
}

/**
 * Chunk coordinate [y, x] for the chunk whose north-west corner is at
 * (eastMin, northMax). y runs south from the top of the sheet, matching the
 * north-first row order of the codestreams.
 */
export function chunkCoordFor(
  level: RenormLevel,
  eastMin: number,
  northMax: number,
): readonly [number, number] {
  const x = Math.round((eastMin - NATIONAL_EXTENT.eastMin) / level.chunkMetres);
  const y = Math.round((NATIONAL_EXTENT.northMax - northMax) / level.chunkMetres);
  return [y, x];
}

/** The 4×4 block of child coordinates a coarse chunk is built from. */
export function childChunkCoords(
  coord: readonly [number, number],
): Array<readonly [number, number]> {
  const children: Array<readonly [number, number]> = [];
  for (let dy = 0; dy < LEVEL_FACTOR; dy += 1) {
    for (let dx = 0; dx < LEVEL_FACTOR; dx += 1) {
      children.push([coord[0] * LEVEL_FACTOR + dy, coord[1] * LEVEL_FACTOR + dx]);
    }
  }
  return children;
}

export function parentChunkCoord(
  coord: readonly [number, number],
): readonly [number, number] {
  return [Math.floor(coord[0] / LEVEL_FACTOR), Math.floor(coord[1] / LEVEL_FACTOR)];
}
