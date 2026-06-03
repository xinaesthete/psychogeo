import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  summarizeStorage,
} from './manifest.ts';
import { readRasterSource, windowRaster, downsampleNearest, type RasterSource } from './raster.ts';
import { scanDefraZips, type DefraTileGroup } from './scan.ts';
import type {
  ChannelManifest,
  ChannelTileRecord,
  IngestChannelFailure,
  TerrainChannelId,
  TerrainManifestV1,
  TileExtent,
  TileIndexShard,
  TileIngestIssue,
  TileRecord,
  DatasetStorageStats,
} from './types.ts';

const COMPLETED_GROUPS_FILE = 'completed-groups.json';
const DIAGNOSTICS_FILE = 'ingest-diagnostics.json';
/** OpenJPH rejects very narrow windows (e.g. 1×1000 edge clips). */
const MIN_HTJ2K_DIMENSION = 2;

interface CompletedGroupEntry {
  readonly tileRef: string;
  readonly year: number;
  readonly shardId: string;
}

interface CompletedGroupsFile {
  readonly groups: CompletedGroupEntry[];
}

export type IngestProgressEvent =
  | {
      readonly phase: 'scan';
      readonly groups: number;
    }
  | {
      readonly phase: 'resume';
      readonly completedGroups: number;
      readonly remainingGroups: number;
    }
  | {
      readonly phase: 'recover';
      readonly message: string;
    }
  | {
      readonly phase: 'group-start';
      readonly tileRef: string;
      readonly year: number;
      readonly groupIndex: number;
      readonly groupCount: number;
    }
  | {
      readonly phase: 'group-skip';
      readonly tileRef: string;
      readonly year: number;
      readonly shardId: string;
      readonly groupIndex: number;
      readonly groupCount: number;
    }
  | {
      readonly phase: 'tile';
      readonly tileId: string;
      readonly tileIndex: number;
      readonly tileCount: number;
      readonly channels: number;
      readonly bytes: number;
    }
  | {
      readonly phase: 'channel-failed';
      readonly tileRef: string;
      readonly tileId: string;
      readonly channelId: TerrainChannelId;
      readonly message: string;
    }
  | {
      readonly phase: 'tile-skip';
      readonly tileRef: string;
      readonly tileId: string;
      readonly message: string;
    }
  | {
      readonly phase: 'group-complete';
      readonly tileRef: string;
      readonly tiles: number;
      readonly channels: number;
      readonly bytes: number;
    }
  | {
      readonly phase: 'complete';
      readonly tileCount: number;
      readonly channelCount: number;
      readonly shardCount: number;
      readonly totalPayloadBytes: number;
    };

export interface IngestOptions {
  readonly inputDir: string;
  readonly outDir: string;
  readonly datasetId?: string;
  readonly onProgress?: (event: IngestProgressEvent) => void;
}

export interface IngestResult {
  readonly datasetId: string;
  readonly manifestPath: string;
  readonly shardCount: number;
  readonly tileCount: number;
  readonly channelCount: number;
  readonly storage: DatasetStorageStats;
}

interface ExistingDatasetState {
  readonly datasetId?: string;
  readonly createdAt?: string;
  readonly manifestPresent: boolean;
  readonly shards: TileIndexShard[];
  readonly completedGroups: CompletedGroupEntry[];
}

function groupKey(tileRef: string, year: number): string {
  return `${year}:${tileRef}`;
}

