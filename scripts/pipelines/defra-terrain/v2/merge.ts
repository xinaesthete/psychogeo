import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeUint16Normalized } from '../encoding.ts';
import { encodeHtj2k } from '../htj2k.ts';
import { CHANNELS } from '../manifest.ts';
import { readRasterSource, type RasterSource } from '../raster.ts';
import { downsampleBilinearGpu } from '../rasterGpu.ts';
import { scanDefraZips } from '../scan.ts';
import type { TerrainChannelId } from '../types.ts';
import {
  mergedChunkDatasetPath,
  nodeManifestPath,
  pixelDimensions,
} from './derive.ts';
import { readMetadata, readNodeManifest, writeNodeManifest } from './layout.ts';
import {
  filterGroupsByCellPrefix,
  gridRefToBounds,
  normalizeGridRef,
  type TileExtent,
} from './osgb.ts';
import type { IngestMetricsCollector, MergeStepMetrics } from './metrics.ts';
import type { IngestV2ProgressEvent } from './ingest.ts';
import type { EncodingScalars, PyramidNodeManifest, TerrainManifestV2 } from './types.ts';

export interface MergeOptions {
  readonly outDir: string;
  readonly ingestCell: string;
  readonly metadata?: TerrainManifestV2;
  readonly inputDir?: string;
  readonly onProgress?: (event: IngestV2ProgressEvent) => void;
  readonly metrics?: IngestMetricsCollector;
}

export interface MergeResult {
  readonly steps: readonly MergeStepMetrics[];
}

function channelById(channelId: TerrainChannelId) {
  const channel = CHANNELS.find((entry) => entry.id === channelId);
  if (!channel) throw new Error(`Unknown channel: ${channelId}`);
  return channel;
}

function encodingScalarsFromRaster(encoded: ReturnType<typeof encodeUint16Normalized>): EncodingScalars {
  return {
    min: encoded.encoding.min,
    max: encoded.encoding.max,
    scale: encoded.encoding.scale,
    offset: encoded.encoding.offset,
  };
}

function resolutionForLevel(levels: readonly { level: number; resolutionMetres: number }[], level: number): number {
  const entry = levels.find((item) => item.level === level);
  if (!entry) throw new Error(`Missing pyramid level ${level}`);
  return entry.resolutionMetres;
}

function recordMergeStep(
  options: MergeOptions,
  step: MergeStepMetrics,
  steps: MergeStepMetrics[],
): void {
  steps.push(step);
  options.metrics?.recordMergeStep(step);
  options.onProgress?.({
    phase: 'merge-level',
    level: step.level,
    tierMetres: step.tierMetres,
    gridRef: step.gridRef,
    loadMs: step.loadMs,
    downsampleMs: step.downsampleMs,
    downsampleUploadMs: step.downsampleUploadMs,
    downsampleKernelMs: step.downsampleKernelMs,
    downsampleReadbackMs: step.downsampleReadbackMs,
    mosaicMs: step.mosaicMs,
    encodeMs: step.encodeMs,
    totalMs: step.totalMs,
    sourceWidth: step.sourceWidth,
    sourceHeight: step.sourceHeight,
    outputWidth: step.outputWidth,
    outputHeight: step.outputHeight,
  });
}

async function loadSourceRasterForFiveKm(
  inputDir: string | undefined,
  gridRef: string,
): Promise<RasterSource | undefined> {
  if (!inputDir) return undefined;
  const groups = await scanDefraZips(inputDir);
  const normalized = normalizeGridRef(gridRef);
  const group = groups.find((entry) => normalizeGridRef(entry.tileRef) === normalized);
  const fz = group?.sources.FZ;
  if (!fz) return undefined;
  return readRasterSource(fz);
}

