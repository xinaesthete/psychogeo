import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { indexRootForCell } from './derive.ts';
import { readMetadata, writeJsonFile, writeMetadata, writeNodeManifest } from './layout.ts';
import type { CellIngestMetrics } from './metrics.ts';
import { regionLabel, type RegionSpec } from './region.ts';
import type { PyramidNodeManifest, TerrainManifestV2 } from './types.ts';

export const REGION_SUMMARY_FILE = 'index/region-summary.json';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDatasetManifest(
  outDir: string,
  build: () => TerrainManifestV2,
): Promise<TerrainManifestV2> {
  if (await pathExists(path.join(outDir, 'metadata.json'))) {
    return readMetadata(outDir);
  }
  const metadata = build();
  await writeMetadata(outDir, metadata);
  return metadata;
}

export async function ensureRegionSummary(outDir: string, region: RegionSpec): Promise<void> {
  const filePath = path.join(outDir, REGION_SUMMARY_FILE);
  if (await pathExists(filePath)) return;
  await writeRegionSummary(outDir, region, []);
}

export async function writeRegionSummary(
  outDir: string,
  region: RegionSpec,
  cells: readonly CellIngestMetrics[],
): Promise<string> {
  const filePath = path.join(outDir, REGION_SUMMARY_FILE);
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
  await writeJsonFile(outDir, REGION_SUMMARY_FILE, payload);
  return path.join(outDir, REGION_SUMMARY_FILE);
}

export async function upsertRegionSummaryCell(
  outDir: string,
  region: RegionSpec,
  cellMetrics: Pick<CellIngestMetrics, 'cell' | 'groupCount' | 'leafChunks' | 'outputBytes'>,
): Promise<void> {
  const filePath = path.join(outDir, REGION_SUMMARY_FILE);
  let cells: CellIngestMetrics[] = [];
  if (await pathExists(filePath)) {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as { cells?: CellIngestMetrics[] };
    cells = [...(parsed.cells ?? [])];
  }
  const index = cells.findIndex((entry) => entry.cell === cellMetrics.cell);
  const merged: CellIngestMetrics = {
    cell: cellMetrics.cell,
    groupCount: cellMetrics.groupCount,
    leafChunks: cellMetrics.leafChunks,
    outputBytes: cellMetrics.outputBytes,
    sourceZipBytes: index >= 0 ? cells[index].sourceZipBytes : 0,
    elapsedMs: index >= 0 ? cells[index].elapsedMs : 0,
    encodeMs: index >= 0 ? cells[index].encodeMs : 0,
    mergeMs: index >= 0 ? cells[index].mergeMs : 0,
  };
  if (index >= 0) {
    cells[index] = merged;
  } else {
    cells.push(merged);
  }
  cells.sort((a, b) => a.cell.localeCompare(b.cell));
  await writeRegionSummary(outDir, region, cells);
}

export async function writeIncrementalParentManifest(
  outDir: string,
  ingestCell: string,
  children: readonly string[],
  expectedGroupCount: number,
): Promise<void> {
  const uniqueChildren = [...new Set(children)].sort((a, b) => a.localeCompare(b));
  const parentManifest: PyramidNodeManifest = {
    gridRef: ingestCell,
    children: uniqueChildren,
    coverage: uniqueChildren.length >= expectedGroupCount ? 'complete' : 'partial',
  };
  await writeNodeManifest(outDir, indexRootForCell(ingestCell), parentManifest);
}
