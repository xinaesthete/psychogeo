import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { leafSlotBounds, leafSlotIndex } from '../v2/derive.ts';
import { gridRefToBounds, normalizeGridRef, type TileExtent } from '../v2/osgb.ts';
import { safeParseNodeManifestJson } from '../v2/schema.ts';
import type { PyramidNodeManifest, TerrainManifestV2 } from '../v2/types.ts';
import { chunkCoordForExtent, chunkKey, levelGrid, shardPlacement, type LevelGrid } from './grid.ts';
import { nodePath, openSourceStore, readSourceMetadata, type SourceStore } from './sourceStore.ts';
import { writeShard, type ShardChunk } from './shardWriter.ts';
import {
  buildChannelGroupMetadata,
  buildEncodingArrayMetadata,
  buildGroupMetadata,
  buildLevelArrayMetadata,
  buildStoreRootMetadata,
} from './storeMetadata.ts';

export type TranscodeOptions = {
  /** An extracted v2 dataset directory, or the `.zip` holding one. */
  readonly datasetPath: string;
  readonly outDir: string;
  /** Restrict to nodes under this OSGB grid ref, e.g. `SU` or `SU42`. */
  readonly gridRefFilter?: string;
  readonly onProgress?: (event: TranscodeProgressEvent) => void;
};

export type TranscodeProgressEvent =
  | { readonly kind: 'scan'; readonly nodes: number; readonly chunks: number }
  | { readonly kind: 'shard'; readonly level: number; readonly done: number; readonly total: number }
  | { readonly kind: 'level'; readonly level: number; readonly shards: number; readonly chunks: number };

export type TranscodeSummary = {
  readonly nodes: number;
  readonly levels: readonly LevelSummary[];
  readonly totalChunks: number;
  readonly totalShards: number;
  readonly totalBytes: number;
  readonly missingChunks: readonly string[];
};

export type LevelSummary = {
  readonly level: number;
  readonly chunks: number;
  readonly shards: number;
  readonly bytes: number;
  readonly indexBytes: number;
};

type PendingChunk = {
  readonly sourcePath: string;
  readonly chunkCoord: readonly [number, number];
  readonly scale: number;
  readonly offset: number;
};

/**
 * Yield every node manifest under `pyramid/`.
 *
 * Nodes are enumerated rather than derived from `naming` because a bounds
 * ingest has no single grid-ref root to template against (`ingestCell` reads
 * `bounds_0_0_700000_700000`), and the manifests carry their own `gridRef`
 * anyway. Which nodes exist is the store's problem: a directory walks the tree,
 * an archive filters its central directory.
 */
export async function* walkNodes(
  store: SourceStore,
): AsyncGenerator<{ relDir: string; manifest: PyramidNodeManifest }> {
  for (const relDir of await store.nodeDirs()) {
    const raw = await store.readText(nodePath(relDir, 'manifest.json'));
    if (raw === undefined) continue;
    const parsed = safeParseNodeManifestJson(JSON.parse(raw));
    if (parsed.success) yield { relDir, manifest: parsed.data };
  }
}

function matchesFilter(gridRef: string, filter: string | undefined): boolean {
  if (!filter) return true;
  return normalizeGridRef(gridRef).startsWith(normalizeGridRef(filter));
}

function gridsByLevel(source: TerrainManifestV2): Map<number, LevelGrid> {
  const grids = new Map<number, LevelGrid>();
  for (const level of source.tileMatrixSet.levels) {
    grids.set(level.level, levelGrid(level));
  }
  return grids;
}

