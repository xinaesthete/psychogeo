import { availableParallelism } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapPool } from '../concurrency.ts';
import { encodeUint16Normalized, type EncodedRaster } from '../encoding.ts';
import { encodeHtj2k } from '../htj2k.ts';
import { CHANNELS } from '../manifest.ts';
import { readRasterSource, windowRaster } from '../raster.ts';
import { scanDefraZips, type DefraTileGroup } from '../scan.ts';
import type { TerrainChannelId, TileExtent } from '../types.ts';
import {
  defaultNamingConvention,
  defaultSpatialIndex,
  indexRootForCell,
  leafChunkDatasetPath,
  leafSlotIndex,
  nodeManifestPath,
} from './derive.ts';
import { writeMetadata, writeNodeManifest } from './layout.ts';
import {
  IngestMetricsCollector,
  writeIngestMetrics,
  type CellIngestMetrics,
} from './metrics.ts';
import { filterGroupsByCellPrefix, gridRefToBounds, normalizeGridRef } from './osgb.ts';
import { pyramidLevelsForPreset, type PyramidPresetName } from './presets.ts';
import {
  discoverTenKmCells,
  filterGroupsByRegion,
  isSingleTenKmCell,
  regionIngestRoot,
  regionLabel,
  singleTenKmCell,
  tenKmCellFromTileRef,
  type RegionSpec,
} from './region.ts';
import {
  cellAllGroupsComplete,
  cellFullyComplete,
  groupKey,
  markCellCompleted,
  readCellIngestStats,
  readCompletedCells,
  readCompletedGroups,
  resumeStateForRegion,
  writeCompletedGroups,
  type CompletedGroupEntry,
} from './resume.ts';
import { parseMetadataJson, pyramidLevelSchema } from './schema.ts';
import type { EncodingScalars, LeafEncodingTable, PyramidNodeManifest, TerrainManifestV2 } from './types.ts';

const REGION_SUMMARY_FILE = 'index/region-summary.json';
const MIN_HTJ2K_DIMENSION = 2;
const LEAF_COLS = 5;
const LEAF_ROWS = 5;
const LEAF_STEP_METRES = 1000;

export type IngestV2ProgressEvent =
  | { readonly phase: 'scan'; readonly groups: number; readonly cells: number }
  | {
      readonly phase: 'resume';
      readonly completedGroups: number;
      readonly completedCells: number;
      readonly remainingGroups: number;
      readonly remainingCells: number;
    }
  | { readonly phase: 'cell-start'; readonly cell: string; readonly cellIndex: number; readonly cellCount: number }
  | { readonly phase: 'cell-skip'; readonly cell: string; readonly cellIndex: number; readonly cellCount: number }
  | { readonly phase: 'group-start'; readonly tileRef: string; readonly groupIndex: number; readonly groupCount: number }
  | { readonly phase: 'group-skip'; readonly tileRef: string; readonly groupIndex: number; readonly groupCount: number }
  | { readonly phase: 'tile'; readonly tileRef: string; readonly eastMin: number; readonly northMin: number; readonly bytes: number }
  | { readonly phase: 'group-complete'; readonly tileRef: string; readonly presentSlots: number; readonly bytes: number }
  | { readonly phase: 'merge-level'; readonly level: number; readonly gridRef: string }
  | { readonly phase: 'merge-complete'; readonly levels: number }
  | { readonly phase: 'complete'; readonly leafChunks: number; readonly groups: number; readonly outputBytes: number; readonly elapsedMs: number };

export interface IngestV2Options {
  readonly inputDir: string;
  readonly outDir: string;
  /** Ingest extent — 500 km / 100 km / 10 km grid ref, or bounds (see region.ts). */
  readonly region: RegionSpec;
  readonly channelId?: TerrainChannelId;
  readonly datasetId?: string;
  readonly pyramidPreset?: PyramidPresetName;
  readonly pyramidLevelsPath?: string;
  readonly tileConcurrency?: number;
  readonly onProgress?: (event: IngestV2ProgressEvent) => void;
  readonly runMerge?: boolean;
}

