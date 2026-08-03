import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downsampleReduce, type DownsampleSource } from '../raster.ts';
import { leafSlotBounds, leafSlotIndex } from '../v2/derive.ts';
import { readMetadata } from '../v2/layout.ts';
import { gridRefToBounds, normalizeGridRef } from '../v2/osgb.ts';
import type { TerrainManifestV2 } from '../v2/types.ts';
import { decodeChunk, encodeChunk } from './chunkCodec.ts';
import {
  dequantiseToHeights,
  globalScaleOffset,
  quantiseHeights,
  seededRandom,
  type ScaleOffset,
} from './globalScale.ts';
import { chunkKey } from './grid.ts';
import {
  CHUNK_PIXELS,
  childChunkCoords,
  chunkCoordFor,
  LEVEL_FACTOR,
  parentChunkCoord,
  renormalisedLevels,
  type RenormLevel,
} from './levels.ts';
import { ShardReader } from './shardReader.ts';
import { writeShard, type ShardChunk } from './shardWriter.ts';
import { buildGroupMetadata, buildRenormLevelMetadata, buildRenormChannelMetadata } from './storeMetadata.ts';
import { walkNodes } from './transcode.ts';

/**
 * Peak-preserving sub-block edge, in pixels of the *source* level.
 *
 * The peak surface has to be extracted at a fixed ground scale — roughly one
 * tree crown — and every coarser level then area-averages that same surface.
 * Mixing the two makes adjacent levels statistically inconsistent, which is
 * what makes LOD transitions pop. At 1 m a 4 px block is ~4 m; above that the
 * source is already a peak surface, so plain area mean is correct.
 */
function reductionFor(sourceLevel: number): { blockSize: number; bias: number } {
  return sourceLevel === 0 ? { blockSize: LEVEL_FACTOR, bias: 1 } : { blockSize: 1, bias: 0 };
}

export type RenormaliseOptions = {
  readonly datasetDir: string;
  readonly outDir: string;
  readonly gridRefFilter?: string;
  readonly dither?: boolean;
  readonly ditherSeed?: number;
  readonly levelCount?: number;
  readonly onProgress?: (event: RenormaliseProgressEvent) => void;
};

export type RenormaliseProgressEvent =
  | { readonly kind: 'scan'; readonly chunks: number }
  | { readonly kind: 'chunk'; readonly level: number; readonly done: number; readonly total: number }
  | { readonly kind: 'level'; readonly level: number; readonly chunks: number; readonly bytes: number };

export type RenormaliseSummary = {
  readonly encoding: ScaleOffset;
  readonly dithered: boolean;
  readonly levels: ReadonlyArray<{
    readonly level: number;
    readonly resolutionMetres: number;
    readonly chunks: number;
    readonly objects: number;
    readonly bytes: number;
  }>;
  readonly sourceBytes: number;
  readonly totalBytes: number;
};

type SourceChunk = {
  readonly sourcePath: string;
  readonly coord: readonly [number, number];
  readonly encoding: ScaleOffset;
};

function ditherFor(dither: boolean, seed: number, coord: readonly [number, number]) {
  if (!dither) return undefined;
  // Vary by chunk so a single pattern does not tile across the country, but
  // stay a pure function of (seed, coord) so a re-run reproduces the store.
  return seededRandom(seed + coord[0] * 73856093 + coord[1] * 19349663);
}