async function collectChunks(
  store: SourceStore,
  options: TranscodeOptions,
  source: TerrainManifestV2,
  grids: Map<number, LevelGrid>,
): Promise<{ byLevel: Map<number, PendingChunk[]>; nodes: number; missing: string[] }> {
  const byLevel = new Map<number, PendingChunk[]>();
  const missing: string[] = [];
  let nodes = 0;
  let chunks = 0;

  const push = async (level: number, chunk: PendingChunk) => {
    // A manifest can outlive its payload if a run was interrupted; a missing
    // file is recorded and skipped rather than aborting the transcode.
    if ((await store.size(chunk.sourcePath)) === undefined) {
      missing.push(chunk.sourcePath);
      return;
    }
    const list = byLevel.get(level);
    if (list) list.push(chunk);
    else byLevel.set(level, [chunk]);
    chunks += 1;
  };

  for await (const { relDir, manifest } of walkNodes(store)) {
    if (!matchesFilter(manifest.gridRef, options.gridRefFilter)) continue;
    nodes += 1;
    const nodeBounds = gridRefToBounds(manifest.gridRef);

    for (const [levelKey, enc] of Object.entries(manifest.levels ?? {})) {
      const level = Number(levelKey);
      const grid = grids.get(level);
      if (!grid) continue;
      await push(level, {
        sourcePath: nodePath(relDir, String(level), `${manifest.gridRef}.j2c`),
        chunkCoord: chunkCoordForExtent(grid, nodeBounds),
        scale: enc.scale,
        offset: enc.offset,
      });
    }

    const leaf = manifest.leaf;
    if (leaf) {
      const grid = grids.get(0);
      if (!grid) continue;
      const absent = new Set(leaf.missing ?? []);
      for (let row = 0; row < leaf.rows; row += 1) {
        for (let col = 0; col < leaf.cols; col += 1) {
          const slot = leafSlotIndex(col, row, leaf.cols);
          if (absent.has(slot)) continue;
          const bounds: TileExtent = leafSlotBounds(nodeBounds, col, row, leaf.stepMetres);
          await push(0, {
            sourcePath: nodePath(relDir, '0', `${bounds.eastMin}_${bounds.northMin}.j2c`),
            chunkCoord: chunkCoordForExtent(grid, bounds),
            scale: leaf.enc.scale[slot],
            offset: leaf.enc.offset[slot],
          });
        }
      }
    }

    if (nodes % 250 === 0) options.onProgress?.({ kind: 'scan', nodes, chunks });
  }
  options.onProgress?.({ kind: 'scan', nodes, chunks });
  return { byLevel, nodes, missing };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** One chunk covering the whole grid, raw little-endian float64. */
async function writeEncodingArray(
  arrayDir: string,
  grid: LevelGrid,
  name: 'scale' | 'offset',
  values: Float64Array,
): Promise<void> {
  await writeJson(path.join(arrayDir, 'zarr.json'), buildEncodingArrayMetadata(grid, name));
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const chunkPath = path.join(arrayDir, 'c', '0', '0');
  await mkdir(path.dirname(chunkPath), { recursive: true });
  await writeFile(chunkPath, bytes);
}

export async function transcodeToZarr(options: TranscodeOptions): Promise<TranscodeSummary> {
  const store = await openSourceStore(options.datasetPath);
  try {
    return await runTranscode(store, options);
  } finally {
    await store.close();
  }
}

async function runTranscode(
  store: SourceStore,
  options: TranscodeOptions,
): Promise<TranscodeSummary> {
  const source = await readSourceMetadata(store);
  const grids = gridsByLevel(source);
  const { byLevel, nodes, missing } = await collectChunks(store, options, source, grids);

  const channelDir = path.join(options.outDir, source.channelId);
  await writeJson(
    path.join(options.outDir, 'zarr.json'),
    buildStoreRootMetadata([source.channelId], {
      transcodedFrom: source.datasetId,
      sourceFormat: source.format,
    }),
  );
  const usedGrids = [...byLevel.keys()].sort((a, b) => a - b).map((level) => grids.get(level)!);
  await writeJson(path.join(channelDir, 'zarr.json'), buildChannelGroupMetadata(source, usedGrids));
  await writeJson(path.join(channelDir, 'encoding', 'zarr.json'), buildGroupMetadata());
  await writeJson(path.join(channelDir, 'encoding', 'scale', 'zarr.json'), buildGroupMetadata());
  await writeJson(path.join(channelDir, 'encoding', 'offset', 'zarr.json'), buildGroupMetadata());

  const levels: LevelSummary[] = [];
  let totalChunks = 0;
  let totalShards = 0;
  let totalBytes = 0;

  for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
    const grid = grids.get(level)!;
    const pending = byLevel.get(level)!;
    const levelDir = path.join(channelDir, String(level));
    await writeJson(path.join(levelDir, 'zarr.json'), buildLevelArrayMetadata(grid, source));

    const scale = new Float64Array(grid.chunkGrid[0] * grid.chunkGrid[1]).fill(Number.NaN);
    const offset = new Float64Array(scale.length).fill(Number.NaN);

    // Group by shard. Unsharded levels still land here with one chunk each,
    // which is written straight out rather than wrapped in an index.
    const shards = new Map<string, ShardChunk[]>();
    for (const chunk of pending) {
      const flat = chunk.chunkCoord[0] * grid.chunkGrid[1] + chunk.chunkCoord[1];
      scale[flat] = chunk.scale;
      offset[flat] = chunk.offset;
      const placement = shardPlacement(grid, chunk.chunkCoord);
      const key = chunkKey(placement.shard);
      const entry: ShardChunk = {
        local: placement.local,
        load: async () => {
          const bytes = await store.readBytes(chunk.sourcePath);
          if (!bytes) throw new Error(`${chunk.sourcePath} vanished from ${store.label}`);
          return bytes;
        },
      };
      const list = shards.get(key);
      if (list) list.push(entry);
      else shards.set(key, [entry]);
    }

    let levelBytes = 0;
    let levelIndexBytes = 0;
    let done = 0;
    for (const [key, entries] of shards) {
      const target = path.join(levelDir, key);
      if (grid.shardChunks) {
        const stats = await writeShard(target, grid.shardChunks, entries);
        levelBytes += stats.payloadBytes + stats.indexBytes;
        levelIndexBytes += stats.indexBytes;
      } else {
        const bytes = await entries[0].load();
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        levelBytes += bytes.length;
      }
      done += 1;
      if (done % 50 === 0) options.onProgress?.({ kind: 'shard', level, done, total: shards.size });
    }

    await writeEncodingArray(path.join(channelDir, 'encoding', 'scale', String(level)), grid, 'scale', scale);
    await writeEncodingArray(path.join(channelDir, 'encoding', 'offset', String(level)), grid, 'offset', offset);

    levels.push({
      level,
      chunks: pending.length,
      shards: shards.size,
      bytes: levelBytes,
      indexBytes: levelIndexBytes,
    });
    totalChunks += pending.length;
    totalShards += shards.size;
    totalBytes += levelBytes;
    options.onProgress?.({ kind: 'level', level, shards: shards.size, chunks: pending.length });
  }

  return { nodes, levels, totalChunks, totalShards, totalBytes, missingChunks: missing };
}
