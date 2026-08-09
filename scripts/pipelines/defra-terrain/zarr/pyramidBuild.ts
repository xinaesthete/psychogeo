import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { quantiseHeights, seededRandom, type ScaleOffset } from './globalScale.ts';
import { chunkKey } from './grid.ts';
import { createCodecRunner, mapWithRunner, type CodecRunner } from './codecPool.ts';
import {
  CHUNK_PIXELS,
  childChunkCoords,
  LEVEL_FACTOR,
  parentChunkCoord,
  type RenormLevel,
} from './levels.ts';
import { ShardReader } from './shardReader.ts';
import { shardIndexByteLength, writeShard, type ShardChunk } from './shardWriter.ts';
import { decodeShardIndex } from './shardResort.ts';

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

/**
 * The dither seed for one chunk, or undefined when dithering is off.
 *
 * Varies by chunk so a single pattern does not tile across the country, and is
 * a pure function of (seed, coord) so a re-run reproduces the store — which
 * also means it survives being computed on one thread and used on another.
 */
export function ditherSeedFor(
  dither: boolean,
  seed: number,
  coord: readonly [number, number],
): number | undefined {
  return dither ? seed + coord[0] * 73856093 + coord[1] * 19349663 : undefined;
}

export function ditherFor(dither: boolean, seed: number, coord: readonly [number, number]) {
  const chunkSeed = ditherSeedFor(dither, seed, coord);
  return chunkSeed === undefined ? undefined : seededRandom(chunkSeed);
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
 * Can this shard be skipped — does it already hold every chunk this run wants
 * in it?
 *
 * Existence alone is not enough, and assuming it was cost the LZ store its
 * coarse levels. A `--region SU42` test run had written the level-3 shard
 * covering most of England with the two chunks SU42 reaches; the national run
 * then found the file present and skipped it, so 53 of 55 chunks were never
 * built. Nothing failed and nothing was logged, because from the run's point of
 * view the shard was done.
 *
 * A shard is complete only against a given expectation, so the expectation has
 * to be checked. One suffix read per shard, against a level-0 shard that is
 * ~100 MB of payload — the cheapest part of deciding to skip it.
 */
export async function shardIsComplete(
  filePath: string,
  level: RenormLevel,
  expected: ReadonlyArray<readonly [number, number]>,
): Promise<{ readonly complete: boolean; readonly bytes: number } | undefined> {
  const size = await fileSize(filePath);
  if (size === undefined) return undefined;
  // An unsharded level is one chunk per object, so the file being there is the
  // whole of the claim.
  if (!level.shardChunks) return { complete: true, bytes: size };

  const indexBytes = shardIndexByteLength(level.shardChunks);
  if (size < indexBytes) return { complete: false, bytes: size };
  const handle = await open(filePath, 'r');
  try {
    const buffer = new Uint8Array(indexBytes);
    await handle.read(buffer, 0, indexBytes, size - indexBytes);
    const present = new Set(decodeShardIndex(buffer, level.shardChunks).map((entry) => entry.slot));
    const [, perX] = level.shardChunks;
    const complete = expected.every((coord) => {
      const { local } = placeInShard(level, coord);
      return present.has(local[0] * perX + local[1]);
    });
    return { complete, bytes: size };
  } finally {
    await handle.close();
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
  /** Shared with the caller's level-0 pass; omit to run the codec inline. */
  readonly runner?: CodecRunner;
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
  const runner = options.runner ?? createCodecRunner({ size: 0 });
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
      const existing = await shardIsComplete(path.join(levelDir, key), level, group);
      const skip = existing?.complete === true;
      if (skip) levelBytes += existing.bytes;
      const pending = skip ? [] : group;
      if (skip) nextCoords.push(...group);

      // Reads stay here, where the shard reader and its index cache live; the
      // 16 decodes, the downsample and the encode go to the pool. One shard's
      // worth is in flight at a time, which bounds memory the way writing a
      // shard at a time already does.
      const width = Math.max(1, runner.size);
      const built = await mapWithRunner(pending, width, async (coord) => {
        const children = [];
        for (const childCoord of childChunkCoords(coord)) {
          let bytes: Uint8Array | undefined;
          try {
            bytes = await reader.read(childCoord);
          } catch (error) {
            failures += 1;
            options.onProgress?.({
              kind: 'failed',
              level: child.level,
              coord: childCoord,
              reason: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (!bytes) continue;
          children.push({
            bytes,
            originY: (childCoord[0] % LEVEL_FACTOR) * CHUNK_PIXELS,
            originX: (childCoord[1] % LEVEL_FACTOR) * CHUNK_PIXELS,
            coord: childCoord,
          });
        }
        if (children.length === 0) return undefined;

        const { blockSize, bias } = options.reduction(child.level);
        try {
          const outcome = await runner.submit({
            kind: 'reduce',
            id: 0,
            children: children.map(({ bytes, originY, originX }) => ({ bytes, originY, originX })),
            block: CHUNK_PIXELS * LEVEL_FACTOR,
            encoding,
            sourceResolutionMetres: child.resolutionMetres,
            targetResolutionMetres: level.resolutionMetres,
            blockSize,
            bias,
            ditherSeed: ditherSeedFor(dither, seed, coord),
          });
          // A child that would not decode costs its own quadrant, which the
          // downsample already treats as absent.
          for (const index of outcome.failed) {
            failures += 1;
            options.onProgress?.({
              kind: 'failed',
              level: child.level,
              coord: children[index].coord,
              reason: 'would not decode',
            });
          }
          return outcome.bytes ?? undefined;
        } catch (error) {
          failures += 1;
          options.onProgress?.({
            kind: 'failed',
            level: level.level,
            coord,
            reason: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      });

      const entries: ShardChunk[] = [];
      pending.forEach((coord, i) => {
        const bytes = built[i];
        if (!bytes) return;
        entries.push({ local: placeInShard(level, coord).local, load: async () => bytes });
        nextCoords.push(coord);
        processed += 1;
        if (processed % 25 === 0) {
          options.onProgress?.({ kind: 'chunk', level: level.level, done: processed, total: parents.length });
        }
      });
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
