import { open, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shardIndexByteLength } from './shardWriter.ts';

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

type LevelMeta = {
  shape: readonly number[];
  chunkShape: readonly number[];
  innerChunkShape: readonly number[] | null;
  attributes: Record<string, number>;
};

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseLevelMeta(raw: Record<string, unknown> | undefined): LevelMeta | undefined {
  if (!raw || raw.node_type !== 'array') return undefined;
  const shape = raw.shape as number[] | undefined;
  const grid = raw.chunk_grid as { configuration?: { chunk_shape?: number[] } } | undefined;
  const chunkShape = grid?.configuration?.chunk_shape;
  if (!shape || !chunkShape) return undefined;
  const codecs = (raw.codecs ?? []) as Array<{
    name?: string;
    configuration?: { chunk_shape?: number[] };
  }>;
  const sharding = codecs.find((codec) => codec.name === 'sharding_indexed');
  const attributes = ((raw.attributes as Record<string, unknown> | undefined)?.psychogeo ??
    {}) as Record<string, number>;
  return {
    shape,
    chunkShape,
    innerChunkShape: sharding?.configuration?.chunk_shape ?? null,
    attributes,
  };
}

/** Every `c/<y>/<x>` object under a level, sorted so the index is reproducible. */
async function listChunkObjects(levelDir: string): Promise<Array<[number, number]>> {
  const found: Array<[number, number]> = [];
  let rows: string[];
  try {
    rows = await readdir(path.join(levelDir, 'c'));
  } catch {
    return found;
  }
  for (const row of rows) {
    // `._name` are AppleDouble sidecars, which macOS writes beside every file
    // on a volume with no native xattrs. They are not chunks.
    if (row.startsWith('._') || !/^\d+$/.test(row)) continue;
    let cols: string[];
    try {
      cols = await readdir(path.join(levelDir, 'c', row));
    } catch {
      continue;
    }
    for (const col of cols) {
      if (col.startsWith('._') || !/^\d+$/.test(col)) continue;
      found.push([Number(row), Number(col)]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return found;
}

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
  const root = await readJson(path.join(storeDir, 'zarr.json'));
  const rootPsychogeo = ((root?.attributes as Record<string, unknown> | undefined)?.psychogeo ??
    {}) as Record<string, unknown>;
  const channelIds = Array.isArray(rootPsychogeo.channels)
    ? (rootPsychogeo.channels as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (channelIds.length === 0) {
    throw new Error(`no psychogeo.channels in ${storeDir}/zarr.json — nothing to index`);
  }

  const channels: StoreIndexChannel[] = [];
  const parts: Uint8Array[] = [];
  let shards = 0;
  let chunks = 0;

  for (const channelId of channelIds) {
    const channelDir = path.join(storeDir, channelId);
    const channelJson = await readJson(path.join(channelDir, 'zarr.json'));
    const channelAttrs = (channelJson?.attributes ?? {}) as Record<string, unknown>;
    const psychogeo = (channelAttrs.psychogeo ?? {}) as Record<string, unknown>;
    const multiscales = channelAttrs.multiscales as
      | Array<{ datasets?: Array<{ path?: string }> }>
      | undefined;
    const paths = (multiscales?.[0]?.datasets ?? [])
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === 'string');

    const levels: StoreIndexLevel[] = [];
    for (const levelPath of paths) {
      const levelDir = path.join(channelDir, levelPath);
      const meta = parseLevelMeta(await readJson(path.join(levelDir, 'zarr.json')));
      if (!meta) continue;
      const chunkPixels = (meta.innerChunkShape ?? meta.chunkShape)[0];
      const shardChunks = meta.innerChunkShape
        ? ([
            meta.chunkShape[0] / meta.innerChunkShape[0],
            meta.chunkShape[1] / meta.innerChunkShape[1],
          ] as [number, number])
        : null;
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
      channelId,
      encoding: (psychogeo.encoding ?? {}) as Record<string, unknown>,
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
