import { describe, expect, it } from 'vitest';
import { downsampleNearest } from './raster.ts';
import { downsampleNearestGpu } from './rasterGpu.ts';
import type { RasterSource } from './raster.ts';

function makeRaster(width: number, height: number, resolutionMetres: number): RasterSource {
  const pixels = new Float32Array(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = i;
  return {
    width,
    height,
    pixels,
    resolutionMetres,
    extent: {
      eastMin: 0,
      eastMax: width * resolutionMetres,
      northMin: 0,
      northMax: height * resolutionMetres,
    },
    provenance: {
      product: 'test',
      returnKind: 'fz',
      year: 2024,
      tileRef: 'SP51',
      zipPath: '/tmp/test.zip',
    },
  };
}

describe('rasterGpu', () => {
  it('matches CPU nearest downsample', async () => {
    const source = makeRaster(8, 6, 1);
    const targetResolution = 2;
    const cpu = downsampleNearest(source, targetResolution);
    const gpu = await downsampleNearestGpu(source, targetResolution);
    expect(gpu.width).toBe(cpu.width);
    expect(gpu.height).toBe(cpu.height);
    expect(Array.from(gpu.pixels)).toEqual(Array.from(cpu.pixels));
    expect(gpu.extent).toEqual(cpu.extent);
  });
});
