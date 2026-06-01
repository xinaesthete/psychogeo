import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChannelTileRecord,
  TerrainChannelId,
  TerrainManifestV1,
  TileIndexShard,
  TileRecord,
} from './types.ts';

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null;
}

function isManifest(value: unknown): value is TerrainManifestV1 {
  return isRecord(value) && value.schemaVersion === 'psychogeo.terrain.v1' && isRecord(value.index);
}

function isShard(value: unknown): value is TileIndexShard {
  return isRecord(value) && value.schemaVersion === 'psychogeo.terrain.index.v1' && Array.isArray(value.tiles);
}

export interface ResolvedTerrainTile {
  readonly manifest: TerrainManifestV1;
  readonly shard: TileIndexShard;
  readonly tile: TileRecord;
  readonly channel: ChannelTileRecord;
  readonly url: string;
}

export async function readTerrainManifest(datasetDir: string): Promise<TerrainManifestV1> {
  const raw = JSON.parse(await readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));
  if (!isManifest(raw)) throw new Error('manifest.json is not a psychogeo terrain v1 manifest.');
  return raw;
}

export async function readTileIndexShard(datasetDir: string, href: string): Promise<TileIndexShard> {
  const raw = JSON.parse(await readFile(path.join(datasetDir, href), 'utf8'));
  if (!isShard(raw)) throw new Error(`${href} is not a psychogeo terrain index v1 shard.`);
  return raw;
}

export async function resolveTerrainTile(
  datasetDir: string,
  east: number,
  north: number,
  channelId: TerrainChannelId,
): Promise<ResolvedTerrainTile | null> {
  const manifest = await readTerrainManifest(datasetDir);
  for (const shardHref of manifest.index.shards) {
    const shard = await readTileIndexShard(datasetDir, shardHref);
    if (
      east < shard.extent.eastMin ||
      east >= shard.extent.eastMax ||
      north < shard.extent.northMin ||
      north >= shard.extent.northMax
    ) {
      continue;
    }
    for (const tile of shard.tiles) {
      if (
        east < tile.nominalExtent.eastMin ||
        east >= tile.nominalExtent.eastMax ||
        north < tile.nominalExtent.northMin ||
        north >= tile.nominalExtent.northMax
      ) {
        continue;
      }
      const channel = tile.channels[channelId];
      if (!channel) return null;
      return {
        manifest,
        shard,
        tile,
        channel,
        url: path.join(datasetDir, channel.href),
      };
    }
  }
  return null;
}
