import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeDeltaInt16, encodeUint16Normalized, type EncodedRaster } from './encoding.ts';
import { encodeHtj2k } from './htj2k.ts';
import {
  CHANNELS,
  emptyExtent,
  exportDsmCatalog,
  extentIsEmpty,
  includeExtent,
  makeManifest,
  makeShard,
} from './manifest.ts';
import { readRasterSource, windowRaster, downsampleNearest, type RasterSource } from './raster.ts';
import { scanDefraZips, type DefraTileGroup } from './scan.ts';
import type {
  ChannelManifest,
  ChannelTileRecord,
  TerrainChannelId,
  TileExtent,
  TileIndexShard,
  TileRecord,
} from './types.ts';

export interface IngestOptions {
  readonly inputDir: string;
  readonly outDir: string;
  readonly datasetId?: string;
}

export interface IngestResult {
  readonly datasetId: string;
  readonly manifestPath: string;
  readonly shardCount: number;
  readonly tileCount: number;
  readonly channelCount: number;
}

function channelById(channelId: TerrainChannelId): ChannelManifest {
  const channel = CHANNELS.find((candidate) => candidate.id === channelId);
  if (!channel) throw new Error(`Unknown channel ${channelId}`);
  return channel;
}

function shardIdForExtent(extent: TileExtent): string {
  return `${Math.round(extent.eastMin)}_${Math.round(extent.northMin)}`;
}

function hrefJoin(...parts: string[]): string {
  return parts.join('/').replaceAll('//', '/');
}

function makeOneKmNominalExtents(extent: TileExtent): TileExtent[] {
  const extents: TileExtent[] = [];
  const step = 1000;
  for (let north = extent.northMin; north < extent.northMax; north += step) {
    for (let east = extent.eastMin; east < extent.eastMax; east += step) {
      extents.push({
        eastMin: east,
        eastMax: Math.min(extent.eastMax, east + step),
        northMin: north,
        northMax: Math.min(extent.northMax, north + step),
      });
    }
  }
  return extents;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeEncodedChannel(
  outDir: string,
  href: string,
  encoded: EncodedRaster,
  width: number,
  height: number,
  channel: ChannelManifest,
): Promise<{ readonly bytes: number }> {
  const bytes = await encodeHtj2k(encoded, width, height, channel.lossyQuality);
  const filePath = path.join(outDir, href);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(bytes));
  return { bytes: bytes.byteLength };
}

function makeChannelRecord(
  channel: ChannelManifest,
  href: string,
  width: number,
  height: number,
  extent: TileExtent,
  nominalExtent: TileExtent,
  encoded: EncodedRaster,
  bytes: number,
): ChannelTileRecord {
  return {
    channelId: channel.id,
    href,
    width,
    height,
    resolutionMetres: channel.resolutionMetres,
    apronMetres: channel.apronMetres,
    extent,
    nominalExtent,
    encoding: encoded.encoding,
    bytes,
    validPercent: encoded.stats.validPercent,
    rmseMetres: encoded.rmseMetres,
    meanAbsMetres: encoded.meanAbsMetres,
    maxAbsMetres: encoded.maxAbsMetres,
    sourceReturnKind: channel.sourceReturnKind,
  };
}

async function encodeHeightChannel(
  outDir: string,
  raster: RasterSource,
  channelId: TerrainChannelId,
  nominalExtent: TileExtent,
  href: string,
): Promise<ChannelTileRecord> {
  const channel = channelById(channelId);
  const window = windowRaster(raster, nominalExtent, channel.apronMetres);
  const encoded = encodeUint16Normalized(window.pixels);
  const { bytes } = await writeEncodedChannel(outDir, href, encoded, window.width, window.height, channel);
  return makeChannelRecord(
    channel,
    href,
    window.width,
    window.height,
    window.extent,
    nominalExtent,
    encoded,
    bytes,
  );
}

async function encodeDeltaChannel(
  outDir: string,
  first: RasterSource,
  last: RasterSource,
  nominalExtent: TileExtent,
  href: string,
): Promise<ChannelTileRecord> {
  const channel = channelById('height.aux.dz');
  const firstWindow = windowRaster(first, nominalExtent, channel.apronMetres);
  const lastWindow = windowRaster(last, nominalExtent, channel.apronMetres);
  if (firstWindow.width !== lastWindow.width || firstWindow.height !== lastWindow.height) {
    throw new Error('FZ/LZ windows do not align for DZ encoding.');
  }
  const encoded = encodeDeltaInt16(firstWindow.pixels, lastWindow.pixels);
  const { bytes } = await writeEncodedChannel(
    outDir,
    href,
    encoded,
    firstWindow.width,
    firstWindow.height,
    channel,
  );
  return makeChannelRecord(
    channel,
    href,
    firstWindow.width,
    firstWindow.height,
    firstWindow.extent,
    nominalExtent,
    encoded,
    bytes,
  );
}

