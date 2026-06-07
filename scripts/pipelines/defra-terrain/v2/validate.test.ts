import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultNamingConvention,
  defaultSpatialIndex,
  indexRootForCell,
} from './derive.ts';
import { writeMetadata, writeNodeManifest } from './layout.ts';
import { assertDatasetValid, validateDatasetV2 } from './validate.ts';

const CELL_LEVELS = [
  { level: 0, resolutionMetres: 1, tierMetres: 1000 },
  { level: 1, resolutionMetres: 8, tierMetres: 5000 },
  { level: 2, resolutionMetres: 32, tierMetres: 10000 },
];

async function writeMinimalSingleCellDataset(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeMetadata(outDir, {
    schemaVersion: 'psychogeo.terrain.v2',
    format: 'tc-dsm-pyramid',
    datasetId: 'test',
    channelId: 'height.dsm.fz',
    ingestCell: 'SP51',
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
    indexRoot: indexRootForCell('SP51'),
  });
  await writeNodeManifest(outDir, indexRootForCell('SP51'), {
    gridRef: 'SP51',
    children: ['SP51ne'],
    coverage: 'partial',
  });
  await mkdir(path.join(outDir, 'index'), { recursive: true });
  await writeFile(path.join(outDir, 'index/ingest-metrics.json'), '{}\n');
}

describe('validateDatasetV2', () => {
  it('reports missing metadata.json', async () => {
    const outDir = path.join('/tmp', `terracognita-validate-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    const errors = await validateDatasetV2(outDir);
    expect(errors).toContain('missing metadata.json');
  });

  it('accepts a minimal single-cell dataset', async () => {
    const outDir = path.join('/tmp', `terracognita-validate-${Date.now()}`);
    await writeMinimalSingleCellDataset(outDir);
    expect(await validateDatasetV2(outDir)).toEqual([]);
    assertDatasetValid([]);
  });

  it('requires region summary cells for multi-cell metadata', async () => {
    const outDir = path.join('/tmp', `terracognita-validate-${Date.now()}`);
    await writeMinimalSingleCellDataset(outDir);
    await writeFile(
      path.join(outDir, 'metadata.json'),
      `${JSON.stringify({
        schemaVersion: 'psychogeo.terrain.v2',
        format: 'tc-dsm-pyramid',
        datasetId: 'test',
        channelId: 'height.dsm.fz',
        ingestCell: 'SP5',
        crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN via OSGM15/OSTN15' },
        spatialIndex: defaultSpatialIndex(),
        naming: defaultNamingConvention(),
        tileMatrixSet: { levels: CELL_LEVELS },
        encoding: {
          codec: 'htj2k',
          sampleType: 'uint16',
          normalisation: 'perChunkScaleOffset',
          nodata: 0,
        },
        indexRoot: indexRootForCell('SP50'),
        regionSummary: 'index/region-summary.json',
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(outDir, 'index/region-summary.json'),
      `${JSON.stringify({ regionLabel: 'SP5', cells: [{ cell: 'SP50', indexRoot: 'pyramid/SP50/manifest.json' }] }, null, 2)}\n`,
    );
    const errors = await validateDatasetV2(outDir);
    expect(errors.some((entry) => entry.includes('missing cell index root'))).toBe(true);
  });
});