export function mosaicRasters(
  tiles: Array<{ extent: TileExtent; pixels: Float32Array; width: number; height: number }>,
  bounds: TileExtent,
  resolutionMetres: number,
): { pixels: Float32Array; width: number; height: number; extent: TileExtent } {
  const width = Math.round((bounds.eastMax - bounds.eastMin) / resolutionMetres);
  const height = Math.round((bounds.northMax - bounds.northMin) / resolutionMetres);
  const pixels = new Float32Array(width * height);
  pixels.fill(Number.NaN);

  for (const tile of tiles) {
    for (let row = 0; row < tile.height; row += 1) {
      for (let col = 0; col < tile.width; col += 1) {
        const east = tile.extent.eastMin + col * resolutionMetres;
        const north = tile.extent.northMax - row * resolutionMetres;
        const destCol = Math.round((east - bounds.eastMin) / resolutionMetres);
        const destRow = Math.round((bounds.northMax - north) / resolutionMetres);
        if (destCol < 0 || destRow < 0 || destCol >= width || destRow >= height) continue;
        const value = tile.pixels[row * tile.width + col];
        pixels[destRow * width + destCol] = value;
      }
    }
  }

  return { pixels, width, height, extent: bounds };
}

async function downsampleForMerge(
  source: RasterSource,
  targetResolution: number,
): Promise<{
  readonly pixels: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly downsampleMs: number;
  readonly downsampleUploadMs: number;
  readonly downsampleKernelMs: number;
  readonly downsampleReadbackMs: number;
}> {
  const downsampled = await downsampleBilinearGpu(source, targetResolution);
  return {
    pixels: downsampled.pixels,
    width: downsampled.width,
    height: downsampled.height,
    downsampleMs: downsampled.timing.totalMs,
    downsampleUploadMs: downsampled.timing.uploadMs,
    downsampleKernelMs: downsampled.timing.kernelMs,
    downsampleReadbackMs: downsampled.timing.readbackMs,
  };
}

async function buildMergedRaster(
  options: MergeOptions,
  gridRef: string,
  targetResolution: number,
  sourceResolution: number,
  childGridRefs: string[],
): Promise<{
  readonly raster?: { pixels: Float32Array; width: number; height: number; extent: TileExtent };
  readonly loadMs: number;
  readonly downsampleMs: number;
  readonly downsampleUploadMs: number;
  readonly downsampleKernelMs: number;
  readonly downsampleReadbackMs: number;
  readonly mosaicMs: number;
}> {
  const bounds = gridRefToBounds(gridRef);
  const childTiles: Array<{ extent: TileExtent; pixels: Float32Array; width: number; height: number }> = [];
  let loadMs = 0;
  let downsampleMs = 0;
  let downsampleUploadMs = 0;
  let downsampleKernelMs = 0;
  let downsampleReadbackMs = 0;

  for (const childRef of childGridRefs) {
    const loadStarted = performance.now();
    const source = await loadSourceRasterForFiveKm(options.inputDir, childRef);
    loadMs += performance.now() - loadStarted;
    if (!source) continue;

    if (sourceResolution === source.resolutionMetres) {
      childTiles.push({
        extent: gridRefToBounds(childRef),
        pixels: source.pixels,
        width: source.width,
        height: source.height,
      });
      continue;
    }

    const downsampled = await downsampleForMerge(source, targetResolution);
    downsampleMs += downsampled.downsampleMs;
    downsampleUploadMs += downsampled.downsampleUploadMs;
    downsampleKernelMs += downsampled.downsampleKernelMs;
    downsampleReadbackMs += downsampled.downsampleReadbackMs;
    childTiles.push({
      extent: gridRefToBounds(childRef),
      pixels: downsampled.pixels,
      width: downsampled.width,
      height: downsampled.height,
    });
  }

  if (childTiles.length === 0) {
    return {
      loadMs,
      downsampleMs,
      downsampleUploadMs,
      downsampleKernelMs,
      downsampleReadbackMs,
      mosaicMs: 0,
    };
  }

  const mosaicStarted = performance.now();
  const raster = mosaicRasters(childTiles, bounds, targetResolution);
  const mosaicMs = performance.now() - mosaicStarted;
  return {
    raster,
    loadMs,
    downsampleMs,
    downsampleUploadMs,
    downsampleKernelMs,
    downsampleReadbackMs,
    mosaicMs,
  };
}

