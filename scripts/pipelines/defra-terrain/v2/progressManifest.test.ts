import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexRootForCell, defaultNamingConvention, defaultSpatialIndex } from './derive.ts';
import {
  ensureDatasetManifest,
  ensureRegionSummary,
  upsertRegionSummaryCell,
  writeIncrementalParentManifest,
} from './progressManifest.ts';
import type { TerrainManifestV2 } from './types.ts';

const CELL_LEVELS = [
  { level: 0, resolutionMetres: 1, tierMetres: 1000 },
  { level: 1, resolutionMetres: 8, tierMetres: 5000 },
  { level: 2, resolutionMetres: 32, tierMetres: 10000 },
];

function sampleMetadata(ingestCell: string, regionSummary?: string): TerrainManifestV2 {
  return {
    schemaVersion: 'psychogeo.terrain.v2',
    format: 'tc-dsm-pyramid',
    datasetId: 'test-progress',
    channelId: 'height.dsm.fz',
    ingestCell: regionSummary ? 'SP5' : ingestCell,
    crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN' },
    spatialIndex: defaultSpatialIndex(),
    naming: defaultNamingConvention(),
    tileMatrixSet: { levels: CELL_LEVELS },
    encoding: {
      codec: 'htj2k',
      sampleType: 'uint16',
      normalisation: 'perChunkScaleOffset',
      nodata: 0,
    },
    indexRoot: indexRootForCell(ingestCell),
    regionSummary,
  };
}

describe('progressManifest', () => {
  it('writes metadata.json once and preserves it on resume', async () => {
    const outDir = path.join('/tmp', `terracognita-progress-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    const build = () => sampleMetadata('SP50', 'index/region-summary.json');
    const first = await ensureDatasetManifest(outDir, build);
    const second = await ensureDatasetManifest(outDir, () => sampleMetadata('SP59', 'index/region-summary.json'));
    expect(second.datasetId).toBe(first.datasetId);
    expect(second.indexRoot).toBe(first.indexRoot);
  });

  it('creates an empty region summary for multi-cell ingests', async () => {
    const outDir = path.join('/tmp', `terracognita-progress-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    const region = { kind: 'grid-ref' as const, gridRef: 'SP5' };
    await ensureRegionSummary(outDir, region);
    const content = JSON.parse(await readFile(path.join(outDir, 'index/region-summary.json'), 'utf8'));
    expect(content.cells).toEqual([]);
    expect(content.regionLabel).toBe('SP5');
  });

  it('upserts cells into region summary as work completes', async () => {
    const outDir = path.join('/tmp', `terracognita-progress-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    const region = { kind: 'grid-ref' as const, gridRef: 'SP5' };
    await ensureRegionSummary(outDir, region);
    await upsertRegionSummaryCell(outDir, region, {
      cell: 'SP52',
      groupCount: 1,
      leafChunks: 20,
      outputBytes: 1024,
    });
    await upsertRegionSummaryCell(outDir, region, {
      cell: 'SP50',
      groupCount: 2,
      leafChunks: 40,
      outputBytes: 2048,
    });
    await upsertRegionSummaryCell(outDir, region, {
      cell: 'SP52',
      groupCount: 2,
      leafChunks: 35,
      outputBytes: 1800,
    });
    const content = JSON.parse(await readFile(path.join(outDir, 'index/region-summary.json'), 'utf8'));
    expect(content.cells.map((cell: { cell: string }) => cell.cell)).toEqual(['SP50', 'SP52']);
    expect(content.cells[1].groupCount).toBe(2);
    expect(content.cells[1].leafChunks).toBe(35);
  });

  it('writes partial parent manifests while groups are still running', async () => {
    const outDir = path.join('/tmp', `terracognita-progress-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    await writeIncrementalParentManifest(outDir, 'SP51', ['SP51ne'], 4);
    const partial = JSON.parse(
      await readFile(path.join(outDir, indexRootForCell('SP51')), 'utf8'),
    );
    expect(partial.coverage).toBe('partial');
    expect(partial.children).toEqual(['SP51ne']);

    await writeIncrementalParentManifest(outDir, 'SP51', ['SP51ne', 'SP51nw', 'SP51se', 'SP51sw'], 4);
    const complete = JSON.parse(
      await readFile(path.join(outDir, indexRootForCell('SP51')), 'utf8'),
    );
    expect(complete.coverage).toBe('complete');
    expect(complete.children).toHaveLength(4);
  });
});
