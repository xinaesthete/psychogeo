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
import { HEIGHT_CODE_MAX } from './heightTextureFormat';
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
import { extentsIntersect } from './pyramidOsgb';
import { chunkExtent, TileLayerManagerImpl } from './tileLayerManager';
import {
  DEFAULT_RETAINED_BUDGET_BYTES,
  COVERAGE_MASK_RESOLUTION,
  FALLBACK_POLYGON_OFFSET_FACTOR,
  FALLBACK_POLYGON_OFFSET_UNITS,
  isPinnedTier,
  rasteriseCoverageMask,
  retainedShouldDrop,
  retainedStillNeeded,
  selectRetainedEvictions,
  type CoverageEntry,
  type RetainedEntry,
} from './tileRetention';
import type { CoverageMaskUniforms } from './pyramidHeightChannel';
import type { TileLayerManagerDebugStats } from './tileLayerTypes';
import type {
  RasterChannelState,
  TileNode,
  TileVisibility,
} from './tileLayerTypes';

const tileBoundsGeometry = new THREE.BoxGeometry(1, 1, 1);

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

export type PyramidRetainedStats = {
  readonly count: number;
  readonly visibleCount: number;
  readonly pinnedCount: number;
  readonly bytes: number;
  readonly budgetBytes: number;
};

