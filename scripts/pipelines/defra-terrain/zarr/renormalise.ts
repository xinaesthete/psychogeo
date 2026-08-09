import path from 'node:path';
import { leafSlotBounds, leafSlotIndex } from '../v2/derive.ts';
import { gridRefToBounds, normalizeGridRef } from '../v2/osgb.ts';
import type { TerrainManifestV2 } from '../v2/types.ts';
import { globalScaleOffset, type ScaleOffset } from './globalScale.ts';
import { createCodecRunner, mapWithRunner, type CodecRunner } from './codecPool.ts';
import { chunkCoordFor, LEVEL_FACTOR, renormalisedLevels, type RenormLevel } from './levels.ts';
import {
  buildCoarseLevels,
  ditherSeedFor,
  fileSize,
  groupByShard,
  heightReduction,
  placeInShard,
  writeJson,
  writeOneShard,
  type LevelSummary,
  type PyramidProgressEvent,
} from './pyramidBuild.ts';
import type { ShardChunk } from './shardWriter.ts';
import { nodePath, openSourceStore, readSourceMetadata, type SourceStore } from './sourceStore.ts';
import {
  buildRenormChannelMetadata,
  buildRenormLevelMetadata,
  buildStoreRootMetadata,
} from './storeMetadata.ts';
import { walkNodes } from './transcode.ts';

export type RenormaliseOptions = {
  /** An extracted v2 dataset directory, or the `.zip` holding one. */
  readonly datasetPath: string;
  readonly outDir: string;
  readonly gridRefFilter?: string;
  readonly dither?: boolean;
  readonly ditherSeed?: number;
  readonly levelCount?: number;
  /** Codec threads. 0 runs inline; omit for one per spare core. */
  readonly poolSize?: number;
  /** The built codec worker module. Omit to run inline. */
  readonly workerUrl?: URL;
  readonly onProgress?: (event: RenormaliseProgressEvent) => void;
};

export type RenormaliseProgressEvent =
  | { readonly kind: 'scan'; readonly chunks: number }
  | PyramidProgressEvent;

export type RenormaliseSummary = {
  readonly encoding: ScaleOffset;
  readonly dithered: boolean;
  readonly levels: readonly LevelSummary[];
  readonly sourceBytes: number;
  readonly totalBytes: number;
  /** Chunks that could not be built. Each is a hole, and each was logged.  */
  readonly failures: number;
};

type SourceChunk = {
  readonly sourcePath: string;
  /** Known from the scan, so the summary totals the source even when a resume skips reading it. */
  readonly sourceBytes: number;
  readonly coord: readonly [number, number];
  readonly encoding: ScaleOffset;
};

