import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { finalizeHundredKmSquares, mosaicRasters, readCoarseCellRaster } from './merge.ts';
import { NATIONAL_PYRAMID_LEVELS } from './presets.ts';
import { defaultNamingConvention, defaultSpatialIndex, indexRootForCell } from './derive.ts';
import { parseMetadataJson } from './schema.ts';

describe('v2 merge', () => {
  it('keeps row 0 north-up when mosaicking child rasters', () => {
    const merged = mosaicRasters(
      [
        {
          extent: { eastMin: 0, eastMax: 2, northMin: 2, northMax: 4 },
          width: 2,
          height: 2,
          pixels: new Float32Array([
            10, 11,
            12, 13,
          ]),
        },
        {
          extent: { eastMin: 0, eastMax: 2, northMin: 0, northMax: 2 },
          width: 2,
          height: 2,
          pixels: new Float32Array([
            20, 21,
            22, 23,
          ]),
        },
      ],
      { eastMin: 0, eastMax: 2, northMin: 0, northMax: 4 },
      1,
    );

    expect(Array.from(merged.pixels)).toEqual([
      10, 11,
      12, 13,
      20, 21,
      22, 23,
    ]);
  });
});

describe('finalizeHundredKmSquares', () => {
  const metadata = parseMetadataJson({
    schemaVersion: 'psychogeo.terrain.v2',
    format: 'tc-dsm-pyramid',
    datasetId: 'test-square-merge',
    channelId: 'height.dsm.fz',
    ingestCell: 'SP50',
    crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN via OSGM15/OSTN15' },
    spatialIndex: defaultSpatialIndex(),
    naming: defaultNamingConvention(),
    tileMatrixSet: { levels: NATIONAL_PYRAMID_LEVELS },
    encoding: {
      codec: 'htj2k',
      sampleType: 'uint16',
      normalisation: 'perChunkScaleOffset',
      nodata: 0,
    },
    indexRoot: indexRootForCell('SP50'),
  });

  async function writeCoarseFixture(outDir: string, cell: string, eastMin: number, northMin: number, value: number) {
    const width = 80;
    const height = 80;
    const pixels = new Float32Array(width * height).fill(value);
    pixels[0] = Number.NaN;
    const dir = path.join(outDir, 'pyramid', cell);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'coarse.f32'), Buffer.from(pixels.buffer));
    await writeFile(
      path.join(dir, 'coarse.json'),
      JSON.stringify({
        resolutionMetres: 125,
        width,
        height,
        extent: {
          eastMin,
          eastMax: eastMin + 10000,
          northMin,
          northMax: northMin + 10000,
        },
      }),
      'utf8',
    );
  }

  it('mosaics cell rasters into square chunks and derives coarser levels', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'tc-square-'));
    await writeCoarseFixture(outDir, 'SP50', 450000, 200000, 10);
    await writeCoarseFixture(outDir, 'SP51', 450000, 210000, 20);

    const first = await finalizeHundredKmSquares({
      outDir,
      metadata,
      cells: ['SP50', 'SP51'],
    });
    expect(first.steps.map((step) => step.level)).toEqual([3, 4]);
    expect(first.steps[0].gridRef).toBe('SP');
    expect(first.steps[0].outputWidth).toBe(800);
    expect(first.steps[1].outputWidth).toBe(200);

    const manifest = JSON.parse(
      await readFile(path.join(outDir, 'pyramid', 'SP', 'manifest.json'), 'utf8'),
    ) as { gridRef: string; children: string[]; levels: Record<string, { min: number; max: number }> };
    expect(manifest.gridRef).toBe('SP');
    expect(manifest.children).toEqual(['SP50', 'SP51']);
    expect(manifest.levels['3'].min).toBeCloseTo(10, 3);
    expect(manifest.levels['3'].max).toBeCloseTo(20, 3);
    expect(manifest.levels['4']).toBeDefined();

    const l3Bytes = await readFile(path.join(outDir, 'pyramid', 'SP', '3', 'SP.j2c'));
    const l4Bytes = await readFile(path.join(outDir, 'pyramid', 'SP', '4', 'SP.j2c'));
    expect(l3Bytes.byteLength).toBeGreaterThan(0);
    expect(l4Bytes.byteLength).toBeGreaterThan(0);

    // Second run with the same completed cells is a no-op.
    const second = await finalizeHundredKmSquares({
      outDir,
      metadata,
      cells: ['SP50', 'SP51'],
    });
    expect(second.steps).toHaveLength(0);
  });

  it('round-trips the coarse cell raster intermediate', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'tc-coarse-'));
    await writeCoarseFixture(outDir, 'SP50', 450000, 200000, 42);
    const coarse = await readCoarseCellRaster(outDir, 'SP50');
    expect(coarse).toBeDefined();
    expect(coarse?.width).toBe(80);
    expect(coarse?.resolutionMetres).toBe(125);
    expect(coarse?.pixels[1]).toBe(42);
    expect(Number.isNaN(coarse?.pixels[0])).toBe(true);
  });
});
