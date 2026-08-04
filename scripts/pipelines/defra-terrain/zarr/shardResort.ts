import { open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { crc32c } from './crc32c.ts';
import { encodeShardIndex, shardIndexByteLength } from './shardWriter.ts';
import { listChunkObjects, readStoreLayout } from './storeLayout.ts';

/**
 * Rewrite existing shards so their inner chunks sit in slot order.
 *
 * `writeShard` now sorts, but the national store was written before it did:
 * chunks landed in the order the renormalise pass produced them, which is
 * source-node order, so spatial neighbours are scattered through each shard.
 * A viewport of nine adjacent chunks is then nine unrelated byte ranges.
 *
 * This does not need a re-run of the pass. The payload is opaque HTJ2K — the
 * bytes of a chunk do not depend on where in the file it sits — so putting a
 * shard in order is a permutation of byte ranges plus a fresh index, at disk
 * speed rather than codec speed.
 *
 * Idempotent: a shard already in order is left untouched, so an interrupted run
 * resumes by simply being run again.
 */

const EMPTY = 0xffffffffffffffffn;

export type ShardEntry = { readonly slot: number; readonly offset: number; readonly length: number };

export type ResortStatus =
  /** Rewritten into slot order. */
  | 'sorted'
  /** Already in slot order and gap-free; not touched. */
  | 'ordered'
  /** No index, or no chunks to move. */
  | 'skipped';

export type ResortShardResult = {
  readonly status: ResortStatus;
  readonly chunks: number;
  readonly payloadBytes: number;
};

/** Decode a shard's trailing index into its present entries, in slot order. */
export function decodeShardIndex(
  index: Uint8Array,
  shardChunks: readonly [number, number],
): ShardEntry[] {
  const slots = shardChunks[0] * shardChunks[1];
  const view = new DataView(index.buffer, index.byteOffset);
  const entries: ShardEntry[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const offset = view.getBigUint64(slot * 16, true);
    const length = view.getBigUint64(slot * 16 + 8, true);
    if (offset === EMPTY) continue;
    entries.push({ slot, offset: Number(offset), length: Number(length) });
  }
  return entries;
}

/**
 * Is the payload already laid out slot by slot, from byte zero, with no gaps?
 *
 * Gap-free matters as much as ordered: a merely-ascending layout still costs a
 * client the dead bytes between chunks when it coalesces a run into one range.
 */
export function isSlotOrdered(entries: readonly ShardEntry[]): boolean {
  let expected = 0;
  for (const entry of entries) {
    if (entry.offset !== expected) return false;
    expected += entry.length;
  }
  return true;
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
    if (bytesRead === 0) throw new Error(`short read at ${offset + read}`);
    read += bytesRead;
  }
  return buffer;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, offset: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      written,
      bytes.length - written,
      offset + written,
    );
    if (bytesWritten === 0) throw new Error(`short write at ${offset + written}`);
    written += bytesWritten;
  }
}

/**
 * Put one shard's chunks in slot order.
 *
 * The rewrite goes to a sibling temp file and is checked before it replaces the
 * original, so a bug in the offset arithmetic costs a failed run rather than a
 * corrupted store. With `verify`, every chunk is read back out of the new file
 * through its new index and compared by checksum against what went in — the
 * strongest available statement that the permutation preserved the data, at the
 * cost of reading the store a second time.
 */
export async function resortShard(
  filePath: string,
  shardChunks: readonly [number, number],
  options: { readonly verify?: boolean } = {},
): Promise<ResortShardResult> {
  const indexBytes = shardIndexByteLength(shardChunks);
  const source = await open(filePath, 'r');
  let entries: ShardEntry[];
  let payloadEnd: number;
  try {
    const { size } = await source.stat();
    if (size < indexBytes) return { status: 'skipped', chunks: 0, payloadBytes: 0 };
    payloadEnd = size - indexBytes;
    entries = decodeShardIndex(await readAt(source, payloadEnd, indexBytes), shardChunks);
    if (entries.length === 0) return { status: 'skipped', chunks: 0, payloadBytes: 0 };
    if (isSlotOrdered(entries)) {
      return {
        status: 'ordered',
        chunks: entries.length,
        payloadBytes: entries.reduce((sum, entry) => sum + entry.length, 0),
      };
    }
    for (const entry of entries) {
      if (entry.offset < 0 || entry.offset + entry.length > payloadEnd) {
        throw new Error(
          `slot ${entry.slot} of ${filePath} runs to ${entry.offset + entry.length}, past the ${payloadEnd}-byte payload`,
        );
      }
    }

    const tempPath = `${filePath}.${process.pid}.resort`;
    const target = await open(tempPath, 'w');
    const placed = new Map<number, { offset: number; length: number }>();
    const checksums = new Map<number, number>();
    let offset = 0;
    try {
      for (const entry of entries) {
        const bytes = await readAt(source, entry.offset, entry.length);
        await writeAll(target, bytes, offset);
        placed.set(entry.slot, { offset, length: entry.length });
        if (options.verify) checksums.set(entry.slot, crc32c(bytes));
        offset += entry.length;
      }
      const index = encodeShardIndex(shardChunks, placed);
      await writeAll(target, index, offset);
      await target.close();
    } catch (error) {
      await target.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw error;
    }

    try {
      await checkRewrite(tempPath, shardChunks, placed, offset, checksums);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
    await rename(tempPath, filePath);
    return { status: 'sorted', chunks: entries.length, payloadBytes: offset };
  } finally {
    await source.close().catch(() => {});
  }
}

/** Read the rewritten shard back as a client would and confirm it says what it should. */
async function checkRewrite(
  tempPath: string,
  shardChunks: readonly [number, number],
  placed: ReadonlyMap<number, { offset: number; length: number }>,
  payloadBytes: number,
  checksums: ReadonlyMap<number, number>,
): Promise<void> {
  const indexBytes = shardIndexByteLength(shardChunks);
  const handle = await open(tempPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size !== payloadBytes + indexBytes) {
      throw new Error(`${tempPath} is ${size} bytes, expected ${payloadBytes + indexBytes}`);
    }
    const written = decodeShardIndex(await readAt(handle, payloadBytes, indexBytes), shardChunks);
    if (written.length !== placed.size) {
      throw new Error(`${tempPath} indexes ${written.length} chunks, expected ${placed.size}`);
    }
    for (const entry of written) {
      const expected = placed.get(entry.slot);
      if (!expected || expected.offset !== entry.offset || expected.length !== entry.length) {
        throw new Error(`${tempPath} slot ${entry.slot} indexed at ${entry.offset}+${entry.length}`);
      }
      const checksum = checksums.get(entry.slot);
      if (checksum === undefined) continue;
      const bytes = await readAt(handle, entry.offset, entry.length);
      if (crc32c(bytes) !== checksum) {
        throw new Error(`${tempPath} slot ${entry.slot} does not match what was written`);
      }
    }
    if (!isSlotOrdered(written)) throw new Error(`${tempPath} is still not in slot order`);
  } finally {
    await handle.close();
  }
}

