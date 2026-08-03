import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { crc32cBytes } from './crc32c.ts';

/** Sentinel for an inner chunk that was never written (ZEP2 §"empty chunks"). */
const EMPTY = 0xffffffffffffffffn;

export type ShardChunk = {
  /** Position within the shard, [y, x]. */
  readonly local: readonly [number, number];
  /**
   * Deferred so a shard's worth of codestreams is never all in memory at
   * once — a 1 m shard is ~100 MB and there are thousands of them.
   */
  readonly load: () => Promise<Uint8Array>;
};

export function chunkFromBytes(
  local: readonly [number, number],
  bytes: Uint8Array,
): ShardChunk {
  return { local, load: async () => bytes };
}

export type ShardStats = {
  readonly chunkCount: number;
  readonly payloadBytes: number;
  readonly indexBytes: number;
};

export function shardIndexByteLength(shardChunks: readonly [number, number]): number {
  return shardChunks[0] * shardChunks[1] * 2 * 8 + 4; // (offset, nbytes) uint64 pairs + crc32c
}

/**
 * Serialise the shard index: a uint64 `(offset, nbytes)` pair per inner chunk
 * in C order over the shard's chunk grid, little-endian, with a trailing
 * crc32c — i.e. the output of the `[bytes(little), crc32c]` index codec
 * pipeline that `buildShardArrayCodecs` declares.
 */
export function encodeShardIndex(
  shardChunks: readonly [number, number],
  entries: ReadonlyMap<number, { offset: number; length: number }>,
): Uint8Array {
  const slots = shardChunks[0] * shardChunks[1];
  const body = new Uint8Array(slots * 16);
  const view = new DataView(body.buffer);
  for (let slot = 0; slot < slots; slot += 1) {
    const entry = entries.get(slot);
    // Explicit endianness rather than BigUint64Array, which would follow the
    // host's byte order.
    view.setBigUint64(slot * 16, entry ? BigInt(entry.offset) : EMPTY, true);
    view.setBigUint64(slot * 16 + 8, entry ? BigInt(entry.length) : EMPTY, true);
  }
  const checksum = crc32cBytes(body);
  const out = new Uint8Array(body.length + checksum.length);
  out.set(body, 0);
  out.set(checksum, body.length);
  return out;
}

/**
 * Write one shard: inner chunk bytes back to back, then the index
 * (`index_location: "end"`).
 *
 * Streamed rather than assembled in memory — a 1 m shard is ~100 MB of
 * codestreams and there are thousands of them. Nothing is decoded or
 * re-encoded; the HTJ2K bytes pass through untouched.
 */
export async function writeShard(
  filePath: string,
  shardChunks: readonly [number, number],
  chunks: readonly ShardChunk[],
): Promise<ShardStats> {
  const slots = shardChunks[0] * shardChunks[1];
  const entries = new Map<number, { offset: number; length: number }>();

  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const handle = await open(tempPath, 'w');
  let offset = 0;
  try {
    for (const chunk of chunks) {
      const slot = chunk.local[0] * shardChunks[1] + chunk.local[1];
      if (slot < 0 || slot >= slots) {
        throw new Error(`chunk ${chunk.local} is outside a ${shardChunks} shard`);
      }
      if (entries.has(slot)) {
        throw new Error(`two chunks claim slot ${chunk.local} of ${filePath}`);
      }
      const bytes = await chunk.load();
      await handle.write(bytes, 0, bytes.length, offset);
      entries.set(slot, { offset, length: bytes.length });
      offset += bytes.length;
    }
    const index = encodeShardIndex(shardChunks, entries);
    await handle.write(index, 0, index.length, offset);
    await handle.close();
    await rename(tempPath, filePath);
    return { chunkCount: entries.size, payloadBytes: offset, indexBytes: index.length };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