export interface IngestV2Result {
  readonly metadataPath?: string;
  readonly metricsPath: string;
  readonly regionSummaryPath?: string;
  readonly leafChunkCount: number;
  readonly groupCount: number;
  readonly cellCount: number;
  readonly outputBytes: number;
  readonly elapsedMs: number;
  readonly resumed: boolean;
}

function makeOneKmNominalExtents(extent: TileExtent): TileExtent[] {
  const extents: TileExtent[] = [];
  const step = LEAF_STEP_METRES;
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

function emptyLeafTable(): LeafEncodingTable {
  const slotCount = LEAF_COLS * LEAF_ROWS;
  return {
    stepMetres: LEAF_STEP_METRES,
    cols: LEAF_COLS,
    rows: LEAF_ROWS,
    enc: {
      min: Array.from({ length: slotCount }, () => 0),
      max: Array.from({ length: slotCount }, () => 0),
      scale: Array.from({ length: slotCount }, () => 0),
      offset: Array.from({ length: slotCount }, () => 0),
    },
  };
}

function channelById(channelId: TerrainChannelId) {
  const channel = CHANNELS.find((entry) => entry.id === channelId);
  if (!channel) throw new Error(`Unknown channel: ${channelId}`);
  return channel;
}

function encodingScalarsFromEncoded(encoded: EncodedRaster): EncodingScalars {
  return {
    min: encoded.encoding.min,
    max: encoded.encoding.max,
    scale: encoded.encoding.scale,
    offset: encoded.encoding.offset,
  };
}

async function loadPyramidLevels(options: IngestV2Options) {
  if (options.pyramidLevelsPath) {
    const content = await readFile(options.pyramidLevelsPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) throw new Error('--pyramid-levels must be a JSON array');
    return parsed.map((entry) => pyramidLevelSchema.parse(entry));
  }
  return pyramidLevelsForPreset(options.pyramidPreset ?? 'cell');
}

function buildMetadata(
  options: IngestV2Options,
  ingestCell: string,
  levels: TerrainManifestV2['tileMatrixSet']['levels'],
  regionSummary?: string,
): TerrainManifestV2 {
  const channelId = options.channelId ?? 'height.dsm.fz';
  const root = regionIngestRoot(options.region);
  return parseMetadataJson({
    schemaVersion: 'psychogeo.terrain.v2',
    format: 'tc-dsm-pyramid',
    datasetId: options.datasetId ?? `terracognita-defra-v2-${root.toLowerCase()}`,
    channelId,
    ingestCell: regionSummary ? root : ingestCell,
    createdAt: new Date().toISOString(),
    crs: {
      horizontal: 'EPSG:27700',
      verticalDatum: 'ODN via OSGM15/OSTN15',
    },
    spatialIndex: defaultSpatialIndex(),
    naming: defaultNamingConvention(),
    tileMatrixSet: { levels },
    encoding: {
      codec: 'htj2k',
      sampleType: 'uint16',
      normalisation: 'perChunkScaleOffset',
      nodata: 0,
    },
    indexRoot: indexRootForCell(ingestCell),
    regionSummary,
  });
}

async function encodeLeafTile(
  outDir: string,
  ingestCell: string,
  tileRef: string,
  nominalExtent: TileExtent,
  raster: Awaited<ReturnType<typeof readRasterSource>>,
  channelId: TerrainChannelId,
): Promise<{ readonly encoding: EncodingScalars; readonly bytes: number } | undefined> {
  const channel = channelById(channelId);
  const window = windowRaster(raster, nominalExtent, channel.apronMetres);
  if (window.width < MIN_HTJ2K_DIMENSION || window.height < MIN_HTJ2K_DIMENSION) {
    return undefined;
  }
  const encoded = encodeUint16Normalized(window.pixels);
  const href = leafChunkDatasetPath(
    ingestCell,
    tileRef,
    Math.round(nominalExtent.eastMin),
    Math.round(nominalExtent.northMin),
    defaultNamingConvention(),
  );
  const bytes = await encodeHtj2k(encoded, window.width, window.height, channel.lossyQuality);
  const filePath = path.join(outDir, href);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(bytes));
  return { encoding: encodingScalarsFromEncoded(encoded), bytes: bytes.byteLength };
}

