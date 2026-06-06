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
import { filterGroupsByCellPrefix, gridRefToBounds, normalizeGridRef } from './osgb.ts';
import { pyramidLevelsForPreset, type PyramidPresetName } from './presets.ts';
import { parseMetadataJson, pyramidLevelSchema } from './schema.ts';
import type { EncodingScalars, LeafEncodingTable, PyramidNodeManifest, TerrainManifestV2 } from './types.ts';

const COMPLETED_GROUPS_FILE = 'index/completed-groups.json';
const MIN_HTJ2K_DIMENSION = 2;
const LEAF_COLS = 5;
const LEAF_ROWS = 5;
const LEAF_STEP_METRES = 1000;

interface CompletedGroupEntry {
  readonly tileRef: string;
  readonly year: number;
}

interface CompletedGroupsFile {
  readonly groups: CompletedGroupEntry[];
}

export type IngestV2ProgressEvent =
  | { readonly phase: 'scan'; readonly groups: number }
  | { readonly phase: 'group-start'; readonly tileRef: string; readonly groupIndex: number; readonly groupCount: number }
  | { readonly phase: 'group-skip'; readonly tileRef: string; readonly groupIndex: number; readonly groupCount: number }
  | { readonly phase: 'tile'; readonly tileRef: string; readonly eastMin: number; readonly northMin: number }
  | { readonly phase: 'group-complete'; readonly tileRef: string; readonly presentSlots: number }
  | { readonly phase: 'merge-level'; readonly level: number; readonly gridRef: string }
  | { readonly phase: 'merge-complete'; readonly levels: number }
  | { readonly phase: 'complete'; readonly leafChunks: number; readonly groups: number };

export interface IngestV2Options {
  readonly inputDir: string;
  readonly outDir: string;
  readonly cell: string;
  readonly channelId?: TerrainChannelId;
  readonly datasetId?: string;
  readonly pyramidPreset?: PyramidPresetName;
  readonly pyramidLevelsPath?: string;
  readonly tileConcurrency?: number;
  readonly onProgress?: (event: IngestV2ProgressEvent) => void;
  readonly runMerge?: boolean;
}

export interface IngestV2Result {
  readonly metadataPath: string;
  readonly leafChunkCount: number;
  readonly groupCount: number;
}

