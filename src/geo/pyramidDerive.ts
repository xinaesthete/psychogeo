import * as THREE from 'three';
import { viewportMetresFromCameraDistance } from './groundViewport';
import {
  gridRefToBounds,
  normalizeGridRef,
  tierMetresForGridRef,
  type TileExtent,
} from './pyramidOsgb';
import type { EncodingScalars, NamingConvention, PyramidLevel, TerrainManifestV2 } from './pyramidTypes';

const scratchCameraPos = new THREE.Vector3();
const scratchClosest = new THREE.Vector3();

export function applyTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`missing template value: ${key}`);
    return String(value);
  });
}

export function nodeRelDir(gridRef: string, ingestCell: string): string {
  const normalizedCell = normalizeGridRef(ingestCell);
  const normalizedRef = normalizeGridRef(gridRef);
  if (normalizedRef === normalizedCell) return '';
  if (normalizedRef.startsWith(normalizedCell)) {
    return normalizedRef;
  }
  throw new Error(`gridRef ${gridRef} is outside ingest cell ${ingestCell}`);
}

export function nodeDirPath(ingestCell: string, gridRef: string): string {
  const rel = nodeRelDir(gridRef, ingestCell);
  if (rel.length === 0) return `pyramid/${ingestCell}`;
  return `pyramid/${ingestCell}/${rel}`;
}

export function nodeManifestPath(ingestCell: string, gridRef: string): string {
  return `${nodeDirPath(ingestCell, gridRef)}/manifest.json`;
}

export function mergedChunkRelHref(level: number, gridRef: string, naming: NamingConvention): string {
  return applyTemplate(naming.mergedChunk, { level, gridRef });
}

export function mergedChunkDatasetPath(
  ingestCell: string,
  gridRef: string,
  level: number,
  naming: NamingConvention,
): string {
  return `${nodeDirPath(ingestCell, gridRef)}/${mergedChunkRelHref(level, gridRef, naming)}`;
}

export function leafChunkId(eastMin: number, northMin: number, naming: NamingConvention): string {
  return applyTemplate(naming.leafChunkId, { eastMin, northMin });
}

export function leafChunkRelHref(eastMin: number, northMin: number, naming: NamingConvention): string {
  return applyTemplate(naming.leafChunk, { eastMin, northMin });
}

export function leafChunkDatasetPath(
  ingestCell: string,
  gridRef: string,
  eastMin: number,
  northMin: number,
  naming: NamingConvention,
): string {
  return `${nodeDirPath(ingestCell, gridRef)}/${leafChunkRelHref(eastMin, northMin, naming)}`;
}

export function leafSlotIndex(col: number, row: number, cols: number): number {
  return col + row * cols;
}

export function leafSlotCoordinates(
  cellBounds: TileExtent,
  col: number,
  row: number,
  stepMetres: number,
): { eastMin: number; northMin: number } {
  return {
    eastMin: cellBounds.eastMin + col * stepMetres,
    northMin: cellBounds.northMin + row * stepMetres,
  };
}

export function leafSlotBounds(
  cellBounds: TileExtent,
  col: number,
  row: number,
  stepMetres: number,
): TileExtent {
  const { eastMin, northMin } = leafSlotCoordinates(cellBounds, col, row, stepMetres);
  return {
    eastMin,
    eastMax: eastMin + stepMetres,
    northMin,
    northMax: northMin + stepMetres,
  };
}

export function pixelDimensions(tierMetres: number, resolutionMetres: number): {
  width: number;
  height: number;
} {
  const pixels = Math.round(tierMetres / resolutionMetres);
  return { width: pixels, height: pixels };
}

export function levelsForNode(
  gridRef: string,
  levels: readonly PyramidLevel[],
): PyramidLevel[] {
  const nodeTier = tierMetresForGridRef(gridRef);
  return levels.filter((entry) => entry.tierMetres === nodeTier && entry.level > 0);
}

export function finestLeafLevel(levels: readonly PyramidLevel[]): PyramidLevel {
  const leaf = levels.find((entry) => entry.level === 0);
  if (!leaf) throw new Error('tileMatrixSet must include level 0');
  return leaf;
}

export function cameraDistanceToExtent(camera: THREE.Camera, extent: TileExtent): number {
  scratchCameraPos.setFromMatrixPosition(camera.matrixWorld);
  const closestX = THREE.MathUtils.clamp(scratchCameraPos.x, extent.eastMin, extent.eastMax);
  const closestY = THREE.MathUtils.clamp(scratchCameraPos.y, extent.northMin, extent.northMax);
  const horizontal = Math.hypot(
    scratchCameraPos.x - closestX,
    scratchCameraPos.y - closestY,
  );
  return Math.hypot(horizontal, scratchCameraPos.z);
}

