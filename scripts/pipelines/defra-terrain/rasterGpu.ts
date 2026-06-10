import tgpu, { d, std, type TgpuGuardedComputePipeline, type TgpuMutable, type TgpuReadonly, type TgpuRoot, type TgpuUniform } from 'typegpu';
import type { RasterWindow } from './raster.ts';
import { downsampleDimensions, downsampleExtent } from './raster.ts';
import { getGpuRoot } from './gpuContext.ts';
import type { RasterSource } from './raster.ts';

const DownsampleParams = d.struct({
  inWidth: d.u32,
  inHeight: d.u32,
  outWidth: d.u32,
  factor: d.u32,
});

export interface DownsampleGpuTiming {
  readonly uploadMs: number;
  readonly kernelMs: number;
  readonly readbackMs: number;
  readonly totalMs: number;
}

export interface DownsampleGpuResult extends RasterWindow {
  readonly timing: DownsampleGpuTiming;
}

interface CachedDownsampleGpu {
  readonly inCount: number;
  readonly outCount: number;
  readonly params: TgpuUniform<typeof DownsampleParams>;
  readonly inPixels: TgpuReadonly<d.WgslArray<d.F32>>;
  readonly outPixels: TgpuMutable<d.WgslArray<d.F32>>;
  readonly bilinearPipeline: TgpuGuardedComputePipeline<[outX: number, outY: number]>;
}

const bilinearCache = new Map<string, CachedDownsampleGpu>();

function cacheKey(inCount: number, outCount: number): string {
  return `${inCount}:${outCount}`;
}

function createBilinearPipeline(
  root: TgpuRoot,
  params: CachedDownsampleGpu['params'],
  inPixels: CachedDownsampleGpu['inPixels'],
  outPixels: CachedDownsampleGpu['outPixels'],
): CachedDownsampleGpu['bilinearPipeline'] {
  return root.createGuardedComputePipeline((outX, outY) => {
    'use gpu';
    const factor = d.f32(params.$.factor);
    const srcX = (d.f32(outX) + 0.5) * factor - 0.5;
    const srcY = (d.f32(outY) + 0.5) * factor - 0.5;
    const inWidth = params.$.inWidth;
    const inHeight = params.$.inHeight;
    const x0 = d.u32(std.floor(srcX));
    const y0 = d.u32(std.floor(srcY));
    const x1 = std.min(x0 + 1, inWidth - 1);
    const y1 = std.min(y0 + 1, inHeight - 1);
    const tx = std.fract(srcX);
    const ty = std.fract(srcY);
    const row0 = y0 * inWidth;
    const row1 = y1 * inWidth;
    const v00 = inPixels.$[row0 + x0];
    const v10 = inPixels.$[row0 + x1];
    const v01 = inPixels.$[row1 + x0];
    const v11 = inPixels.$[row1 + x1];
    const top = std.mix(v00, v10, tx);
    const bottom = std.mix(v01, v11, tx);
    outPixels.$[d.u32(outY) * params.$.outWidth + d.u32(outX)] = std.mix(top, bottom, ty);
  });
}

async function getCachedDownsampleGpu(
  root: TgpuRoot,
  inWidth: number,
  inHeight: number,
  outWidth: number,
  outHeight: number,
): Promise<CachedDownsampleGpu> {
  const inCount = inWidth * inHeight;
  const outCount = outWidth * outHeight;
  const key = cacheKey(inCount, outCount);
  const existing = bilinearCache.get(key);
  if (existing) return existing;

  const params = root.createUniform(DownsampleParams, {
    inWidth,
    inHeight,
    outWidth,
    factor: 1,
  });
  const inPixels = root.createReadonly(d.arrayOf(d.f32, inCount));
  const outPixels = root.createMutable(d.arrayOf(d.f32, outCount));
  const bilinearPipeline = createBilinearPipeline(root, params, inPixels, outPixels);
  const cached: CachedDownsampleGpu = {
    inCount,
    outCount,
    params,
    inPixels,
    outPixels,
    bilinearPipeline,
  };
  bilinearCache.set(key, cached);
  return cached;
}

export function resetGpuRasterCache(): void {
  bilinearCache.clear();
}

export async function downsampleBilinearGpu(
  source: RasterSource,
  resolutionMetres: number,
): Promise<DownsampleGpuResult> {
  const { factor, width, height } = downsampleDimensions(source, resolutionMetres);

  if (width === 0 || height === 0) {
    return {
      pixels: new Float32Array(0),
      width,
      height,
      extent: downsampleExtent(source, width, height, resolutionMetres),
      timing: { uploadMs: 0, kernelMs: 0, readbackMs: 0, totalMs: 0 },
    };
  }

  const totalStarted = performance.now();
  const root = await getGpuRoot();
  const cached = await getCachedDownsampleGpu(root, source.width, source.height, width, height);

  const uploadStarted = performance.now();
  cached.inPixels.write(source.pixels);
  cached.params.write({
    inWidth: source.width,
    inHeight: source.height,
    outWidth: width,
    factor,
  });
  const uploadMs = performance.now() - uploadStarted;

  const kernelStarted = performance.now();
  cached.bilinearPipeline.dispatchThreads(width, height);
  const kernelMs = performance.now() - kernelStarted;

  const readbackStarted = performance.now();
  const out = await cached.outPixels.read();
  const pixels = Float32Array.from(out);
  const readbackMs = performance.now() - readbackStarted;

  return {
    pixels,
    width,
    height,
    extent: downsampleExtent(source, width, height, resolutionMetres),
    timing: {
      uploadMs,
      kernelMs,
      readbackMs,
      totalMs: performance.now() - totalStarted,
    },
  };
}
