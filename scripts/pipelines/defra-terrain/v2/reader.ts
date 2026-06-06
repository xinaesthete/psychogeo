import {
  encodingFromLeafSlot,
  finestLeafLevel,
  leafChunkDatasetPath,
  leafSlotsInBounds,
  mergedChunkDatasetPath,
  nodeManifestPath,
  pickPyramidLevel,
  pixelDimensions,
} from './derive.ts';
import { readMetadata, readNodeManifest } from './layout.ts';
import { extentsIntersect, gridRefToBounds, type TileExtent } from './osgb.ts';
import type { ChunkFetchDescriptor, TerrainManifestV2 } from './types.ts';

export async function loadPyramidRoot(outDir: string): Promise<TerrainManifestV2> {
  return readMetadata(outDir);
}

async function loadNodeManifest(outDir: string, meta: TerrainManifestV2, gridRef: string) {
  return readNodeManifest(outDir, nodeManifestPath(meta.ingestCell, gridRef));
}

export function pickPyramidLevelForViewport(meta: TerrainManifestV2, viewportMetres: number): number {
  return pickPyramidLevel(meta, viewportMetres);
}

export async function resolveChunksInBounds(
  outDir: string,
  bounds: TileExtent,
  targetLevel?: number,
): Promise<ChunkFetchDescriptor[]> {
  const meta = await loadPyramidRoot(outDir);
  const level =
    targetLevel ??
    pickPyramidLevel(
      meta,
      Math.max(bounds.eastMax - bounds.eastMin, bounds.northMax - bounds.northMin),
    );
  const descriptors: ChunkFetchDescriptor[] = [];
  const root = await loadNodeManifest(outDir, meta, meta.ingestCell);

  if (level === 0) {
    const leafLevel = finestLeafLevel(meta.tileMatrixSet.levels);
    for (const childRef of root.children ?? []) {
      const node = await loadNodeManifest(outDir, meta, childRef);
      if (!node.leaf) continue;
      const cellBounds = gridRefToBounds(childRef);
      if (!extentsIntersect(cellBounds, bounds)) continue;
      const slots = leafSlotsInBounds(
        cellBounds,
        bounds,
        node.leaf.cols,
        node.leaf.rows,
        node.leaf.stepMetres,
      );
      for (const slot of slots) {
        const encoding = encodingFromLeafSlot(node.leaf, slot.index);
        if (!encoding) continue;
        const { eastMin, northMin } = {
          eastMin: cellBounds.eastMin + slot.col * node.leaf.stepMetres,
          northMin: cellBounds.northMin + slot.row * node.leaf.stepMetres,
        };
        const { width, height } = pixelDimensions(node.leaf.stepMetres, leafLevel.resolutionMetres);
        descriptors.push({
          gridRef: childRef,
          level: 0,
          eastMin,
          northMin,
          url: leafChunkDatasetPath(meta.ingestCell, childRef, eastMin, northMin, meta.naming),
          encoding,
          width,
          height,
        });
      }
    }
    return descriptors;
  }

  const levelEntry = meta.tileMatrixSet.levels.find((entry) => entry.level === level);
  if (!levelEntry) return descriptors;

  if (levelEntry.tierMetres === 10000) {
    const node = root;
    const encoding = node.levels?.[String(level)];
    if (!encoding) return descriptors;
    const cellBounds = gridRefToBounds(meta.ingestCell);
    if (!extentsIntersect(cellBounds, bounds)) return descriptors;
    const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
    descriptors.push({
      gridRef: meta.ingestCell,
      level,
      eastMin: cellBounds.eastMin,
      northMin: cellBounds.northMin,
      url: mergedChunkDatasetPath(meta.ingestCell, meta.ingestCell, level, meta.naming),
      encoding,
      width,
      height,
    });
    return descriptors;
  }

  for (const childRef of root.children ?? []) {
    const node = await loadNodeManifest(outDir, meta, childRef);
    const encoding = node.levels?.[String(level)];
    if (!encoding) continue;
    const cellBounds = gridRefToBounds(childRef);
    if (!extentsIntersect(cellBounds, bounds)) continue;
    const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
    descriptors.push({
      gridRef: childRef,
      level,
      eastMin: cellBounds.eastMin,
      northMin: cellBounds.northMin,
      url: mergedChunkDatasetPath(meta.ingestCell, childRef, level, meta.naming),
      encoding,
      width,
      height,
    });
  }

  return descriptors;
}
