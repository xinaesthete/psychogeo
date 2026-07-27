import { describe, expect, it } from 'vitest';
import { downsampleArea, downsampleBilinear, downsampleMaxBiased, MAX_BIAS } from './raster.ts';
import { downsampleBilinearGpu, downsampleReduceManyGpu, resetGpuRasterCache } from './rasterGpu.ts';
import type { RasterSource } from './raster.ts';

const DEFRA_NODATA = -3.40282346639e38;

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

  it('matches CPU area and max-biased reductions with one upload', async () => {
    resetGpuRasterCache();
    const source = makeRaster(16, 8, 1);
    source.pixels[3] = DEFRA_NODATA;
    source.pixels[20] = DEFRA_NODATA;

    const { outputs } = await downsampleReduceManyGpu(source, [
      { resolutionMetres: 2, bias: 0 },
      { resolutionMetres: 4, bias: MAX_BIAS },
    ]);
    const cpuArea = downsampleArea(source, 2);
    const cpuMax = downsampleMaxBiased(source, 4);

    expect(outputs[0].width).toBe(cpuArea.width);
    expect(outputs[0].height).toBe(cpuArea.height);
    for (let i = 0; i < cpuArea.pixels.length; i += 1) {
      expect(outputs[0].pixels[i]).toBeCloseTo(cpuArea.pixels[i], 4);
    }
    expect(outputs[1].width).toBe(cpuMax.width);
    for (let i = 0; i < cpuMax.pixels.length; i += 1) {
      expect(outputs[1].pixels[i]).toBeCloseTo(cpuMax.pixels[i], 4);
    }
  });

  it('returns NaN where a footprint has no valid samples', async () => {
    resetGpuRasterCache();
    const source = makeRaster(4, 4, 1);
    source.pixels.fill(DEFRA_NODATA, 0, 2);
    source.pixels.fill(DEFRA_NODATA, 4, 6);

    const { outputs } = await downsampleReduceManyGpu(source, [
      { resolutionMetres: 2, bias: MAX_BIAS },
    ]);
    expect(Number.isNaN(outputs[0].pixels[0])).toBe(true);
    expect(Number.isNaN(outputs[0].pixels[1])).toBe(false);

    const cpu = downsampleMaxBiased(source, 2);
    expect(Number.isNaN(cpu.pixels[0])).toBe(true);
    expect(outputs[0].pixels[1]).toBeCloseTo(cpu.pixels[1], 4);
  });

  it('reuses cached GPU pipelines for repeated dimensions', async () => {
    resetGpuRasterCache();
    const source = makeRaster(8, 6, 1);
    const first = await downsampleBilinearGpu(source, 2);
    const second = await downsampleBilinearGpu(source, 2);
    expect(second.timing.kernelMs).toBeLessThanOrEqual(first.timing.totalMs);
  });
});
