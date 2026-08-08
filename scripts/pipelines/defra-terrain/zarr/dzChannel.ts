import path from 'node:path';
import { readRasterSource } from '../raster.ts';
import { scanDefraZips, type DefraTileGroup } from '../scan.ts';
import { gridRefToBounds, normalizeGridRef } from '../v2/osgb.ts';
import type { TerrainManifestV2 } from '../v2/types.ts';
import { encodeChunk } from './chunkCodec.ts';
import { quantiseHeights, type ScaleOffset } from './globalScale.ts';
import { NATIONAL_EXTENT } from './grid.ts';
import { CHUNK_PIXELS, renormalisedLevels, type RenormLevel } from './levels.ts';
import {
  buildCoarseLevels,
  ditherFor,
  fileSize,
  groupByShard,
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
 * dz — first return minus last return — as a sibling channel of the heights.
 *
 * Where the height channel is transcoded from the v2 pyramid, dz cannot be:
 * the archive holds FZ only, so the difference has to be taken back at the
 * source, from the FZ and LZ composite rasters. Everything above level 0 is
 * then the same pyramid the heights use.
 *
 * What the numbers mean is worth stating plainly, because "canopy height" is
 * the obvious reading and it is not quite right. The composite merges surveys
 * flown at different times, so LZ can sit above FZ over the same ground and a
 * fifth to a third of samples come out negative. Vegetation and buildings are
 * the signal; the negatives are survey disagreement, and they are kept rather
 * than clamped so that disagreement stays visible instead of looking like flat
 * ground.
 */

export const DZ_CHANNEL_ID = 'height.aux.dz';

/**
 * Deliberately coarse. Quantisation error at a 10 cm step measures ~1 cm RMSE
 * against the float source with a 5 cm worst case, an order of magnitude inside
 * the composite's own ~±15 cm vertical accuracy — so the finer steps the height
 * channel uses would be spending bits on survey noise. Range covers the
 * observed −30..+68 m with room for tall structures.
 */
export const DZ_STEP_METRES = 0.1;
export const DZ_MIN_METRES = -40;
export const DZ_MAX_METRES = 400;

/** `dz = raw * scale + offset`, raw 0 nodata, so raw 1 is exactly DZ_MIN. */
export function dzScaleOffset(): ScaleOffset {
  return { scale: DZ_STEP_METRES, offset: DZ_MIN_METRES - DZ_STEP_METRES };
}

export type DzOptions = {
  /** Directory of DEFRA composite zips, holding matched FZ and LZ products. */
  readonly sourceDir: string;
  /** An existing renormalised store; dz is added beside the channels in it. */
  readonly storeDir: string;
  readonly gridRefFilter?: string;
  readonly levelCount?: number;
  readonly dither?: boolean;
  readonly ditherSeed?: number;
  readonly onProgress?: (event: DzProgressEvent) => void;
};

export type DzProgressEvent =
  | { readonly kind: 'scan'; readonly quads: number; readonly skipped: number }
  | { readonly kind: 'quad'; readonly tileRef: string; readonly done: number; readonly total: number }
  | PyramidProgressEvent;

export type DzSummary = {
  readonly encoding: ScaleOffset;
  readonly quads: number;
  readonly skippedNoLz: number;
  readonly levels: readonly LevelSummary[];
  readonly totalBytes: number;
  readonly clampedSamples: number;
};

/** Quads with both returns present. dz needs the pair; FZ alone is not a difference. */
export function pairedQuads(
  groups: readonly DefraTileGroup[],
  gridRefFilter?: string,
): { readonly paired: DefraTileGroup[]; readonly skippedNoLz: number } {
  const filter = gridRefFilter ? normalizeGridRef(gridRefFilter) : undefined;
  const paired: DefraTileGroup[] = [];
  let skippedNoLz = 0;
  for (const group of groups) {
    if (filter && !normalizeGridRef(group.tileRef).startsWith(filter)) continue;
    if (!group.sources.FZ) continue;
    if (!group.sources.LZ) {
      skippedNoLz += 1;
      continue;
    }
    paired.push(group);
  }
  return { paired, skippedNoLz };
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

export async function buildDzChannel(options: DzOptions): Promise<DzSummary> {
  const levels = renormalisedLevels(options.levelCount);
  const encoding = dzScaleOffset();
  const dither = options.dither ?? false;
  const seed = options.ditherSeed ?? 1;
  const channelDir = path.join(options.storeDir, DZ_CHANNEL_ID);

  const groups = await scanDefraZips(options.sourceDir);
  const { paired, skippedNoLz } = pairedQuads(groups, options.gridRefFilter);
  options.onProgress?.({ kind: 'scan', quads: paired.length, skipped: skippedNoLz });
  if (paired.length === 0) {
    throw new Error(
      `no quads with both FZ and LZ under ${options.sourceDir}` +
        (options.gridRefFilter ? ` matching ${options.gridRefFilter}` : ''),
    );
  }

  const rootCrs = await storeCrs(options.storeDir);
  await writeJson(
    path.join(channelDir, 'zarr.json'),
    buildChannelMetadata({
      channelId: DZ_CHANNEL_ID,
      sourceDatasetId: 'defra-lidar-composite-1m-2022',
      crs: rootCrs,
      levels,
      encoding,
      dithered: dither,
      measure: 'firstReturnMinusLastReturn',
      description:
        'FZ − LZ from the DEFRA 1 m composite. Negative where surveys disagree, not clamped to zero.',
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
  let level0Bytes = 0;
  let clampedSamples = 0;
  let done = 0;

  for (const [key, quads] of shards) {
    const existingBytes = await fileSize(path.join(levelDir0, key));
    if (existingBytes !== undefined) {
      // Resume: a shard is renamed into place only once complete.
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
      const fz = await readRasterSource(group.sources.FZ!);
      const lz = await readRasterSource(group.sources.LZ!);
      if (fz.width !== lz.width || fz.height !== lz.height) {
        throw new Error(
          `${group.tileRef}: FZ is ${fz.width}x${fz.height} but LZ is ${lz.width}x${lz.height}`,
        );
      }
      const { values, clamped } = differenceRasters(fz.pixels, lz.pixels);
      clampedSamples += clamped;

      for (const coord of chunksForExtent(level0, fz.extent)) {
        const tile = chunkFromRaster(values, fz, coord, level0);
        if (!tile.some((value) => Number.isFinite(value))) continue;
        const raw = quantiseHeights(tile, { encoding, dither: ditherFor(dither, seed, coord) });
        const bytes = await encodeChunk(raw, CHUNK_PIXELS, CHUNK_PIXELS);
        entries.push({ local: placeInShard(level0, coord).local, load: async () => bytes });
        writtenCoords.push(coord);
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
    // Plain area mean at every level. The height channel preserves peaks at
    // level 0 so tree tops survive, but dz is already a difference: the mean of
    // a difference is the difference of the means, which keeps a coarse dz
    // readable as "mean structure height over this cell". Peak-preserving would
    // also amplify the survey-disagreement outliers.
    reduction: () => ({ blockSize: 1, bias: 0 }),
    levelMetadata: (level) => buildRenormLevelMetadata(level, encoding),
    dither,
    ditherSeed: seed,
    onProgress: options.onProgress,
  });
  summary.push(...coarse);

  await registerChannel(options.storeDir, DZ_CHANNEL_ID);

  return {
    encoding,
    quads: paired.length,
    skippedNoLz,
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
