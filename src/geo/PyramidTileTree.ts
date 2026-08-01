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
  type PyramidCatalogResolver,
} from './pyramidCatalog';
import { finestLeafLevel } from './pyramidDerive';
import type { ChunkFetchDescriptor, EncodingScalars } from './pyramidTypes';
import {
  attachPyramidTileDebugHooks,
  buildTileLabelLines,
  createTileLabelSprite,
  disposeTileLabelSprite,
  inspectBoundsMaterial,
  inspectPickMaterial,
  pickInspectTileKey,
  PRIMARY_HEIGHT_CHANNEL_ID,
  selectedInspectBoundsMaterial,
  tileMatchesQuery,
} from './pyramidInspect';
import { chunkExtent, TileLayerManagerImpl } from './tileLayerManager';
import type { TileLayerManagerDebugStats } from './tileLayerTypes';
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

export type PyramidTileDebugRecord = {
  readonly key: string;
  readonly name: string;
  readonly gridRef: string;
  readonly level: number;
  readonly generation: number;
  readonly eastMin: number;
  readonly northMin: number;
  readonly extentMetres: number;
  readonly payloadUrl: string;
  readonly inFrustum: boolean;
  readonly working: boolean;
  readonly geoLodLevel: number;
  readonly channelStatus: RasterChannelState['status'] | 'missing';
  readonly texture?: {
    readonly width: number;
    readonly height: number;
    readonly sourceUrl?: string;
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
  readonly reconcileGeneration: number;
  readonly inspectionModeEnabled: boolean;
  readonly inspectBoundsVisible: boolean;
  readonly labelsVisible: boolean;
  readonly selectedKey: string | null;
  readonly lastLevel: number | null;
  readonly lastLevelViewportMetres: number;
  readonly lastBounds: ReturnType<typeof groundViewportBounds> | null;
  readonly lastQueryBounds: ReturnType<typeof groundViewportBounds> | null;
  readonly manager: TileLayerManagerDebugStats;
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

function textureDebugInfo(texture: THREE.Texture): { width: number; height: number; sourceUrl?: string } | undefined {
  const image = texture.image;
  if (!image || typeof image !== 'object') return undefined;
  if (!('width' in image) || !('height' in image)) return undefined;
  const width = finiteNumber(image.width);
  const height = finiteNumber(image.height);
  if (width === undefined || height === undefined) return undefined;
  const sourceUrl = texture.userData.sourceUrl;
  return {
    width,
    height,
    sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : undefined,
  };
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
  readonly sceneInspectObject: THREE.Mesh;
  /** Canvas-text sprite; exists only while inspection labels are shown. */
  labelSprite: THREE.Sprite | null = null;
  private selected = false;

  constructor(private readonly descriptor: ChunkFetchDescriptor) {
    super();
    const { eastMin, northMin, extentMetres, encoding } = descriptor;
    this.extent = chunkExtent(eastMin, northMin, extentMetres);
    const heightMin = encodingHeightMin(encoding);
    const heightMax = encodingHeightMax(encoding);
    const eleScale = Math.max(heightMax - heightMin, 1);

    this.userData.generation = 0;
    this.userData.pyramidLevel = descriptor.level;
    this.userData.encoding = encoding;
    this.userData.extentMetres = extentMetres;
    this.userData.payloadUrl = descriptor.url;
    this.userData.heightMin = heightMin;
    this.userData.heightMax = heightMax;

    this.position.set(eastMin + extentMetres / 2, northMin + extentMetres / 2, 0);

    const placeholder = new THREE.Mesh(placeholderGeometry, placeholderMaterial);
    placeholder.scale.set(extentMetres, extentMetres, eleScale);
    placeholder.position.z = heightMin + eleScale / 2;
    this.add(placeholder);
    this.userData.placeholder = placeholder;

    this.sceneInspectObject = placeholder.clone();
    this.sceneInspectObject.material = inspectBoundsMaterial;
    this.sceneInspectObject.visible = false;
    this.add(this.sceneInspectObject);

    attachPyramidTileDebugHooks(this, descriptor);
  }

  setSelected(selected: boolean): void {
    this.selected = selected;
  }

  isSelected(): boolean {
    return this.selected;
  }

  configureInspectPresentation(options: {
    pickable: boolean;
    showWireframe: boolean;
    selected: boolean;
  }): void {
    if (!options.pickable) {
      this.sceneInspectObject.visible = false;
      return;
    }
    this.sceneInspectObject.visible = true;
    if (options.showWireframe) {
      this.sceneInspectObject.material = options.selected
        ? selectedInspectBoundsMaterial
        : inspectBoundsMaterial;
      return;
    }
    this.sceneInspectObject.material = inspectPickMaterial;
  }

  /** Rebuild the label content; no-op unless a label is currently shown. */
  updateLabel(): void {
    if (!this.labelSprite) return;
    this.removeLabelSprite();
    this.addLabelSprite();
  }

  setLabelVisible(visible: boolean): void {
    if (!visible) {
      this.removeLabelSprite();
      return;
    }
    if (!this.labelSprite) {
      this.addLabelSprite();
    }
  }

  private addLabelSprite(): void {
    const sprite = createTileLabelSprite(buildTileLabelLines(this));
    const extentMetres = this.userData.extentMetres as number;
    const labelHeight = (this.userData.heightMax as number) + Math.max(extentMetres * 0.08, 20);
    sprite.position.z = labelHeight;
    sprite.scale.set(extentMetres * 0.55, extentMetres * 0.18, 1);
    this.labelSprite = sprite;
    this.add(sprite);
  }

  private removeLabelSprite(): void {
    if (!this.labelSprite) return;
    disposeTileLabelSprite(this.labelSprite);
    this.remove(this.labelSprite);
    this.labelSprite = null;
  }

  descriptorSnapshot(): ChunkFetchDescriptor {
    return this.descriptor;
  }

  disposeNode(): void {
    const placeholder = this.userData.placeholder as THREE.Object3D | undefined;
    if (placeholder) {
      this.remove(placeholder);
    }
    this.remove(this.sceneInspectObject);
    this.removeLabelSprite();
    this.clear();
  }
}

export type PyramidTileTreeDebugHooks = {
  previewTexture?(texture: THREE.Texture, label: string): void;
};

function desiredChunkSetKey(desired: ChunkFetchDescriptor[]): string {
  return desired
    .map((chunk) => chunkKey(chunk))
    .sort()
    .join('|');
}

export class PyramidTileTree {
  private readonly active = new Map<string, PyramidTileNode>();
  private lastBounds: ReturnType<typeof groundViewportBounds> | null = null;
  private lastQueryBounds: ReturnType<typeof groundViewportBounds> | null = null;
  private lastDesiredKey = '';
  private lastCameraPosition = new THREE.Vector3();
  private lastLevelViewport = 0;
  private reconcileGeneration = 0;
  private reconcileScheduled = false;
  private pendingCamera: THREE.Camera | null = null;
  private inspectBoundsVisible = false;
  private inspectionModeEnabled = false;
  private labelsVisible = false;
  private selectedKey: string | null = null;
  private pointerDom: HTMLElement | null = null;
  private pointerCamera: THREE.Camera | null = null;
  private pointerHandler?: (event: PointerEvent) => void;
  private onPickSelectedKey?: (key: string) => void;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly resolver: PyramidCatalogResolver,
    private readonly manager: TileLayerManagerImpl,
    private readonly debugHooks?: PyramidTileTreeDebugHooks,
  ) {
    this.parent.name = this.parent.name || 'pyramid-tile-root';
  }

  get activeTiles(): ReadonlyMap<string, PyramidTileNode> {
    return this.active;
  }

  get inspectBoundsShown(): boolean {
    return this.inspectBoundsVisible;
  }

  get selectedTileKey(): string | null {
    return this.selectedKey;
  }

  configureInspection(options: {
    enabled: boolean;
    showBounds: boolean;
    showLabels: boolean;
    selectedKey: string | null;
  }): void {
    this.inspectionModeEnabled = options.enabled;
    this.inspectBoundsVisible = options.enabled && options.showBounds;
    this.labelsVisible = options.enabled && options.showLabels;
    if (options.selectedKey !== this.selectedKey) {
      this.setSelectedKey(options.selectedKey);
    } else {
      this.applyInspectionVisuals();
    }
  }

  setSelectedKey(key: string | null): void {
    if (this.selectedKey === key) return;
    const previous = this.selectedKey ? this.active.get(this.selectedKey) : undefined;
    previous?.setSelected(false);
    this.selectedKey = key;
    const next = key ? this.active.get(key) : undefined;
    next?.setSelected(true);
    this.applyInspectionVisuals();
  }

  getInspectPickTargets(): THREE.Object3D[] {
    if (!this.inspectionModeEnabled) return [];
    const targets: THREE.Object3D[] = [];
    for (const node of this.active.values()) {
      if (!node.visibility.inFrustum) continue;
      targets.push(node.sceneInspectObject);
    }
    return targets;
  }

  pickTileKeyAtClient(
    camera: THREE.Camera,
    dom: HTMLElement,
    clientX: number,
    clientY: number,
  ): string | null {
    return pickInspectTileKey({
      camera,
      dom,
      clientX,
      clientY,
      targets: this.getInspectPickTargets(),
    });
  }

  configureInspectionPointer(
    dom: HTMLElement | null,
    camera: THREE.Camera,
    enabled: boolean,
    onPickSelectedKey?: (key: string) => void,
  ): void {
    this.unbindInspectionPointer();
    if (!enabled || !dom) return;
    this.pointerDom = dom;
    this.pointerCamera = camera;
    this.onPickSelectedKey = onPickSelectedKey;
    this.pointerHandler = (event: PointerEvent) => {
      if (!event.shiftKey || !this.pointerCamera) return;
      const key = this.pickTileKeyAtClient(
        this.pointerCamera,
        dom,
        event.clientX,
        event.clientY,
      );
      if (!key) return;
      this.setSelectedKey(key);
      this.onPickSelectedKey?.(key);
    };
    dom.addEventListener('pointerdown', this.pointerHandler);
  }

  private unbindInspectionPointer(): void {
    if (this.pointerDom && this.pointerHandler) {
      this.pointerDom.removeEventListener('pointerdown', this.pointerHandler);
    }
    this.pointerDom = null;
    this.pointerCamera = null;
    this.pointerHandler = undefined;
    this.onPickSelectedKey = undefined;
  }

  onVisibilityUpdated(): void {
    this.refreshLabels();
    this.applyInspectionVisuals();
  }

  refreshLabels(): void {
    for (const node of this.active.values()) {
      node.updateLabel();
    }
  }

  private applyInspectionVisuals(): void {
    for (const [key, node] of this.active.entries()) {
      const showWireframe = this.inspectBoundsVisible;
      node.configureInspectPresentation({
        pickable: this.inspectionModeEnabled,
        showWireframe,
        selected: showWireframe && key === this.selectedKey,
      });
      const showLabel = this.labelsVisible && node.visibility.inFrustum;
      node.setLabelVisible(showLabel);
    }
  }

  setInspectBoundsVisible(visible: boolean): void {
    this.inspectBoundsVisible = visible;
    this.applyInspectionVisuals();
  }

  getNode(key: string): PyramidTileNode | undefined {
    return this.active.get(key);
  }

  findNodes(query: string): PyramidTileNode[] {
    return [...this.active.values()].filter((node) => tileMatchesQuery(node, query));
  }

  refetchNode(key: string, channelId = PRIMARY_HEIGHT_CHANNEL_ID): boolean {
    const node = this.active.get(key);
    if (!node) return false;
    return this.manager.refetchChannel(node, channelId);
  }

  previewNodeTexture(key: string, channelId = PRIMARY_HEIGHT_CHANNEL_ID): boolean {
    const node = this.active.get(key);
    if (!node || !this.debugHooks?.previewTexture) return false;
    const channelState = node.channels.get(channelId);
    const texture = channelState?.payload?.texture;
    if (!texture) return false;
    this.debugHooks.previewTexture(texture, node.name);
    return true;
  }

  clearCatalogCache(): void {
    this.resolver.clearCache();
  }

  forceReconcile(): void {
    this.lastBounds = null;
    this.lastDesiredKey = '';
    if (this.pendingCamera) {
      this.reconcileNow(this.pendingCamera);
    }
  }

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
    this.unbindInspectionPointer();
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
    this.lastQueryBounds = null;
    this.lastDesiredKey = '';
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
        name: node.name,
        gridRef: descriptor.gridRef,
        level: descriptor.level,
        generation: node.userData.generation as number,
        eastMin: descriptor.eastMin,
        northMin: descriptor.northMin,
        extentMetres: descriptor.extentMetres,
        payloadUrl: descriptor.url,
        inFrustum: node.visibility.inFrustum,
        working: node.visibility.working,
        geoLodLevel: node.visibility.lodLevel,
        channelStatus: channelState?.status ?? 'missing',
        texture: channelState?.payload ? textureDebugInfo(channelState.payload.texture) : undefined,
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
      reconcileGeneration: this.reconcileGeneration,
      inspectionModeEnabled: this.inspectionModeEnabled,
      inspectBoundsVisible: this.inspectBoundsVisible,
      labelsVisible: this.labelsVisible,
      selectedKey: this.selectedKey,
      lastLevel: null,
      lastLevelViewportMetres: this.lastLevelViewport,
      lastBounds: this.lastBounds,
      lastQueryBounds: this.lastQueryBounds,
      manager: this.manager.debugStats(),
      levelCounts,
      duplicatePayloadUrls,
      tiles,
    };
  }

  private reconcileNow(camera: THREE.Camera): void {
    const bounds = groundViewportBounds(camera);
    const levelViewportMetres = viewportSpanMetres(bounds);
    const leafStep = gridStepForLevel(0, this.resolver);
    const queryBounds = snapBoundsToGrid(bounds, leafStep);

    const cameraMoved =
      this.lastDesiredKey.length === 0 ||
      camera.position.distanceTo(this.lastCameraPosition) > 50;

    if (
      !boundsChangedSignificantly(this.lastBounds, bounds) &&
      !cameraMoved &&
      this.lastDesiredKey.length > 0
    ) {
      return;
    }

    this.lastCameraPosition.copy(camera.position);
    const generation = ++this.reconcileGeneration;
    void this.reconcileAsync(camera, queryBounds, bounds, levelViewportMetres, generation);
  }

  private async reconcileAsync(
    camera: THREE.Camera,
    queryBounds: ReturnType<typeof groundViewportBounds>,
    bounds: ReturnType<typeof groundViewportBounds>,
    levelViewportMetres: number,
    generation: number,
  ): Promise<void> {
    const desired = await this.resolver.resolveChunksInBoundsAdaptive(queryBounds, camera);
    if (generation !== this.reconcileGeneration) return;

    const desiredKeys = new Set(desired.map((chunk) => chunkKey(chunk)));
    const desiredKey = desiredChunkSetKey(desired);

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
      if (this.selectedKey === key) {
        node.setSelected(true);
      }
      this.active.set(key, node);
      this.parent.add(node);
      this.manager.registerTile(node);
    }

    this.applyInspectionVisuals();
    this.lastBounds = bounds;
    this.lastQueryBounds = queryBounds;
    this.lastDesiredKey = desiredKey;
    this.lastLevelViewport = levelViewportMetres;
    this.refreshLabels();
    this.applyInspectionVisuals();
  }
}

export { viewportMetresFromCameraDistance, PRIMARY_HEIGHT_CHANNEL_ID };
