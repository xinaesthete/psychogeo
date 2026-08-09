import path from 'node:path';
import { readRasterSource } from '../raster.ts';
import { scanDefraZips, type DefraTileGroup } from '../scan.ts';
import type { DefraReturnKind } from '../types.ts';
import { gridRefToBounds, normalizeGridRef } from '../v2/osgb.ts';
import type { TerrainManifestV2 } from '../v2/types.ts';
import { createCodecRunner, mapWithRunner, type CodecRunner } from './codecPool.ts';
import { globalScaleOffset, type ScaleOffset } from './globalScale.ts';
import { NATIONAL_EXTENT } from './grid.ts';
import { CHUNK_PIXELS, renormalisedLevels, type RenormLevel } from './levels.ts';
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
import { readJson } from './storeLayout.ts';
import {
  buildChannelMetadata,
  buildRenormLevelMetadata,
  buildStoreRootMetadata,
} from './storeMetadata.ts';

/**
 * Channels built from the DEFRA source rasters rather than from the v2 archive.
 *
 * The archive holds first return only, so anything involving the last return
 * has to be taken back at the source, from the FZ/LZ composite zips. Everything
 * above level 0 is then the same pyramid the heights use.
 *
 * Two channels are available and they are not equals. `height.dsm.lz` stores
 * the last-return surface itself; `height.aux.dz` stores the difference. dz was
 * the original plan on the theory that a difference is cheap, and measurement
 * did not bear that out — see the plan doc. Storing LZ costs ~34% more than
 * storing dz, but dz then comes back exactly, and *more* accurately, as
 * `(fz_raw - lz_raw) * scale`, because both surfaces share the height channel's
 * scale and the offset cancels. LZ is the one to build.
 */

export const FZ_CHANNEL_ID = 'height.dsm.fz';
export const LZ_CHANNEL_ID = 'height.dsm.lz';
export const DZ_CHANNEL_ID = 'height.aux.dz';

/**
 * Deliberately coarse. Quantisation error at a 10 cm step measures ~1 cm RMSE
 * against the float source with a 5 cm worst case, an order of magnitude inside
 * the composite's own ~±15 cm vertical accuracy. Range covers the observed
 * −30..+68 m with room for tall structures.
 *
 * Only used by the stored dz channel. Derived dz is bounded at 2.15 cm — twice
 * as tight — by the two half-steps of the height encoding.
 */
export const DZ_STEP_METRES = 0.1;
export const DZ_MIN_METRES = -40;
export const DZ_MAX_METRES = 400;

/** `dz = raw * scale + offset`, raw 0 nodata, so raw 1 is exactly DZ_MIN. */
export function dzScaleOffset(): ScaleOffset {
  return { scale: DZ_STEP_METRES, offset: DZ_MIN_METRES - DZ_STEP_METRES };
}

export type SourceChannelSpec = {
  readonly channelId: string;
  /** Source products needed per quad; all must be present or the quad is skipped. */
  readonly needs: readonly DefraReturnKind[];
  readonly encoding: ScaleOffset;
  /** Combine the needed rasters into one field of metres, NaN for absent. */
  readonly combine: (rasters: Float32Array[]) => { values: Float32Array; clamped: number };
  readonly measure: string;
  readonly description: string;
  readonly sourceDatasetId: string;
};

const COMPOSITE_DATASET_ID = 'defra-lidar-composite-1m-2022';

/**
 * The first-return surface, straight from the composite zips.
 *
 * The store already has `height.dsm.fz`, transcoded from the v2 archive, and
 * this rebuilds the same surface from the same source DEFRA published — one
 * quantisation instead of two. The archive had already quantised to its own
 * per-chunk scale, so transcoding requantised, and 0.56% of samples land one
 * 2.152 cm code away from what direct quantisation gives. Small, but it is the
 * reason derived dz is bounded at ~2.26 cm rather than the ~2.15 cm the encoding
 * alone would imply, and the reason FZ − LZ is not exactly zero on bare ground
 * where both surveys agree.
 *
 * Identical encoding to the channel it replaces, so the rebuild is a swap rather
 * than a migration.
 */