function groupKey(tileRef: string, year: number): string {
  return `${year}:${tileRef}`;
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

async function readCompletedGroups(outDir: string): Promise<CompletedGroupEntry[]> {
  try {
    const content = await readFile(path.join(outDir, COMPLETED_GROUPS_FILE), 'utf8');
    const parsed = JSON.parse(content) as CompletedGroupsFile;
    return parsed.groups;
  } catch {
    return [];
  }
}

async function writeCompletedGroups(outDir: string, groups: CompletedGroupEntry[]): Promise<void> {
  const sorted = [...groups].sort((a, b) => {
    const tileOrder = a.tileRef.localeCompare(b.tileRef);
    return tileOrder !== 0 ? tileOrder : a.year - b.year;
  });
  await mkdir(path.join(outDir, 'index'), { recursive: true });
  await writeFile(
    path.join(outDir, COMPLETED_GROUPS_FILE),
    `${JSON.stringify({ groups: sorted }, null, 2)}\n`,
    'utf8',
  );
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

function buildMetadata(options: IngestV2Options, levels: TerrainManifestV2['tileMatrixSet']['levels']): TerrainManifestV2 {
  const ingestCell = normalizeGridRef(options.cell);
  const channelId = options.channelId ?? 'height.dsm.fz';
  return parseMetadataJson({
    schemaVersion: 'psychogeo.terrain.v2',
    format: 'tc-dsm-pyramid',
    datasetId: options.datasetId ?? `terracognita-defra-v2-${ingestCell.toLowerCase()}`,
    channelId,
    ingestCell,
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
  });
}

async function encodeLeafTile(
  outDir: string,
  ingestCell: string,
  tileRef: string,
  nominalExtent: TileExtent,
  raster: Awaited<ReturnType<typeof readRasterSource>>,
  channelId: TerrainChannelId,
): Promise<EncodingScalars | undefined> {
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
  return encodingScalarsFromEncoded(encoded);
}

async function ingestOneGroup(
  options: IngestV2Options,
  metadata: TerrainManifestV2,
  group: DefraTileGroup,
): Promise<{ readonly manifest: PyramidNodeManifest; readonly presentSlots: number }> {
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
  const results = await mapPool(nominalExtents, tileConcurrency, async (nominalExtent) => {
    const col = Math.round((nominalExtent.eastMin - cellBounds.eastMin) / LEAF_STEP_METRES);
    const row = Math.round((nominalExtent.northMin - cellBounds.northMin) / LEAF_STEP_METRES);
    if (col < 0 || row < 0 || col >= LEAF_COLS || row >= LEAF_ROWS) {
      return { col, row, encoding: undefined, inGrid: false };
    }
    options.onProgress?.({
      phase: 'tile',
      tileRef,
      eastMin: Math.round(nominalExtent.eastMin),
      northMin: Math.round(nominalExtent.northMin),
    });
    const encoding = await encodeLeafTile(
      options.outDir,
      metadata.ingestCell,
      tileRef,
      nominalExtent,
      raster,
      channelId,
    );
    return { col, row, encoding, inGrid: true };
  });

  for (const result of results) {
    if (!result.inGrid) continue;
    const index = leafSlotIndex(result.col, result.row, LEAF_COLS);
    if (result.encoding) {
      leaf.enc.min[index] = result.encoding.min;
      leaf.enc.max[index] = result.encoding.max;
      leaf.enc.scale[index] = result.encoding.scale;
      leaf.enc.offset[index] = result.encoding.offset;
      present.add(index);
    }
  }

  for (let index = 0; index < LEAF_COLS * LEAF_ROWS; index += 1) {
    if (!present.has(index)) missing.add(index);
  }

  const presentSlots = LEAF_COLS * LEAF_ROWS - missing.size;
  const manifest: PyramidNodeManifest = {
    gridRef: tileRef,
    leaf: {
      ...leaf,
      missing: missing.size > 0 ? [...missing].sort((a, b) => a - b) : undefined,
    },
  };
  return { manifest, presentSlots };
}

export async function ingestDefraTerrainV2(options: IngestV2Options): Promise<IngestV2Result> {
  const levels = await loadPyramidLevels(options);
  const metadata = buildMetadata(options, levels);
  const ingestCell = metadata.ingestCell;
  const allGroups = await scanDefraZips(options.inputDir);
  const groups = allGroups
    .filter((group) => filterGroupsByCellPrefix(group.tileRef, ingestCell))
    .sort((a, b) => a.tileRef.localeCompare(b.tileRef) || a.year - b.year);

  options.onProgress?.({ phase: 'scan', groups: groups.length });
  if (groups.length === 0) {
    throw new Error(`No DEFRA groups found for cell ${ingestCell} in ${options.inputDir}`);
  }

  let completedGroups = await readCompletedGroups(options.outDir);
  const completedKeys = new Set(completedGroups.map((entry) => groupKey(entry.tileRef, entry.year)));
  const ingestedChildren: string[] = [];
  let leafChunkCount = 0;

  for (const [groupIndex, group] of groups.entries()) {
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

    const { manifest, presentSlots } = await ingestOneGroup(options, metadata, group);
    const manifestPath = nodeManifestPath(ingestCell, manifest.gridRef);
    await writeNodeManifest(options.outDir, manifestPath, manifest);
    ingestedChildren.push(manifest.gridRef);
    leafChunkCount += presentSlots;

    completedGroups = [
      ...completedGroups.filter((entry) => groupKey(entry.tileRef, entry.year) !== key),
      { tileRef: group.tileRef, year: group.year },
    ];
    await writeCompletedGroups(options.outDir, completedGroups);
    completedKeys.add(key);

    options.onProgress?.({
      phase: 'group-complete',
      tileRef: group.tileRef,
      presentSlots,
    });
  }

  const uniqueChildren = [...new Set(ingestedChildren)].sort((a, b) => a.localeCompare(b));
  const parentManifest: PyramidNodeManifest = {
    gridRef: ingestCell,
    children: uniqueChildren,
    coverage: uniqueChildren.length === 4 ? 'complete' : 'partial',
  };
  await writeNodeManifest(options.outDir, metadata.indexRoot, parentManifest);
  const metadataPath = await writeMetadata(options.outDir, metadata);

  if (options.runMerge !== false) {
    const { mergePyramidLevels } = await import('./merge.ts');
    await mergePyramidLevels({
      outDir: options.outDir,
      ingestCell,
      inputDir: options.inputDir,
      onProgress: options.onProgress,
    });
  }

  options.onProgress?.({
    phase: 'complete',
    leafChunks: leafChunkCount,
    groups: uniqueChildren.length,
  });

  return {
    metadataPath,
    leafChunkCount,
    groupCount: uniqueChildren.length,
  };
}
