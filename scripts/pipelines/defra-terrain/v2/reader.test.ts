import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CELL_PYRAMID_LEVELS } from './presets.ts';
import {
  defaultNamingConvention,
  defaultSpatialIndex,
  indexRootForCell,
  leafChunkDatasetPath,
} from './derive.ts';
import { writeMetadata, writeNodeManifest } from './layout.ts';
import { loadPyramidRoot, resolveChunksInBounds } from './reader.ts';

describe('reader', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'terracognita-v2-reader-'));
    await writeMetadata(tempDir, {
      schemaVersion: 'psychogeo.terrain.v2',
      format: 'tc-dsm-pyramid',
      datasetId: 'test-sp51',
      channelId: 'height.dsm.fz',
      ingestCell: 'SP51',
      crs: {
        horizontal: 'EPSG:27700',
        verticalDatum: 'ODN via OSGM15/OSTN15',
      },
      spatialIndex: defaultSpatialIndex(),
      naming: defaultNamingConvention(),
      tileMatrixSet: { levels: CELL_PYRAMID_LEVELS },
      encoding: {
        codec: 'htj2k',
        sampleType: 'uint16',
        normalisation: 'perChunkScaleOffset',
        nodata: 0,
      },
      indexRoot: indexRootForCell('SP51'),
    });
    await writeNodeManifest(tempDir, 'pyramid/SP51/manifest.json', {
      gridRef: 'SP51',
      children: ['SP51ne'],
      coverage: 'partial',
    });
    await writeNodeManifest(tempDir, 'pyramid/SP51/SP51ne/manifest.json', {
      gridRef: 'SP51ne',
      leaf: {
        stepMetres: 1000,
        cols: 5,
        rows: 5,
        missing: Array.from({ length: 24 }, (_, index) => index + 1),
        enc: {
          min: Array.from({ length: 25 }, (_, index) => (index === 0 ? 42.1 : 0)),
          max: Array.from({ length: 25 }, (_, index) => (index === 0 ? 88.2 : 0)),
          scale: Array.from({ length: 25 }, (_, index) => (index === 0 ? 0.001 : 0)),
          offset: Array.from({ length: 25 }, (_, index) => (index === 0 ? 42.1 : 0)),
        },
      },
    });
  });

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('loads pyramid metadata', async () => {
    const meta = await loadPyramidRoot(tempDir);
    expect(meta.ingestCell).toBe('SP51');
  });

  it('resolves leaf chunks in bounds by arithmetic', async () => {
    const chunks = await resolveChunksInBounds(
      tempDir,
      { eastMin: 455100, eastMax: 455900, northMin: 215100, northMax: 215900 },
      0,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.eastMin).toBe(455000);
    expect(chunks[0]?.northMin).toBe(215000);
    expect(chunks[0]?.url).toBe(leafChunkDatasetPath('SP51', 'SP51ne', 455000, 215000, defaultNamingConvention()));
    expect(chunks[0]?.encoding.min).toBe(42.1);
  });
});
