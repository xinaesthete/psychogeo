import * as THREE from 'three';
import {
  boundsChangedSignificantly,
  groundViewportBounds,
  snapBoundsToGrid,
  viewportMetresFromCameraDistance,
  viewportSpanMetres,
} from './groundViewport';
import {
  chunkKey,
  pickPyramidLevelForViewport,
  type PyramidCatalogResolver,
} from './pyramidCatalog';
import { finestLeafLevel } from './pyramidDerive';
import type { ChunkFetchDescriptor, EncodingScalars } from './pyramidTypes';
import { chunkExtent, TileLayerManagerImpl } from './tileLayerManager';
import type {
  RasterChannelState,
  TileNode,
  TileVisibility,
} from './tileLayerTypes';

const placeholderGeometry = new THREE.BoxGeometry(1, 1, 1);
const placeholderMaterial = new THREE.MeshBasicMaterial({
  transparent: true,
  color: 0x204060,
  opacity: 0.35,
});

const PRIMARY_HEIGHT_CHANNEL_ID = 'height.primary';

export type PyramidTileDebugRecord = {
  readonly key: string;
  readonly level: number;
  readonly eastMin: number;
  readonly northMin: number;
  readonly extentMetres: number;
  readonly payloadUrl: string;
  readonly inFrustum: boolean;
  readonly working: boolean;
  readonly channelStatus: RasterChannelState['status'] | 'missing';
  readonly texture?: {
    readonly width: number;
    readonly height: number;
  };
  readonly encoding: {
    readonly min: number;
    readonly max: number;
    readonly offset: number;
    readonly scale: number;
  };
};

export type PyramidDebugSnapshot = {
  readonly activeTileCount: number;
  readonly lastLevel: number | null;
  readonly lastLevelViewportMetres: number;
  readonly lastBounds: ReturnType<typeof groundViewportBounds> | null;
  readonly levelCounts: Record<string, number>;
  readonly duplicatePayloadUrls: Array<{
    readonly url: string;
    readonly count: number;
    readonly keys: readonly string[];
  }>;
  readonly tiles: readonly PyramidTileDebugRecord[];
};

function encodingHeightMin(encoding: EncodingScalars): number {
  return encoding.offset;
}

function encodingHeightMax(encoding: EncodingScalars): number {
  return encoding.offset + encoding.scale * 65536;
}