async function ingestOneGroup(
  options: IngestV2Options,
  ingestCell: string,
  metadata: TerrainManifestV2,
  group: DefraTileGroup,
  metrics: IngestMetricsCollector,
): Promise<{ readonly manifest: PyramidNodeManifest; readonly presentSlots: number; readonly bytes: number }> {
  const encodeStarted = Date.now();
  const fzSource = group.sources.FZ;
  if (!fzSource) throw new Error(`Skipping ${group.tileRef}: no DSM source.`);
  const raster = await readRasterSource(fzSource);
  const tileRef = normalizeGridRef(group.tileRef);
  const cellBounds = gridRefToBounds(tileRef);
  const leaf = emptyLeafTable();
  const missing = new Set<number>();
  const channelId = channelById(metadata.channelId).id;

  const nominalExtents = makeOneKmNominalExtents(raster.extent);
  const tileConcurrency = options.tileConcurrency ?? Math.min(8, availableParallelism());
  const present = new Set<number>();
  let groupBytes = 0;
  const results = await mapPool(nominalExtents, tileConcurrency, async (nominalExtent) => {
    const col = Math.round((nominalExtent.eastMin - cellBounds.eastMin) / LEAF_STEP_METRES);
    const row = Math.round((nominalExtent.northMin - cellBounds.northMin) / LEAF_STEP_METRES);
    if (col < 0 || row < 0 || col >= LEAF_COLS || row >= LEAF_ROWS) {
      return { col, row, result: undefined, inGrid: false };
    }
    const result = await encodeLeafTile(
      options.outDir,
      ingestCell,
      tileRef,
      nominalExtent,
      raster,
      channelId,
    );
    if (result) {
      options.onProgress?.({
        phase: 'tile',
        tileRef,
        eastMin: Math.round(nominalExtent.eastMin),
        northMin: Math.round(nominalExtent.northMin),
        bytes: result.bytes,
      });
    }
    return { col, row, result, inGrid: true };
  });

  for (const entry of results) {
    if (!entry.inGrid) continue;
    const index = leafSlotIndex(entry.col, entry.row, LEAF_COLS);
    if (entry.result) {
      leaf.enc.min[index] = entry.result.encoding.min;
      leaf.enc.max[index] = entry.result.encoding.max;
      leaf.enc.scale[index] = entry.result.encoding.scale;
      leaf.enc.offset[index] = entry.result.encoding.offset;
      present.add(index);
      groupBytes += entry.result.bytes;
      metrics.addOutputBytes(entry.result.bytes);
    }
  }

  for (let index = 0; index < LEAF_COLS * LEAF_ROWS; index += 1) {
    if (!present.has(index)) missing.add(index);
  }

  metrics.addEncodeMs(Date.now() - encodeStarted);
  const presentSlots = LEAF_COLS * LEAF_ROWS - missing.size;
  const manifest: PyramidNodeManifest = {
    gridRef: tileRef,
    leaf: {
      ...leaf,
      missing: missing.size > 0 ? [...missing].sort((a, b) => a - b) : undefined,
    },
  };
  return { manifest, presentSlots, bytes: groupBytes };
}

interface TenKmCellResult {
  readonly leafChunkCount: number;
  readonly groupCount: number;
  readonly outputBytes: number;
  readonly sourceZipBytes: number;
  readonly encodeMs: number;
  readonly mergeMs: number;
  readonly elapsedMs: number;
}