export function fzChannelSpec(): SourceChannelSpec {
  return {
    channelId: FZ_CHANNEL_ID,
    needs: ['FZ'],
    encoding: globalScaleOffset(),
    combine: (rasters) => ({ values: passThrough(rasters[0]), clamped: 0 }),
    measure: 'firstReturnSurface',
    description:
      'DEFRA 1 m composite first return, quantised once from the source float rather than transcoded from the v2 archive.',
    sourceDatasetId: COMPOSITE_DATASET_ID,
  };
}

/**
 * The last-return surface, on exactly the height channel's encoding.
 *
 * Sharing the scale is what makes dz derivable: `fz - lz = (fz_raw - lz_raw) *
 * scale`, since the offset cancels. Sharing the *reduction* is what keeps that
 * true above level 0, which is why this uses `heightReduction` like FZ rather
 * than anything tuned for a ground surface.
 */
export function lzChannelSpec(): SourceChannelSpec {
  return {
    channelId: LZ_CHANNEL_ID,
    needs: ['LZ'],
    encoding: globalScaleOffset(),
    combine: (rasters) => ({ values: passThrough(rasters[0]), clamped: 0 }),
    measure: 'lastReturnSurface',
    description:
      'DEFRA 1 m composite last return, on the same scale as height.dsm.fz so that dz is (fz_raw - lz_raw) * scale.',
    sourceDatasetId: COMPOSITE_DATASET_ID,
  };
}

/**
 * First return minus last return, stored directly.
 *
 * Superseded by storing LZ, and kept because it is what SU42 was first built
 * with and because the comparison is the argument. What the numbers mean is
 * worth stating plainly, since "canopy height" is the obvious reading and is
 * not quite right: the composite merges surveys flown at different times, so LZ
 * can sit above FZ over the same ground and a fifth to a third of samples come
 * out negative. Those are kept rather than clamped, so survey disagreement
 * stays visible instead of reading as flat ground.
 */
export function dzChannelSpec(): SourceChannelSpec {
  return {
    channelId: DZ_CHANNEL_ID,
    needs: ['FZ', 'LZ'],
    encoding: dzScaleOffset(),
    combine: (rasters) => differenceRasters(rasters[0], rasters[1]),
    measure: 'firstReturnMinusLastReturn',
    description:
      'FZ − LZ from the DEFRA 1 m composite. Negative where surveys disagree, not clamped to zero.',
    sourceDatasetId: COMPOSITE_DATASET_ID,
  };
}

export function channelSpecById(channelId: string): SourceChannelSpec {
  if (channelId === FZ_CHANNEL_ID) return fzChannelSpec();
  if (channelId === LZ_CHANNEL_ID) return lzChannelSpec();
  if (channelId === DZ_CHANNEL_ID) return dzChannelSpec();
  throw new Error(`no source-built channel called ${channelId}`);
}

/**
 * The same channel written under a different name.
 *
 * Level 0 resumes on whether a shard exists, so a rebuild aimed at a channel
 * that is already there would skip every shard and do nothing. Building beside
 * the live channel and renaming once it is verified avoids deleting a working
 * 76 GB surface in order to find out whether its replacement is any good.
 */
export function renamedSpec(spec: SourceChannelSpec, channelId: string): SourceChannelSpec {
  return { ...spec, channelId };
}

export type SourceChannelOptions = {
  /** Directory of DEFRA composite zips. */
  readonly sourceDir: string;
  /** An existing renormalised store; the channel is added beside those in it. */
  readonly storeDir: string;
  readonly spec: SourceChannelSpec;
  readonly gridRefFilter?: string;
  readonly levelCount?: number;
  readonly dither?: boolean;
  readonly ditherSeed?: number;
  /** Codec threads. 0 runs inline; omit for one per spare core. */
  readonly poolSize?: number;
  /** The built codec worker module. Omit to run inline. */
  readonly workerUrl?: URL;
  readonly onProgress?: (event: SourceChannelProgressEvent) => void;
};