function completedGroupsFromShards(shards: TileIndexShard[]): CompletedGroupEntry[] {
  const byKey = new Map<string, CompletedGroupEntry>();
  for (const shard of shards) {
    const tile = shard.tiles[0];
    if (!tile) continue;
    const year = tile.provenance[0]?.year;
    if (year === undefined) continue;
    const key = groupKey(tile.sourceTileRef, year);
    byKey.set(key, { tileRef: tile.sourceTileRef, year, shardId: shard.shardId });
  }
  return Array.from(byKey.values());
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

function recordBytes(record: ChannelTileRecord): number {
  return record.bytes;
}

function recordsBytes(records: TileRecord[]): number {
  let bytes = 0;
  for (const record of records) {
    for (const channel of Object.values(record.channels)) {
      bytes += channel.bytes;
    }
  }
  return bytes;
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
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

function isMacOsMetadataName(name: string): boolean {
  return name.startsWith('._') || name === '.DS_Store';
}

function isIndexShardFile(name: string): boolean {
  return name.endsWith('.json') && name !== COMPLETED_GROUPS_FILE && !isMacOsMetadataName(name);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  if (isMacOsMetadataName(path.basename(filePath))) return undefined;
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      console.warn(`Ignoring unreadable JSON at ${filePath}: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

async function loadExistingDatasetState(outDir: string): Promise<ExistingDatasetState> {
  const manifest = await readJsonIfExists<TerrainManifestV1>(path.join(outDir, 'manifest.json'));
  const indexDir = path.join(outDir, 'index');
  const shards: TileIndexShard[] = [];
  try {
    const entries = await readdir(indexDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isIndexShardFile(entry.name)) continue;
      const shard = await readJsonIfExists<TileIndexShard>(path.join(indexDir, entry.name));
      if (shard) shards.push(shard);
    }
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')
    ) {
      throw error;
    }
  }
  shards.sort((a, b) => a.shardId.localeCompare(b.shardId));
  const progress = await readJsonIfExists<CompletedGroupsFile>(path.join(indexDir, COMPLETED_GROUPS_FILE));
  const completedGroups =
    progress && progress.groups.length > 0 ? progress.groups : completedGroupsFromShards(shards);
  return {
    datasetId: manifest?.datasetId ?? shards[0]?.datasetId,
    createdAt: manifest?.createdAt,
    manifestPresent: manifest !== undefined,
    shards,
    completedGroups,
  };
}

interface ValidationReport {
  readonly datasetId: string;
  readonly tileCount: number;
  readonly channelCount: number;
  readonly processedTileCount: number;
  readonly processedChannelCount: number;
  readonly shardCount: number;
  readonly bounds: TileExtent;
  readonly storage: DatasetStorageStats;
  readonly incomplete: boolean;
  readonly failures: IngestChannelFailure[];
}

async function loadIngestFailures(outDir: string): Promise<IngestChannelFailure[]> {
  const report = await readJsonIfExists<ValidationReport>(path.join(outDir, 'validation-report.json'));
  if (report?.failures) return [...report.failures];
  const diagnostics = await readJsonIfExists<{ readonly failures?: IngestChannelFailure[] }>(
    path.join(outDir, DIAGNOSTICS_FILE),
  );
  return [...(diagnostics?.failures ?? [])];
}

async function persistDatasetSnapshot(
  outDir: string,
  datasetId: string,
  shards: TileIndexShard[],
  bounds: TileExtent,
  createdAt: string,
  processedTileCount: number,
  processedChannelCount: number,
  failures: IngestChannelFailure[],
  incomplete: boolean,
): Promise<DatasetStorageStats> {
  const shardHrefs = shards.map((shard) => hrefJoin('index', `${shard.shardId}.json`));
  const storage = summarizeStorage(shards);
  const manifest = makeManifest(datasetId, bounds, shardHrefs, storage, createdAt);
  await writeJson(path.join(outDir, 'manifest.json'), manifest);
  await writeJson(path.join(outDir, 'dsm_catalog.compat.json'), exportDsmCatalog(shards));
  const report: ValidationReport = {
    datasetId,
    tileCount: storage.tileCount,
    channelCount: storage.channelPayloadCount,
    processedTileCount,
    processedChannelCount,
    shardCount: shards.length,
    bounds,
    storage,
    incomplete,
    failures,
  };
  await writeJson(path.join(outDir, 'validation-report.json'), report);
  await writeJson(path.join(outDir, DIAGNOSTICS_FILE), {
    updatedAt: new Date().toISOString(),
    failureCount: failures.length,
    failures,
  });
  return storage;
}

function isWindowEncodable(width: number, height: number): boolean {
  return width >= MIN_HTJ2K_DIMENSION && height >= MIN_HTJ2K_DIMENSION;
}

function encodeWindowIssue(width: number, height: number): string | undefined {
  if (width === 0 || height === 0) return `empty window (${width}×${height})`;
  if (!isWindowEncodable(width, height)) {
    return `window too small for HTJ2K (${width}×${height}, minimum ${MIN_HTJ2K_DIMENSION})`;
  }
  return undefined;
}

interface ChannelEncodeContext {
  readonly failures: IngestChannelFailure[];
  readonly onProgress?: (event: IngestProgressEvent) => void;
  readonly sourceTileRef: string;
  readonly year: number;
  readonly tileId: string;
  readonly nominalExtent: TileExtent;
}

function recordChannelFailure(
  context: ChannelEncodeContext,
  channelId: TerrainChannelId,
  width: number,
  height: number,
  code: TileIngestIssue['code'],
  message: string,
): TileIngestIssue {
  const issue: TileIngestIssue = { channelId, code, message, width, height };
  context.failures.push({
    at: new Date().toISOString(),
    sourceTileRef: context.sourceTileRef,
    year: context.year,
    tileId: context.tileId,
    channelId,
    nominalExtent: context.nominalExtent,
    width,
    height,
    code,
    message,
  });
  context.onProgress?.({
    phase: 'channel-failed',
    tileRef: context.sourceTileRef,
    tileId: context.tileId,
    channelId,
    message,
  });
  return issue;
}

async function tryEncodeHeightChannel(
  outDir: string,
  raster: RasterSource,
  channelId: TerrainChannelId,
  context: ChannelEncodeContext,
  href: string,
): Promise<{ readonly record?: ChannelTileRecord; readonly issue?: TileIngestIssue }> {
  const channel = channelById(channelId);
  const window = windowRaster(raster, context.nominalExtent, channel.apronMetres);
  const dimensionIssue = encodeWindowIssue(window.width, window.height);
  if (dimensionIssue) {
    return {
      issue: recordChannelFailure(
        context,
        channelId,
        window.width,
        window.height,
        'window-too-small',
        dimensionIssue,
      ),
    };
  }
  try {
    const encoded = encodeUint16Normalized(window.pixels);
    const { bytes } = await writeEncodedChannel(outDir, href, encoded, window.width, window.height, channel);
    return {
      record: makeChannelRecord(
        channel,
        href,
        window.width,
        window.height,
        window.extent,
        context.nominalExtent,
        encoded,
        bytes,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      issue: recordChannelFailure(
        context,
        channelId,
        window.width,
        window.height,
        'encode-failed',
        message,
      ),
    };
  }
}

async function tryEncodeDeltaChannel(
  outDir: string,
  first: RasterSource,
  last: RasterSource,
  context: ChannelEncodeContext,
  href: string,
): Promise<{ readonly record?: ChannelTileRecord; readonly issue?: TileIngestIssue }> {
  const channel = channelById('height.aux.dz');
  const firstWindow = windowRaster(first, context.nominalExtent, channel.apronMetres);
  const lastWindow = windowRaster(last, context.nominalExtent, channel.apronMetres);
  if (firstWindow.width !== lastWindow.width || firstWindow.height !== lastWindow.height) {
    return {
      issue: recordChannelFailure(
        context,
        channel.id,
        firstWindow.width,
        firstWindow.height,
        'encode-failed',
        'FZ/LZ windows do not align for DZ encoding.',
      ),
    };
  }
  const dimensionIssue = encodeWindowIssue(firstWindow.width, firstWindow.height);
  if (dimensionIssue) {
    return {
      issue: recordChannelFailure(
        context,
        channel.id,
        firstWindow.width,
        firstWindow.height,
        'window-too-small',
        dimensionIssue,
      ),
    };
  }
  try {
    const encoded = encodeDeltaInt16(firstWindow.pixels, lastWindow.pixels);
    const { bytes } = await writeEncodedChannel(
      outDir,
      href,
      encoded,
      firstWindow.width,
      firstWindow.height,
      channel,
    );
    return {
      record: makeChannelRecord(
        channel,
        href,
        firstWindow.width,
        firstWindow.height,
        firstWindow.extent,
        context.nominalExtent,
        encoded,
        bytes,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      issue: recordChannelFailure(
        context,
        channel.id,
        firstWindow.width,
        firstWindow.height,
        'encode-failed',
        message,
      ),
    };
  }
}

async function persistCompletedGroup(
  outDir: string,
  shard: TileIndexShard,
  completedGroups: CompletedGroupEntry[],
  group: DefraTileGroup,
): Promise<CompletedGroupEntry[]> {
  const shardHref = hrefJoin('index', `${shard.shardId}.json`);
  await writeJson(path.join(outDir, shardHref), shard);
  const entry: CompletedGroupEntry = {
    tileRef: group.tileRef,
    year: group.year,
    shardId: shard.shardId,
  };
  const key = groupKey(group.tileRef, group.year);
  const next = [...completedGroups.filter((item) => groupKey(item.tileRef, item.year) !== key), entry];
  next.sort((a, b) => {
    const tileOrder = a.tileRef.localeCompare(b.tileRef);
    return tileOrder !== 0 ? tileOrder : a.year - b.year;
  });
  await writeJson(path.join(outDir, 'index', COMPLETED_GROUPS_FILE), { groups: next });
  return next;
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
  if (!fzSource) throw new Error(`Skipping ${group.tileRef}: no DSM source.`);
  const fz = await readRasterSource(fzSource);
  const lz = group.sources.LZ ? await readRasterSource(group.sources.LZ) : undefined;
  const dtm = group.sources.DTM ? await readRasterSource(group.sources.DTM) : undefined;
  return { fz, lz, dtm };
}

export async function ingestDefraTerrain(options: IngestOptions): Promise<IngestResult> {
  const existingState = await loadExistingDatasetState(options.outDir);
  const datasetId =
    options.datasetId ??
    existingState.datasetId ??
    `defra-terrain-${new Date().toISOString().replaceAll(':', '-')}`;
  const createdAt = existingState.createdAt ?? new Date().toISOString();
  const groups = await scanDefraZips(options.inputDir);
  options.onProgress?.({ phase: 'scan', groups: groups.length });
  const shards: TileIndexShard[] = [...existingState.shards];
  let completedGroups = [...existingState.completedGroups];
  const completedGroupKeys = new Set(
    completedGroups.map((entry) => groupKey(entry.tileRef, entry.year)),
  );
  const completedGroupByKey = new Map(
    completedGroups.map((entry) => [groupKey(entry.tileRef, entry.year), entry]),
  );
  const ingestableGroups = groups.filter((group) => group.sources.FZ !== undefined);
  const remainingGroups = ingestableGroups.filter(
    (group) => !completedGroupKeys.has(groupKey(group.tileRef, group.year)),
  ).length;
  if (completedGroups.length > 0) {
    options.onProgress?.({
      phase: 'resume',
      completedGroups: completedGroups.length,
      remainingGroups,
    });
  }
  let bounds = emptyExtent();
  for (const shard of shards) bounds = includeExtent(bounds, shard.extent);
  let processedTileCount = 0;
  let processedChannelCount = 0;
  const failures = await loadIngestFailures(options.outDir);

  await mkdir(options.outDir, { recursive: true });

  if (existingState.shards.length > 0 && !existingState.manifestPresent) {
    options.onProgress?.({
      phase: 'recover',
      message: `rebuilding dataset metadata from ${existingState.shards.length} shard indexes`,
    });
    await persistDatasetSnapshot(
      options.outDir,
      datasetId,
      shards,
      bounds,
      createdAt,
      0,
      0,
      failures,
      true,
    );
  }

  for (const [groupIndex, group] of groups.entries()) {
    if (!group.sources.FZ) continue;
    const completed = completedGroupByKey.get(groupKey(group.tileRef, group.year));
    if (completed) {
      options.onProgress?.({
        phase: 'group-skip',
        tileRef: group.tileRef,
        year: group.year,
        shardId: completed.shardId,
        groupIndex: groupIndex + 1,
        groupCount: groups.length,
      });
      continue;
    }
    options.onProgress?.({
      phase: 'group-start',
      tileRef: group.tileRef,
      year: group.year,
      groupIndex: groupIndex + 1,
      groupCount: groups.length,
    });
    const rasters = await loadGroupRasters(group);
    const shardId = shardIdForExtent(rasters.fz.extent);
    let baseChannel: ChannelTileRecord;
    try {
      baseChannel = await encodeBaseChannel(options.outDir, rasters.fz, shardId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordChannelFailure(
        {
          failures,
          onProgress: options.onProgress,
          sourceTileRef: group.tileRef,
          year: group.year,
          tileId: shardId,
          nominalExtent: rasters.fz.extent,
        },
        'height.dsm.base',
        0,
        0,
        'encode-failed',
        `base channel encode failed: ${message}`,
      );
      continue;
    }
    const records: TileRecord[] = [];
    let groupChannelCount = 0;
    bounds = includeExtent(bounds, rasters.fz.extent);
    const nominalExtents = makeOneKmNominalExtents(rasters.fz.extent);

    for (const [tileIndex, nominalExtent] of nominalExtents.entries()) {
      const tileId = `${Math.round(nominalExtent.eastMin)}_${Math.round(nominalExtent.northMin)}`;
      const tileDir = hrefJoin('tiles', tileId);
      const encodeContext: ChannelEncodeContext = {
        failures,
        onProgress: options.onProgress,
        sourceTileRef: group.tileRef,
        year: group.year,
        tileId,
        nominalExtent,
      };
      const issues: TileIngestIssue[] = [];
      const channels: Record<string, ChannelTileRecord> = {
        [baseChannel.channelId]: baseChannel,
      };
      const fzResult = await tryEncodeHeightChannel(
        options.outDir,
        rasters.fz,
        'height.dsm.fz',
        encodeContext,
        hrefJoin(tileDir, 'height.dsm.fz.0.j2c'),
      );
      if (fzResult.record) channels['height.dsm.fz'] = fzResult.record;
      if (fzResult.issue) issues.push(fzResult.issue);
      if (rasters.lz) {
        const lzResult = await tryEncodeHeightChannel(
          options.outDir,
          rasters.lz,
          'height.dsm.lz',
          encodeContext,
          hrefJoin(tileDir, 'height.dsm.lz.0.j2c'),
        );
        if (lzResult.record) channels['height.dsm.lz'] = lzResult.record;
        if (lzResult.issue) issues.push(lzResult.issue);
        const dzResult = await tryEncodeDeltaChannel(
          options.outDir,
          rasters.fz,
          rasters.lz,
          encodeContext,
          hrefJoin(tileDir, 'height.aux.dz.0.j2c'),
        );
        if (dzResult.record) channels['height.aux.dz'] = dzResult.record;
        if (dzResult.issue) issues.push(dzResult.issue);
      }
      if (rasters.dtm) {
        const dtmResult = await tryEncodeHeightChannel(
          options.outDir,
          rasters.dtm,
          'height.dtm',
          encodeContext,
          hrefJoin(tileDir, 'height.dtm.0.j2c'),
        );
        if (dtmResult.record) channels['height.dtm'] = dtmResult.record;
        if (dtmResult.issue) issues.push(dtmResult.issue);
      }
      if (!channels['height.dsm.fz']) {
        options.onProgress?.({
          phase: 'tile-skip',
          tileRef: group.tileRef,
          tileId,
          message: issues.length > 0 ? issues.map((issue) => issue.message).join('; ') : 'primary DSM missing',
        });
        continue;
      }
      const tileChannelCount = Object.keys(channels).length;
      const tileBytes = Object.values(channels).reduce((sum, channel) => sum + recordBytes(channel), 0);
      processedChannelCount += tileChannelCount;
      groupChannelCount += tileChannelCount;
      processedTileCount += 1;
      records.push({
        tileId,
        sourceTileRef: group.tileRef,
        extent: nominalExtent,
        nominalExtent,
        channels,
        provenance: [rasters.fz.provenance, rasters.lz?.provenance, rasters.dtm?.provenance].filter(
          (item) => item !== undefined,
        ),
        issues: issues.length > 0 ? issues : undefined,
      });
      options.onProgress?.({
        phase: 'tile',
        tileId,
        tileIndex: tileIndex + 1,
        tileCount: nominalExtents.length,
        channels: tileChannelCount,
        bytes: tileBytes,
      });
    }

    if (records.length === 0) {
      options.onProgress?.({
        phase: 'group-complete',
        tileRef: group.tileRef,
        tiles: 0,
        channels: 0,
        bytes: 0,
      });
      await persistDatasetSnapshot(
        options.outDir,
        datasetId,
        shards,
        bounds,
        createdAt,
        processedTileCount,
        processedChannelCount,
        failures,
        true,
      );
      continue;
    }

    const shard = makeShard(datasetId, shardId, records);
    shards.push(shard);
    completedGroups = await persistCompletedGroup(options.outDir, shard, completedGroups, group);
    completedGroupKeys.add(groupKey(group.tileRef, group.year));
    completedGroupByKey.set(groupKey(group.tileRef, group.year), {
      tileRef: group.tileRef,
      year: group.year,
      shardId,
    });
    await persistDatasetSnapshot(
      options.outDir,
      datasetId,
      shards,
      bounds,
      createdAt,
      processedTileCount,
      processedChannelCount,
      failures,
      true,
    );
    options.onProgress?.({
      phase: 'group-complete',
      tileRef: group.tileRef,
      tiles: records.length,
      channels: groupChannelCount,
      bytes: recordsBytes(records),
    });
  }

  if (extentIsEmpty(bounds)) throw new Error(`No ingestable DSM ZIPs found in ${options.inputDir}`);

  const storage = await persistDatasetSnapshot(
    options.outDir,
    datasetId,
    shards,
    bounds,
    createdAt,
    processedTileCount,
    processedChannelCount,
    failures,
    false,
  );
  options.onProgress?.({
    phase: 'complete',
    tileCount: storage.tileCount,
    channelCount: storage.channelPayloadCount,
    shardCount: shards.length,
    totalPayloadBytes: storage.totalPayloadBytes,
  });

  return {
    datasetId,
    manifestPath: path.join(options.outDir, 'manifest.json'),
    shardCount: shards.length,
    tileCount: storage.tileCount,
    channelCount: storage.channelPayloadCount,
    storage,
  };
}