/** Level-0 leaves of the v2 pyramid, with the scalars needed to undo their normalisation. */
async function scanLeaves(options: RenormaliseOptions, level: RenormLevel): Promise<SourceChunk[]> {
  const pyramidDir = path.join(options.datasetDir, 'pyramid');
  const chunks: SourceChunk[] = [];
  for await (const { relDir, manifest } of walkNodes(pyramidDir)) {
    if (options.gridRefFilter) {
      const filter = normalizeGridRef(options.gridRefFilter);
      if (!normalizeGridRef(manifest.gridRef).startsWith(filter)) continue;
    }
    const leaf = manifest.leaf;
    if (!leaf) continue;
    const nodeDir = path.join(pyramidDir, relDir);
    const nodeBounds = gridRefToBounds(manifest.gridRef);
    const absent = new Set(leaf.missing ?? []);
    for (let row = 0; row < leaf.rows; row += 1) {
      for (let col = 0; col < leaf.cols; col += 1) {
        const slot = leafSlotIndex(col, row, leaf.cols);
        if (absent.has(slot)) continue;
        const bounds = leafSlotBounds(nodeBounds, col, row, leaf.stepMetres);
        const sourcePath = path.join(nodeDir, '0', `${bounds.eastMin}_${bounds.northMin}.j2c`);
        try {
          await stat(sourcePath);
        } catch {
          continue;
        }
        chunks.push({
          sourcePath,
          coord: chunkCoordFor(level, bounds.eastMin, bounds.northMax),
          encoding: { scale: leaf.enc.scale[slot], offset: leaf.enc.offset[slot] },
        });
      }
    }
    options.onProgress?.({ kind: 'scan', chunks: chunks.length });
  }
  return chunks;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Group encoded chunks by shard and write them out. */
async function flushLevel(
  levelDir: string,
  level: RenormLevel,
  encoded: Map<string, Uint8Array>,
): Promise<{ objects: number; bytes: number }> {
  const shards = new Map<string, ShardChunk[]>();
  for (const [key, bytes] of encoded) {
    const [y, x] = key.split(',').map(Number);
    if (!level.shardChunks) {
      shards.set(chunkKey([y, x]), [{ local: [0, 0], load: async () => bytes }]);
      continue;
    }
    const [perY, perX] = level.shardChunks;
    const shardCoord: readonly [number, number] = [Math.floor(y / perY), Math.floor(x / perX)];
    const entry: ShardChunk = { local: [y % perY, x % perX], load: async () => bytes };
    const shardKey = chunkKey(shardCoord);
    const list = shards.get(shardKey);
    if (list) list.push(entry);
    else shards.set(shardKey, [entry]);
  }

  let bytes = 0;
  for (const [key, entries] of shards) {
    const target = path.join(levelDir, key);
    if (level.shardChunks) {
      const stats = await writeShard(target, level.shardChunks, entries);
      bytes += stats.payloadBytes + stats.indexBytes;
    } else {
      const payload = await entries[0].load();
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, payload);
      bytes += payload.length;
    }
  }
  return { objects: shards.size, bytes };
}

