import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downsampleReduce, type DownsampleSource } from '../raster.ts';
import { dequantiseToHeights, quantiseHeights, seededRandom, type ScaleOffset } from './globalScale.ts';
import { chunkKey } from './grid.ts';
import { decodeChunk, encodeChunk } from './chunkCodec.ts';
import {
  CHUNK_PIXELS,
  childChunkCoords,
  LEVEL_FACTOR,
  parentChunkCoord,
  type RenormLevel,
} from './levels.ts';
import { ShardReader } from './shardReader.ts';
import { writeShard, type ShardChunk } from './shardWriter.ts';

/**
 * Building the pyramid above level 0.
 *
 * Every channel's coarse levels are made the same way — read the 4x4 block
 * below through the shard index, area-reduce it, requantise, write the shard —
 * and only level 0 differs between channels: heights come from the v2 archive's
 * codestreams, dz from a pair of source rasters. This is the shared half.
 */

export type PyramidProgressEvent =
  | { readonly kind: 'chunk'; readonly level: number; readonly done: number; readonly total: number }
  | { readonly kind: 'level'; readonly level: number; readonly chunks: number; readonly bytes: number }
  /** One chunk could not be built. Loud, counted, and not fatal. */
  | {
      readonly kind: 'failed';
      readonly level: number;
      readonly coord: readonly [number, number];
      readonly reason: string;
    };

export type LevelSummary = {
  readonly level: number;
  readonly resolutionMetres: number;
  readonly chunks: number;
  readonly objects: number;
  readonly bytes: number;
};

/** How a level is reduced from the one below it. */
export type Reduction = { readonly blockSize: number; readonly bias: number };

/**
 * Peak-preserving sub-block edge, in pixels of the *source* level.
 *
 * The peak surface has to be extracted at a fixed ground scale — roughly one
 * tree crown — and every coarser level then area-averages that same surface.
 * Mixing the two makes adjacent levels statistically inconsistent, which is
 * what makes LOD transitions pop. At 1 m a 4 px block is ~4 m; above that the
 * source is already a peak surface, so plain area mean is correct.
 *
 * Shared by every height-like channel, and that sharing is load-bearing: FZ and
 * LZ have to be reduced identically or their difference stops meaning anything
 * above level 0, where a peak-reduced FZ would be measured against a
 * mean-reduced LZ.
 */
export function heightReduction(sourceLevel: number): Reduction {
  return sourceLevel === 0 ? { blockSize: LEVEL_FACTOR, bias: 1 } : { blockSize: 1, bias: 0 };
}

export function ditherFor(dither: boolean, seed: number, coord: readonly [number, number]) {
  if (!dither) return undefined;
  // Vary by chunk so a single pattern does not tile across the country, but
  // stay a pure function of (seed, coord) so a re-run reproduces the store.
  return seededRandom(seed + coord[0] * 73856093 + coord[1] * 19349663);
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Which shard a chunk belongs to, and where inside it. */
export function placeInShard(level: RenormLevel, coord: readonly [number, number]) {
  if (!level.shardChunks) return { key: chunkKey(coord), local: [0, 0] as const };
  const [perY, perX] = level.shardChunks;
  return {
    key: chunkKey([Math.floor(coord[0] / perY), Math.floor(coord[1] / perX)]),
    local: [coord[0] % perY, coord[1] % perX] as const,
  };
}

export function groupByShard<T>(
  level: RenormLevel,
  items: readonly T[],
  coordOf: (item: T) => readonly [number, number],
): Map<string, T[]> {
  const shards = new Map<string, T[]>();
  for (const item of items) {
    const { key } = placeInShard(level, coordOf(item));
    const list = shards.get(key);
    if (list) list.push(item);
    else shards.set(key, [item]);
  }
  return shards;
}

/** Size of an already-written object, or undefined if it is not there yet. */
export async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return undefined;
  }
}

/**
 * Write one shard's chunks and let them go.
 *
 * Deliberately per shard rather than per level: holding a whole level's
 * encoded chunks would be ~50 MB for one cell but ~75 GB nationally, which is
 * the difference between a run that finishes and one that dies overnight.
 */
export async function writeOneShard(
  levelDir: string,
  level: RenormLevel,
  key: string,
  entries: ShardChunk[],
): Promise<number> {
  const target = path.join(levelDir, key);
  if (level.shardChunks) {
    const stats = await writeShard(target, level.shardChunks, entries);
    return stats.payloadBytes + stats.indexBytes;
  }
  const payload = await entries[0].load();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, payload);
  return payload.length;
}

export type CoarseLevelResult = {
  readonly levels: LevelSummary[];
  readonly failures: number;
};

export type CoarseLevelOptions = {
  readonly channelDir: string;
  readonly levels: readonly RenormLevel[];
  readonly encoding: ScaleOffset;
  /** Chunk coordinates written at level 0. */
  readonly baseCoords: ReadonlyArray<readonly [number, number]>;
  /** Reduction to apply when building *from* the given source level. */
  readonly reduction: (sourceLevel: number) => Reduction;
  /** Metadata for each level, written before the level is built. */
  readonly levelMetadata: (level: RenormLevel) => unknown;
  readonly dither?: boolean;
  readonly ditherSeed?: number;
  readonly onProgress?: (event: PyramidProgressEvent) => void;
};