function gridStepForLevel(level: number, resolver: PyramidCatalogResolver): number {
  const meta = resolver.catalogRef.meta;
  if (level === 0) {
    return finestLeafLevel(meta.tileMatrixSet.levels).tierMetres;
  }
  const entry = meta.tileMatrixSet.levels.find((l) => l.level === level);
  return entry?.tierMetres ?? 1000;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textureDimensions(texture: THREE.Texture): { width: number; height: number } | undefined {
  const image = texture.image;
  if (!image || typeof image !== 'object') return undefined;
  if (!('width' in image) || !('height' in image)) return undefined;
  const width = finiteNumber(image.width);
  const height = finiteNumber(image.height);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

export class PyramidTileNode extends THREE.Group implements TileNode {
  readonly extent;
  readonly channels = new Map<string, RasterChannelState>();
  visibility: TileVisibility = {
    inFrustum: false,
    screenPixelsApprox: 0,
    lodLevel: 0,
    working: false,
  };

  constructor(private readonly descriptor: ChunkFetchDescriptor) {
    super();
    const { eastMin, northMin, extentMetres, encoding, level, url } = descriptor;
    this.extent = chunkExtent(eastMin, northMin, extentMetres);
    const heightMin = encodingHeightMin(encoding);
    const heightMax = encodingHeightMax(encoding);
    const eleScale = Math.max(heightMax - heightMin, 1);

    this.userData.generation = 0;
    this.userData.pyramidLevel = level;
    this.userData.encoding = encoding;
    this.userData.extentMetres = extentMetres;
    this.userData.payloadUrl = url;
    this.userData.heightMin = heightMin;
    this.userData.heightMax = heightMax;

    this.position.set(eastMin + extentMetres / 2, northMin + extentMetres / 2, 0);

    const placeholder = new THREE.Mesh(placeholderGeometry, placeholderMaterial);
    placeholder.name = `placeholder ${descriptor.gridRef} (${level})`
    placeholder.scale.set(extentMetres, extentMetres, eleScale);
    placeholder.position.z = heightMin + eleScale / 2;
    this.add(placeholder);
    this.userData.placeholder = placeholder;
    this.name = `TileNode ${descriptor.gridRef} (${level})`;
  }

  descriptorSnapshot(): ChunkFetchDescriptor {
    return this.descriptor;
  }

  disposeNode(): void {
    const placeholder = this.userData.placeholder as THREE.Object3D | undefined;
    if (placeholder) {
      this.remove(placeholder);
    }
    this.clear();
  }
}

export class PyramidTileTree {
  private readonly active = new Map<string, PyramidTileNode>();
  private lastBounds: ReturnType<typeof groundViewportBounds> | null = null;
  private lastLevel: number | null = null;
  private lastLevelViewport = 0;
  private reconcileGeneration = 0;
  private reconcileScheduled = false;
  private pendingCamera: THREE.Camera | null = null;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly resolver: PyramidCatalogResolver,
    private readonly manager: TileLayerManagerImpl,
  ) {}

  reconcile(camera: THREE.Camera): void {
    this.pendingCamera = camera;
    if (this.reconcileScheduled) return;
    this.reconcileScheduled = true;
    requestAnimationFrame(() => {
      this.reconcileScheduled = false;
      if (!this.pendingCamera) return;
      this.reconcileNow(this.pendingCamera);
    });
  }

  dispose(): void {
    this.reconcileGeneration += 1;
    this.reconcileScheduled = false;
    this.pendingCamera = null;
    for (const node of this.active.values()) {
      this.manager.unregisterTile(node);
      this.parent.remove(node);
      node.disposeNode();
    }
    this.active.clear();
    this.lastBounds = null;
    this.lastLevel = null;
    this.lastLevelViewport = 0;
  }

  debugSnapshot(maxTiles = 128): PyramidDebugSnapshot {
    const levelCounts: Record<string, number> = {};
    const urlKeys = new Map<string, string[]>();
    const tiles: PyramidTileDebugRecord[] = [];

    for (const [key, node] of this.active.entries()) {
      const descriptor = node.descriptorSnapshot();
      const levelKey = String(descriptor.level);
      levelCounts[levelKey] = (levelCounts[levelKey] ?? 0) + 1;
      const keys = urlKeys.get(descriptor.url) ?? [];
      keys.push(key);
      urlKeys.set(descriptor.url, keys);

      if (tiles.length >= maxTiles) continue;
      const channelState = node.channels.get(PRIMARY_HEIGHT_CHANNEL_ID);
      tiles.push({
        key,
        level: descriptor.level,
        eastMin: descriptor.eastMin,
        northMin: descriptor.northMin,
        extentMetres: descriptor.extentMetres,
        payloadUrl: descriptor.url,
        inFrustum: node.visibility.inFrustum,
        working: node.visibility.working,
        channelStatus: channelState?.status ?? 'missing',
        texture: channelState?.payload ? textureDimensions(channelState.payload.texture) : undefined,
        encoding: {
          min: descriptor.encoding.min,
          max: descriptor.encoding.max,
          offset: descriptor.encoding.offset,
          scale: descriptor.encoding.scale,
        },
      });
    }

    const duplicatePayloadUrls = [...urlKeys.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([url, keys]) => ({ url, count: keys.length, keys }));

    return {
      activeTileCount: this.active.size,
      lastLevel: this.lastLevel,
      lastLevelViewportMetres: this.lastLevelViewport,
      lastBounds: this.lastBounds,
      levelCounts,
      duplicatePayloadUrls,
      tiles,
    };
  }

  private pickStableLevel(levelViewportMetres: number): number {
    return pickPyramidLevelForViewport(
      this.resolver.catalogRef,
      levelViewportMetres,
    );
  }

  private reconcileNow(camera: THREE.Camera): void {
    const bounds = groundViewportBounds(camera);
    const levelViewportMetres = viewportSpanMetres(bounds);
    const level = this.pickStableLevel(levelViewportMetres);
    const levelChanged = level !== this.lastLevel;
    if (
      !levelChanged &&
      !boundsChangedSignificantly(this.lastBounds, bounds) &&
      level === this.lastLevel
    ) {
      this.manager.observeVisibility(camera);
      return;
    }

    const generation = ++this.reconcileGeneration;
    const gridStep = gridStepForLevel(level, this.resolver);
    const queryBounds = snapBoundsToGrid(bounds, gridStep);
    void this.reconcileAsync(camera, queryBounds, level, levelViewportMetres, generation);
  }

  private async reconcileAsync(
    camera: THREE.Camera,
    bounds: ReturnType<typeof groundViewportBounds>,
    level: number,
    levelViewportMetres: number,
    generation: number,
  ): Promise<void> {
    const desired = await this.resolver.resolveChunksInBounds(bounds, level);
    if (generation !== this.reconcileGeneration) return;

    const desiredKeys = new Set(desired.map((chunk) => chunkKey(chunk)));

    for (const [key, node] of [...this.active.entries()]) {
      if (desiredKeys.has(key)) continue;
      node.userData.generation = (node.userData.generation as number) + 1;
      this.manager.unregisterTile(node);
      this.parent.remove(node);
      node.disposeNode();
      this.active.delete(key);
    }

    for (const chunk of desired) {
      const key = chunkKey(chunk);
      if (this.active.has(key)) continue;
      const node = new PyramidTileNode(chunk);
      this.active.set(key, node);
      this.parent.add(node);
      this.manager.registerTile(node);
    }

    this.lastBounds = bounds;
    this.lastLevel = level;
    this.lastLevelViewport = levelViewportMetres;
    this.manager.observeVisibility(camera);
  }
}

export { viewportMetresFromCameraDistance };