export function pickPyramidLevelForTileDistance(
  meta: TerrainManifestV2,
  camera: THREE.Camera,
  extent: TileExtent,
): number {
  if (!(camera instanceof THREE.PerspectiveCamera)) {
    return pickPyramidLevel(meta, extent.eastMax - extent.eastMin);
  }
  const distance = cameraDistanceToExtent(camera, extent);
  const viewportMetres = viewportMetresFromCameraDistance(camera, distance);
  return pickPyramidLevel(meta, viewportMetres);
}

export function pickPyramidLevel(
  meta: TerrainManifestV2,
  viewportMetres: number,
): number {
  const levels = [...meta.tileMatrixSet.levels].sort((a, b) => b.level - a.level);
  for (const entry of levels) {
    if (entry.level === 0) continue;
    const threshold = entry.level > 1 ? entry.tierMetres * 2.5 : entry.tierMetres;
    if (viewportMetres >= threshold) {
      return entry.level;
    }
  }
  return 0;
}

export function encodingFromLeafSlot(
  leaf: {
    readonly enc: {
      readonly min: number[];
      readonly max: number[];
      readonly scale: number[];
      readonly offset: number[];
    };
    readonly missing?: number[];
  },
  slotIndex: number,
): EncodingScalars | undefined {
  if (leaf.missing?.includes(slotIndex)) return undefined;
  return {
    min: leaf.enc.min[slotIndex],
    max: leaf.enc.max[slotIndex],
    scale: leaf.enc.scale[slotIndex],
    offset: leaf.enc.offset[slotIndex],
  };
}

export function leafSlotsInBounds(
  cellBounds: TileExtent,
  viewport: TileExtent,
  cols: number,
  rows: number,
  stepMetres: number,
): Array<{ col: number; row: number; index: number }> {
  const slots: Array<{ col: number; row: number; index: number }> = [];
  const colStart = Math.max(0, Math.floor((viewport.eastMin - cellBounds.eastMin) / stepMetres));
  const colEnd = Math.min(cols - 1, Math.floor((viewport.eastMax - cellBounds.eastMin) / stepMetres));
  const rowStart = Math.max(0, Math.floor((viewport.northMin - cellBounds.northMin) / stepMetres));
  const rowEnd = Math.min(rows - 1, Math.floor((viewport.northMax - cellBounds.northMin) / stepMetres));
  for (let row = rowStart; row <= rowEnd; row += 1) {
    for (let col = colStart; col <= colEnd; col += 1) {
      const slotBounds = leafSlotBounds(cellBounds, col, row, stepMetres);
      if (
        slotBounds.eastMin < viewport.eastMax &&
        slotBounds.eastMax > viewport.eastMin &&
        slotBounds.northMin < viewport.northMax &&
        slotBounds.northMax > viewport.northMin
      ) {
        slots.push({ col, row, index: leafSlotIndex(col, row, cols) });
      }
    }
  }
  return slots;
}

export function defaultNamingConvention(): NamingConvention {
  return {
    nodeDir: 'pyramid/{gridRef}',
    nodeManifest: 'pyramid/{gridRef}/manifest.json',
    mergedChunk: '{level}/{gridRef}.j2c',
    leafChunk: '0/{eastMin}_{northMin}.j2c',
    leafChunkId: '{eastMin}_{northMin}',
  };
}

export function defaultSpatialIndex() {
  return {
    scheme: 'osgb-national-grid' as const,
    tiers: [
      { suffix: '', cellMetres: 100000 },
      { suffix: 'digit2', cellMetres: 10000 },
      { suffix: 'quad', cellMetres: 5000 },
      { suffix: 'leaf', cellMetres: 1000 },
    ],
  };
}

export function indexRootForCell(ingestCell: string): string {
  return nodeManifestPath(ingestCell, ingestCell);
}

export function boundsForGridRef(gridRef: string): TileExtent {
  return gridRefToBounds(gridRef);
}

export function tierMetresForLevel(meta: TerrainManifestV2, level: number): number {
  const entry = meta.tileMatrixSet.levels.find((l) => l.level === level);
  if (!entry) throw new Error(`unknown pyramid level ${level}`);
  return entry.tierMetres;
}
