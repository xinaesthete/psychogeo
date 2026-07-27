import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DefraTileGroup } from '../scan.ts';
import { indexRootForCell, nodeManifestPath } from './derive.ts';
import { readMetadata, readNodeManifest } from './layout.ts';
import type { CellIngestMetrics } from './metrics.ts';
import { writeRegionSummary } from './progressManifest.ts';
import { normalizeGridRef } from './osgb.ts';
import { pyramidLevelsForPreset, type PyramidPresetName } from './presets.ts';
import type { RegionSpec } from './region.ts';
import { regionLabel } from './region.ts';
import {
  readCellIngestStats,
  readCompletedCells,
  readCompletedGroups,
  writeCompletedCells,
  writeCompletedGroups,
  type CompletedGroupEntry,
} from './resume.ts';
import type { PyramidNodeManifest, TerrainManifestV2 } from './types.ts';

const GRID_REF_10KM = /^[A-Z]{2}\d{2}$/;

export interface SyncCheckpointsOptions {
  readonly outDir: string;
  readonly inputGroups: readonly DefraTileGroup[];
  readonly region: RegionSpec;
  readonly pyramidPreset?: PyramidPresetName;
}

export interface SyncCheckpointsResult {
  readonly pyramidCells: number;
  readonly completedGroups: number;
  readonly completedCells: number;
  readonly mergedCells: number;
  readonly regionSummaryCells: number;
  readonly addedGroups: number;
  readonly addedCells: number;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function discoverPyramidCells(outDir: string): Promise<string[]> {
  const pyramidDir = path.join(outDir, 'pyramid');
  if (!(await pathExists(pyramidDir))) return [];
  const entries = await readdir(pyramidDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && GRID_REF_10KM.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function tileRefYearMap(groups: readonly DefraTileGroup[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const group of groups) {
    map.set(normalizeGridRef(group.tileRef), group.year);
  }
  return map;
}

function topMergeLevel(metadata: TerrainManifestV2): number | undefined {
  // 100 km-tier levels live on square nodes, not cell nodes — a cell counts
  // as merged once its own coarsest (tier <= 10 km) level is present.
  const mergeLevels = metadata.tileMatrixSet.levels.filter(
    (entry) => entry.level > 0 && entry.tierMetres <= 10000,
  );
  if (mergeLevels.length === 0) return undefined;
  return Math.max(...mergeLevels.map((entry) => entry.level));
}

function isCellMerged(parent: PyramidNodeManifest, metadata: TerrainManifestV2): boolean {
  const level = topMergeLevel(metadata);
  if (level === undefined) return false;
  return parent.levels?.[String(level)] !== undefined;
}

async function childManifestExists(
  outDir: string,
  ingestCell: string,
  childRef: string,
): Promise<boolean> {
  try {
    const child = await readNodeManifest(outDir, nodeManifestPath(ingestCell, childRef));
    return child.leaf !== undefined;
  } catch {
    return false;
  }
}

async function deriveCheckpointsFromDisk(
  outDir: string,
  inputGroups: readonly DefraTileGroup[],
  metadata: TerrainManifestV2,
): Promise<{ groups: CompletedGroupEntry[]; cells: string[]; mergedCells: number }> {
  const yearsByTileRef = tileRefYearMap(inputGroups);
  const groups: CompletedGroupEntry[] = [];
  const cells: string[] = [];
  let mergedCells = 0;

  for (const cell of await discoverPyramidCells(outDir)) {
    let parent: PyramidNodeManifest;
    try {
      parent = await readNodeManifest(outDir, indexRootForCell(cell));
    } catch {
      continue;
    }

    const children = parent.children ?? [];
    for (const childRef of children) {
      if (!(await childManifestExists(outDir, cell, childRef))) continue;
      const year = yearsByTileRef.get(normalizeGridRef(childRef));
      if (year === undefined) continue;
      groups.push({ tileRef: normalizeGridRef(childRef), year });
    }

    if (children.length > 0 && isCellMerged(parent, metadata)) {
      cells.push(cell);
      mergedCells += 1;
    }
  }

  return { groups, cells, mergedCells };
}

function mergeCompletedGroups(
  existing: readonly CompletedGroupEntry[],
  derived: readonly CompletedGroupEntry[],
): CompletedGroupEntry[] {
  const byKey = new Map<string, CompletedGroupEntry>();
  for (const entry of existing) {
    byKey.set(`${entry.year}:${normalizeGridRef(entry.tileRef)}`, entry);
  }
  for (const entry of derived) {
    byKey.set(`${entry.year}:${normalizeGridRef(entry.tileRef)}`, entry);
  }
  return [...byKey.values()].sort((a, b) => {
    const tileOrder = a.tileRef.localeCompare(b.tileRef);
    return tileOrder !== 0 ? tileOrder : a.year - b.year;
  });
}

function mergeCompletedCells(existing: ReadonlySet<string>, derived: readonly string[]): Set<string> {
  const cells = new Set(existing);
  for (const cell of derived) cells.add(cell);
  return cells;
}

async function loadMetadataForSync(
  outDir: string,
  region: RegionSpec,
  pyramidPreset: PyramidPresetName,
): Promise<TerrainManifestV2> {
  if (await pathExists(path.join(outDir, 'metadata.json'))) {
    return readMetadata(outDir);
  }
  return {
    schemaVersion: 'psychogeo.terrain.v2',
    format: 'tc-dsm-pyramid',
    datasetId: `terracognita-defra-v2-${regionLabel(region).toLowerCase()}`,
    channelId: 'height.dsm.fz',
    ingestCell: regionLabel(region),
    crs: {
      horizontal: 'EPSG:27700',
      verticalDatum: 'ODN via OSGM15/OSTN15',
    },
    spatialIndex: {
      scheme: 'osgb-national-grid',
      tiers: [
        { suffix: '', cellMetres: 100000 },
        { suffix: 'digit2', cellMetres: 10000 },
        { suffix: 'quad', cellMetres: 5000 },
        { suffix: 'leaf', cellMetres: 1000 },
      ],
    },
    naming: {
      nodeDir: 'pyramid/{ingestCell}/{gridRef}',
      nodeManifest: 'pyramid/{ingestCell}/{gridRef}/manifest.json',
      mergedChunk: 'pyramid/{ingestCell}/{gridRef}/{level}/{gridRef}.j2c',
      leafChunk: 'pyramid/{ingestCell}/{gridRef}/0/{eastMin}_{northMin}.j2c',
      leafChunkId: '{eastMin}_{northMin}',
    },
    tileMatrixSet: { levels: pyramidLevelsForPreset(pyramidPreset) },
    encoding: {
      codec: 'htj2k',
      sampleType: 'uint16',
      normalisation: 'perChunkScaleOffset',
      nodata: 0,
    },
    indexRoot: indexRootForCell(regionLabel(region)),
  };
}

async function buildRegionSummaryFromDisk(outDir: string, region: RegionSpec): Promise<CellIngestMetrics[]> {
  const cells: CellIngestMetrics[] = [];
  for (const cell of await discoverPyramidCells(outDir)) {
    const stats = await readCellIngestStats(outDir, cell);
    if (!stats || stats.groupCount === 0) continue;
    cells.push({
      cell,
      groupCount: stats.groupCount,
      leafChunks: stats.leafChunks,
      sourceZipBytes: 0,
      outputBytes: 0,
      elapsedMs: 0,
      encodeMs: 0,
      mergeMs: 0,
    });
  }
  return cells;
}

export async function syncCheckpointsFromDisk(
  options: SyncCheckpointsOptions,
): Promise<SyncCheckpointsResult> {
  const metadata = await loadMetadataForSync(
    options.outDir,
    options.region,
    options.pyramidPreset ?? 'cell',
  );
  const existingGroups = await readCompletedGroups(options.outDir);
  const existingCells = await readCompletedCells(options.outDir);
  const derived = await deriveCheckpointsFromDisk(options.outDir, options.inputGroups, metadata);
  const mergedGroups = mergeCompletedGroups(existingGroups, derived.groups);
  const mergedCells = mergeCompletedCells(existingCells, derived.cells);

  await writeCompletedGroups(options.outDir, mergedGroups);
  await writeCompletedCells(options.outDir, mergedCells);

  const summaryCells = await buildRegionSummaryFromDisk(options.outDir, options.region);
  await writeRegionSummary(options.outDir, options.region, summaryCells);

  const pyramidCells = (await discoverPyramidCells(options.outDir)).length;
  return {
    pyramidCells,
    completedGroups: mergedGroups.length,
    completedCells: mergedCells.size,
    mergedCells: derived.mergedCells,
    regionSummaryCells: summaryCells.length,
    addedGroups: mergedGroups.length - existingGroups.length,
    addedCells: mergedCells.size - existingCells.size,
  };
}
