import * as THREE from 'three';
import { GeoLOD } from './GeoLod';
import type {
  ChannelReadyListener,
  ChannelReconciliation,
  RasterChannel,
  RasterChannelState,
  TileLayerManager,
  TileLayerManagerDebugStats,
  TileNode,
  TileVisibility,
} from './tileLayerTypes';
import type { TileExtent } from './pyramidOsgb';

type ManagedTile = {
  tile: TileNode;
  generation: number;
  abortController: AbortController | null;
  inFrustum: boolean;
  channelStates: Map<string, RasterChannelState>;
};

const scratchBox = new THREE.Box3();
const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();
const HORIZONTAL_CULL_PADDING_METRES = 250;
const VERTICAL_CULL_PADDING_METRES = 500;
/** Brief gap after unload before re-queueing so refetch reads visually (mesh gone → loading). */
const REFETCH_RELOAD_DELAY_MS = 200;

function defaultVisibility(): TileVisibility {
  return {
    inFrustum: false,
    screenPixelsApprox: 0,
    lodLevel: 0,
    working: false,
  };
}

function syncTileDebugLabel(tile: TileNode): void {
  const sync = tile.userData.syncDebugLabel;
  if (typeof sync === 'function') sync();
}

function clearLoadingIfOwned(
  managed: ManagedTile,
  channelId: string,
  generation: number,
  abortController: AbortController,
): void {
  const current = managed.channelStates.get(channelId);
  if (
    current?.status !== 'loading' ||
    current.generation !== generation ||
    managed.abortController !== abortController
  ) {
    return;
  }
  managed.channelStates.set(channelId, {
    channelId,
    status: 'idle',
    generation: managed.generation,
  });
  syncTileDebugLabel(managed.tile);
}

function currentGeoLodLevel(tile: TileNode, camera: THREE.Camera, inFrustum: boolean): number {
  const geoLod = tile.userData.geoLod;
  if (!(geoLod instanceof GeoLOD) || !inFrustum) return 0;
  return geoLod.getLevelForCamera(camera);
}

function tileWorldBox(tile: TileNode, target: THREE.Box3): THREE.Box3 {
  const { extent } = tile;
  const minZ = (tile.userData.heightMin as number | undefined) ?? 0;
  const maxZ = (tile.userData.heightMax as number | undefined) ?? minZ + 100;
  target.min.set(
    extent.eastMin - HORIZONTAL_CULL_PADDING_METRES,
    extent.northMin - HORIZONTAL_CULL_PADDING_METRES,
    minZ - VERTICAL_CULL_PADDING_METRES,
  );
  target.max.set(
    extent.eastMax + HORIZONTAL_CULL_PADDING_METRES,
    extent.northMax + HORIZONTAL_CULL_PADDING_METRES,
    maxZ + VERTICAL_CULL_PADDING_METRES,
  );
  return target;
}

export class TileLayerManagerImpl implements TileLayerManager {
  private readonly channels = new Map<string, RasterChannel>();
  private readonly tiles = new Map<TileNode, ManagedTile>();
  private activeLoads = 0;
  private readonly maxConcurrentLoads = 3;
  private readonly loadQueue: Array<{ managed: ManagedTile; channelId: string }> = [];
  private channelReadyListener: ChannelReadyListener | null = null;

  setChannelReadyListener(listener: ChannelReadyListener | null): void {
    this.channelReadyListener = listener;
  }

  attachChannel(channel: RasterChannel): void {
    this.channels.set(channel.id, channel);
  }

  detachChannel(channelId: string): void {
    this.channels.delete(channelId);
    for (const managed of this.tiles.values()) {
      this.unloadChannel(managed, channelId);
    }
  }

  updateChannelParams<Params>(channelId: string, params: Params): ChannelReconciliation {
    const channel = this.channels.get(channelId);
    if (channel && 'params' in channel) {
      Object.assign(channel.params as object, params);
    }
    return this.invalidateChannel(channelId);
  }

  invalidateChannel(channelId: string): ChannelReconciliation {
    let cancelled = 0;
    let queued = 0;
    for (const managed of this.tiles.values()) {
      if (this.unloadChannel(managed, channelId)) cancelled += 1;
      if (managed.inFrustum) {
        this.enqueueLoad(managed, channelId);
        queued += 1;
      }
    }
    return {
      channelId,
      visibleTiles: [...this.tiles.values()].filter((m) => m.inFrustum).length,
      cancelled,
      queued,
    };
  }

  refetchChannel(tile: TileNode, channelId: string): boolean {
    const managed = this.tiles.get(tile);
    if (!managed) return false;
    this.cancelLoads(managed);
    this.unloadChannel(managed, channelId);
    const payloadUrl = tile.userData.payloadUrl;
    if (typeof payloadUrl === 'string') {
      this.channels.get(channelId)?.evictCachedPayload?.(payloadUrl);
    }
    syncTileDebugLabel(tile);
    if (managed.inFrustum) {
      setTimeout(() => {
        if (!this.tiles.has(managed.tile)) return;
        this.enqueueLoad(managed, channelId);
      }, REFETCH_RELOAD_DELAY_MS);
    }
    return true;
  }

  debugStats(): TileLayerManagerDebugStats {
    return {
      registeredTiles: this.tiles.size,
      inFrustumTiles: [...this.tiles.values()].filter((m) => m.inFrustum).length,
      activeLoads: this.activeLoads,
      queuedLoads: this.loadQueue.length,
      channelIds: [...this.channels.keys()],
    };
  }

  registerTile(tile: TileNode): void {
    if (this.tiles.has(tile)) return;
    tile.visibility = defaultVisibility();
    this.tiles.set(tile, {
      tile,
      generation: tile.userData.generation as number,
      abortController: null,
      inFrustum: false,
      channelStates: tile.channels as Map<string, RasterChannelState>,
    });
  }