export type PyramidDebugSnapshot = {
  readonly activeTileCount: number;
  readonly retained: PyramidRetainedStats;
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

/** See pyramidCatalog: codes run to HEIGHT_CODE_MAX, and both formats normalise by it. */
function encodingHeightMax(encoding: EncodingScalars): number {
  return encoding.offset + encoding.scale * HEIGHT_CODE_MAX;
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
    observed: false,
    screenPixelsApprox: 0,
    lodLevel: 0,
    working: false,
  };
  readonly sceneInspectObject: THREE.Mesh;
  /** Canvas-text sprite; exists only while inspection labels are shown. */
  labelSprite: THREE.Sprite | null = null;
  /** Coarse overview tiers are held resident rather than evicted. */
  readonly pinnedTier: boolean;
  /** Retain-pool ordering; 0 while the tile is still desired. */
  retiredTick = 0;
  private maskTexture: THREE.DataTexture | null = null;
  private selected = false;

  constructor(private readonly descriptor: ChunkFetchDescriptor) {
    super();
    const { eastMin, northMin, extentMetres, encoding } = descriptor;
    this.extent = chunkExtent(eastMin, northMin, extentMetres);
    this.pinnedTier = isPinnedTier(extentMetres);
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

    // No stand-in geometry while loading: a translucent slab popping in and out
    // reads far worse than the older, coarser terrain the tree now keeps drawing
    // underneath. See PyramidTileTree's retained pool.
    this.sceneInspectObject = new THREE.Mesh(tileBoundsGeometry, inspectBoundsMaterial);
    this.sceneInspectObject.scale.set(extentMetres, extentMetres, eleScale);
    this.sceneInspectObject.position.z = heightMin + eleScale / 2;
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

  /** True once real terrain geometry exists — the precondition for retaining it. */
  hasTerrain(): boolean {
    return this.userData.geoLod instanceof THREE.Object3D;
  }

  /** Decoded bytes this tile is holding, for the retain-pool budget. */
  residentBytes(): number {
    return this.channels.get(PRIMARY_HEIGHT_CHANNEL_ID)?.payload?.bytes ?? 0;
  }

  /**
   * Publish which parts of this tile are already covered by ready terrain.
   * Passing null clears the mask, so the whole tile draws again.
   */
  setCoverageMask(mask: Uint8Array | null): void {
    const uniforms = (this.userData.geoLod as THREE.Object3D | undefined)?.userData
      .coverageMaskUniforms as CoverageMaskUniforms | undefined;
    if (!uniforms) return;

    if (!mask) {
      uniforms.coverageMaskEnabled.value = 0;
      return;
    }
    if (!this.maskTexture) {
      this.maskTexture = new THREE.DataTexture(
        new Uint8Array(mask.length),
        COVERAGE_MASK_RESOLUTION,
        COVERAGE_MASK_RESOLUTION,
        THREE.RedFormat,
        THREE.UnsignedByteType,
      );
      // Nearest: cell edges line up with cover edges, and interpolating across
      // them would fade the fallback out over ground nothing else is drawing.
      this.maskTexture.magFilter = THREE.NearestFilter;
      this.maskTexture.minFilter = THREE.NearestFilter;
    }
    (this.maskTexture.image.data as Uint8Array).set(mask);
    this.maskTexture.needsUpdate = true;
    // Rebind every time, not just on creation. A tile that goes off screen long
    // enough to be unloaded gets a fresh mesh on reload, with fresh uniforms
    // pointing at the empty placeholder — binding only on creation would leave
    // the mask switched on but reading 1x1 zeroes, so nothing was discarded and
    // the tile drew in full while reporting itself masked.
    uniforms.coverageMask.value = this.maskTexture;
    uniforms.coverageMaskEnabled.value = 1;
  }

  /**
   * Bias this tile's surface behind (or back level with) its replacements.
   * Shadow materials are left alone: a fallback that is about to be covered
   * should not also be moving the shadows around.
   */
  setFallbackDepthBias(biased: boolean): void {
    const mesh = this.userData.geoLod as THREE.Object3D | undefined;
    if (!mesh) return;
    mesh.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        // Render state, not program state — no recompile needed.
        material.polygonOffset = biased;
        material.polygonOffsetFactor = biased ? FALLBACK_POLYGON_OFFSET_FACTOR : 0;
        material.polygonOffsetUnits = biased ? FALLBACK_POLYGON_OFFSET_UNITS : 0;
      }
    });
  }

  disposeNode(): void {
    this.maskTexture?.dispose();
    this.maskTexture = null;
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
  /**
   * Superseded tiles that still hold terrain. They keep drawing until whatever
   * replaces them is ready, so changing zoom level no longer punches a hole in
   * the scene while the new chunks are in flight.
   */
  private readonly retained = new Map<string, PyramidTileNode>();
  private retainBudgetBytes = DEFAULT_RETAINED_BUDGET_BYTES;
  private retireCounter = 0;
  private lastVisibilityRevision = -1;
  private readonly maskScratch = new Uint8Array(
    COVERAGE_MASK_RESOLUTION * COVERAGE_MASK_RESOLUTION,
  );
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
    // A tile becoming ready is what retires the fallback drawing underneath it.
    this.manager.setChannelReadyListener(() => this.updateFallbackVisibility());
  }

  get activeTiles(): ReadonlyMap<string, PyramidTileNode> {
    return this.active;
  }

  get retainedTiles(): ReadonlyMap<string, PyramidTileNode> {
    return this.retained;
  }

  setRetainedBudgetBytes(bytes: number): void {
    this.retainBudgetBytes = Math.max(0, bytes);
    this.enforceRetainedBudget();
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
    // Frustum membership decides which tiles a fallback is still waiting on, so
    // recompute when it moves — but only then, since this walks retained tiles
    // against active ones and runs off the render loop.
    const revision = this.manager.visibilityRevision;
    if (revision !== this.lastVisibilityRevision) {
      this.lastVisibilityRevision = revision;
      this.updateFallbackVisibility();
    }
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
    // Retained fallbacks are not part of the current desired set, so they are
    // never pick targets and never labelled — they would only clutter and
    // shadow the tiles that are actually being reasoned about.
    for (const node of this.retained.values()) {
      node.configureInspectPresentation({
        pickable: false,
        showWireframe: false,
        selected: false,
      });
      node.setLabelVisible(false);
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
    this.manager.setChannelReadyListener(null);
    this.reconcileGeneration += 1;
    this.reconcileScheduled = false;
    this.pendingCamera = null;
    for (const node of [...this.active.values(), ...this.retained.values()]) {
      this.manager.unregisterTile(node);
      this.parent.remove(node);
      node.disposeNode();
    }
    this.active.clear();
    this.retained.clear();
    this.retireCounter = 0;
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

    let retainedBytes = 0;
    let retainedVisible = 0;
    let retainedPinned = 0;
    for (const node of this.retained.values()) {
      retainedBytes += node.residentBytes();
      if (node.visible) retainedVisible += 1;
      if (node.pinnedTier) retainedPinned += 1;
    }

    return {
      activeTileCount: this.active.size,
      retained: {
        count: this.retained.size,
        visibleCount: retainedVisible,
        pinnedCount: retainedPinned,
        bytes: retainedBytes,
        budgetBytes: this.retainBudgetBytes,
      },
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
      this.active.delete(key);
      // Terrain already on screen is the best fallback there is; keep it until
      // its replacement can take over. Tiles that never loaded have nothing to
      // contribute and go now.
      if (node.hasTerrain()) {
        node.retiredTick = ++this.retireCounter;
        node.setFallbackDepthBias(true);
        this.retained.set(key, node);
        this.manager.setTileRetention(node, node.pinnedTier ? 'pinned' : 'retained');
      } else {
        this.destroyNode(node);
      }
    }

    for (const chunk of desired) {
      const key = chunkKey(chunk);
      if (this.active.has(key)) continue;
      const revived = this.retained.get(key);
      if (revived) {
        this.retained.delete(key);
        if (revived.hasTerrain()) {
          // Straight back out of the pool with its texture and mesh intact —
          // this is what makes zoom out/in and pan-and-return free.
          revived.retiredTick = 0;
          revived.visible = true;
          revived.setFallbackDepthBias(false);
          revived.setCoverageMask(null);
          this.manager.setTileRetention(revived, 'active');
          this.active.set(key, revived);
          continue;
        }
        // Payload was released while it sat off-screen; start over rather than
        // adopt a husk that would never be scheduled for a load.
        this.destroyNode(revived);
      }
      const node = new PyramidTileNode(chunk);
      if (this.selectedKey === key) {
        node.setSelected(true);
      }
      this.active.set(key, node);
      this.parent.add(node);
      this.manager.registerTile(node);
    }

    this.lastBounds = bounds;
    this.lastQueryBounds = queryBounds;
    this.lastDesiredKey = desiredKey;
    this.lastLevelViewport = levelViewportMetres;
    this.updateFallbackVisibility();
    this.refreshLabels();
    this.applyInspectionVisuals();
  }

  /**
   * Decide which retained tiles are still earning their place, and mask every
   * tile down to the ground nothing better is drawing. Called on every
   * reconcile and whenever a channel becomes ready.
   */
  private updateFallbackVisibility(): void {
    const covers: CoverageEntry[] = [];
    const activeNodes: PyramidTileNode[] = [];
    for (const node of this.active.values()) {
      const status = node.channels.get(PRIMARY_HEIGHT_CHANNEL_ID)?.status;
      activeNodes.push(node);
      covers.push({
        extent: node.extent,
        ready: status === 'ready',
        settled: status === 'ready' || status === 'error',
        awaited: node.visibility.inFrustum || !node.visibility.observed,
      });
    }

    const queryBounds = this.lastQueryBounds;
    for (const [key, node] of [...this.retained.entries()]) {
      // A fallback that lost its payload has nothing left to fall back to, and
      // one outside the query bounds can never be uncovered by a loading tile.
      const spent =
        !node.hasTerrain() ||
        (queryBounds !== null && retainedShouldDrop(this.retainedEntry(key, node), queryBounds));
      if (spent) {
        this.retained.delete(key);
        this.destroyNode(node);
        continue;
      }
      node.visible = retainedStillNeeded(node.extent, covers);
    }

    this.maskDrawnTiles();
    this.enforceRetainedBudget();
  }

  /**
   * Mask every drawn tile down to the ground no finer tile has.
   *
   * Two things make surfaces overlap. The desired set is not a partition: a far
   * cell resolves to its whole 100 km square chunk, and that square spans near
   * cells that resolved to 1 km leaves — dedupeOverlappingChunks only drops a
   * coarse chunk a finer one covers *entirely*, which a leaf never does. And
   * rapid zooming leaves several generations of retained fallback on screen at
   * once, overlapping each other as well as the active set.
   *
   * So this works over everything currently drawing, from both pools, on one
   * rule: finer wins. Tiles at the same level tile the plane without overlap,
   * so only strictly finer tiles mask. Considering only active tiles as covers
   * was the hole — a retained tile is just as much on screen as an active one.
   */
  private maskDrawnTiles(): void {
    const drawn: Array<{ node: PyramidTileNode; level: number; entry: CoverageEntry }> = [];
    const collect = (node: PyramidTileNode) => {
      if (!node.visible || !node.hasTerrain()) return;
      if (node.channels.get(PRIMARY_HEIGHT_CHANNEL_ID)?.status !== 'ready') return;
      drawn.push({
        node,
        level: node.userData.pyramidLevel as number,
        entry: { extent: node.extent, ready: true, settled: true, awaited: true },
      });
    };
    for (const node of this.active.values()) collect(node);
    for (const node of this.retained.values()) collect(node);
    // Ascending by level puts every possible cover for tile i before it, so the
    // inner scan is a prefix that stops as soon as levels match.
    drawn.sort((a, b) => a.level - b.level);

    const finer: CoverageEntry[] = [];
    for (let i = 0; i < drawn.length; i += 1) {
      const target = drawn[i];
      finer.length = 0;
      for (let j = 0; j < i; j += 1) {
        if (drawn[j].level >= target.level) break;
        if (!extentsIntersect(drawn[j].entry.extent, target.entry.extent)) continue;
        finer.push(drawn[j].entry);
      }
      if (finer.length === 0) {
        target.node.setCoverageMask(null);
        continue;
      }
      target.node.setCoverageMask(
        rasteriseCoverageMask(target.entry.extent, finer, this.maskScratch)
          ? this.maskScratch
          : null,
      );
    }
  }

  private retainedEntry(key: string, node: PyramidTileNode): RetainedEntry {
    return {
      key,
      extent: node.extent,
      bytes: node.residentBytes(),
      pinned: node.pinnedTier,
      retiredTick: node.retiredTick,
    };
  }

  private enforceRetainedBudget(): void {
    if (this.retained.size === 0) return;
    const entries = [...this.retained.entries()].map(([key, node]) =>
      this.retainedEntry(key, node),
    );
    for (const key of selectRetainedEvictions(entries, this.retainBudgetBytes)) {
      const node = this.retained.get(key);
      if (!node) continue;
      this.retained.delete(key);
      this.destroyNode(node);
    }
  }

  private destroyNode(node: PyramidTileNode): void {
    node.userData.generation = (node.userData.generation as number) + 1;
    this.manager.unregisterTile(node);
    this.parent.remove(node);
    node.disposeNode();
  }
}

export { viewportMetresFromCameraDistance, PRIMARY_HEIGHT_CHANNEL_ID };
