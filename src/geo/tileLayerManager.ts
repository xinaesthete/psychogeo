import * as THREE from 'three';
import { defaultDecodeWorkerCount } from '../openjpegjs/workerPool';
import { GeoLOD } from './GeoLod';
import type {
  ChannelReadyListener,
  ChannelReconciliation,
  RasterChannel,
  RasterChannelState,
  RasterPayload,
  TileLayerManager,
  TileLoadContext,
  TileLayerManagerDebugStats,
  TileNode,
  TileRetentionMode,
  TileVisibility,
} from './tileLayerTypes';
import type { TileExtent } from './pyramidOsgb';

type ManagedTile = {
  tile: TileNode;
  generation: number;
  abortController: AbortController | null;
  inFrustum: boolean;
  retention: TileRetentionMode;
  /** When the tile left the frustum; null while visible, or once unloaded. */
  offscreenSinceMs: number | null;
  channelStates: Map<string, RasterChannelState>;
};

const scratchBox = new THREE.Box3();
const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();
const HORIZONTAL_CULL_PADDING_METRES = 250;
const VERTICAL_CULL_PADDING_METRES = 500;
/** Brief gap after unload before re-queueing so refetch reads visually (mesh gone → loading). */
const REFETCH_RELOAD_DELAY_MS = 200;
/**
 * Grace period before an off-screen tile's payload is released. Dropping it the
 * instant it clears the frustum means a small pan or a rotation throws away a
 * mesh that is about to be needed again, and rebuilding it costs a frame.
 */
const OFFSCREEN_UNLOAD_GRACE_MS = 4000;

function defaultVisibility(): TileVisibility {
  return {
    inFrustum: false,
    observed: false,
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

/**
 * How many times a channel load is attempted before the tile is left in error.
 *
 * A tile that fails once used to stay black for the rest of the session: the
 * LOD descent keeps resolving it, so nothing re-requests it, and the failure
 * never reaches the console. Observed against the national zarr store as four
 * permanent holes in one shard, where every byte range served 206 and all 100
 * of that shard's codestreams decode — so the failure was transient and the
 * absence of a retry was the whole of the bug.
 */
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 150;

export function retryDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Run `load`, retrying a transient failure up to `maxAttempts` times.
 *
 * Split out from the manager because the policy is the part worth pinning, and
 * it is decided entirely by three things — the load, whether the work is still
 * wanted, and how long to wait — none of which need the manager's state
 * machine to express.
 *
 * `isCancelled` is what keeps a retry from resurrecting abandoned work: an
 * aborted, superseded or off-screen load is not a failure to recover from, and
 * rethrows at once.
 */
export async function attemptWithRetries<T>(
  load: () => Promise<T>,
  isCancelled: () => boolean,
  wait: (ms: number) => Promise<void>,
  maxAttempts: number = MAX_LOAD_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (isCancelled() || attempt >= maxAttempts) throw error;
      await wait(retryDelay(attempt));
      if (isCancelled()) throw error;
    }
  }
}

export class TileLayerManagerImpl implements TileLayerManager {
  private readonly channels = new Map<string, RasterChannel>();
  private readonly tiles = new Map<TileNode, ManagedTile>();
  private activeLoads = 0;
  /** A couple above the decode pool so fetches overlap in-progress decodes. */
  private readonly maxConcurrentLoads = defaultDecodeWorkerCount() + 2;
  private readonly loadQueue: Array<{ managed: ManagedTile; channelId: string }> = [];
  private channelReadyListener: ChannelReadyListener | null = null;
  private visibilityRevisionCounter = 0;

