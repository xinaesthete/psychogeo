import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeUint16Normalized } from '../encoding.ts';
import { encodeHtj2k } from '../htj2k.ts';
import { CHANNELS } from '../manifest.ts';
import {
  downsampleMaxBiased,
  MAX_BIAS,
  readRasterSource,
  type RasterSource,
  type RasterWindow,
} from '../raster.ts';
import { downsampleReduceManyGpu, type ReduceTarget } from '../rasterGpu.ts';
import { scanDefraZips } from '../scan.ts';
import type { TerrainChannelId } from '../types.ts';
import {
  mergedChunkDatasetPath,
  nodeDirPath,
  nodeManifestPath,
} from './derive.ts';
import { readMetadata, readNodeManifest, writeNodeManifest } from './layout.ts';
import {
  gridRefToBounds,
  normalizeGridRef,
  type TileExtent,
} from './osgb.ts';
import type { IngestMetricsCollector, MergeStepMetrics } from './metrics.ts';
import type { IngestV2ProgressEvent } from './ingest.ts';
import type { EncodingScalars, PyramidLevel, PyramidNodeManifest, TerrainManifestV2 } from './types.ts';

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

const COARSE_RASTER_FILE = 'coarse.f32';
const COARSE_META_FILE = 'coarse.json';

interface CoarseRasterMeta {
  readonly resolutionMetres: number;
  readonly width: number;
  readonly height: number;
  readonly extent: TileExtent;
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

/** Levels merged within a 10 km ingest cell, by spatial tier. */
function cellLevels(metadata: TerrainManifestV2): {
  readonly l1?: PyramidLevel;
  readonly l2?: PyramidLevel;
} {
  const levels = metadata.tileMatrixSet.levels;
  return {
    l1: levels.find((entry) => entry.level > 0 && entry.tierMetres === 5000),
    l2: levels.find((entry) => entry.level > 0 && entry.tierMetres === 10000),
  };
}

/** The finest (lowest-resolution-number) 100 km-tier level, if any. */
export function finestSquareLevel(metadata: TerrainManifestV2): PyramidLevel | undefined {
  const squares = metadata.tileMatrixSet.levels.filter((entry) => entry.tierMetres === 100000);
  if (squares.length === 0) return undefined;
  return squares.reduce((finest, entry) =>
    entry.resolutionMetres < finest.resolutionMetres ? entry : finest,
  );
}

function recordMergeStep(
  options: Pick<MergeOptions, 'onProgress' | 'metrics'>,
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

function coarseRasterPath(outDir: string, ingestCell: string): string {
  return path.join(outDir, nodeDirPath(ingestCell, ingestCell), COARSE_RASTER_FILE);
}

function coarseMetaPath(outDir: string, ingestCell: string): string {
  return path.join(outDir, nodeDirPath(ingestCell, ingestCell), COARSE_META_FILE);
}

async function writeCoarseCellRaster(
  outDir: string,
  ingestCell: string,
  raster: { pixels: Float32Array; width: number; height: number; extent: TileExtent },
  resolutionMetres: number,
): Promise<void> {
  const meta: CoarseRasterMeta = {
    resolutionMetres,
    width: raster.width,
    height: raster.height,
    extent: raster.extent,
  };
  const rasterFile = coarseRasterPath(outDir, ingestCell);
  await mkdir(path.dirname(rasterFile), { recursive: true });
  await writeFile(rasterFile, Buffer.from(raster.pixels.buffer, raster.pixels.byteOffset, raster.pixels.byteLength));
  await writeFile(coarseMetaPath(outDir, ingestCell), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function readCoarseCellRaster(
  outDir: string,
  ingestCell: string,
): Promise<(CoarseRasterMeta & { readonly pixels: Float32Array }) | undefined> {
  try {
    const meta = JSON.parse(await readFile(coarseMetaPath(outDir, ingestCell), 'utf8')) as CoarseRasterMeta;
    const bytes = await readFile(coarseRasterPath(outDir, ingestCell));
    const pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    if (pixels.length !== meta.width * meta.height) return undefined;
    return { ...meta, pixels: Float32Array.from(pixels) };
  } catch {
    return undefined;
  }
}

export async function mergePyramidLevels(options: MergeOptions): Promise<MergeResult> {
  const metadata = options.metadata ?? (await readMetadata(options.outDir));
  const ingestCell = metadata.ingestCell;
  const parent = await readNodeManifest(options.outDir, metadata.indexRoot);
  const children = parent.children ?? [];
  const { l1, l2 } = cellLevels(metadata);
  const squareLevel = finestSquareLevel(metadata);
  const steps: MergeStepMetrics[] = [];

  const groups = options.inputDir ? await scanDefraZips(options.inputDir) : [];
  const groupByRef = new Map(groups.map((group) => [normalizeGridRef(group.tileRef), group]));

  const targets: Array<{ level: PyramidLevel; bias: number; role: 'l1' | 'l2' | 'coarse' }> = [];
  if (l1) targets.push({ level: l1, bias: 0, role: 'l1' });
  if (l2) targets.push({ level: l2, bias: MAX_BIAS, role: 'l2' });
  if (squareLevel) targets.push({ level: squareLevel, bias: MAX_BIAS, role: 'coarse' });
  if (targets.length === 0) return { steps };

  const l2Tiles: Array<{ extent: TileExtent; pixels: Float32Array; width: number; height: number }> = [];
  const coarseTiles: Array<{ extent: TileExtent; pixels: Float32Array; width: number; height: number }> = [];
  let mosaicLoadMs = 0;
  let mosaicDownsample = { totalMs: 0, uploadMs: 0, kernelMs: 0, readbackMs: 0 };

  for (const childRef of children) {
    const stepStarted = performance.now();
    const loadStarted = performance.now();
    const group = groupByRef.get(normalizeGridRef(childRef));
    const fz = group?.sources.FZ;
    const source: RasterSource | undefined = fz ? await readRasterSource(fz) : undefined;
    const loadMs = performance.now() - loadStarted;
    if (!source) continue;

    const reduceTargets: ReduceTarget[] = targets.map((target) => ({
      resolutionMetres: target.level.resolutionMetres,
      bias: target.bias,
    }));
    const { outputs, timing } = await downsampleReduceManyGpu(source, reduceTargets);
    const childBounds = gridRefToBounds(childRef);

    for (const [index, target] of targets.entries()) {
      const output = outputs[index];
      if (target.role === 'l1') {
        const encodeStarted = performance.now();
        const encoding = await encodeMergedChunk(
          options.outDir,
          ingestCell,
          childRef,
          target.level.level,
          output,
          metadata.channelId,
          options.metrics,
        );
        const encodeMs = performance.now() - encodeStarted;
        await patchNodeManifest(options.outDir, ingestCell, childRef, target.level.level, encoding);
        recordMergeStep(options, {
          level: target.level.level,
          tierMetres: target.level.tierMetres,
          gridRef: childRef,
          loadMs,
          downsampleMs: timing.totalMs,
          downsampleUploadMs: timing.uploadMs,
          downsampleKernelMs: timing.kernelMs,
          downsampleReadbackMs: timing.readbackMs,
          mosaicMs: 0,
          encodeMs,
          totalMs: performance.now() - stepStarted,
          sourceWidth: source.width,
          sourceHeight: source.height,
          outputWidth: output.width,
          outputHeight: output.height,
        }, steps);
      } else {
        const tiles = target.role === 'l2' ? l2Tiles : coarseTiles;
        tiles.push({
          extent: childBounds,
          pixels: output.pixels,
          width: output.width,
          height: output.height,
        });
      }
    }
    if (!l1) {
      // Downsample cost is otherwise attributed to the L1 step.
      mosaicLoadMs += loadMs;
      mosaicDownsample = {
        totalMs: mosaicDownsample.totalMs + timing.totalMs,
        uploadMs: mosaicDownsample.uploadMs + timing.uploadMs,
        kernelMs: mosaicDownsample.kernelMs + timing.kernelMs,
        readbackMs: mosaicDownsample.readbackMs + timing.readbackMs,
      };
    }
  }

  const cellBounds = gridRefToBounds(ingestCell);

  if (l2 && l2Tiles.length > 0) {
    const stepStarted = performance.now();
    const mosaicStarted = performance.now();
    const raster = mosaicRasters(l2Tiles, cellBounds, l2.resolutionMetres);
    const mosaicMs = performance.now() - mosaicStarted;

    const encodeStarted = performance.now();
    const encoding = await encodeMergedChunk(
      options.outDir,
      ingestCell,
      ingestCell,
      l2.level,
      raster,
      metadata.channelId,
      options.metrics,
    );
    const encodeMs = performance.now() - encodeStarted;
    await patchNodeManifest(options.outDir, ingestCell, ingestCell, l2.level, encoding);

    recordMergeStep(options, {
      level: l2.level,
      tierMetres: l2.tierMetres,
      gridRef: ingestCell,
      loadMs: mosaicLoadMs,
      downsampleMs: mosaicDownsample.totalMs,
      downsampleUploadMs: mosaicDownsample.uploadMs,
      downsampleKernelMs: mosaicDownsample.kernelMs,
      downsampleReadbackMs: mosaicDownsample.readbackMs,
      mosaicMs,
      encodeMs,
      totalMs: performance.now() - stepStarted,
      sourceWidth: raster.width,
      sourceHeight: raster.height,
      outputWidth: raster.width,
      outputHeight: raster.height,
    }, steps);
  }

  if (squareLevel && coarseTiles.length > 0) {
    const raster = mosaicRasters(coarseTiles, cellBounds, squareLevel.resolutionMetres);
    await writeCoarseCellRaster(options.outDir, ingestCell, raster, squareLevel.resolutionMetres);
  }

  const mergeSummaryMs = steps.reduce((sum, step) => sum + step.totalMs, 0);
  options.onProgress?.({
    phase: 'merge-complete',
    levels: targets.length,
    elapsedMs: mergeSummaryMs,
    stepCount: steps.length,
  });

  return { steps };
}

export interface SquareMergeOptions {
  readonly outDir: string;
  readonly metadata: TerrainManifestV2;
  /** Completed 10 km cells with data, across the whole region. */
  readonly cells: readonly string[];
  readonly onProgress?: (event: IngestV2ProgressEvent) => void;
  readonly metrics?: IngestMetricsCollector;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function squareUpToDate(
  outDir: string,
  square: string,
  cells: readonly string[],
  levels: readonly PyramidLevel[],
): Promise<boolean> {
  let manifest: PyramidNodeManifest;
  try {
    manifest = await readNodeManifest(outDir, nodeManifestPath(square, square));
  } catch {
    return false;
  }
  const existing = [...(manifest.children ?? [])].sort((a, b) => a.localeCompare(b));
  const wanted = [...cells].sort((a, b) => a.localeCompare(b));
  if (existing.length !== wanted.length || existing.some((cell, i) => cell !== wanted[i])) {
    return false;
  }
  for (const level of levels) {
    if (!manifest.levels?.[String(level.level)]) return false;
    const href = mergedChunkDatasetPath(square, square, level.level, {
      nodeDir: 'pyramid/{gridRef}',
      nodeManifest: 'pyramid/{gridRef}/manifest.json',
      mergedChunk: '{level}/{gridRef}.j2c',
      leafChunk: '0/{eastMin}_{northMin}.j2c',
      leafChunkId: '{eastMin}_{northMin}',
    });
    if (!(await pathExists(path.join(outDir, href)))) return false;
  }
  return true;
}

/**
 * Build true 100 km-square overview chunks by mosaicking the per-cell coarse
 * rasters persisted during cell merges. The finest 100 km level is encoded
 * from the mosaic; coarser 100 km levels are derived from it by further
 * max-biased reduction. Idempotent: squares whose manifest already covers the
 * same completed cells are skipped.
 */
export async function finalizeHundredKmSquares(options: SquareMergeOptions): Promise<MergeResult> {
  const steps: MergeStepMetrics[] = [];
  const squareLevels = options.metadata.tileMatrixSet.levels
    .filter((entry) => entry.tierMetres === 100000)
    .sort((a, b) => a.resolutionMetres - b.resolutionMetres);
  if (squareLevels.length === 0 || options.cells.length === 0) return { steps };

  const cellsBySquare = new Map<string, string[]>();
  for (const cell of options.cells) {
    const square = normalizeGridRef(cell).slice(0, 2);
    const existing = cellsBySquare.get(square) ?? [];
    existing.push(normalizeGridRef(cell));
    cellsBySquare.set(square, existing);
  }

  const finest = squareLevels[0];

  for (const [square, cells] of [...cellsBySquare.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const stepStarted = performance.now();
    const loadStarted = performance.now();
    const tiles: Array<{ extent: TileExtent; pixels: Float32Array; width: number; height: number }> = [];
    const contributingCells: string[] = [];
    for (const cell of cells) {
      const coarse = await readCoarseCellRaster(options.outDir, cell);
      if (!coarse || coarse.resolutionMetres !== finest.resolutionMetres) continue;
      tiles.push({
        extent: coarse.extent,
        pixels: coarse.pixels,
        width: coarse.width,
        height: coarse.height,
      });
      contributingCells.push(cell);
    }
    const loadMs = performance.now() - loadStarted;
    if (tiles.length === 0) continue;

    if (await squareUpToDate(options.outDir, square, contributingCells, squareLevels)) continue;

    const squareBounds = gridRefToBounds(square);
    const mosaicStarted = performance.now();
    const mosaic = mosaicRasters(tiles, squareBounds, finest.resolutionMetres);
    const mosaicMs = performance.now() - mosaicStarted;

    const levelEncodings: Record<string, EncodingScalars> = {};
    let currentRaster: RasterWindow = mosaic;
    let currentResolution = finest.resolutionMetres;
    let firstLevel = true;
    for (const level of squareLevels) {
      let downsampleMs = 0;
      if (!firstLevel) {
        const downsampleStarted = performance.now();
        currentRaster = downsampleMaxBiased(
          {
            pixels: currentRaster.pixels,
            width: currentRaster.width,
            height: currentRaster.height,
            resolutionMetres: currentResolution,
            extent: squareBounds,
          },
          level.resolutionMetres,
        );
        currentResolution = level.resolutionMetres;
        downsampleMs = performance.now() - downsampleStarted;
      }
      firstLevel = false;

      const encodeStarted = performance.now();
      const encoding = await encodeMergedChunk(
        options.outDir,
        square,
        square,
        level.level,
        currentRaster,
        options.metadata.channelId,
        options.metrics,
      );
      const encodeMs = performance.now() - encodeStarted;
      levelEncodings[String(level.level)] = encoding;

      recordMergeStep(options, {
        level: level.level,
        tierMetres: level.tierMetres,
        gridRef: square,
        loadMs: level === squareLevels[0] ? loadMs : 0,
        downsampleMs,
        downsampleUploadMs: 0,
        downsampleKernelMs: 0,
        downsampleReadbackMs: 0,
        mosaicMs: level === squareLevels[0] ? mosaicMs : 0,
        encodeMs,
        totalMs: performance.now() - stepStarted,
        sourceWidth: mosaic.width,
        sourceHeight: mosaic.height,
        outputWidth: currentRaster.width,
        outputHeight: currentRaster.height,
      }, steps);
    }

    const manifest: PyramidNodeManifest = {
      gridRef: square,
      children: [...contributingCells].sort((a, b) => a.localeCompare(b)),
      levels: levelEncodings,
    };
    await writeNodeManifest(options.outDir, nodeManifestPath(square, square), manifest);
  }

  return { steps };
}