export async function renormaliseToZarr(options: RenormaliseOptions): Promise<RenormaliseSummary> {
  const source: TerrainManifestV2 = await readMetadata(options.datasetDir);
  const levels = renormalisedLevels(options.levelCount);
  const encoding = globalScaleOffset();
  const dither = options.dither ?? false;
  const seed = options.ditherSeed ?? 1;
  const channelDir = path.join(options.outDir, source.channelId);

  await writeJson(path.join(options.outDir, 'zarr.json'), buildGroupMetadata({
    psychogeo: { renormalisedFrom: source.datasetId, sourceFormat: source.format },
  }));
  await writeJson(
    path.join(channelDir, 'zarr.json'),
    buildRenormChannelMetadata(source, levels, encoding, dither),
  );

  const summary: RenormaliseSummary['levels'][number][] = [];
  let sourceBytes = 0;
  let totalBytes = 0;

  // Level 0: decode, undo the per-chunk normalisation, requantise nationally.
  const leaves = await scanLeaves(options, levels[0]);
  const levelDir0 = path.join(channelDir, '0');
  await writeJson(path.join(levelDir0, 'zarr.json'), buildRenormLevelMetadata(levels[0], encoding));
  const encoded0 = new Map<string, Uint8Array>();
  let done = 0;
  for (const leaf of leaves) {
    const codestream = new Uint8Array(await readFile(leaf.sourcePath));
    sourceBytes += codestream.length;
    const decoded = await decodeChunk(codestream);
    const heights = dequantiseToHeights(decoded.raw, leaf.encoding);
    const raw = quantiseHeights(heights, {
      encoding,
      dither: ditherFor(dither, seed, leaf.coord),
    });
    encoded0.set(
      `${leaf.coord[0]},${leaf.coord[1]}`,
      await encodeChunk(raw, decoded.width, decoded.height),
    );
    done += 1;
    if (done % 25 === 0) {
      options.onProgress?.({ kind: 'chunk', level: 0, done, total: leaves.length });
    }
  }
  const flushed0 = await flushLevel(levelDir0, levels[0], encoded0);
  summary.push({
    level: 0,
    resolutionMetres: levels[0].resolutionMetres,
    chunks: encoded0.size,
    objects: flushed0.objects,
    bytes: flushed0.bytes,
  });
  totalBytes += flushed0.bytes;
  options.onProgress?.({ kind: 'level', level: 0, chunks: encoded0.size, bytes: flushed0.bytes });

  // Coarser levels, each built from the 4x4 block below it.
  let previousCoords = [...encoded0.keys()].map((key) => key.split(',').map(Number) as [number, number]);
  for (let index = 1; index < levels.length; index += 1) {
    const level = levels[index];
    const child = levels[index - 1];
    const levelDir = path.join(channelDir, String(level.level));
    await writeJson(path.join(levelDir, 'zarr.json'), buildRenormLevelMetadata(level, encoding));
    const reader = new ShardReader(path.join(channelDir, String(child.level)), child.shardChunks);

    const parents = new Set<string>();
    for (const coord of previousCoords) {
      const parent = parentChunkCoord(coord);
      parents.add(`${parent[0]},${parent[1]}`);
    }

    const block = CHUNK_PIXELS * LEVEL_FACTOR;
    const encodedLevel = new Map<string, Uint8Array>();
    let processed = 0;
    for (const key of parents) {
      const coord = key.split(',').map(Number) as [number, number];
      const pixels = new Float32Array(block * block).fill(Number.NaN);
      let anyChild = false;
      for (const childCoord of childChunkCoords(coord)) {
        const bytes = await reader.read(childCoord);
        if (!bytes) continue;
        anyChild = true;
        const decoded = await decodeChunk(bytes);
        const heights = dequantiseToHeights(decoded.raw, encoding);
        const originY = (childCoord[0] % LEVEL_FACTOR) * CHUNK_PIXELS;
        const originX = (childCoord[1] % LEVEL_FACTOR) * CHUNK_PIXELS;
        for (let y = 0; y < decoded.height; y += 1) {
          pixels.set(
            heights.subarray(y * decoded.width, (y + 1) * decoded.width),
            (originY + y) * block + originX,
          );
        }
      }
      if (!anyChild) continue;

      const { blockSize, bias } = reductionFor(child.level);
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
      const raw = quantiseHeights(reduced.pixels, {
        encoding,
        dither: ditherFor(dither, seed, coord),
      });
      encodedLevel.set(key, await encodeChunk(raw, reduced.width, reduced.height));
      processed += 1;
      if (processed % 10 === 0) {
        options.onProgress?.({ kind: 'chunk', level: level.level, done: processed, total: parents.size });
      }
    }
    reader.clear();

    const flushed = await flushLevel(levelDir, level, encodedLevel);
    summary.push({
      level: level.level,
      resolutionMetres: level.resolutionMetres,
      chunks: encodedLevel.size,
      objects: flushed.objects,
      bytes: flushed.bytes,
    });
    totalBytes += flushed.bytes;
    options.onProgress?.({ kind: 'level', level: level.level, chunks: encodedLevel.size, bytes: flushed.bytes });
    previousCoords = [...encodedLevel.keys()].map((entry) => entry.split(',').map(Number) as [number, number]);
    if (previousCoords.length === 0) break;
  }

  return { encoding, dithered: dither, levels: summary, sourceBytes, totalBytes };
}
