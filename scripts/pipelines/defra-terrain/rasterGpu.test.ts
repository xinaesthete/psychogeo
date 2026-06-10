import { describe, expect, it } from 'vitest';
import { downsampleBilinear } from './raster.ts';
import { downsampleBilinearGpu, resetGpuRasterCache } from './rasterGpu.ts';
import type { RasterSource } from './raster.ts';

function makeRaster(width: number, height: number, resolutionMetres: number): RasterSource {
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = x + y * width;
    }
  }
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
      returnKind: 'FZ',
      year: 2024,
      tileRef: 'SP51',
      zipPath: '/tmp/test.zip',
    },
  };
}

describe('rasterGpu', () => {
  it('matches CPU bilinear downsample', async () => {
    resetGpuRasterCache();
    const source = makeRaster(8, 6, 1);
    const targetResolution = 2;
    const cpu = downsampleBilinear(source, targetResolution);
    const gpu = await downsampleBilinearGpu(source, targetResolution);
    expect(gpu.width).toBe(cpu.width);
    expect(gpu.height).toBe(cpu.height);
    expect(gpu.extent).toEqual(cpu.extent);
    for (let i = 0; i < cpu.pixels.length; i += 1) {
      expect(gpu.pixels[i]).toBeCloseTo(cpu.pixels[i], 4);
    }
  });

  it('reuses cached GPU pipelines for repeated dimensions', async () => {
    resetGpuRasterCache();
    const source = makeRaster(8, 6, 1);
    const first = await downsampleBilinearGpu(source, 2);
    const second = await downsampleBilinearGpu(source, 2);
    expect(second.timing.kernelMs).toBeLessThanOrEqual(first.timing.totalMs);
  });
});
