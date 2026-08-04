import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reading a written store back the way a client would: root group, channel
 * groups, then the level ladder each one declares.
 *
 * Everything here is derived from what is on disk rather than from what a pass
 * remembers writing, so a store that was resumed, partly rebuilt or hand-edited
 * still describes itself correctly.
 */

export type LevelMeta = {
  readonly shape: readonly number[];
  readonly chunkShape: readonly number[];
  readonly innerChunkShape: readonly number[] | null;
  readonly attributes: Record<string, number>;
};

export type StoreLevel = {
  readonly levelPath: string;
  readonly levelDir: string;
  readonly meta: LevelMeta;
  readonly chunkPixels: number;
  /** How many inner chunks a shard holds, or null when the level is unsharded. */
  readonly shardChunks: readonly [number, number] | null;
};

export type StoreChannel = {
  readonly channelId: string;
  readonly channelDir: string;
  readonly psychogeo: Record<string, unknown>;
  readonly levels: readonly StoreLevel[];
};

export async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseLevelMeta(raw: Record<string, unknown> | undefined): LevelMeta | undefined {
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

/** Every `c/<y>/<x>` object under a level, sorted so a walk is reproducible. */
export async function listChunkObjects(levelDir: string): Promise<Array<[number, number]>> {
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

/** The store's channels and their levels, in the order the metadata declares. */
export async function readStoreLayout(storeDir: string): Promise<StoreChannel[]> {
  const root = await readJson(path.join(storeDir, 'zarr.json'));
  const rootPsychogeo = ((root?.attributes as Record<string, unknown> | undefined)?.psychogeo ??
    {}) as Record<string, unknown>;
  const channelIds = Array.isArray(rootPsychogeo.channels)
    ? (rootPsychogeo.channels as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  if (channelIds.length === 0) {
    throw new Error(`no psychogeo.channels in ${storeDir}/zarr.json — nothing to read`);
  }

  const channels: StoreChannel[] = [];
  for (const channelId of channelIds) {
    const channelDir = path.join(storeDir, channelId);
    const channelJson = await readJson(path.join(channelDir, 'zarr.json'));
    const attributes = (channelJson?.attributes ?? {}) as Record<string, unknown>;
    const multiscales = attributes.multiscales as
      | Array<{ datasets?: Array<{ path?: string }> }>
      | undefined;
    const paths = (multiscales?.[0]?.datasets ?? [])
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === 'string');

    const levels: StoreLevel[] = [];
    for (const levelPath of paths) {
      const levelDir = path.join(channelDir, levelPath);
      const meta = parseLevelMeta(await readJson(path.join(levelDir, 'zarr.json')));
      if (!meta) continue;
      levels.push({
        levelPath,
        levelDir,
        meta,
        chunkPixels: (meta.innerChunkShape ?? meta.chunkShape)[0],
        shardChunks: meta.innerChunkShape
          ? [
              meta.chunkShape[0] / meta.innerChunkShape[0],
              meta.chunkShape[1] / meta.innerChunkShape[1],
            ]
          : null,
      });
    }

    channels.push({
      channelId,
      channelDir,
      psychogeo: (attributes.psychogeo ?? {}) as Record<string, unknown>,
      levels,
    });
  }
  return channels;
}
