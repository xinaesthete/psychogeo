import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexRootForCell, nodeManifestPath } from './derive.ts';
import { writeMetadata, writeNodeManifest } from './layout.ts';
import {
  defaultNamingConvention,
  defaultSpatialIndex,
} from './derive.ts';
import { readCompletedCells, readCompletedGroups } from './resume.ts';
import { syncCheckpointsFromDisk } from './syncCheckpoints.ts';

const CELL_LEVELS = [
  { level: 0, resolutionMetres: 1, tierMetres: 1000 },
  { level: 1, resolutionMetres: 8, tierMetres: 5000 },
  { level: 2, resolutionMetres: 32, tierMetres: 10000 },
];

async function writeMinimalCell(
  outDir: string,
  cell: string,
  childRefs: readonly string[],
  merged: boolean,
): Promise<void> {
  await writeNodeManifest(outDir, indexRootForCell(cell), {
    gridRef: cell,
    children: [...childRefs],
    coverage: childRefs.length === 4 ? 'complete' : 'partial',
    levels: merged ? { '2': { min: 0, max: 100, scale: 1, offset: 0 } } : undefined,
  });
  for (const childRef of childRefs) {
    await writeNodeManifest(outDir, nodeManifestPath(cell, childRef), {
      gridRef: childRef,
      leaf: {
        stepMetres: 1000,
        cols: 5,
        rows: 5,
        enc: {
          min: Array.from({ length: 25 }, () => 0),
          max: Array.from({ length: 25 }, () => 100),
          scale: Array.from({ length: 25 }, () => 1),
          offset: Array.from({ length: 25 }, () => 0),
        },
      },
    });
  }
}

describe('syncCheckpointsFromDisk', () => {
  it('rebuilds checkpoints and region summary from existing pyramid output', async () => {
    const outDir = path.join('/tmp', `terracognita-sync-${Date.now()}`);
    const region = { kind: 'grid-ref' as const, gridRef: 'SP5' };
    const inputGroups = [
      { tileRef: 'SP50ne', year: 2022, sources: {} },
      { tileRef: 'SP50nw', year: 2022, sources: {} },
      { tileRef: 'SP51ne', year: 2022, sources: {} },
      { tileRef: 'SP51nw', year: 2022, sources: {} },
      { tileRef: 'SP51se', year: 2022, sources: {} },
      { tileRef: 'SP51sw', year: 2022, sources: {} },
    ];
    await mkdir(outDir, { recursive: true });
    try {
      await writeMetadata(outDir, {
        schemaVersion: 'psychogeo.terrain.v2',
        format: 'tc-dsm-pyramid',
        datasetId: 'test-sync',
        channelId: 'height.dsm.fz',
        ingestCell: 'SP5',
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
        indexRoot: indexRootForCell('SP50'),
        regionSummary: 'index/region-summary.json',
      });
      await mkdir(path.join(outDir, 'index'), { recursive: true });
      await writeFile(
        path.join(outDir, 'index/completed-groups.json'),
        `${JSON.stringify({ groups: [{ tileRef: 'SP50ne', year: 2022 }] }, null, 2)}\n`,
      );
      await writeFile(path.join(outDir, 'index/completed-cells.json'), `${JSON.stringify({ cells: [] }, null, 2)}\n`);
      await writeMinimalCell(outDir, 'SP50', ['SP50ne', 'SP50nw'], true);
      await writeMinimalCell(outDir, 'SP51', ['SP51ne', 'SP51nw', 'SP51se', 'SP51sw'], false);

      const result = await syncCheckpointsFromDisk({
        outDir,
        inputGroups,
        region,
      });

      expect(result.pyramidCells).toBe(2);
      expect(result.completedGroups).toBe(6);
      expect(result.completedCells).toBe(1);
      expect(await readCompletedGroups(outDir)).toHaveLength(6);
      expect([...(await readCompletedCells(outDir))]).toEqual(['SP50']);

      const summary = JSON.parse(
        await readFile(path.join(outDir, 'index/region-summary.json'), 'utf8'),
      );
      expect(summary.cells.map((cell: { cell: string }) => cell.cell)).toEqual(['SP50', 'SP51']);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
