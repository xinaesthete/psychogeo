import { open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shardIndexByteLength } from './shardWriter.ts';
import { listChunkObjects, readStoreLayout } from './storeLayout.ts';

/**
 * A single consolidated index for a renormalised store.
 *
 * Reading one chunk cold costs a suffix request for its shard's index before
 * the chunk itself, and opening the store costs a request per level before
 * that. Nationally that is 1,641 shard indices and seven `zarr.json` files —
 * all of it small, all of it a round trip. Gathered into one object it is
 * about 1 MiB gzipped, which is one fetch instead of one per shard touched.
 *
 * Deliberately **additive**. Nothing here is required to read the store: the
 * per-node `zarr.json` and the shard indices at the end of each shard remain
 * exactly as they were, so zarrita and any other Zarr reader are unaffected.
 * This is a cache, it is derived entirely from the store, and it can be
 * rebuilt in seconds by `index-zarr` if it is ever stale or deleted.
 *
 * Layout, little-endian throughout:
 *
 * ```
 *   magic     4  "PGZI"
 *   version   4  = 1
 *   headerLen 4  bytes of UTF-8 JSON that follow
 *   header       JSON: channels, level ladder, encoding, record counts
 *   body         per channel, per level, in header order:
 *                  sharded:   shardCount x { y u32, x u32, slots x (offset u32, nbytes u32) }
 *                  unsharded: chunkCount x { y u32, x u32 }
 * ```
 *
 * `nbytes = 0` marks an absent inner chunk, which a real codestream never is.
 * uint32 holds both comfortably: the largest shard here is 97 MiB and the
 * largest chunk 1.3 MB.
 */
export const STORE_INDEX_FILENAME = 'psychogeo-index.bin';
export const STORE_INDEX_MAGIC = 0x497a4750; // "PGZI" little-endian
export const STORE_INDEX_VERSION = 1;

export type StoreIndexLevel = {
  readonly level: number;
  readonly path: string;
  readonly resolutionMetres: number;
  readonly chunkMetres: number;
  readonly chunkPixels: number;
  readonly chunkGrid: readonly [number, number];
  readonly shardChunks: readonly [number, number] | null;
  /** Sharded levels: shard records. Unsharded: present chunk coordinates. */
  readonly recordCount: number;
};

export type StoreIndexChannel = {
  readonly channelId: string;
  readonly encoding: Record<string, unknown>;
  readonly levels: readonly StoreIndexLevel[];
};

export type StoreIndexHeader = {
  readonly psychogeo: { readonly storeIndexVersion: number };
  readonly channels: readonly StoreIndexChannel[];
};

export type BuildStoreIndexSummary = {
  readonly channels: number;
  readonly shards: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly path: string;
};

/** Pull a written shard's own index back off the end of it. */
async function readShardIndex(
  filePath: string,
  shardChunks: readonly [number, number],
): Promise<Array<{ offset: number; nbytes: number }>> {
  const slots = shardChunks[0] * shardChunks[1];
  const indexBytes = shardIndexByteLength(shardChunks);
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = new Uint8Array(indexBytes);
    await handle.read(buffer, 0, indexBytes, size - indexBytes);
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    const entries: Array<{ offset: number; nbytes: number }> = [];
    for (let slot = 0; slot < slots; slot += 1) {
      const offset = view.getBigUint64(slot * 16, true);
      const nbytes = view.getBigUint64(slot * 16 + 8, true);
      entries.push(
        offset === 0xffffffffffffffffn
          ? { offset: 0, nbytes: 0 }
          : { offset: Number(offset), nbytes: Number(nbytes) },
      );
    }
    return entries;
  } finally {
    await handle.close();
  }
}

export function encodeStoreIndex(header: StoreIndexHeader, body: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(12 + headerBytes.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, STORE_INDEX_MAGIC, true);
  view.setUint32(4, STORE_INDEX_VERSION, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  out.set(body, 12 + headerBytes.length);
  return out;
}

/**
 * Build the consolidated index by reading the store, not by remembering what
 * was written. It is a cache of what is actually on disk, so a store that was
 * resumed, partially rebuilt or hand-edited still indexes correctly.
 */
export async function buildStoreIndex(storeDir: string): Promise<BuildStoreIndexSummary> {
  const layout = await readStoreLayout(storeDir);

  const channels: StoreIndexChannel[] = [];
  const parts: Uint8Array[] = [];
  let shards = 0;
  let chunks = 0;

  for (const channel of layout) {
    const levels: StoreIndexLevel[] = [];
    for (const { levelPath, levelDir, meta, chunkPixels, shardChunks } of channel.levels) {
      const objects = await listChunkObjects(levelDir);

      if (shardChunks) {
        const slots = shardChunks[0] * shardChunks[1];
        const record = new Uint8Array(objects.length * (8 + slots * 8));
        const view = new DataView(record.buffer);
        let at = 0;
        for (const [y, x] of objects) {
          view.setUint32(at, y, true);
          view.setUint32(at + 4, x, true);
          at += 8;
          const entries = await readShardIndex(path.join(levelDir, 'c', String(y), String(x)), shardChunks);
          for (const entry of entries) {
            view.setUint32(at, entry.offset, true);
            view.setUint32(at + 4, entry.nbytes, true);
            at += 8;
            if (entry.nbytes > 0) chunks += 1;
          }
        }
        parts.push(record);
        shards += objects.length;
      } else {
        // Unsharded levels have no index to read; what the reader needs is
        // simply which coordinates exist, so it stops probing for the rest.
        const record = new Uint8Array(objects.length * 8);
        const view = new DataView(record.buffer);
        objects.forEach(([y, x], i) => {
          view.setUint32(i * 8, y, true);
          view.setUint32(i * 8 + 4, x, true);
        });
        parts.push(record);
        chunks += objects.length;
      }

      levels.push({
        level: meta.attributes.level ?? Number(levelPath),
        path: levelPath,
        resolutionMetres: meta.attributes.resolutionMetres,
        chunkMetres: meta.attributes.chunkMetres,
        chunkPixels,
        chunkGrid: [
          Math.round(meta.shape[0] / chunkPixels),
          Math.round(meta.shape[1] / chunkPixels),
        ],
        shardChunks,
        recordCount: objects.length,
      });
    }

    channels.push({
      channelId: channel.channelId,
      encoding: (channel.psychogeo.encoding ?? {}) as Record<string, unknown>,
      levels,
    });
  }

  const bodyLength = parts.reduce((total, part) => total + part.length, 0);
  const body = new Uint8Array(bodyLength);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }

  const bytes = encodeStoreIndex(
    { psychogeo: { storeIndexVersion: STORE_INDEX_VERSION }, channels },
    body,
  );
  const target = path.join(storeDir, STORE_INDEX_FILENAME);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, target);

  return { channels: channels.length, shards, chunks, bytes: bytes.length, path: target };
}