export type SourceChannelProgressEvent =
  | {
      readonly kind: 'scan';
      readonly quads: number;
      readonly skipped: number;
      readonly unplaceable: readonly string[];
    }
  | { readonly kind: 'unreadable'; readonly tileRef: string; readonly reason: string }
  | { readonly kind: 'quad'; readonly tileRef: string; readonly done: number; readonly total: number }
  | PyramidProgressEvent;

export type SourceChannelSummary = {
  readonly channelId: string;
  readonly encoding: ScaleOffset;
  readonly quads: number;
  readonly skippedIncomplete: number;
  readonly unplaceable: readonly string[];
  /** Quads whose source rasters could not be read, with the reason. */
  readonly unreadable: ReadonlyArray<{ tileRef: string; reason: string }>;
  readonly levels: readonly LevelSummary[];
  readonly totalBytes: number;
  readonly clampedSamples: number;
};

/**
 * Quads carrying every product the channel needs, and placeable on the sheet.
 *
 * Both rejections are reported rather than thrown. A national run walks ~5,900
 * source quads and the set is not curated: one file the pipeline cannot place
 * must not take down nine hours of work, and it must not vanish silently
 * either.
 */
export function quadsWith(
  groups: readonly DefraTileGroup[],
  needs: readonly DefraReturnKind[],
  gridRefFilter?: string,
): {
  readonly usable: DefraTileGroup[];
  readonly skippedIncomplete: number;
  readonly unplaceable: string[];
} {
  const filter = gridRefFilter ? normalizeGridRef(gridRefFilter) : undefined;
  const usable: DefraTileGroup[] = [];
  const unplaceable: string[] = [];
  let skippedIncomplete = 0;
  for (const group of groups) {
    if (filter && !normalizeGridRef(group.tileRef).startsWith(filter)) continue;
    const present = needs.filter((kind) => group.sources[kind] !== undefined);
    if (present.length !== needs.length) {
      // Nothing at all is not a gap worth reporting; a partial set is.
      if (present.length > 0) skippedIncomplete += 1;
      continue;
    }
    // The OSGB squares the grid library knows do not quite cover the sheet —
    // the bottom row of O (OU, OV, OW) is rejected, and DEFRA ships an OV00
    // quad. Offshore and near enough all nodata, but the failure is what
    // matters: an unparseable ref is a skip with a name attached, not a crash.
    try {
      gridRefToBounds(group.tileRef);
    } catch {
      unplaceable.push(group.tileRef);
      continue;
    }
    usable.push(group);
  }
  return { usable, skippedIncomplete, unplaceable };
}

/** The store-grid chunks a quad's extent covers, at level 0. */
export function chunksForExtent(
  level: RenormLevel,
  extent: { eastMin: number; eastMax: number; northMin: number; northMax: number },
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  const xMin = Math.floor((extent.eastMin - NATIONAL_EXTENT.eastMin) / level.chunkMetres);
  const xMax = Math.ceil((extent.eastMax - NATIONAL_EXTENT.eastMin) / level.chunkMetres);
  const yMin = Math.floor((NATIONAL_EXTENT.northMax - extent.northMax) / level.chunkMetres);
  const yMax = Math.ceil((NATIONAL_EXTENT.northMax - extent.northMin) / level.chunkMetres);
  for (let y = yMin; y < yMax; y += 1) {
    for (let x = xMin; x < xMax; x += 1) {
      if (y < 0 || x < 0 || y >= level.chunkGrid[0] || x >= level.chunkGrid[1]) continue;
      out.push([y, x]);
    }
  }
  return out;
}

/**
 * Cut one store chunk out of a source raster.
 *
 * Rasters are north-up and the store's y axis runs south, so both index rows
 * from the north edge and no flip is needed — only the offset differs. Anything
 * the raster does not reach stays NaN, which quantises to nodata.
 */
