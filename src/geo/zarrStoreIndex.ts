/**
 * Reader for the consolidated store index written by `index-zarr`.
 *
 * See scripts/pipelines/defra-terrain/zarr/storeIndex.ts for the writer and
 * the layout. The point of it is round trips: without it, opening a store
 * costs a request per level and reading a chunk costs a suffix request for its
 * shard's index first. With it, one fetch answers both for the whole store —
 * about 1 MiB gzipped nationally, against 1,641 shard indices.
 *
 * Strictly an optimisation. Every failure path here returns undefined and the
 * resolver falls back to reading `zarr.json` and shard indices directly, which
 * is also what happens for a store that was never indexed.
 */

const MAGIC = 0x497a4750; // "PGZI" little-endian
const SUPPORTED_VERSION = 1;

export type StoreIndexLevelInfo = {
  readonly level: number;
  readonly path: string;
  readonly resolutionMetres: number;
  readonly chunkMetres: number;
  readonly chunkPixels: number;
  readonly chunkGrid: readonly [number, number];
  readonly shardChunks: readonly [number, number] | null;
};

export type ShardSlot = { readonly offset: number; readonly length: number };

export type StoreIndexChannelInfo = {
  readonly channelId: string;
  readonly encoding: Record<string, unknown>;
  readonly levels: readonly StoreIndexLevelInfo[];
  /** Slot table for a sharded level, or undefined if that shard has no data. */
  shardSlots(level: number, shardY: number, shardX: number): readonly (ShardSlot | null)[] | undefined;
  /** Whether an unsharded level has this chunk, which saves a HEAD probe each. */
  hasChunk(level: number, y: number, x: number): boolean;
};

export type StoreIndex = {
  readonly channels: readonly string[];
  channel(channelId?: string): StoreIndexChannelInfo | undefined;
};

type RawLevel = StoreIndexLevelInfo & { readonly recordCount: number };

function key(y: number, x: number): string {
  return `${y},${x}`;
}

export function parseStoreIndex(bytes: Uint8Array): StoreIndex | undefined {
  if (bytes.byteLength < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return undefined;
  if (view.getUint32(4, true) !== SUPPORTED_VERSION) return undefined;
  const headerLength = view.getUint32(8, true);
  if (12 + headerLength > bytes.byteLength) return undefined;

  let header: { channels?: Array<{ channelId?: string; encoding?: Record<string, unknown>; levels?: RawLevel[] }> };
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
  } catch {
    return undefined;
  }
  if (!Array.isArray(header.channels) || header.channels.length === 0) return undefined;

  let at = 12 + headerLength;
  const parsed = new Map<string, StoreIndexChannelInfo>();
  const order: string[] = [];

  for (const rawChannel of header.channels) {
    const channelId = rawChannel.channelId;
    const rawLevels = rawChannel.levels;
    if (typeof channelId !== 'string' || !Array.isArray(rawLevels)) return undefined;

    const shards = new Map<number, Map<string, readonly (ShardSlot | null)[]>>();
    const present = new Map<number, Set<string>>();
    const levels: StoreIndexLevelInfo[] = [];

    for (const level of rawLevels) {
      // Body order follows header order exactly, so a length that does not add
      // up means the two disagree and nothing after this point can be trusted.
      if (level.shardChunks) {
        const slots = level.shardChunks[0] * level.shardChunks[1];
        const need = level.recordCount * (8 + slots * 8);
        if (at + need > bytes.byteLength) return undefined;
        const table = new Map<string, readonly (ShardSlot | null)[]>();
        for (let i = 0; i < level.recordCount; i += 1) {
          const y = view.getUint32(at, true);
          const x = view.getUint32(at + 4, true);
          at += 8;
          const entries: Array<ShardSlot | null> = new Array(slots);
          for (let slot = 0; slot < slots; slot += 1) {
            const offset = view.getUint32(at, true);
            const length = view.getUint32(at + 4, true);
            at += 8;
            entries[slot] = length > 0 ? { offset, length } : null;
          }
          table.set(key(y, x), entries);
        }
        shards.set(level.level, table);
      } else {
        const need = level.recordCount * 8;
        if (at + need > bytes.byteLength) return undefined;
        const coords = new Set<string>();
        for (let i = 0; i < level.recordCount; i += 1) {
          coords.add(key(view.getUint32(at, true), view.getUint32(at + 4, true)));
          at += 8;
        }
        present.set(level.level, coords);
      }
      levels.push({
        level: level.level,
        path: level.path,
        resolutionMetres: level.resolutionMetres,
        chunkMetres: level.chunkMetres,
        chunkPixels: level.chunkPixels,
        chunkGrid: level.chunkGrid,
        shardChunks: level.shardChunks,
      });
    }

    order.push(channelId);
    parsed.set(channelId, {
      channelId,
      encoding: rawChannel.encoding ?? {},
      levels,
      shardSlots: (level, shardY, shardX) => shards.get(level)?.get(key(shardY, shardX)),
      hasChunk: (level, y, x) => present.get(level)?.has(key(y, x)) ?? false,
    });
  }

  return {
    channels: order,
    channel: (channelId) => parsed.get(channelId ?? order[0]),
  };
}
