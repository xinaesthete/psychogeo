import type * as THREE from 'three';

export interface TileExtent {
  readonly eastMin: number;
  readonly eastMax: number;
  readonly northMin: number;
  readonly northMax: number;
}

export interface RasterPayload {
  readonly texture: THREE.Texture;
  readonly extent: TileExtent;
  readonly uvMargin?: number;
  readonly bytes: number;
  dispose(): void;
}

/**
 * `active` — currently wanted, loads freely.
 * `retained` — superseded but still drawing as a fallback; never starts a load.
 * `pinned` — retained, and holds its payload even off-screen.
 */
export type TileRetentionMode = 'active' | 'retained' | 'pinned';

export interface TileVisibility {
  readonly inFrustum: boolean;
  /**
   * False until the tile has been through a frustum test. Distinguishes "known
   * to be off-screen" from "not looked at yet", which matters because loads are
   * only scheduled for on-screen tiles.
   */
  readonly observed: boolean;
  readonly screenPixelsApprox: number;
  readonly lodLevel: number;
  readonly working: boolean;
}

export interface RasterChannelState {
  readonly channelId: string;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly generation: number;
  readonly payload?: RasterPayload;
  readonly error?: Error;
}

export interface TileNode extends THREE.Object3D {
  readonly extent: TileExtent;
  readonly channels: ReadonlyMap<string, RasterChannelState>;
  visibility: TileVisibility;
}

export interface EncodingScalars {
  readonly min: number;
  readonly max: number;
  readonly scale: number;
  readonly offset: number;
}

export interface TileLoadContext {
  readonly tile: TileNode;
  readonly lodLevel: number;
  readonly pyramidLevel: number;
  readonly encoding: EncodingScalars;
  readonly extentMetres: number;
  readonly payloadUrl: string;
  readonly signal: AbortSignal;
  readonly generation: number;
}

export interface RasterChannel<Params = unknown> {
  readonly id: string;
  readonly params: Params;
  load(ctx: TileLoadContext): Promise<RasterPayload>;
  unload(payload: RasterPayload): void;
  applyToTile(tile: TileNode, payload: RasterPayload): void;
  detachFromTile(tile: TileNode): void;
  evictCachedPayload?(payloadUrl: string): void;
}

export interface ChannelReconciliation {
  readonly channelId: string;
  readonly visibleTiles: number;
  readonly cancelled: number;
  readonly queued: number;
}

export type ChannelReadyListener = (tile: TileNode, channelId: string) => void;

export interface TileLayerManager {
  attachChannel(channel: RasterChannel): void;
  detachChannel(channelId: string): void;
  updateChannelParams<Params>(
    channelId: string,
    params: Params,
  ): ChannelReconciliation;
  invalidateChannel(channelId: string): ChannelReconciliation;
  refetchChannel(tile: TileNode, channelId: string): boolean;
  setTileRetention(tile: TileNode, retention: TileRetentionMode): void;
  observeVisibility(camera: THREE.Camera): void;
  /** Bumped whenever frustum membership changes; lets callers skip stale recomputes. */
  readonly visibilityRevision: number;
  setChannelReadyListener(listener: ChannelReadyListener | null): void;
  dispose(): void;
}

export type TileLayerManagerDebugStats = {
  readonly registeredTiles: number;
  readonly inFrustumTiles: number;
  /** Superseded tiles still held as fallbacks. */
  readonly retainedTiles: number;
  /** Retained tiles holding their payload indefinitely (coarse overview tiers). */
  readonly pinnedTiles: number;
  /** Off-screen tiles still inside the unload grace period. */
  readonly offscreenHeldTiles: number;
  readonly activeLoads: number;
  readonly queuedLoads: number;
  readonly channelIds: readonly string[];
};