export function chunkFromRaster(
  values: Float32Array,
  raster: { width: number; height: number; extent: { eastMin: number; northMax: number }; resolutionMetres: number },
  coord: readonly [number, number],
  level: RenormLevel,
): Float32Array {
  const out = new Float32Array(CHUNK_PIXELS * CHUNK_PIXELS).fill(Number.NaN);
  const chunkEastMin = NATIONAL_EXTENT.eastMin + coord[1] * level.chunkMetres;
  const chunkNorthMax = NATIONAL_EXTENT.northMax - coord[0] * level.chunkMetres;
  const rowOffset = Math.round((raster.extent.northMax - chunkNorthMax) / raster.resolutionMetres);
  const colOffset = Math.round((chunkEastMin - raster.extent.eastMin) / raster.resolutionMetres);

  for (let y = 0; y < CHUNK_PIXELS; y += 1) {
    const srcRow = rowOffset + y;
    if (srcRow < 0 || srcRow >= raster.height) continue;
    const srcColStart = colOffset;
    const from = Math.max(0, -srcColStart);
    const to = Math.min(CHUNK_PIXELS, raster.width - srcColStart);
    if (to <= from) continue;
    out.set(
      values.subarray(srcRow * raster.width + srcColStart + from, srcRow * raster.width + srcColStart + to),
      y * CHUNK_PIXELS + from,
    );
  }
  return out;
}

const isNodata = (value: number) => !Number.isFinite(value) || value <= -9999 || value < -1e30;

/** A source raster's own nodata sentinels turned into NaN, values otherwise kept. */
export function passThrough(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = isNodata(values[i]) ? Number.NaN : values[i];
  return out;
}

/** FZ − LZ, with either side missing making the difference missing. */
export function differenceRasters(
  first: Float32Array,
  last: Float32Array,
): { readonly values: Float32Array; readonly clamped: number } {
  const out = new Float32Array(first.length);
  let clamped = 0;
  for (let i = 0; i < first.length; i += 1) {
    const a = first[i];
    const b = last[i];
    if (isNodata(a) || isNodata(b)) {
      out[i] = Number.NaN;
      continue;
    }
    const delta = a - b;
    if (delta < DZ_MIN_METRES || delta > DZ_MAX_METRES) clamped += 1;
    out[i] = delta < DZ_MIN_METRES ? DZ_MIN_METRES : delta > DZ_MAX_METRES ? DZ_MAX_METRES : delta;
  }
  return { values: out, clamped };
}

