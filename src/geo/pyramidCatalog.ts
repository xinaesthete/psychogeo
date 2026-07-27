import type * as THREE from 'three';
import type { DsmCatItem } from './TileLoaderUK';
import {
  cameraDistanceToExtent,
  encodingFromLeafSlot,
  finestLeafLevel,
  leafChunkDatasetPath,
  leafSlotBounds,
  leafSlotsInBounds,
  mergedChunkDatasetPath,
  nodeManifestPath,
  pickPyramidLevel,
  pickPyramidLevelForTileDistance,
  pixelDimensions,
  tierMetresForLevel,
} from './pyramidDerive';
import { extentCovers, extentsIntersect, gridRefToBounds, type TileExtent } from './pyramidOsgb';
import { parseMetadataJson, parseNodeManifestJson } from './pyramidSchema';
import type { ChunkFetchDescriptor, EncodingScalars, PyramidNodeManifest, TerrainManifestV2 } from './pyramidTypes';

export interface PyramidCatalog {
  readonly metadataUrl: string;
  readonly baseUrl: string;
  readonly meta: TerrainManifestV2;
}

export interface RegionSummaryCell {
  readonly cell: string;
  readonly indexRoot: string;
  readonly groupCount: number;
  readonly leafChunks: number;
  readonly outputBytes: number;
}

export interface RegionSummary {
  readonly region: { readonly kind: 'grid-ref'; readonly gridRef: string } | { readonly kind: 'bounds'; readonly bounds: TileExtent };
  readonly regionLabel: string;
  readonly cells: readonly RegionSummaryCell[];
}

function datasetBaseUrl(metadataUrl: string): string {
  const slash = metadataUrl.lastIndexOf('/');
  return slash >= 0 ? metadataUrl.slice(0, slash + 1) : '';
}

export function resolveDatasetHref(baseUrl: string, href: string): string {
  if (href.startsWith('/') || href.startsWith('http://') || href.startsWith('https://')) {
    return href;
  }
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    return new URL(href, baseUrl).toString();
  }
  return `${baseUrl}${href}`;
}