async function encodeMergedChunk(
  outDir: string,
  ingestCell: string,
  gridRef: string,
  level: number,
  raster: { pixels: Float32Array; width: number; height: number },
  channelId: TerrainChannelId,
  metrics?: IngestMetricsCollector,
): Promise<EncodingScalars> {
  const channel = channelById(channelId);
  const encoded = encodeUint16Normalized(raster.pixels);
  const bytes = await encodeHtj2k(encoded, raster.width, raster.height, channel.lossyQuality);
  const href = mergedChunkDatasetPath(ingestCell, gridRef, level, {
    nodeDir: 'pyramid/{gridRef}',
    nodeManifest: 'pyramid/{gridRef}/manifest.json',
    mergedChunk: '{level}/{gridRef}.j2c',
    leafChunk: '0/{eastMin}_{northMin}.j2c',
    leafChunkId: '{eastMin}_{northMin}',
  });
  const filePath = path.join(outDir, href);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(bytes));
  metrics?.addOutputBytes(bytes.byteLength);
  return encodingScalarsFromRaster(encoded);
}

async function patchNodeManifest(
  outDir: string,
  ingestCell: string,
  gridRef: string,
  level: number,
  encoding: EncodingScalars,
): Promise<void> {
  const relPath = nodeManifestPath(ingestCell, gridRef);
  const manifest = await readNodeManifest(outDir, relPath);
  const levels = { ...manifest.levels, [String(level)]: encoding };
  const next: PyramidNodeManifest = { ...manifest, levels };
  await writeNodeManifest(outDir, relPath, next);
}

