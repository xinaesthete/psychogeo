import tgpu, { d } from 'typegpu';
import type { TileExtent } from './types.ts';
import { getGpuRoot } from './gpuContext.ts';
import type { RasterSource } from './raster.ts';

const DownsampleParams = d.struct({
  inWidth: d.u32,
  outWidth: d.u32,
  factor: d.u32,
});

export async function downsampleNearestGpu(
  source: RasterSource,
  resolutionMetres: number,
): Promise<{ readonly pixels: Float32Array; readonly width: number; readonly height: number; readonly extent: TileExtent }> {
  const factor = Math.max(1, Math.round(resolutionMetres / source.resolutionMetres));
  const width = Math.floor(source.width / factor);
  const height = Math.floor(source.height / factor);

  if (width === 0 || height === 0) {
    return {
      pixels: new Float32Array(0),
      width,
      height,
      extent: {
        eastMin: source.extent.eastMin,
        eastMax: source.extent.eastMin,
        northMin: source.extent.northMax,
        northMax: source.extent.northMax,
      },
    };
  }

  const root = await getGpuRoot();
  const inCount = source.width * source.height;
  const outCount = width * height;

  const params = root.createUniform(DownsampleParams, {
    inWidth: source.width,
    outWidth: width,
    factor,
  });
  const inPixels = root.createReadonly(d.arrayOf(d.f32, inCount), source.pixels);
  const outPixels = root.createMutable(d.arrayOf(d.f32, outCount));

  const pipeline = root.createGuardedComputePipeline((outX, outY) => {
    'use gpu';
    const sourceX = outX * params.$.factor;
    const sourceY = outY * params.$.factor;
    const sourceIndex = sourceY * params.$.inWidth + sourceX;
    const outIndex = outY * params.$.outWidth + outX;
    outPixels.$[outIndex] = inPixels.$[sourceIndex];
  });

  pipeline.dispatchThreads(width, height);
  const out = await outPixels.read();
  const pixels = Float32Array.from(out);

  return {
    pixels,
    width,
    height,
    extent: {
      eastMin: source.extent.eastMin,
      eastMax: source.extent.eastMin + width * resolutionMetres,
      northMin: source.extent.northMax - height * resolutionMetres,
      northMax: source.extent.northMax,
    },
  };
}
