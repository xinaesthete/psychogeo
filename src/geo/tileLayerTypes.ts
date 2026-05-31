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

export interface TileVisibility {
  readonly inFrustum: boolean;
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
  readonly visibility: TileVisibility;
}

export interface TileLoadContext {
  readonly tile: TileNode;
  readonly lodLevel: number;
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
}

export interface ChannelReconciliation {
  readonly channelId: string;
  readonly visibleTiles: number;
  readonly cancelled: number;
  readonly queued: number;
}

export interface TileLayerManager {
  attachChannel(channel: RasterChannel): void;
  detachChannel(channelId: string): void;
  updateChannelParams<Params>(
    channelId: string,
    params: Params,
  ): ChannelReconciliation;
  invalidateChannel(channelId: string): ChannelReconciliation;
  observeVisibility(camera: THREE.Camera): void;
  dispose(): void;
}