export async function mergePyramidLevels(options: MergeOptions): Promise<MergeResult> {
  const metadata = options.metadata ?? (await readMetadata(options.outDir));
  const ingestCell = metadata.ingestCell;
  const parent = await readNodeManifest(options.outDir, metadata.indexRoot);
  const children = parent.children ?? [];
  const levels = metadata.tileMatrixSet.levels.filter((entry) => entry.level > 0);
  const steps: MergeStepMetrics[] = [];

  for (const levelEntry of levels) {
    if (levelEntry.tierMetres === 5000) {
      for (const childRef of children) {
        const stepStarted = performance.now();
        let loadMs = 0;
        let downsampleMs = 0;
        let downsampleUploadMs = 0;
        let downsampleKernelMs = 0;
        let downsampleReadbackMs = 0;
        let encodeMs = 0;
        let sourceWidth = 0;
        let sourceHeight = 0;
        let outputWidth = 0;
        let outputHeight = 0;

        const loadStarted = performance.now();
        const source = await loadSourceRasterForFiveKm(options.inputDir, childRef);
        loadMs = performance.now() - loadStarted;
        if (!source) continue;
        sourceWidth = source.width;
        sourceHeight = source.height;

        const downsampled = await downsampleForMerge(source, levelEntry.resolutionMetres);
        downsampleMs = downsampled.downsampleMs;
        downsampleUploadMs = downsampled.downsampleUploadMs;
        downsampleKernelMs = downsampled.downsampleKernelMs;
        downsampleReadbackMs = downsampled.downsampleReadbackMs;
        outputWidth = downsampled.width;
        outputHeight = downsampled.height;

        const encodeStarted = performance.now();
        const encoding = await encodeMergedChunk(
          options.outDir,
          ingestCell,
          childRef,
          levelEntry.level,
          downsampled,
          metadata.channelId,
          options.metrics,
        );
        encodeMs = performance.now() - encodeStarted;
        await patchNodeManifest(options.outDir, ingestCell, childRef, levelEntry.level, encoding);

        recordMergeStep(options, {
          level: levelEntry.level,
          tierMetres: levelEntry.tierMetres,
          gridRef: childRef,
          loadMs,
          downsampleMs,
          downsampleUploadMs,
          downsampleKernelMs,
          downsampleReadbackMs,
          mosaicMs: 0,
          encodeMs,
          totalMs: performance.now() - stepStarted,
          sourceWidth,
          sourceHeight,
          outputWidth,
          outputHeight,
        }, steps);
      }
      continue;
    }

    if (levelEntry.tierMetres === 10000 && levelEntry.level > 0) {
      const stepStarted = performance.now();
      const finerLevel = metadata.tileMatrixSet.levels.find(
        (entry) => entry.tierMetres === 5000 && entry.level < levelEntry.level,
      );
      const sourceResolution = finerLevel?.resolutionMetres ?? resolutionForLevel(metadata.tileMatrixSet.levels, 0);
      const built = await buildMergedRaster(
        options,
        ingestCell,
        levelEntry.resolutionMetres,
        sourceResolution,
        children,
      );
      if (!built.raster) continue;

      const encodeStarted = performance.now();
      const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
      const encoding = await encodeMergedChunk(
        options.outDir,
        ingestCell,
        ingestCell,
        levelEntry.level,
        {
          pixels: built.raster.pixels,
          width: built.raster.width > 0 ? built.raster.width : width,
          height: built.raster.height > 0 ? built.raster.height : height,
        },
        metadata.channelId,
        options.metrics,
      );
      const encodeMs = performance.now() - encodeStarted;
      await patchNodeManifest(options.outDir, ingestCell, ingestCell, levelEntry.level, encoding);

      recordMergeStep(options, {
        level: levelEntry.level,
        tierMetres: levelEntry.tierMetres,
        gridRef: ingestCell,
        loadMs: built.loadMs,
        downsampleMs: built.downsampleMs,
        downsampleUploadMs: built.downsampleUploadMs,
        downsampleKernelMs: built.downsampleKernelMs,
        downsampleReadbackMs: built.downsampleReadbackMs,
        mosaicMs: built.mosaicMs,
        encodeMs,
        totalMs: performance.now() - stepStarted,
        sourceWidth: built.raster.width,
        sourceHeight: built.raster.height,
        outputWidth: built.raster.width > 0 ? built.raster.width : width,
        outputHeight: built.raster.height > 0 ? built.raster.height : height,
      }, steps);
      continue;
    }

    if (levelEntry.tierMetres === 100000) {
      const stepStarted = performance.now();
      let loadMs = 0;
      let downsampleMs = 0;
      let downsampleUploadMs = 0;
      let downsampleKernelMs = 0;
      let downsampleReadbackMs = 0;
      let encodeMs = 0;
      let sourceWidth = 0;
      let sourceHeight = 0;
      let outputWidth = 0;
      let outputHeight = 0;

      const loadStarted = performance.now();
      const source = await loadSourceRasterForFiveKm(options.inputDir, children[0] ?? '');
      loadMs = performance.now() - loadStarted;
      if (!source) continue;
      sourceWidth = source.width;
      sourceHeight = source.height;

      const bounds = gridRefToBounds(ingestCell);
      const downsampled = await downsampleForMerge(
        {
          ...source,
          extent: bounds,
        },
        levelEntry.resolutionMetres,
      );
      downsampleMs = downsampled.downsampleMs;
      downsampleUploadMs = downsampled.downsampleUploadMs;
      downsampleKernelMs = downsampled.downsampleKernelMs;
      downsampleReadbackMs = downsampled.downsampleReadbackMs;
      outputWidth = downsampled.width;
      outputHeight = downsampled.height;

      const encodeStarted = performance.now();
      const encoding = await encodeMergedChunk(
        options.outDir,
        ingestCell,
        ingestCell,
        levelEntry.level,
        downsampled,
        metadata.channelId,
        options.metrics,
      );
      encodeMs = performance.now() - encodeStarted;
      await patchNodeManifest(options.outDir, ingestCell, ingestCell, levelEntry.level, encoding);

      recordMergeStep(options, {
        level: levelEntry.level,
        tierMetres: levelEntry.tierMetres,
        gridRef: ingestCell,
        loadMs,
        downsampleMs,
        downsampleUploadMs,
        downsampleKernelMs,
        downsampleReadbackMs,
        mosaicMs: 0,
        encodeMs,
        totalMs: performance.now() - stepStarted,
        sourceWidth,
        sourceHeight,
        outputWidth,
        outputHeight,
      }, steps);
    }
  }

  const mergeSummaryMs = steps.reduce((sum, step) => sum + step.totalMs, 0);
  options.onProgress?.({
    phase: 'merge-complete',
    levels: levels.length,
    elapsedMs: mergeSummaryMs,
    stepCount: steps.length,
  });

  return { steps };
}