  get visibilityRevision(): number {
    return this.visibilityRevisionCounter;
  }

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
    const managed = [...this.tiles.values()];
    return {
      registeredTiles: this.tiles.size,
      inFrustumTiles: managed.filter((m) => m.inFrustum).length,
      retainedTiles: managed.filter((m) => m.retention !== 'active').length,
      pinnedTiles: managed.filter((m) => m.retention === 'pinned').length,
      offscreenHeldTiles: managed.filter((m) => !m.inFrustum && m.offscreenSinceMs !== null)
        .length,
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
      retention: 'active',
      offscreenSinceMs: null,
      channelStates: tile.channels as Map<string, RasterChannelState>,
    });
  }

  /**
   * `retained` tiles are superseded but still drawing as a fallback: they keep
   * what they already have, but never start a fetch, because nothing wants
   * their data any more. `pinned` additionally holds the payload off-screen —
   * used for the coarse overview tiers, which are few, small, and the thing
   * everything else falls back to.
   */
  setTileRetention(tile: TileNode, retention: TileRetentionMode): void {
    const managed = this.tiles.get(tile);
    if (!managed) return;
    managed.retention = retention;
    if (retention === 'pinned') managed.offscreenSinceMs = null;
    if (retention !== 'active') this.cancelQueuedLoads(managed);
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
    const nowMs = performance.now();

    for (const managed of this.tiles.values()) {
      const { tile } = managed;
      tileWorldBox(tile, scratchBox);
      const inFrustum = frustum.intersectsBox(scratchBox);
      const wasVisible = managed.inFrustum;
      const wasObserved = tile.visibility.observed;
      if (inFrustum !== wasVisible || !wasObserved) this.visibilityRevisionCounter += 1;
      managed.inFrustum = inFrustum;
      const lodLevel = currentGeoLodLevel(tile, camera, inFrustum);
      tile.visibility = {
        inFrustum,
        observed: true,
        screenPixelsApprox: 0,
        lodLevel,
        working: managed.abortController !== null,
      };
      syncTileDebugLabel(tile);

      if (inFrustum) {
        managed.offscreenSinceMs = null;
        if (!wasVisible) {
          for (const channelId of this.channels.keys()) {
            this.enqueueLoad(managed, channelId);
          }
        }
        continue;
      }

      if (wasVisible) {
        // Stop fetching what cannot be seen straight away, but hold anything
        // already decoded for a while — see OFFSCREEN_UNLOAD_GRACE_MS.
        this.cancelLoads(managed);
        managed.offscreenSinceMs = nowMs;
      }
      if (
        managed.retention !== 'pinned' &&
        managed.offscreenSinceMs !== null &&
        nowMs - managed.offscreenSinceMs >= OFFSCREEN_UNLOAD_GRACE_MS
      ) {
        for (const channelId of this.channels.keys()) {
          this.unloadChannel(managed, channelId);
        }
        managed.offscreenSinceMs = null;
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
    this.cancelQueuedLoads(managed);
  }

  private cancelQueuedLoads(managed: ManagedTile): void {
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
    // Retained tiles draw whatever they already hold; refetching data nothing
    // has asked for would compete with the tiles that are actually wanted.
    if (managed.retention !== 'active') return;
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

  /**
   * Attempt a channel load, retrying a transient failure.
   *
   * Only genuine failures are retried. A cancelled load — aborted, superseded
   * by a newer generation, or scrolled out of frustum — is not a failure and
   * rethrows immediately, so this cannot keep work alive that the tree has
   * already moved on from.
   */
  private loadWithRetry(
    channel: RasterChannel,
    ctx: TileLoadContext,
    abortController: AbortController,
    managed: ManagedTile,
    generation: number,
  ): Promise<RasterPayload> {
    return attemptWithRetries(
      () => channel.load(ctx),
      () =>
        abortController.signal.aborted ||
        generation !== managed.generation ||
        !managed.inFrustum,
      (ms) => sleep(ms, abortController.signal),
    );
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
      const payload = await this.loadWithRetry(channel, ctx, abortController, managed, generation);
      if (
        abortController.signal.aborted ||
        generation !== managed.generation ||
        !managed.inFrustum ||
        managed.tile.userData.payloadUrl !== payloadUrl
      ) {
        // Loaded but will never be applied — let the channel drop any
        // cache pin or resources tied to the payload.
        channel.unload(payload);
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
      const failure = error instanceof Error ? error : new Error(String(error));
      managed.channelStates.set(channelId, {
        channelId,
        status: 'error',
        generation,
        error: failure,
      });
      syncTileDebugLabel(managed.tile);
      // Say so. A silent error is why this took a store-sized render to notice:
      // the tile just stayed black and nothing anywhere said why.
      console.warn(
        `[tile] ${channelId} failed after ${MAX_LOAD_ATTEMPTS} attempts: ${payloadUrl}`,
        failure,
      );
      // A failed tile is settled, not pending. Without this the retained
      // fallback covering it is never re-evaluated, because only readiness
      // notifies.
      this.channelReadyListener?.(managed.tile, channelId);
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