export type ResortProgressEvent =
  | { readonly kind: 'level'; readonly channelId: string; readonly levelPath: string; readonly shards: number }
  | {
      readonly kind: 'shard';
      readonly done: number;
      readonly total: number;
      readonly sorted: number;
      readonly bytes: number;
    };

export type ResortSummary = {
  readonly levels: ReadonlyArray<{
    readonly channelId: string;
    readonly levelPath: string;
    readonly shards: number;
    readonly sorted: number;
    readonly alreadyOrdered: number;
    readonly bytes: number;
  }>;
  readonly sorted: number;
  readonly alreadyOrdered: number;
  readonly bytes: number;
};

export type ResortOptions = {
  readonly storeDir: string;
  readonly verify?: boolean;
  readonly dryRun?: boolean;
  readonly onProgress?: (event: ResortProgressEvent) => void;
};

/** Walk every sharded level of a store and put each shard in slot order. */
export async function resortStore(options: ResortOptions): Promise<ResortSummary> {
  const layout = await readStoreLayout(options.storeDir);
  const levels: ResortSummary['levels'][number][] = [];
  let sorted = 0;
  let alreadyOrdered = 0;
  let bytes = 0;

  for (const channel of layout) {
    for (const level of channel.levels) {
      if (!level.shardChunks) continue;
      const objects = await listChunkObjects(level.levelDir);
      options.onProgress?.({
        kind: 'level',
        channelId: channel.channelId,
        levelPath: level.levelPath,
        shards: objects.length,
      });

      let levelSorted = 0;
      let levelOrdered = 0;
      let levelBytes = 0;
      let done = 0;
      for (const [y, x] of objects) {
        const file = path.join(level.levelDir, 'c', String(y), String(x));
        const result = options.dryRun
          ? await inspectShard(file, level.shardChunks)
          : await resortShard(file, level.shardChunks, { verify: options.verify });
        if (result.status === 'sorted') levelSorted += 1;
        else if (result.status === 'ordered') levelOrdered += 1;
        levelBytes += result.payloadBytes;
        done += 1;
        options.onProgress?.({ kind: 'shard', done, total: objects.length, sorted: levelSorted, bytes: levelBytes });
      }

      levels.push({
        channelId: channel.channelId,
        levelPath: level.levelPath,
        shards: objects.length,
        sorted: levelSorted,
        alreadyOrdered: levelOrdered,
        bytes: levelBytes,
      });
      sorted += levelSorted;
      alreadyOrdered += levelOrdered;
      bytes += levelBytes;
    }
  }

  return { levels, sorted, alreadyOrdered, bytes };
}

/** What `resortShard` would report, without writing anything. */
async function inspectShard(
  filePath: string,
  shardChunks: readonly [number, number],
): Promise<ResortShardResult> {
  const indexBytes = shardIndexByteLength(shardChunks);
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < indexBytes) return { status: 'skipped', chunks: 0, payloadBytes: 0 };
    const entries = decodeShardIndex(await readAt(handle, size - indexBytes, indexBytes), shardChunks);
    if (entries.length === 0) return { status: 'skipped', chunks: 0, payloadBytes: 0 };
    const payloadBytes = entries.reduce((sum, entry) => sum + entry.length, 0);
    return {
      status: isSlotOrdered(entries) ? 'ordered' : 'sorted',
      chunks: entries.length,
      payloadBytes,
    };
  } finally {
    await handle.close();
  }
}