  unregisterTile(tile: TileNode): void {
    const managed = this.tiles.get(tile);
    if (!managed) return;
    managed.generation += 1;
    tile.userData.generation = managed.generation;
    this.cancelLoads(managed);
    for (const channelId of this.channels.keys()) {
      this.unloadChannel(managed, channelId);
    }
    this.tiles.delete(tile);
  }

  // not sure I'm convinced we needed this; could we have hooked into three object render?
  // also currently not convinced of correctness.
  observeVisibility(camera: THREE.Camera): void {
    camera.updateMatrixWorld(true);
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);

    for (const managed of this.tiles.values()) {
      const { tile } = managed;
      tileWorldBox(tile, scratchBox);
      const inFrustum = frustum.intersectsBox(scratchBox);
      const wasVisible = managed.inFrustum;
      managed.inFrustum = inFrustum;
      const lodLevel = currentGeoLodLevel(tile, camera, inFrustum);
      tile.visibility = {
        inFrustum,
        screenPixelsApprox: 0,
        lodLevel,
        working: managed.abortController !== null,
      };
      syncTileDebugLabel(tile);

      if (inFrustum && !wasVisible) {
        for (const channelId of this.channels.keys()) {
          this.enqueueLoad(managed, channelId);
        }
      } else if (!inFrustum && wasVisible) {
        this.cancelLoads(managed);
        for (const channelId of this.channels.keys()) {
          this.unloadChannel(managed, channelId);
        }
      }
    }
  }

  dispose(): void {
    this.loadQueue.length = 0;
    for (const managed of [...this.tiles.values()]) {
      this.unregisterTile(managed.tile);
    }
    this.channels.clear();
  }

  private cancelLoads(managed: ManagedTile): void {
    managed.abortController?.abort();
    managed.abortController = null;
    for (let i = this.loadQueue.length - 1; i >= 0; i -= 1) {
      if (this.loadQueue[i]?.managed === managed) {
        this.loadQueue.splice(i, 1);
      }
    }
  }

  private unloadChannel(managed: ManagedTile, channelId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;
    const state = managed.channelStates.get(channelId);
    if (state?.status === 'loading') {
      this.cancelLoads(managed);
    }
    if (state?.payload) {
      channel.detachFromTile(managed.tile);
      channel.unload(state.payload);
    }
    managed.channelStates.set(channelId, {
      channelId,
      status: 'idle',
      generation: managed.generation,
    });
    return state?.status === 'loading' || state?.status === 'ready';
  }

  private enqueueLoad(managed: ManagedTile, channelId: string): void {
    const existing = managed.channelStates.get(channelId);
    if (existing?.status === 'ready' || existing?.status === 'loading') return;
    if (
      this.loadQueue.some(
        (entry) => entry.managed === managed && entry.channelId === channelId,
      )
    ) {
      return;
    }
    this.loadQueue.push({ managed, channelId });
    this.pumpLoadQueue();
  }

  private pumpLoadQueue(): void {
    while (this.activeLoads < this.maxConcurrentLoads && this.loadQueue.length > 0) {
      const next = this.loadQueue.shift();
      if (!next) break;
      if (!next.managed.inFrustum || !this.tiles.has(next.managed.tile)) continue;
      this.activeLoads += 1;
      void this.loadChannel(next.managed, next.channelId).finally(() => {
        this.activeLoads -= 1;
        this.pumpLoadQueue();
      });
    }
  }

  private async loadChannel(managed: ManagedTile, channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel || !managed.inFrustum) return;
    const existing = managed.channelStates.get(channelId);
    if (existing?.status === 'ready' || existing?.status === 'loading') return;

    this.cancelLoads(managed);
    const abortController = new AbortController();
    managed.abortController = abortController;
    const generation = managed.generation;
    managed.channelStates.set(channelId, {
      channelId,
      status: 'loading',
      generation,
    });
    syncTileDebugLabel(managed.tile);

    const encoding = managed.tile.userData.encoding;
    const payloadUrl = managed.tile.userData.payloadUrl as string;
    const ctx = {
      tile: managed.tile,
      lodLevel: 0,
      pyramidLevel: managed.tile.userData.pyramidLevel as number,
      encoding,
      extentMetres: managed.tile.userData.extentMetres as number,
      payloadUrl,
      signal: abortController.signal,
      generation,
    };

    try {
      const payload = await channel.load(ctx);
      if (
        abortController.signal.aborted ||
        generation !== managed.generation ||
        !managed.inFrustum ||
        managed.tile.userData.payloadUrl !== payloadUrl
      ) {
        clearLoadingIfOwned(managed, channelId, generation, abortController);
        return;
      }
      channel.applyToTile(managed.tile, payload);
      managed.channelStates.set(channelId, {
        channelId,
        status: 'ready',
        generation,
        payload,
      });
      syncTileDebugLabel(managed.tile);
      this.channelReadyListener?.(managed.tile, channelId);
    } catch (error) {
      if (abortController.signal.aborted || generation !== managed.generation) {
        clearLoadingIfOwned(managed, channelId, generation, abortController);
        return;
      }
      managed.channelStates.set(channelId, {
        channelId,
        status: 'error',
        generation,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      syncTileDebugLabel(managed.tile);
    } finally {
      if (managed.abortController === abortController) {
        managed.abortController = null;
      }
    }
  }
}

export function chunkExtent(
  eastMin: number,
  northMin: number,
  extentMetres: number,
): TileExtent {
  return {
    eastMin,
    eastMax: eastMin + extentMetres,
    northMin,
    northMax: northMin + extentMetres,
  };
}