async function sourceZipBytesForGroup(group: DefraTileGroup): Promise<number> {
  const { stat } = await import('node:fs/promises');
  let total = 0;
  for (const source of Object.values(group.sources)) {
    if (!source) continue;
    const fileStat = await stat(source.zipPath);
    total += fileStat.size;
  }
  return total;
}

async function ingestTenKmCell(
  options: IngestV2Options,
  ingestCell: string,
  allGroups: readonly DefraTileGroup[],
  levels: TerrainManifestV2['tileMatrixSet']['levels'],
  metrics: IngestMetricsCollector,
  completedGroups: CompletedGroupEntry[],
  completedCells: Set<string>,
): Promise<TenKmCellResult> {
  const cellStarted = Date.now();
  let encodeMs = 0;
  let mergeMs = 0;
  const runMerge = options.runMerge !== false;
  const metadata = buildMetadata(options, ingestCell, levels);
  const groups = allGroups
    .filter((group) => filterGroupsByCellPrefix(group.tileRef, ingestCell))
    .sort((a, b) => a.tileRef.localeCompare(b.tileRef) || a.year - b.year);

  if (groups.length === 0) {
    return {
      leafChunkCount: 0,
      groupCount: 0,
      outputBytes: 0,
      sourceZipBytes: 0,
      encodeMs: 0,
      mergeMs: 0,
      elapsedMs: Date.now() - cellStarted,
    };
  }

  let mutableCompletedGroups = [...completedGroups];
  const completedKeys = new Set(mutableCompletedGroups.map((entry) => groupKey(entry.tileRef, entry.year)));
  if (cellFullyComplete(ingestCell, groups, completedKeys, completedCells, runMerge)) {
    const existing = await readCellIngestStats(options.outDir, ingestCell);
    let sourceZipBytes = 0;
    for (const group of groups) {
      sourceZipBytes += await sourceZipBytesForGroup(group);
    }
    return {
      leafChunkCount: existing?.leafChunks ?? 0,
      groupCount: existing?.groupCount ?? groups.length,
      outputBytes: 0,
      sourceZipBytes,
      encodeMs: 0,
      mergeMs: 0,
      elapsedMs: Date.now() - cellStarted,
    };
  }

  const ingestedChildren: string[] = [];
  let leafChunkCount = 0;
  let outputBytes = 0;
  let sourceZipBytes = 0;

  for (const [groupIndex, group] of groups.entries()) {
    sourceZipBytes += await sourceZipBytesForGroup(group);
    const key = groupKey(group.tileRef, group.year);
    if (completedKeys.has(key)) {
      options.onProgress?.({
        phase: 'group-skip',
        tileRef: group.tileRef,
        groupIndex: groupIndex + 1,
        groupCount: groups.length,
      });
      ingestedChildren.push(normalizeGridRef(group.tileRef));
      continue;
    }

    options.onProgress?.({
      phase: 'group-start',
      tileRef: group.tileRef,
      groupIndex: groupIndex + 1,
      groupCount: groups.length,
    });

    const encodeBefore = Date.now();
    const { manifest, presentSlots, bytes } = await ingestOneGroup(
      options,
      ingestCell,
      metadata,
      group,
      metrics,
    );
    encodeMs += Date.now() - encodeBefore;
    const manifestPath = nodeManifestPath(ingestCell, manifest.gridRef);
    await writeNodeManifest(options.outDir, manifestPath, manifest);
    ingestedChildren.push(manifest.gridRef);
    leafChunkCount += presentSlots;
    outputBytes += bytes;

    mutableCompletedGroups = [
      ...mutableCompletedGroups.filter((entry) => groupKey(entry.tileRef, entry.year) !== key),
      { tileRef: group.tileRef, year: group.year },
    ];
    await writeCompletedGroups(options.outDir, mutableCompletedGroups);
    completedKeys.add(key);
    completedGroups.splice(0, completedGroups.length, ...mutableCompletedGroups);

    options.onProgress?.({
      phase: 'group-complete',
      tileRef: group.tileRef,
      presentSlots,
      bytes,
    });
  }

  const uniqueChildren = [...new Set(ingestedChildren)].sort((a, b) => a.localeCompare(b));
  const parentManifest: PyramidNodeManifest = {
    gridRef: ingestCell,
    children: uniqueChildren,
    coverage: uniqueChildren.length === 4 ? 'complete' : 'partial',
  };
  await writeNodeManifest(options.outDir, metadata.indexRoot, parentManifest);

  const needsMerge =
    runMerge && cellAllGroupsComplete(groups, completedKeys) && !completedCells.has(ingestCell);
  if (needsMerge) {
    const mergeStarted = Date.now();
    const { mergePyramidLevels } = await import('./merge.ts');
    await mergePyramidLevels({
      outDir: options.outDir,
      ingestCell,
      metadata,
      inputDir: options.inputDir,
      onProgress: options.onProgress,
      metrics,
    });
    mergeMs = Date.now() - mergeStarted;
    metrics.addMergeMs(mergeMs);
    await markCellCompleted(options.outDir, ingestCell);
    completedCells.add(ingestCell);
  } else if (cellAllGroupsComplete(groups, completedKeys) && !runMerge) {
    await markCellCompleted(options.outDir, ingestCell);
    completedCells.add(ingestCell);
  }

  if (leafChunkCount === 0) {
    const existing = await readCellIngestStats(options.outDir, ingestCell);
    leafChunkCount = existing?.leafChunks ?? leafChunkCount;
  }

  return {
    leafChunkCount,
    groupCount: uniqueChildren.length,
    outputBytes,
    sourceZipBytes,
    encodeMs,
    mergeMs,
    elapsedMs: Date.now() - cellStarted,
  };
}