/** Level-0 leaves of the v2 pyramid, with the scalars needed to undo their normalisation. */
async function scanLeaves(
  store: SourceStore,
  options: RenormaliseOptions,
  level: RenormLevel,
): Promise<SourceChunk[]> {
  const chunks: SourceChunk[] = [];
  for await (const { relDir, manifest } of walkNodes(store)) {
    if (options.gridRefFilter) {
      const filter = normalizeGridRef(options.gridRefFilter);
      if (!normalizeGridRef(manifest.gridRef).startsWith(filter)) continue;
    }
    const leaf = manifest.leaf;
    if (!leaf) continue;
    const nodeBounds = gridRefToBounds(manifest.gridRef);
    const absent = new Set(leaf.missing ?? []);
    for (let row = 0; row < leaf.rows; row += 1) {
      for (let col = 0; col < leaf.cols; col += 1) {
        const slot = leafSlotIndex(col, row, leaf.cols);
        if (absent.has(slot)) continue;
        const bounds = leafSlotBounds(nodeBounds, col, row, leaf.stepMetres);
        const sourcePath = nodePath(relDir, '0', `${bounds.eastMin}_${bounds.northMin}.j2c`);
        // A manifest can outlive its payload if an ingest was interrupted.
        const sourceBytes = await store.size(sourcePath);
        if (sourceBytes === undefined) continue;
        chunks.push({
          sourceBytes,
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

export async function renormaliseToZarr(options: RenormaliseOptions): Promise<RenormaliseSummary> {
  const store = await openSourceStore(options.datasetPath);
  const runner = createCodecRunner({ size: options.poolSize, workerUrl: options.workerUrl });
  try {
    return await runRenormalise(store, options, runner);
  } finally {
    await runner.close();
    await store.close();
  }
}

async function runRenormalise(
  store: SourceStore,
  options: RenormaliseOptions,
  runner: CodecRunner,
): Promise<RenormaliseSummary> {
  const source: TerrainManifestV2 = await readSourceMetadata(store);
  const levels = renormalisedLevels(options.levelCount);
  const encoding = globalScaleOffset();
  const dither = options.dither ?? false;
  const seed = options.ditherSeed ?? 1;
  const channelDir = path.join(options.outDir, source.channelId);

  await writeJson(
    path.join(options.outDir, 'zarr.json'),
    buildStoreRootMetadata([source.channelId], {
      renormalisedFrom: source.datasetId,
      sourceFormat: source.format,
    }),
  );
  await writeJson(
    path.join(channelDir, 'zarr.json'),
    buildRenormChannelMetadata(source, levels, encoding, dither),
  );

  const summary: RenormaliseSummary['levels'][number][] = [];
  let sourceBytes = 0;
  let totalBytes = 0;
  let failures = 0;

  // Level 0: decode, undo the per-chunk normalisation, requantise nationally.
  const leaves = await scanLeaves(store, options, levels[0]);
  const levelDir0 = path.join(channelDir, '0');
  await writeJson(path.join(levelDir0, 'zarr.json'), buildRenormLevelMetadata(levels[0], encoding));

  // Totalled from the scan rather than as chunks are read, so that a resumed
  // run reports the whole source behind the store and not just this
  // invocation's share of it.
  for (const leaf of leaves) sourceBytes += leaf.sourceBytes;

  const shards0 = groupByShard(levels[0], leaves, (leaf) => leaf.coord);
  let writtenCoords: Array<readonly [number, number]> = [];
  let level0Bytes = 0;
  let done = 0;
  for (const [key, group] of shards0) {
    for (const leaf of group) writtenCoords.push(leaf.coord);
    // Resume: a shard already on disk is complete, since it is renamed into
    // place only after every chunk in it is written. Its size still counts
    // towards the level, or a resumed run would under-report the store.
    const existingBytes = await fileSize(path.join(levelDir0, key));
    if (existingBytes !== undefined) {
      level0Bytes += existingBytes;
      done += group.length;
      options.onProgress?.({ kind: 'chunk', level: 0, done, total: leaves.length });
      continue;
    }
    // Reads stay here — the archive handle and the resume logic live on this
    // thread — while decode, requantise and encode go to the pool. One shard's
    // worth is in flight at a time, which bounds memory the same way writing a
    // shard at a time already does.
    const width = Math.max(1, runner.size);
    const encoded = await mapWithRunner(group, width, async (leaf) => {
      // One unreadable source chunk costs its own square kilometre. It used to
      // cost the whole run, which for a national pass is hours of completed
      // work thrown away over a single bad file.
      try {
        const codestream = await store.readBytes(leaf.sourcePath);
        if (!codestream) throw new Error(`missing from ${store.label}`);
        return await runner.run({
          kind: 'requantise',
          id: 0,
          codestream,
          from: leaf.encoding,
          to: encoding,
          ditherSeed: ditherSeedFor(dither, seed, leaf.coord),
        });
      } catch (error) {
        failures += 1;
        options.onProgress?.({
          kind: 'failed',
          level: 0,
          coord: leaf.coord,
          reason: `${leaf.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return undefined;
      } finally {
        done += 1;
        if (done % 100 === 0) {
          options.onProgress?.({ kind: 'chunk', level: 0, done, total: leaves.length });
        }
      }
    });

    const entries: ShardChunk[] = [];
    group.forEach((leaf, i) => {
      const bytes = encoded[i];
      if (!bytes) return;
      entries.push({ local: placeInShard(levels[0], leaf.coord).local, load: async () => bytes });
    });
    level0Bytes += await writeOneShard(levelDir0, levels[0], key, entries);
  }
  summary.push({
    level: 0,
    resolutionMetres: levels[0].resolutionMetres,
    chunks: writtenCoords.length,
    objects: shards0.size,
    bytes: level0Bytes,
  });
  totalBytes += level0Bytes;
  options.onProgress?.({ kind: 'level', level: 0, chunks: writtenCoords.length, bytes: level0Bytes });

  // Coarser levels, each built from the 4x4 block below it.
  const coarse = await buildCoarseLevels({
    channelDir,
    levels,
    encoding,
    baseCoords: writtenCoords,
    reduction: heightReduction,
    levelMetadata: (level) => buildRenormLevelMetadata(level, encoding),
    dither,
    ditherSeed: seed,
    onProgress: options.onProgress,
  });
  summary.push(...coarse.levels);
  for (const level of coarse.levels) totalBytes += level.bytes;
  failures += coarse.failures;

  return { encoding, dithered: dither, levels: summary, sourceBytes, totalBytes, failures };
}
