import type { DsmCatItem } from './TileLoaderUK';
import {
  encodingFromLeafSlot,
  finestLeafLevel,
  leafChunkDatasetPath,
  leafSlotsInBounds,
  mergedChunkDatasetPath,
  nodeManifestPath,
  pickPyramidLevel,
  pixelDimensions,
  tierMetresForLevel,
} from './pyramidDerive';
import { extentsIntersect, gridRefToBounds, type TileExtent } from './pyramidOsgb';
import { parseMetadataJson, parseNodeManifestJson } from './pyramidSchema';
import type { ChunkFetchDescriptor, EncodingScalars, PyramidNodeManifest, TerrainManifestV2 } from './pyramidTypes';

export interface PyramidCatalog {
  readonly metadataUrl: string;
  readonly baseUrl: string;
  readonly meta: TerrainManifestV2;
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

  constructor(private readonly catalog: PyramidCatalog) {}

  get catalogRef(): PyramidCatalog {
    return this.catalog;
  }

  clearCache(): void {
    this.manifestCache.clear();
  }

  private async loadNodeManifest(gridRef: string): Promise<PyramidNodeManifest> {
    const cached = this.manifestCache.get(gridRef);
    if (cached) return cached;
    const relPath = nodeManifestPath(this.catalog.meta.ingestCell, gridRef);
    const url = resolveDatasetHref(this.catalog.baseUrl, relPath);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch pyramid node manifest ${url}: ${response.status}`);
    }
    const manifest = parseNodeManifestJson(await response.json());
    this.manifestCache.set(gridRef, manifest);
    return manifest;
  }

  async resolveChunksInBounds(
    bounds: TileExtent,
    targetLevel?: number,
  ): Promise<ChunkFetchDescriptor[]> {
    const { meta, baseUrl } = this.catalog;
    const level =
      targetLevel ??
      pickPyramidLevel(meta, viewportSpanMetres(bounds));
    const descriptors: ChunkFetchDescriptor[] = [];
    const root = await this.loadNodeManifest(meta.ingestCell);

    if (level === 0) {
      const leafLevel = finestLeafLevel(meta.tileMatrixSet.levels);
      for (const childRef of root.children ?? []) {
        const node = await this.loadNodeManifest(childRef);
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
          const relUrl = leafChunkDatasetPath(meta.ingestCell, childRef, eastMin, northMin, meta.naming);
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
      const cellBounds = gridRefToBounds(meta.ingestCell);
      if (!extentsIntersect(cellBounds, bounds)) return descriptors;
      const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
      const relUrl = mergedChunkDatasetPath(meta.ingestCell, meta.ingestCell, level, meta.naming);
      descriptors.push({
        gridRef: meta.ingestCell,
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
      const node = await this.loadNodeManifest(childRef);
      const encoding = node.levels?.[String(level)];
      if (!encoding) continue;
      const cellBounds = gridRefToBounds(childRef);
      if (!extentsIntersect(cellBounds, bounds)) continue;
      const { width, height } = pixelDimensions(levelEntry.tierMetres, levelEntry.resolutionMetres);
      const relUrl = mergedChunkDatasetPath(meta.ingestCell, childRef, level, meta.naming);
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

  tierMetresForLevel(level: number): number {
    return tierMetresForLevel(this.catalog.meta, level);
  }
}

export function chunkKey(descriptor: Pick<ChunkFetchDescriptor, 'level' | 'eastMin' | 'northMin'>): string {
  return `${descriptor.level}:${descriptor.eastMin}:${descriptor.northMin}`;
}