async function writeRegionSummary(
  outDir: string,
  region: RegionSpec,
  cells: readonly CellIngestMetrics[],
): Promise<string> {
  const filePath = path.join(outDir, REGION_SUMMARY_FILE);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    region,
    regionLabel: regionLabel(region),
    cells: cells.map((cell) => ({
      cell: cell.cell,
      indexRoot: indexRootForCell(cell.cell),
      groupCount: cell.groupCount,
      leafChunks: cell.leafChunks,
      outputBytes: cell.outputBytes,
    })),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function ingestDefraTerrainV2(options: IngestV2Options): Promise<IngestV2Result> {
  const started = Date.now();
  const runMerge = options.runMerge !== false;
  await mkdir(options.outDir, { recursive: true });
  const levels = await loadPyramidLevels(options);
  const metrics = new IngestMetricsCollector(options.region);
  const allGroups = await scanDefraZips(options.inputDir);
  const regionGroups = filterGroupsByRegion(allGroups, options.region);
  const cells = discoverTenKmCells(allGroups, options.region);

  options.onProgress?.({ phase: 'scan', groups: regionGroups.length, cells: cells.length });
  if (regionGroups.length === 0) {
    throw new Error(`No DEFRA groups found for region ${regionLabel(options.region)} in ${options.inputDir}`);
  }

  const completedGroups = await readCompletedGroups(options.outDir);
  const completedCells = await readCompletedCells(options.outDir);
  const groupsByCell = new Map<string, DefraTileGroup[]>();
  for (const group of regionGroups) {
    const cell = tenKmCellFromTileRef(group.tileRef);
    const existing = groupsByCell.get(cell) ?? [];
    existing.push(group);
    groupsByCell.set(cell, existing);
  }

  const resume = resumeStateForRegion(
    regionGroups,
    cells,
    completedGroups,
    completedCells,
    groupsByCell,
    runMerge,
  );
  const resumed = resume.completedGroups > 0 || resume.completedCells > 0;
  if (resumed) {
    options.onProgress?.({ phase: 'resume', ...resume });
  }

  const cellMetrics: CellIngestMetrics[] = [];
  let totalLeafChunks = 0;
  let totalGroups = 0;
  let totalSourceZipBytes = 0;

  for (const [cellIndex, cell] of cells.entries()) {
    const cellGroups = groupsByCell.get(cell) ?? [];
    const completedKeys = new Set(completedGroups.map((entry) => groupKey(entry.tileRef, entry.year)));
    if (cellFullyComplete(cell, cellGroups, completedKeys, completedCells, runMerge)) {
      options.onProgress?.({
        phase: 'cell-skip',
        cell,
        cellIndex: cellIndex + 1,
        cellCount: cells.length,
      });
      const existing = await readCellIngestStats(options.outDir, cell);
      let sourceZipBytes = 0;
      for (const group of cellGroups) {
        sourceZipBytes += await sourceZipBytesForGroup(group);
      }
      totalLeafChunks += existing?.leafChunks ?? 0;
      totalGroups += existing?.groupCount ?? cellGroups.length;
      totalSourceZipBytes += sourceZipBytes;
      cellMetrics.push({
        cell,
        groupCount: existing?.groupCount ?? cellGroups.length,
        leafChunks: existing?.leafChunks ?? 0,
        sourceZipBytes,
        outputBytes: 0,
        elapsedMs: 0,
        encodeMs: 0,
        mergeMs: 0,
      });
      metrics.recordCell(cellMetrics[cellMetrics.length - 1]);
      continue;
    }

    options.onProgress?.({
      phase: 'cell-start',
      cell,
      cellIndex: cellIndex + 1,
      cellCount: cells.length,
    });
    const result = await ingestTenKmCell(
      options,
      cell,
      allGroups,
      levels,
      metrics,
      completedGroups,
      completedCells,
    );
    totalLeafChunks += result.leafChunkCount;
    totalGroups += result.groupCount;
    totalSourceZipBytes += result.sourceZipBytes;
    cellMetrics.push({
      cell,
      groupCount: result.groupCount,
      leafChunks: result.leafChunkCount,
      sourceZipBytes: result.sourceZipBytes,
      outputBytes: result.outputBytes,
      elapsedMs: result.elapsedMs,
      encodeMs: result.encodeMs,
      mergeMs: result.mergeMs,
    });
    metrics.recordCell(cellMetrics[cellMetrics.length - 1]);
  }

  let metadataPath: string | undefined;
  let regionSummaryPath: string | undefined;

  if (isSingleTenKmCell(options.region)) {
    const ingestCell = singleTenKmCell(options.region);
    if (!ingestCell) throw new Error('expected single 10 km cell');
    metadataPath = await writeMetadata(
      options.outDir,
      buildMetadata(options, ingestCell, levels),
    );
  } else {
    regionSummaryPath = await writeRegionSummary(options.outDir, options.region, cellMetrics);
    const primaryCell = cells[0];
    if (!primaryCell) throw new Error('expected at least one 10 km cell in region ingest');
    metadataPath = await writeMetadata(
      options.outDir,
      buildMetadata(options, primaryCell, levels, REGION_SUMMARY_FILE),
    );
  }

  const finalized = metrics.finalize({
    groupCount: totalGroups,
    leafChunks: totalLeafChunks,
    sourceZipBytes: totalSourceZipBytes,
  });
  const metricsPath = await writeIngestMetrics(options.outDir, finalized);
  const elapsedMs = Date.now() - started;

  options.onProgress?.({
    phase: 'complete',
    leafChunks: totalLeafChunks,
    groups: totalGroups,
    outputBytes: finalized.outputBytes,
    elapsedMs,
  });

  return {
    metadataPath,
    metricsPath,
    regionSummaryPath,
    leafChunkCount: totalLeafChunks,
    groupCount: totalGroups,
    cellCount: cells.length,
    outputBytes: finalized.outputBytes,
    elapsedMs,
    resumed,
  };
}

/** @deprecated Use IngestV2Options.region — kept for tests migrating from options.cell. */
export function ingestCellFromLegacyOptions(cell: string): RegionSpec {
  return { kind: 'grid-ref', gridRef: cell };
}