/**
 * Build levels 1..N, each from the 4x4 block below it.
 *
 * Reads back through `ShardReader` rather than keeping the level in memory,
 * which also means the pass exercises the same suffix-then-range access the
 * browser will use, so a mistake shows up locally rather than in the viewer.
 */
export async function buildCoarseLevels(options: CoarseLevelOptions): Promise<CoarseLevelResult> {
  const { channelDir, levels, encoding } = options;
  const dither = options.dither ?? false;
  const seed = options.ditherSeed ?? 1;
  const summary: LevelSummary[] = [];
  let failures = 0;
  let writtenCoords: ReadonlyArray<readonly [number, number]> = options.baseCoords;

  for (let index = 1; index < levels.length; index += 1) {
    if (writtenCoords.length === 0) break;
    const level = levels[index];
    const child = levels[index - 1];
    const levelDir = path.join(channelDir, String(level.level));
    await writeJson(path.join(levelDir, 'zarr.json'), options.levelMetadata(level));
    const reader = new ShardReader(path.join(channelDir, String(child.level)), child.shardChunks);

    const parentKeys = new Set<string>();
    for (const coord of writtenCoords) {
      const parent = parentChunkCoord(coord);
      parentKeys.add(`${parent[0]},${parent[1]}`);
    }
    const parents = [...parentKeys].map((key) => key.split(',').map(Number) as [number, number]);
    const shards = groupByShard(level, parents, (coord) => coord);

    const block = CHUNK_PIXELS * LEVEL_FACTOR;
    const nextCoords: Array<readonly [number, number]> = [];
    let levelBytes = 0;
    let processed = 0;
    for (const [key, group] of shards) {
      const existingBytes = await fileSize(path.join(levelDir, key));
      if (existingBytes !== undefined) levelBytes += existingBytes;
      const entries: ShardChunk[] = [];
      for (const coord of group) {
        if (existingBytes !== undefined) {
          nextCoords.push(coord);
          continue;
        }
        const pixels = new Float32Array(block * block).fill(Number.NaN);
        let anyChild = false;
        // A child that will not decode costs its own quadrant of this parent,
        // which the downsample already handles as absent. Losing a quarter of
        // one coarse chunk is a far smaller harm than losing the run, but it is
        // still a hole, so it is reported rather than swallowed.
        for (const childCoord of childChunkCoords(coord)) {
          try {
            const bytes = await reader.read(childCoord);
            if (!bytes) continue;
            const decoded = await decodeChunk(bytes);
            anyChild = true;
            const heights = dequantiseToHeights(decoded.raw, encoding);
            const originY = (childCoord[0] % LEVEL_FACTOR) * CHUNK_PIXELS;
            const originX = (childCoord[1] % LEVEL_FACTOR) * CHUNK_PIXELS;
            for (let y = 0; y < decoded.height; y += 1) {
              pixels.set(
                heights.subarray(y * decoded.width, (y + 1) * decoded.width),
                (originY + y) * block + originX,
              );
            }
          } catch (error) {
            failures += 1;
            options.onProgress?.({
              kind: 'failed',
              level: child.level,
              coord: childCoord,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!anyChild) continue;

        try {
          const { blockSize, bias } = options.reduction(child.level);
          const downsampleSource: DownsampleSource = {
            pixels,
            width: block,
            height: block,
            resolutionMetres: child.resolutionMetres,
            // Only used to derive the output extent, which this pass ignores —
            // placement comes from the chunk coordinate, not the raster extent.
            extent: { eastMin: 0, eastMax: block, northMin: 0, northMax: block },
          };
          const reduced = downsampleReduce(downsampleSource, level.resolutionMetres, blockSize, bias);
          const raw = quantiseHeights(reduced.pixels, { encoding, dither: ditherFor(dither, seed, coord) });
          const bytes = await encodeChunk(raw, reduced.width, reduced.height);
          entries.push({ local: placeInShard(level, coord).local, load: async () => bytes });
          nextCoords.push(coord);
        } catch (error) {
          failures += 1;
          options.onProgress?.({
            kind: 'failed',
            level: level.level,
            coord,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        processed += 1;
        if (processed % 25 === 0) {
          options.onProgress?.({ kind: 'chunk', level: level.level, done: processed, total: parents.length });
        }
      }
      if (entries.length > 0) levelBytes += await writeOneShard(levelDir, level, key, entries);
    }
    reader.clear();

    summary.push({
      level: level.level,
      resolutionMetres: level.resolutionMetres,
      chunks: nextCoords.length,
      objects: shards.size,
      bytes: levelBytes,
    });
    options.onProgress?.({ kind: 'level', level: level.level, chunks: nextCoords.length, bytes: levelBytes });
    writtenCoords = nextCoords;
  }

  return { levels: summary, failures };
}