export async function loadPyramidDataset(metadataUrl: string): Promise<PyramidCatalog> {
  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch pyramid metadata ${metadataUrl}: ${response.status}`);
  }
  const meta = parseMetadataJson(await response.json());
  return {
    metadataUrl,
    baseUrl: datasetBaseUrl(metadataUrl),
    meta,
  };
}

export function pickPyramidLevelForViewport(catalog: PyramidCatalog, viewportMetres: number): number {
  return pickPyramidLevel(catalog.meta, viewportMetres);
}

export function viewportSpanMetres(bounds: TileExtent): number {
  return Math.max(bounds.eastMax - bounds.eastMin, bounds.northMax - bounds.northMin);
}

function chunkExtent(descriptor: ChunkFetchDescriptor): TileExtent {
  return {
    eastMin: descriptor.eastMin,
    eastMax: descriptor.eastMin + descriptor.extentMetres,
    northMin: descriptor.northMin,
    northMax: descriptor.northMin + descriptor.extentMetres,
  };
}

/** Drop coarser chunks fully covered by a finer chunk already in the set. */
export function dedupeOverlappingChunks(
  descriptors: readonly ChunkFetchDescriptor[],
): ChunkFetchDescriptor[] {
  return descriptors.filter((candidate) => {
    const candidateExtent = chunkExtent(candidate);
    return !descriptors.some((other) => {
      if (other === candidate || other.level >= candidate.level) return false;
      return extentCovers(chunkExtent(other), candidateExtent);
    });
  });
}

function encodingHeightMin(encoding: EncodingScalars): number {
  return encoding.offset;
}

function encodingHeightMax(encoding: EncodingScalars): number {
  return encoding.offset + encoding.scale * 65536;
}

export function chunkToDsmCatItem(descriptor: ChunkFetchDescriptor): DsmCatItem {
  return {
    min_ele: encodingHeightMin(descriptor.encoding),
    max_ele: encodingHeightMax(descriptor.encoding),
    valid_percent: 100,
    xllcorner: descriptor.eastMin,
    yllcorner: descriptor.northMin,
    nrows: descriptor.height,
    ncols: descriptor.width,
    extentMetres: descriptor.extentMetres,
    source_filename: descriptor.url,
  };
}

export class PyramidCatalogResolver {
  private readonly manifestCache = new Map<string, PyramidNodeManifest>();
  private readonly missingManifests = new Set<string>();
  private regionSummary: RegionSummary | undefined;
  private regionSummaryLoaded = false;

  constructor(private readonly catalog: PyramidCatalog) {}

  get catalogRef(): PyramidCatalog {
    return this.catalog;
  }

  clearCache(): void {
    this.manifestCache.clear();
    this.missingManifests.clear();
    this.regionSummary = undefined;
    this.regionSummaryLoaded = false;
  }

  private manifestCacheKey(ingestCell: string, gridRef: string): string {
    return `${ingestCell}:${gridRef}`;
  }

  private async loadRegionSummary(): Promise<RegionSummary | undefined> {
    if (this.regionSummaryLoaded) return this.regionSummary;
    this.regionSummaryLoaded = true;
    const href = this.catalog.meta.regionSummary;
    if (!href) return undefined;
    const url = resolveDatasetHref(this.catalog.baseUrl, href);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch region summary ${url}: ${response.status}`);
    }
    this.regionSummary = (await response.json()) as RegionSummary;
    return this.regionSummary;
  }

  private async loadNodeManifest(ingestCell: string, gridRef: string): Promise<PyramidNodeManifest> {
    const cacheKey = this.manifestCacheKey(ingestCell, gridRef);
    const cached = this.manifestCache.get(cacheKey);
    if (cached) return cached;
    const relPath = nodeManifestPath(ingestCell, gridRef);
    const url = resolveDatasetHref(this.catalog.baseUrl, relPath);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch pyramid node manifest ${url}: ${response.status}`);
    }
    const manifest = parseNodeManifestJson(await response.json());
    this.manifestCache.set(cacheKey, manifest);
    return manifest;
  }

  /**
   * Load a node manifest, returning undefined (and negative-caching the miss)
   * instead of throwing. Used for 100 km square nodes, which only exist once
   * their square has been finalized.
   */
  private async tryLoadNodeManifest(
    ingestCell: string,
    gridRef: string,
  ): Promise<PyramidNodeManifest | undefined> {
    const cacheKey = this.manifestCacheKey(ingestCell, gridRef);
    if (this.missingManifests.has(cacheKey)) return undefined;
    try {
      return await this.loadNodeManifest(ingestCell, gridRef);
    } catch {
      this.missingManifests.add(cacheKey);
      return undefined;
    }
  }

  /** Coarsest level merged on cell nodes — the fallback when a square chunk is absent. */
  private coarsestCellLevel(): number | undefined {
    const cellLevels = this.catalog.meta.tileMatrixSet.levels.filter(
      (entry) => entry.level > 0 && entry.tierMetres <= 10000,
    );
    if (cellLevels.length === 0) return undefined;
    return Math.max(...cellLevels.map((entry) => entry.level));
  }

  private squareChunkDescriptor(
    square: string,
    levelEntry: { readonly level: number; readonly resolutionMetres: number; readonly tierMetres: number },
    encoding: EncodingScalars,
  ): ChunkFetchDescriptor {
    const squareBounds = gridRefToBounds(square);
    const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
    const relUrl = mergedChunkDatasetPath(square, square, levelEntry.level, this.catalog.meta.naming);
    return {
      gridRef: square,
      level: levelEntry.level,
      eastMin: squareBounds.eastMin,
      northMin: squareBounds.northMin,
      url: resolveDatasetHref(this.catalog.baseUrl, relUrl),
      encoding,
      width,
      height,
      extentMetres: levelEntry.tierMetres,
    };
  }

  /**
   * Resolve chunks for a 100 km-tier level: one chunk per square node. Cells
   * whose square has not been finalized fall back to their own coarsest
   * cell-tier chunks so partially merged datasets still render.
   */
  private async resolveSquareChunks(
    cells: readonly string[],
    bounds: TileExtent,
    levelEntry: { readonly level: number; readonly resolutionMetres: number; readonly tierMetres: number },
  ): Promise<ChunkFetchDescriptor[]> {
    const cellsBySquare = new Map<string, string[]>();
    for (const cell of cells) {
      const cellBounds = gridRefToBounds(cell);
      if (!extentsIntersect(cellBounds, bounds)) continue;
      const square = cell.slice(0, 2).toUpperCase();
      const existing = cellsBySquare.get(square) ?? [];
      existing.push(cell);
      cellsBySquare.set(square, existing);
    }

    const descriptors: ChunkFetchDescriptor[] = [];
    for (const [square, squareCells] of cellsBySquare) {
      const manifest = await this.tryLoadNodeManifest(square, square);
      const encoding = manifest?.levels?.[String(levelEntry.level)];
      if (encoding) {
        descriptors.push(this.squareChunkDescriptor(square, levelEntry, encoding));
        continue;
      }
      const fallbackLevel = this.coarsestCellLevel();
      if (fallbackLevel === undefined) continue;
      for (const cell of squareCells) {
        descriptors.push(...(await this.resolveChunksForCell(cell, bounds, fallbackLevel)));
      }
    }
    return descriptors;
  }

  private async resolveChunksForCell(
    ingestCell: string,
    bounds: TileExtent,
    targetLevel?: number,
  ): Promise<ChunkFetchDescriptor[]> {
    const { meta, baseUrl } = this.catalog;
    const level =
      targetLevel ??
      pickPyramidLevel(meta, viewportSpanMetres(bounds));
    const descriptors: ChunkFetchDescriptor[] = [];
    const root = await this.loadNodeManifest(ingestCell, ingestCell);

    if (level === 0) {
      const leafLevel = finestLeafLevel(meta.tileMatrixSet.levels);
      for (const childRef of root.children ?? []) {
        const node = await this.loadNodeManifest(ingestCell, childRef);
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
          const eastMin = cellBounds.eastMin + slot.col * node.leaf.stepMetres;
          const northMin = cellBounds.northMin + slot.row * node.leaf.stepMetres;
          const { width, height } = pixelDimensions(node.leaf.stepMetres, leafLevel.resolutionMetres);
          const relUrl = leafChunkDatasetPath(ingestCell, childRef, eastMin, northMin, meta.naming);
          descriptors.push({
            gridRef: childRef,
            level: 0,
            eastMin,
            northMin,
            url: resolveDatasetHref(baseUrl, relUrl),
            encoding,
            width,
            height,
            extentMetres: node.leaf.stepMetres,
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
      const cellBounds = gridRefToBounds(ingestCell);
      if (!extentsIntersect(cellBounds, bounds)) return descriptors;
      const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
      const relUrl = mergedChunkDatasetPath(ingestCell, ingestCell, level, meta.naming);
      descriptors.push({
        gridRef: ingestCell,
        level,
        eastMin: cellBounds.eastMin,
        northMin: cellBounds.northMin,
        url: resolveDatasetHref(baseUrl, relUrl),
        encoding,
        width,
        height,
        extentMetres: levelEntry.tierMetres,
      });
      return descriptors;
    }

    for (const childRef of root.children ?? []) {
      const node = await this.loadNodeManifest(ingestCell, childRef);
      const encoding = node.levels?.[String(level)];
      if (!encoding) continue;
      const cellBounds = gridRefToBounds(childRef);
      if (!extentsIntersect(cellBounds, bounds)) continue;
      const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
      const relUrl = mergedChunkDatasetPath(ingestCell, childRef, level, meta.naming);
      descriptors.push({
        gridRef: childRef,
        level,
        eastMin: cellBounds.eastMin,
        northMin: cellBounds.northMin,
        url: resolveDatasetHref(baseUrl, relUrl),
        encoding,
        width,
        height,
        extentMetres: levelEntry.tierMetres,
      });
    }

    return descriptors;
  }

  private async resolveChunksForCellAdaptive(
    ingestCell: string,
    bounds: TileExtent,
    camera: THREE.Camera,
  ): Promise<ChunkFetchDescriptor[]> {
    const { meta, baseUrl } = this.catalog;
    const root = await this.loadNodeManifest(ingestCell, ingestCell);
    const leafLevel = finestLeafLevel(meta.tileMatrixSet.levels);
    const l1Entry = meta.tileMatrixSet.levels.find((entry) => entry.level === 1);
    const l2Entry = meta.tileMatrixSet.levels.find((entry) => entry.level === 2);

    type QuadPlan = {
      childRef: string;
      node: PyramidNodeManifest;
      cellBounds: TileExtent;
      slots: Array<{ col: number; row: number; index: number }>;
      quadLevel: number;
    };

    const quadPlans: QuadPlan[] = [];

    for (const childRef of root.children ?? []) {
      const node = await this.loadNodeManifest(ingestCell, childRef);
      const cellBounds = gridRefToBounds(childRef);
      if (!extentsIntersect(cellBounds, bounds)) continue;
      if (!node.leaf) continue;

      const slots = leafSlotsInBounds(
        cellBounds,
        bounds,
        node.leaf.cols,
        node.leaf.rows,
        node.leaf.stepMetres,
      );
      if (slots.length === 0) continue;

      let nearestBounds = leafSlotBounds(
        cellBounds,
        slots[0].col,
        slots[0].row,
        node.leaf.stepMetres,
      );
      let minDistance = cameraDistanceToExtent(camera, nearestBounds);
      for (const slot of slots) {
        const slotBounds = leafSlotBounds(
          cellBounds,
          slot.col,
          slot.row,
          node.leaf.stepMetres,
        );
        const distance = cameraDistanceToExtent(camera, slotBounds);
        if (distance < minDistance) {
          minDistance = distance;
          nearestBounds = slotBounds;
        }
      }

      quadPlans.push({
        childRef,
        node,
        cellBounds,
        slots,
        quadLevel: pickPyramidLevelForTileDistance(meta, camera, nearestBounds),
      });
    }

    if (quadPlans.length === 0) return [];

    const descriptors: ChunkFetchDescriptor[] = [];

    // 100 km square chunks cover many ingest cells — use one when every
    // visible quad is far enough. Cells in the same square emit the same
    // descriptor; the caller dedupes by chunk key.
    const squareLevels = meta.tileMatrixSet.levels
      .filter((entry) => entry.tierMetres === 100000)
      .sort((a, b) => a.level - b.level);
    if (squareLevels.length > 0 && quadPlans.every((plan) => plan.quadLevel >= squareLevels[0].level)) {
      const wanted = Math.min(...quadPlans.map((plan) => plan.quadLevel));
      const levelEntry =
        [...squareLevels].reverse().find((entry) => entry.level <= wanted) ?? squareLevels[0];
      const square = ingestCell.slice(0, 2).toUpperCase();
      const manifest = await this.tryLoadNodeManifest(square, square);
      const encoding = manifest?.levels?.[String(levelEntry.level)];
      if (encoding) {
        descriptors.push(this.squareChunkDescriptor(square, levelEntry, encoding));
        return descriptors;
      }
      // Square not finalized yet — fall through to cell-tier resolution.
    }

    // L2 covers the whole ingest cell — only use it when every visible quad is far enough.
    if (l2Entry && quadPlans.every((plan) => plan.quadLevel >= 2)) {
      const encoding = root.levels?.['2'];
      const ingestBounds = gridRefToBounds(ingestCell);
      if (encoding && extentsIntersect(ingestBounds, bounds)) {
        const { width, height } = pixelDimensions(l2Entry.tierMetres, l2Entry.resolutionMetres);
        const relUrl = mergedChunkDatasetPath(ingestCell, ingestCell, 2, meta.naming);
        descriptors.push({
          gridRef: ingestCell,
          level: 2,
          eastMin: ingestBounds.eastMin,
          northMin: ingestBounds.northMin,
          url: resolveDatasetHref(baseUrl, relUrl),
          encoding,
          width,
          height,
          extentMetres: l2Entry.tierMetres,
        });
        return descriptors;
      }
    }

    for (const plan of quadPlans) {
      const leaf = plan.node.leaf;
      if (!leaf) continue;

      if (plan.quadLevel === 0) {
        for (const slot of plan.slots) {
          const encoding = encodingFromLeafSlot(leaf, slot.index);
          if (!encoding) continue;
          const eastMin = plan.cellBounds.eastMin + slot.col * leaf.stepMetres;
          const northMin = plan.cellBounds.northMin + slot.row * leaf.stepMetres;
          const { width, height } = pixelDimensions(leaf.stepMetres, leafLevel.resolutionMetres);
          const relUrl = leafChunkDatasetPath(
            ingestCell,
            plan.childRef,
            eastMin,
            northMin,
            meta.naming,
          );
          descriptors.push({
            gridRef: plan.childRef,
            level: 0,
            eastMin,
            northMin,
            url: resolveDatasetHref(baseUrl, relUrl),
            encoding,
            width,
            height,
            extentMetres: leaf.stepMetres,
          });
        }
        continue;
      }

      if (!l1Entry) continue;
      const encoding = plan.node.levels?.['1'];
      if (!encoding) continue;
      const { width, height } = pixelDimensions(l1Entry.tierMetres, l1Entry.resolutionMetres);
      const relUrl = mergedChunkDatasetPath(ingestCell, plan.childRef, 1, meta.naming);
      descriptors.push({
        gridRef: plan.childRef,
        level: 1,
        eastMin: plan.cellBounds.eastMin,
        northMin: plan.cellBounds.northMin,
        url: resolveDatasetHref(baseUrl, relUrl),
        encoding,
        width,
        height,
        extentMetres: l1Entry.tierMetres,
      });
    }

    return descriptors;
  }

  async resolveChunksInBounds(
    bounds: TileExtent,
    targetLevel?: number,
  ): Promise<ChunkFetchDescriptor[]> {
    const regionSummary = await this.loadRegionSummary();
    const { meta } = this.catalog;
    const level = targetLevel ?? pickPyramidLevel(meta, viewportSpanMetres(bounds));
    const levelEntry = meta.tileMatrixSet.levels.find((entry) => entry.level === level);

    if (levelEntry && levelEntry.tierMetres === 100000) {
      const cells = regionSummary
        ? regionSummary.cells.map((cell) => cell.cell)
        : [meta.ingestCell];
      return this.resolveSquareChunks(cells, bounds, levelEntry);
    }

    if (regionSummary) {
      const descriptors: ChunkFetchDescriptor[] = [];
      for (const cell of regionSummary.cells) {
        const cellBounds = gridRefToBounds(cell.cell);
        if (!extentsIntersect(cellBounds, bounds)) continue;
        const cellChunks = await this.resolveChunksForCell(cell.cell, bounds, level);
        descriptors.push(...cellChunks);
      }
      return descriptors;
    }

    return this.resolveChunksForCell(meta.ingestCell, bounds, level);
  }

  async resolveChunksInBoundsAdaptive(
    bounds: TileExtent,
    camera: THREE.Camera,
  ): Promise<ChunkFetchDescriptor[]> {
    const regionSummary = await this.loadRegionSummary();
    let descriptors: ChunkFetchDescriptor[];
    if (regionSummary) {
      descriptors = [];
      for (const cell of regionSummary.cells) {
        const cellBounds = gridRefToBounds(cell.cell);
        if (!extentsIntersect(cellBounds, bounds)) continue;
        const cellChunks = await this.resolveChunksForCellAdaptive(cell.cell, bounds, camera);
        descriptors.push(...cellChunks);
      }
    } else {
      descriptors = await this.resolveChunksForCellAdaptive(
        this.catalog.meta.ingestCell,
        bounds,
        camera,
      );
    }
    // Cells sharing a 100 km square emit identical square descriptors.
    const seen = new Set<string>();
    descriptors = descriptors.filter((descriptor) => {
      const key = chunkKey(descriptor);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return dedupeOverlappingChunks(descriptors);
  }

  tierMetresForLevel(level: number): number {
    return tierMetresForLevel(this.catalog.meta, level);
  }
}

export function chunkKey(descriptor: Pick<ChunkFetchDescriptor, 'level' | 'eastMin' | 'northMin'>): string {
  return `${descriptor.level}:${descriptor.eastMin}:${descriptor.northMin}`;
}
