import type { DsmCatItem } from './TileLoaderUK';

export type TerrainDatasetChannelId =
  | 'height.dsm.base'
  | 'height.dsm.fz'
  | 'height.dsm.lz'
  | 'height.aux.dz'
  | 'height.dtm';

export interface TerrainDatasetConfig {
  manifestUrl: string;
  channelId: TerrainDatasetChannelId;
}

interface TileExtent {
  eastMin: number;
  eastMax: number;
  northMin: number;
  northMax: number;
}

interface EncodingSpec {
  kind: string;
  min: number;
  max: number;
  offset: number;
  scale: number;
}

interface ChannelTileRecord {
  channelId: string;
  href: string;
  width: number;
  height: number;
  resolutionMetres: number;
  nominalExtent: TileExtent;
  encoding: EncodingSpec;
  validPercent: number;
}

interface TileRecord {
  tileId: string;
  nominalExtent: TileExtent;
  channels: Record<string, ChannelTileRecord>;
}

interface TileIndexShard {
  schemaVersion: string;
  tiles: TileRecord[];
}

interface TerrainManifest {
  schemaVersion: string;
  index: {
    shards: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseExtent(value: unknown): TileExtent | null {
  if (!isRecord(value)) return null;
  const { eastMin, eastMax, northMin, northMax } = value;
  if (!isNumber(eastMin) || !isNumber(eastMax) || !isNumber(northMin) || !isNumber(northMax)) {
    return null;
  }
  return { eastMin, eastMax, northMin, northMax };
}

function parseEncoding(value: unknown): EncodingSpec | null {
  if (!isRecord(value)) return null;
  const { kind, min, max, offset, scale } = value;
  if (!isString(kind) || !isNumber(min) || !isNumber(max) || !isNumber(offset) || !isNumber(scale)) {
    return null;
  }
  return { kind, min, max, offset, scale };
}

function parseChannel(value: unknown): ChannelTileRecord | null {
  if (!isRecord(value)) return null;
  const { channelId, href, width, height, resolutionMetres, nominalExtent, encoding, validPercent } = value;
  const parsedExtent = parseExtent(nominalExtent);
  const parsedEncoding = parseEncoding(encoding);
  if (
    !isString(channelId) ||
    !isString(href) ||
    !isNumber(width) ||
    !isNumber(height) ||
    !isNumber(resolutionMetres) ||
    !isNumber(validPercent) ||
    parsedExtent === null ||
    parsedEncoding === null
  ) {
    return null;
  }
  return {
    channelId,
    href,
    width,
    height,
    resolutionMetres,
    nominalExtent: parsedExtent,
    encoding: parsedEncoding,
    validPercent,
  };
}

function parseTile(value: unknown): TileRecord | null {
  if (!isRecord(value)) return null;
  const { tileId, nominalExtent, channels } = value;
  const parsedExtent = parseExtent(nominalExtent);
  if (!isString(tileId) || parsedExtent === null || !isRecord(channels)) return null;
  const parsedChannels: Record<string, ChannelTileRecord> = {};
  for (const [key, channelValue] of Object.entries(channels)) {
    const parsed = parseChannel(channelValue);
    if (parsed) parsedChannels[key] = parsed;
  }
  return { tileId, nominalExtent: parsedExtent, channels: parsedChannels };
}

function parseManifest(value: unknown): TerrainManifest {
  if (!isRecord(value) || value.schemaVersion !== 'psychogeo.terrain.v1') {
    throw new Error('Terrain dataset manifest is not psychogeo.terrain.v1.');
  }
  const index = value.index;
  if (!isRecord(index) || !Array.isArray(index.shards) || !index.shards.every(isString)) {
    throw new Error('Terrain dataset manifest has no shard list.');
  }
  return {
    schemaVersion: value.schemaVersion,
    index: { shards: index.shards },
  };
}

function parseShard(value: unknown): TileIndexShard {
  if (!isRecord(value) || value.schemaVersion !== 'psychogeo.terrain.index.v1' || !Array.isArray(value.tiles)) {
    throw new Error('Terrain dataset shard is not psychogeo.terrain.index.v1.');
  }
  const tiles = value.tiles.map(parseTile).filter((tile) => tile !== null);
  return { schemaVersion: value.schemaVersion, tiles };
}

function datasetBaseUrl(manifestUrl: string): string {
  const slash = manifestUrl.lastIndexOf('/');
  return slash >= 0 ? manifestUrl.slice(0, slash + 1) : '';
}

function resolveDatasetHref(baseUrl: string, href: string): string {
  if (href.startsWith('/') || href.startsWith('http://') || href.startsWith('https://')) {
    return href;
  }
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    return new URL(href, baseUrl).toString();
  }
  return `${baseUrl}${href}`;
}

function channelHeightMin(channel: ChannelTileRecord): number {
  if (channel.encoding.kind === 'uint16-normalized') return channel.encoding.offset;
  return channel.encoding.min;
}

function channelHeightMax(channel: ChannelTileRecord): number {
  if (channel.encoding.kind === 'uint16-normalized') {
    return channel.encoding.offset + channel.encoding.scale * 65536;
  }
  return channel.encoding.max;
}

function catalogItemFromChannel(baseUrl: string, tile: TileRecord, channel: ChannelTileRecord): DsmCatItem {
  const href = resolveDatasetHref(baseUrl, channel.href);
  return {
    min_ele: channelHeightMin(channel),
    max_ele: channelHeightMax(channel),
    valid_percent: channel.validPercent,
    xllcorner: channel.nominalExtent.eastMin,
    yllcorner: channel.nominalExtent.northMin,
    nrows: Math.round((channel.nominalExtent.northMax - channel.nominalExtent.northMin) / channel.resolutionMetres),
    ncols: Math.round((channel.nominalExtent.eastMax - channel.nominalExtent.eastMin) / channel.resolutionMetres),
    source_filename: href,
    sources: {
      '1000': href,
    },
  };
}

export async function loadTerrainDatasetCatalog(config: TerrainDatasetConfig): Promise<Record<string, DsmCatItem>> {
  const manifestResponse = await fetch(config.manifestUrl);
  if (!manifestResponse.ok) throw new Error(`Failed to fetch terrain manifest ${config.manifestUrl}`);
  const manifest = parseManifest(await manifestResponse.json());
  const baseUrl = datasetBaseUrl(config.manifestUrl);
  const catalog: Record<string, DsmCatItem> = {};

  await Promise.all(
    manifest.index.shards.map(async (shardHref) => {
      const shardUrl = resolveDatasetHref(baseUrl, shardHref);
      const shardResponse = await fetch(shardUrl);
      if (!shardResponse.ok) throw new Error(`Failed to fetch terrain shard ${shardUrl}`);
      const shard = parseShard(await shardResponse.json());
      for (const tile of shard.tiles) {
        const channel = tile.channels[config.channelId];
        if (!channel) continue;
        const key = `${tile.nominalExtent.eastMin}, ${tile.nominalExtent.northMin}`;
        catalog[key] = catalogItemFromChannel(baseUrl, tile, channel);
      }
    }),
  );

  return catalog;
}