/** Add a channel to the root group without dropping the ones already there. */
async function registerChannel(storeDir: string, channelId: string): Promise<void> {
  const root = await readJson(path.join(storeDir, 'zarr.json'));
  const psychogeo = ((root?.attributes as Record<string, unknown> | undefined)?.psychogeo ??
    {}) as Record<string, unknown>;
  const existing = Array.isArray(psychogeo.channels)
    ? (psychogeo.channels as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  if (existing.includes(channelId)) return;
  const { channels: _drop, ...rest } = psychogeo;
  await writeJson(
    path.join(storeDir, 'zarr.json'),
    buildStoreRootMetadata([...existing, channelId], rest),
  );
}

export async function buildSourceChannel(
  options: SourceChannelOptions,
): Promise<SourceChannelSummary> {
  const runner = createCodecRunner({ size: options.poolSize, workerUrl: options.workerUrl });
  try {
    return await runSourceChannel(options, runner);
  } finally {
    await runner.close();
  }
}

async function runSourceChannel(
  options: SourceChannelOptions,
  runner: CodecRunner,
): Promise<SourceChannelSummary> {
  const { spec } = options;
  const levels = renormalisedLevels(options.levelCount);
  const encoding = spec.encoding;
  const dither = options.dither ?? false;
  const seed = options.ditherSeed ?? 1;
  const channelDir = path.join(options.storeDir, spec.channelId);

  const groups = await scanDefraZips(options.sourceDir);
  const { usable: paired, skippedIncomplete, unplaceable } = quadsWith(
    groups,
    spec.needs,
    options.gridRefFilter,
  );
  options.onProgress?.({
    kind: 'scan',
    quads: paired.length,
    skipped: skippedIncomplete,
    unplaceable,
  });
  if (paired.length === 0) {
    throw new Error(
      `no quads with ${spec.needs.join(' and ')} under ${options.sourceDir}` +
        (options.gridRefFilter ? ` matching ${options.gridRefFilter}` : ''),
    );
  }

  const rootCrs = await storeCrs(options.storeDir);
  await writeJson(
    path.join(channelDir, 'zarr.json'),
    buildChannelMetadata({
      channelId: spec.channelId,
      sourceDatasetId: spec.sourceDatasetId,
      crs: rootCrs,
      levels,
      encoding,
      dithered: dither,
      measure: spec.measure,
      description: spec.description,
    }),
  );

  // Level 0, a shard at a time: a shard is a 10 km square and each source quad
  // is 5 km, so four quads fill one shard and none straddles two.
  const level0 = levels[0];
  const levelDir0 = path.join(channelDir, '0');
  await writeJson(path.join(levelDir0, 'zarr.json'), buildRenormLevelMetadata(level0, encoding));

  // A shard is 10 km and the sheet origin is a multiple of 10 km, so a 5 km
  // quad sits wholly inside one. Checked rather than assumed: a quad spread
  // across two shards would have half its chunks written into the wrong file,
  // and nothing downstream would notice.
  for (const group of paired) {
    const coords = chunksForExtent(level0, gridRefToBounds(group.tileRef));
    const keys = new Set(coords.map((coord) => placeInShard(level0, coord).key));
    if (keys.size > 1) {
      throw new Error(`${group.tileRef} straddles shards ${[...keys].join(' and ')}`);
    }
  }

  const shards = groupByShard(level0, paired, (group) => {
    const bounds = gridRefToBounds(group.tileRef);
    return chunksForExtent(level0, bounds)[0];
  });

  const writtenCoords: Array<readonly [number, number]> = [];
  /** Only what this run re-encoded, so the pyramid above it can be left alone. */
  const rebuiltCoords: Array<readonly [number, number]> = [];
  const unreadable: Array<{ tileRef: string; reason: string }> = [];
  let level0Bytes = 0;
  let clampedSamples = 0;
  let done = 0;

  for (const [key, quads] of shards) {
    // Resume on existence here, and only here. A level-0 shard is a 10 km
    // square and the smallest region filter is a 10 km cell, so any run that
    // touches this shard writes all of it. Which chunks it holds is also
    // data-dependent — an all-nodata chunk is legitimately never written — so
    // there is no expectation to check it against.
    const existingBytes = await fileSize(path.join(levelDir0, key));
    if (existingBytes !== undefined) {
      level0Bytes += existingBytes;
      for (const group of quads) {
        for (const coord of chunksForExtent(level0, gridRefToBounds(group.tileRef))) {
          writtenCoords.push(coord);
        }
        done += 1;
        options.onProgress?.({ kind: 'quad', tileRef: group.tileRef, done, total: paired.length });
      }
      continue;
    }

    const entries: ShardChunk[] = [];
    for (const group of quads) {
      // The source set is not curated and at least one of its ~5,900 files is
      // an unreadable TIFF. A bad file costs its own 5 km of coverage; it must
      // not cost the other 5,873 quads, so it is named and counted rather than
      // thrown. A shape mismatch between products is the same kind of fault.
      try {
        const rasters = [];
        for (const kind of spec.needs) rasters.push(await readRasterSource(group.sources[kind]!));
        const [reference] = rasters;
        for (let i = 1; i < rasters.length; i += 1) {
          if (rasters[i].width !== reference.width || rasters[i].height !== reference.height) {
            throw new Error(
              `${spec.needs[0]} is ${reference.width}x${reference.height} but ` +
                `${spec.needs[i]} is ${rasters[i].width}x${rasters[i].height}`,
            );
          }
        }
        const { values, clamped } = spec.combine(rasters.map((raster) => raster.pixels));
        clampedSamples += clamped;

        const coords = chunksForExtent(level0, reference.extent).filter((coord) => {
          const tile = chunkFromRaster(values, reference, coord, level0);
          return tile.some((value) => Number.isFinite(value));
        });
        const encoded = await mapWithRunner(coords, Math.max(1, runner.size), async (coord) =>
          runner.run({
            kind: 'encode',
            id: 0,
            values: chunkFromRaster(values, reference, coord, level0),
            width: CHUNK_PIXELS,
            height: CHUNK_PIXELS,
            encoding,
            ditherSeed: ditherSeedFor(dither, seed, coord),
          }),
        );
        coords.forEach((coord, i) => {
          const bytes = encoded[i];
          if (!bytes) return;
          entries.push({ local: placeInShard(level0, coord).local, load: async () => bytes });
          writtenCoords.push(coord);
          rebuiltCoords.push(coord);
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        unreadable.push({ tileRef: group.tileRef, reason });
        options.onProgress?.({ kind: 'unreadable', tileRef: group.tileRef, reason });
      }
      done += 1;
      options.onProgress?.({ kind: 'quad', tileRef: group.tileRef, done, total: paired.length });
    }
    if (entries.length > 0) level0Bytes += await writeOneShard(levelDir0, level0, key, entries);
  }

  const summary: LevelSummary[] = [
    {
      level: 0,
      resolutionMetres: level0.resolutionMetres,
      chunks: writtenCoords.length,
      objects: shards.size,
      bytes: level0Bytes,
    },
  ];
  options.onProgress?.({ kind: 'level', level: 0, chunks: writtenCoords.length, bytes: level0Bytes });

  const coarse = await buildCoarseLevels({
    channelDir,
    levels,
    encoding,
    baseCoords: writtenCoords,
    rebuiltCoords,
    // Every height-like channel reduces the same way, and for LZ that is not
    // cosmetic: FZ and LZ must be reduced identically or their difference stops
    // meaning anything above level 0. dz, already a difference, takes plain
    // area mean — the mean of a difference is the difference of the means.
    reduction: spec.channelId === DZ_CHANNEL_ID ? () => ({ blockSize: 1, bias: 0 }) : heightReduction,
    levelMetadata: (level) => buildRenormLevelMetadata(level, encoding),
    dither,
    ditherSeed: seed,
    onProgress: options.onProgress,
    runner,
  });
  summary.push(...coarse.levels);

  await registerChannel(options.storeDir, spec.channelId);

  return {
    channelId: spec.channelId,
    encoding,
    quads: paired.length,
    skippedIncomplete,
    unplaceable,
    unreadable,
    levels: summary,
    totalBytes: summary.reduce((total, level) => total + level.bytes, 0),
    clampedSamples,
  };
}

/** Reuse the store's declared CRS so the channels cannot drift apart. */
async function storeCrs(storeDir: string): Promise<TerrainManifestV2['crs']> {
  const root = await readJson(path.join(storeDir, 'zarr.json'));
  const psychogeo = ((root?.attributes as Record<string, unknown> | undefined)?.psychogeo ??
    {}) as Record<string, unknown>;
  const channels = Array.isArray(psychogeo.channels) ? (psychogeo.channels as string[]) : [];
  for (const channelId of channels) {
    const channel = await readJson(path.join(storeDir, channelId, 'zarr.json'));
    const attrs = ((channel?.attributes as Record<string, unknown> | undefined)?.psychogeo ??
      {}) as Record<string, unknown>;
    if (attrs.crs) return attrs.crs as TerrainManifestV2['crs'];
  }
  return { horizontal: 'EPSG:27700', verticalDatum: 'ODN via OSGM15/OSTN15' };
}