async function encodeBaseChannel(
  outDir: string,
  first: RasterSource,
  shardId: string,
): Promise<ChannelTileRecord> {
  const channel = channelById('height.dsm.base');
  const base = downsampleNearest(first, channel.resolutionMetres);
  const encoded = encodeUint16Normalized(base.pixels);
  const href = hrefJoin('tiles', shardId, 'height.dsm.base.0.j2c');
  const { bytes } = await writeEncodedChannel(outDir, href, encoded, base.width, base.height, channel);
  return makeChannelRecord(
    channel,
    href,
    base.width,
    base.height,
    base.extent,
    first.extent,
    encoded,
    bytes,
  );
}

async function loadGroupRasters(group: DefraTileGroup): Promise<{
  readonly fz: RasterSource;
  readonly lz?: RasterSource;
  readonly dtm?: RasterSource;
}> {
  const fzSource = group.sources.FZ;
  if (!fzSource) throw new Error(`Skipping ${group.tileRef}: no FZ DSM source.`);
  const fz = await readRasterSource(fzSource);
  const lz = group.sources.LZ ? await readRasterSource(group.sources.LZ) : undefined;
  const dtm = group.sources.DTM ? await readRasterSource(group.sources.DTM) : undefined;
  return { fz, lz, dtm };
}

export async function ingestDefraTerrain(options: IngestOptions): Promise<IngestResult> {
  const datasetId = options.datasetId ?? `defra-terrain-${new Date().toISOString().replaceAll(':', '-')}`;
  const groups = await scanDefraZips(options.inputDir);
  const shards: TileIndexShard[] = [];
  let bounds = emptyExtent();
  let tileCount = 0;
  let channelCount = 0;

  await mkdir(options.outDir, { recursive: true });

  for (const group of groups) {
    if (!group.sources.FZ) continue;
    const rasters = await loadGroupRasters(group);
    const shardId = shardIdForExtent(rasters.fz.extent);
    const baseChannel = await encodeBaseChannel(options.outDir, rasters.fz, shardId);
    const records: TileRecord[] = [];
    bounds = includeExtent(bounds, rasters.fz.extent);

    for (const nominalExtent of makeOneKmNominalExtents(rasters.fz.extent)) {
      const tileId = `${Math.round(nominalExtent.eastMin)}_${Math.round(nominalExtent.northMin)}`;
      const tileDir = hrefJoin('tiles', tileId);
      const channels: Record<string, ChannelTileRecord> = {
        [baseChannel.channelId]: baseChannel,
      };
      channels['height.dsm.fz'] = await encodeHeightChannel(
        options.outDir,
        rasters.fz,
        'height.dsm.fz',
        nominalExtent,
        hrefJoin(tileDir, 'height.dsm.fz.0.j2c'),
      );
      if (rasters.lz) {
        channels['height.dsm.lz'] = await encodeHeightChannel(
          options.outDir,
          rasters.lz,
          'height.dsm.lz',
          nominalExtent,
          hrefJoin(tileDir, 'height.dsm.lz.0.j2c'),
        );
        channels['height.aux.dz'] = await encodeDeltaChannel(
          options.outDir,
          rasters.fz,
          rasters.lz,
          nominalExtent,
          hrefJoin(tileDir, 'height.aux.dz.0.j2c'),
        );
      }
      if (rasters.dtm) {
        channels['height.dtm'] = await encodeHeightChannel(
          options.outDir,
          rasters.dtm,
          'height.dtm',
          nominalExtent,
          hrefJoin(tileDir, 'height.dtm.0.j2c'),
        );
      }
      channelCount += Object.keys(channels).length;
      tileCount += 1;
      records.push({
        tileId,
        sourceTileRef: group.tileRef,
        extent: nominalExtent,
        nominalExtent,
        channels,
        provenance: [rasters.fz.provenance, rasters.lz?.provenance, rasters.dtm?.provenance].filter(
          (item) => item !== undefined,
        ),
      });
    }

    shards.push(makeShard(datasetId, shardId, records));
  }

  if (extentIsEmpty(bounds)) throw new Error(`No ingestable FZ DSM ZIPs found in ${options.inputDir}`);

  const shardHrefs: string[] = [];
  for (const shard of shards) {
    const href = hrefJoin('index', `${shard.shardId}.json`);
    shardHrefs.push(href);
    await writeJson(path.join(options.outDir, href), shard);
  }
  const manifest = makeManifest(datasetId, bounds, shardHrefs);
  await writeJson(path.join(options.outDir, 'manifest.json'), manifest);
  await writeJson(path.join(options.outDir, 'dsm_catalog.compat.json'), exportDsmCatalog(shards));
  await writeJson(path.join(options.outDir, 'validation-report.json'), {
    datasetId,
    tileCount,
    channelCount,
    shardCount: shards.length,
    bounds,
  });

  return {
    datasetId,
    manifestPath: path.join(options.outDir, 'manifest.json'),
    shardCount: shards.length,
    tileCount,
    channelCount,
  };
}
