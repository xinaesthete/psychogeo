import type {
  ChannelManifest,
  ChannelStorageStats,
  DatasetStorageStats,
  DsmCatalogItem,
  TerrainManifestV1,
  TileExtent,
  TileIndexShard,
  TileRecord,
} from './types.ts';

export const CHANNELS: ChannelManifest[] = [
  {
    id: 'height.dsm.base',
    role: 'base',
    description: 'Aggressively compressed FZ-derived DSM fallback at 8 m resolution.',
    codec: 'htj2k',
    resolutionMetres: 8,
    tileSizeMetres: 5000,
    apronMetres: 32,
    lossyQuality: 0.25,
    sourceReturnKind: 'FZ',
  },
  {
    id: 'height.dsm.fz',
    role: 'primary',
    description: 'Primary first-return DSM at 1 m resolution.',
    codec: 'htj2k',
    resolutionMetres: 1,
    tileSizeMetres: 1000,
    apronMetres: 0,
    lossyQuality: 0.,
    sourceReturnKind: 'FZ',
  },
  {
    id: 'height.dsm.lz',
    role: 'secondary',
    description: 'Secondary last-return DSM at 1 m resolution.',
    codec: 'htj2k',
    resolutionMetres: 1,
    tileSizeMetres: 1000,
    apronMetres: 0,
    lossyQuality: 0.05,
    sourceReturnKind: 'LZ',
  },
  {
    id: 'height.aux.dz',
    role: 'auxiliary',
    description: 'Low-precision first-return minus last-return height difference.',
    codec: 'htj2k',
    resolutionMetres: 1,
    tileSizeMetres: 1000,
    apronMetres: 0,
    lossyQuality: 0.2,
  },
  {
    id: 'height.dtm',
    role: 'secondary',
    description: 'Optional ground DTM at 1 m resolution when DEFRA DTM source is available.',
    codec: 'htj2k',
    resolutionMetres: 1,
    tileSizeMetres: 1000,
    apronMetres: 0,
    lossyQuality: 0.05,
    sourceReturnKind: 'DTM',
  },
];

export function emptyExtent(): TileExtent {
  return {
    eastMin: Infinity,
    eastMax: -Infinity,
    northMin: Infinity,
    northMax: -Infinity,
  };
}

export function includeExtent(bounds: TileExtent, extent: TileExtent): TileExtent {
  return {
    eastMin: Math.min(bounds.eastMin, extent.eastMin),
    eastMax: Math.max(bounds.eastMax, extent.eastMax),
    northMin: Math.min(bounds.northMin, extent.northMin),
    northMax: Math.max(bounds.northMax, extent.northMax),
  };
}

export function extentIsEmpty(extent: TileExtent): boolean {
  return !Number.isFinite(extent.eastMin) || !Number.isFinite(extent.eastMax);
}

export function makeManifest(
  datasetId: string,
  bounds: TileExtent,
  shards: string[],
  storage: DatasetStorageStats,
  createdAt = new Date().toISOString(),
): TerrainManifestV1 {
  return {
    schemaVersion: 'psychogeo.terrain.v1',
    datasetId,
    createdAt,
    generator: {
      name: 'scripts/pipelines/defra-terrain',
      version: 1,
    },
    crs: {
      horizontal: 'EPSG:27700',
      horizontalUnits: 'metre',
      verticalDatum: 'ODN via OSGM15/OSTN15',
      verticalUnits: 'metre',
    },
    source: {
      provider: 'Environment Agency',
      collection: 'DEFRA LIDAR Composite',
      licence: 'Open Government Licence v3',
    },
    bounds,
    channels: CHANNELS,
    storage,
    index: {
      shardTemplate: 'index/{east}_{north}.json',
      shardSizeMetres: 5000,
      shards,
    },
  };
}

export function summarizeStorage(shards: TileIndexShard[]): DatasetStorageStats {
  const channelBytes = new Map<string, number[]>();
  let tileCount = 0;

  for (const shard of shards) {
    for (const tile of shard.tiles) {
      tileCount += 1;
      for (const channel of Object.values(tile.channels)) {
        const entries = channelBytes.get(channel.channelId) ?? [];
        entries.push(channel.bytes);
        channelBytes.set(channel.channelId, entries);
      }
    }
  }

  const channels: ChannelStorageStats[] = CHANNELS.map((channel) => {
    const bytes = channelBytes.get(channel.id) ?? [];
    const totalBytes = bytes.reduce((sum, value) => sum + value, 0);
    return {
      channelId: channel.id,
      payloadCount: bytes.length,
      totalBytes,
      minBytes: bytes.length > 0 ? Math.min(...bytes) : 0,
      maxBytes: bytes.length > 0 ? Math.max(...bytes) : 0,
      meanBytes: bytes.length > 0 ? totalBytes / bytes.length : 0,
    };
  });

  return {
    tileCount,
    channelPayloadCount: channels.reduce((sum, channel) => sum + channel.payloadCount, 0),
    totalPayloadBytes: channels.reduce((sum, channel) => sum + channel.totalBytes, 0),
    channels,
  };
}

export function makeShard(datasetId: string, shardId: string, tiles: TileRecord[]): TileIndexShard {
  let extent = emptyExtent();
  for (const tile of tiles) extent = includeExtent(extent, tile.extent);
  return {
    schemaVersion: 'psychogeo.terrain.index.v1',
    datasetId,
    shardId,
    extent,
    tiles,
  };
}

export function exportDsmCatalog(shards: TileIndexShard[]): Record<string, DsmCatalogItem> {
  const catalog: Record<string, DsmCatalogItem> = {};
  for (const shard of shards) {
    for (const tile of shard.tiles) {
      const channel = tile.channels['height.dsm.fz'];
      if (!channel) continue;
      const key = `${tile.nominalExtent.eastMin}, ${tile.nominalExtent.northMin}`;
      catalog[key] = {
        min_ele: channel.encoding.min,
        max_ele: channel.encoding.max,
        valid_percent: channel.validPercent,
        xllcorner: tile.nominalExtent.eastMin,
        yllcorner: tile.nominalExtent.northMin,
        nrows: Math.round((tile.nominalExtent.northMax - tile.nominalExtent.northMin) / channel.resolutionMetres),
        ncols: Math.round((tile.nominalExtent.eastMax - tile.nominalExtent.eastMin) / channel.resolutionMetres),
        source_filename: channel.href,
        sources: {
          '1000': channel.href,
        },
      };
    }
  }
  return catalog;
}
