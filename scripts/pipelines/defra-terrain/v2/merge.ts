import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeUint16Normalized } from '../encoding.ts';
import { encodeHtj2k } from '../htj2k.ts';
import { CHANNELS } from '../manifest.ts';
import { downsampleNearest, readRasterSource, type RasterSource } from '../raster.ts';
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
import type { IngestV2ProgressEvent } from './ingest.ts';
import type { EncodingScalars, PyramidNodeManifest } from './types.ts';

export interface MergeOptions {
  readonly outDir: string;
  readonly ingestCell: string;
  readonly inputDir?: string;
  readonly onProgress?: (event: IngestV2ProgressEvent) => void;
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

async function buildMergedRaster(
  options: MergeOptions,
  gridRef: string,
  targetResolution: number,
  sourceResolution: number,
  childGridRefs: string[],
): Promise<{ pixels: Float32Array; width: number; height: number; extent: TileExtent } | undefined> {
  const bounds = gridRefToBounds(gridRef);
  const childTiles: Array<{ extent: TileExtent; pixels: Float32Array; width: number; height: number }> = [];

  for (const childRef of childGridRefs) {
    const source = await loadSourceRasterForFiveKm(options.inputDir, childRef);
    if (!source) continue;
    const downsampled =
      sourceResolution === source.resolutionMetres
        ? source
        : {
            ...downsampleNearest(source, targetResolution),
            extent: gridRefToBounds(childRef),
          };
    childTiles.push({
      extent: downsampled.extent,
      pixels: downsampled.pixels,
      width: downsampled.width,
      height: downsampled.height,
    });
  }

  if (childTiles.length === 0) return undefined;
  return mosaicRasters(childTiles, bounds, targetResolution);
}

async function encodeMergedChunk(
  outDir: string,
  ingestCell: string,
  gridRef: string,
  level: number,
  raster: { pixels: Float32Array; width: number; height: number },
  channelId: TerrainChannelId,
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

export async function mergePyramidLevels(options: MergeOptions): Promise<void> {
  const metadata = await readMetadata(options.outDir);
  const ingestCell = metadata.ingestCell;
  const parent = await readNodeManifest(options.outDir, metadata.indexRoot);
  const children = parent.children ?? [];
  const levels = metadata.tileMatrixSet.levels.filter((entry) => entry.level > 0);

  for (const levelEntry of levels) {
    if (levelEntry.tierMetres === 5000) {
      for (const childRef of children) {
        options.onProgress?.({ phase: 'merge-level', level: levelEntry.level, gridRef: childRef });
        const source = await loadSourceRasterForFiveKm(options.inputDir, childRef);
        if (!source) continue;
        const downsampled = downsampleNearest(source, levelEntry.resolutionMetres);
        const encoding = await encodeMergedChunk(
          options.outDir,
          ingestCell,
          childRef,
          levelEntry.level,
          downsampled,
          metadata.channelId,
        );
        await patchNodeManifest(options.outDir, ingestCell, childRef, levelEntry.level, encoding);
      }
      continue;
    }

    if (levelEntry.tierMetres === 10000 && levelEntry.level > 0) {
      options.onProgress?.({ phase: 'merge-level', level: levelEntry.level, gridRef: ingestCell });
      const finerLevel = metadata.tileMatrixSet.levels.find(
        (entry) => entry.tierMetres === 5000 && entry.level < levelEntry.level,
      );
      const sourceResolution = finerLevel?.resolutionMetres ?? resolutionForLevel(metadata.tileMatrixSet.levels, 0);
      const raster = await buildMergedRaster(
        options,
        ingestCell,
        levelEntry.resolutionMetres,
        sourceResolution,
        children,
      );
      if (!raster) continue;
      const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
      const encoding = await encodeMergedChunk(
        options.outDir,
        ingestCell,
        ingestCell,
        levelEntry.level,
        {
          pixels: raster.pixels,
          width: raster.width > 0 ? raster.width : width,
          height: raster.height > 0 ? raster.height : height,
        },
        metadata.channelId,
      );
      await patchNodeManifest(options.outDir, ingestCell, ingestCell, levelEntry.level, encoding);
      continue;
    }

    if (levelEntry.tierMetres === 100000) {
      options.onProgress?.({ phase: 'merge-level', level: levelEntry.level, gridRef: ingestCell });
      const source = await loadSourceRasterForFiveKm(options.inputDir, children[0] ?? '');
      if (!source) continue;
      const bounds = gridRefToBounds(ingestCell);
      const downsampled = downsampleNearest(
        {
          ...source,
          extent: bounds,
        },
        levelEntry.resolutionMetres,
      );
      const encoding = await encodeMergedChunk(
        options.outDir,
        ingestCell,
        ingestCell,
        levelEntry.level,
        downsampled,
        metadata.channelId,
      );
      await patchNodeManifest(options.outDir, ingestCell, ingestCell, levelEntry.level, encoding);
    }
  }

  options.onProgress?.({
    phase: 'merge-complete',
    levels: levels.length,
  });
}
