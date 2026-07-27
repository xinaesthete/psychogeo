import tgpu, { d, std, type TgpuGuardedComputePipeline, type TgpuMutable, type TgpuReadonly, type TgpuRoot, type TgpuUniform } from 'typegpu';
import type { DownsampleSource, RasterWindow } from './raster.ts';
import { downsampleDimensions, downsampleExtent } from './raster.ts';
import { getGpuRoot } from './gpuContext.ts';
import type { RasterSource } from './raster.ts';

const DownsampleParams = d.struct({
  inWidth: d.u32,
  inHeight: d.u32,
  outWidth: d.u32,
  factor: d.u32,
});

const ReduceParams = d.struct({
  inWidth: d.u32,
  inHeight: d.u32,
  outWidth: d.u32,
  factor: d.u32,
  blockSize: d.u32,
  blocksPerAxis: d.u32,
  bias: d.f32,
});

// DEFRA float nodata is -3.4e38; anything below this threshold is invalid.
const VALID_MIN = -1.7e38;
const NODATA_OUT = -3.0e38;

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

interface CachedReduceGpu {
  readonly params: TgpuUniform<typeof ReduceParams>;
  readonly outPixels: TgpuMutable<d.WgslArray<d.F32>>;
  readonly reducePipeline: TgpuGuardedComputePipeline<[outX: number, outY: number]>;
}

const reduceInputCache = new Map<number, TgpuReadonly<d.WgslArray<d.F32>>>();
const reducePipelineCache = new Map<string, CachedReduceGpu>();

function getReduceInput(root: TgpuRoot, inCount: number): TgpuReadonly<d.WgslArray<d.F32>> {
  const existing = reduceInputCache.get(inCount);
  if (existing) return existing;
  const created = root.createReadonly(d.arrayOf(d.f32, inCount));
  reduceInputCache.set(inCount, created);
  return created;
}

function createReducePipeline(
  root: TgpuRoot,
  params: CachedReduceGpu['params'],
  inPixels: TgpuReadonly<d.WgslArray<d.F32>>,
  outPixels: CachedReduceGpu['outPixels'],
): CachedReduceGpu['reducePipeline'] {
  return root.createGuardedComputePipeline((outX, outY) => {
    'use gpu';
    const factor = params.$.factor;
    const blockSize = params.$.blockSize;
    const blocksPerAxis = params.$.blocksPerAxis;
    const inWidth = params.$.inWidth;
    const x0 = d.u32(outX) * factor;
    const y0 = d.u32(outY) * factor;
    let sum = d.f32(0);
    let count = d.u32(0);
    let blockMaxSum = d.f32(0);
    let blockCount = d.u32(0);
    for (let by = d.u32(0); by < blocksPerAxis; by += 1) {
      for (let bx = d.u32(0); bx < blocksPerAxis; bx += 1) {
        let blockMax = d.f32(NODATA_OUT);
        let blockValid = d.u32(0);
        for (let dy = d.u32(0); dy < blockSize; dy += 1) {
          const rowOffset = (y0 + by * blockSize + dy) * inWidth + x0 + bx * blockSize;
          for (let dx = d.u32(0); dx < blockSize; dx += 1) {
            const value = inPixels.$[rowOffset + dx];
            if (value > d.f32(VALID_MIN)) {
              sum += value;
              count += 1;
              blockValid = 1;
              blockMax = std.max(blockMax, value);
            }
          }
        }
        if (blockValid > 0) {
          blockMaxSum += blockMax;
          blockCount += 1;
        }
      }
    }
    let out = d.f32(NODATA_OUT);
    if (count > 0) {
      const mean = sum / d.f32(count);
      out = mean + params.$.bias * (blockMaxSum / d.f32(blockCount) - mean);
    }
    outPixels.$[d.u32(outY) * params.$.outWidth + d.u32(outX)] = out;
  });
}

function getCachedReduceGpu(
  root: TgpuRoot,
  inCount: number,
  outCount: number,
): CachedReduceGpu {
  const key = cacheKey(inCount, outCount);
  const existing = reducePipelineCache.get(key);
  if (existing) return existing;

  const params = root.createUniform(ReduceParams, {
    inWidth: 1,
    inHeight: 1,
    outWidth: 1,
    factor: 1,
    blockSize: 1,
    blocksPerAxis: 1,
    bias: 0,
  });
  const inPixels = getReduceInput(root, inCount);
  const outPixels = root.createMutable(d.arrayOf(d.f32, outCount));
  const cached: CachedReduceGpu = {
    params,
    outPixels,
    reducePipeline: createReducePipeline(root, params, inPixels, outPixels),
  };
  reducePipelineCache.set(key, cached);
  return cached;
}

export function resetGpuRasterCache(): void {
  bilinearCache.clear();
  reduceInputCache.clear();
  reducePipelineCache.clear();
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

export interface ReduceTarget {
  readonly resolutionMetres: number;
  /** Sub-block edge for peak preservation; must divide the reduction factor. 1 = plain mean terms. */
  readonly blockSize: number;
  /** 0 = area mean; 1 = pure mean-of-block-maxes; in between blends. */
  readonly bias: number;
}

export interface ReduceManyGpuResult {
  readonly outputs: readonly RasterWindow[];
  readonly timing: DownsampleGpuTiming;
}

function sentinelToNaN(pixels: Float32Array): Float32Array {
  for (let i = 0; i < pixels.length; i += 1) {
    if (pixels[i] < VALID_MIN) pixels[i] = Number.NaN;
  }
  return pixels;
}

/**
 * Run several nodata-aware reductions of one source raster with a single
 * GPU upload. Each output pixel aggregates the full factor×factor footprint;
 * footprints with no valid samples come back as NaN.
 */
export async function downsampleReduceManyGpu(
  source: DownsampleSource,
  targets: readonly ReduceTarget[],
): Promise<ReduceManyGpuResult> {
  const totalStarted = performance.now();
  const outputs: RasterWindow[] = [];
  let uploadMs = 0;
  let kernelMs = 0;
  let readbackMs = 0;
  let uploaded = false;
  const root = await getGpuRoot();
  const inCount = source.width * source.height;

  for (const target of targets) {
    const { factor, width, height } = downsampleDimensions(source, target.resolutionMetres);
    const extent = downsampleExtent(source, width, height, target.resolutionMetres);
    if (width === 0 || height === 0) {
      outputs.push({ pixels: new Float32Array(0), width, height, extent });
      continue;
    }

    if (factor % target.blockSize !== 0) {
      throw new Error(`blockSize ${target.blockSize} must divide reduction factor ${factor}`);
    }
    const cached = getCachedReduceGpu(root, inCount, width * height);
    const uploadStarted = performance.now();
    if (!uploaded) {
      getReduceInput(root, inCount).write(source.pixels);
      uploaded = true;
    }
    cached.params.write({
      inWidth: source.width,
      inHeight: source.height,
      outWidth: width,
      factor,
      blockSize: target.blockSize,
      blocksPerAxis: factor / target.blockSize,
      bias: target.bias,
    });
    uploadMs += performance.now() - uploadStarted;

    const kernelStarted = performance.now();
    cached.reducePipeline.dispatchThreads(width, height);
    kernelMs += performance.now() - kernelStarted;

    const readbackStarted = performance.now();
    const out = await cached.outPixels.read();
    const pixels = sentinelToNaN(Float32Array.from(out));
    readbackMs += performance.now() - readbackStarted;

    outputs.push({ pixels, width, height, extent });
  }

  return {
    outputs,
    timing: {
      uploadMs,
      kernelMs,
      readbackMs,
      totalMs: performance.now() - totalStarted,
    },
  };
}
