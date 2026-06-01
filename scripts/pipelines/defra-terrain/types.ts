export type DefraReturnKind = 'FZ' | 'LZ' | 'DTM';

export type TerrainChannelId =
  | 'height.dsm.base'
  | 'height.dsm.fz'
  | 'height.dsm.lz'
  | 'height.aux.dz'
  | 'height.dtm';

export interface TileExtent {
  readonly eastMin: number;
  readonly eastMax: number;
  readonly northMin: number;
  readonly northMax: number;
}

export interface SourceProvenance {
  readonly product: string;
  readonly returnKind: DefraReturnKind;
  readonly year: number;
  readonly tileRef: string;
  readonly zipPath: string;
  readonly rasterPath?: string;
  readonly metadataPath?: string;
}

export interface EncodingSpec {
  readonly kind: 'uint16-normalized' | 'int16-delta';
  readonly units: 'metre';
  readonly nodataCode: number;
  readonly min: number;
  readonly max: number;
  readonly offset: number;
  readonly scale: number;
  readonly quantizationStep?: number;
  readonly clampMin?: number;
  readonly clampMax?: number;
}

export interface ChannelManifest {
  readonly id: TerrainChannelId;
  readonly role: 'base' | 'primary' | 'secondary' | 'auxiliary';
  readonly description: string;
  readonly codec: 'htj2k';
  readonly resolutionMetres: number;
  readonly tileSizeMetres: number;
  readonly apronMetres: number;
  readonly lossyQuality: number;
  readonly sourceReturnKind?: DefraReturnKind;
}

export interface ChannelStorageStats {
  readonly channelId: TerrainChannelId;
  readonly payloadCount: number;
  readonly totalBytes: number;
  readonly minBytes: number;
  readonly maxBytes: number;
  readonly meanBytes: number;
}

export interface DatasetStorageStats {
  readonly tileCount: number;
  readonly channelPayloadCount: number;
  readonly totalPayloadBytes: number;
  readonly channels: ChannelStorageStats[];
}

export interface ChannelTileRecord {
  readonly channelId: TerrainChannelId;
  readonly href: string;
  readonly width: number;
  readonly height: number;
  readonly resolutionMetres: number;
  readonly apronMetres: number;
  readonly extent: TileExtent;
  readonly nominalExtent: TileExtent;
  readonly encoding: EncodingSpec;
  readonly bytes: number;
  readonly validPercent: number;
  readonly rmseMetres: number;
  readonly meanAbsMetres: number;
  readonly maxAbsMetres: number;
  readonly sourceReturnKind?: DefraReturnKind;
}

export interface TileRecord {
  readonly tileId: string;
  readonly sourceTileRef: string;
  readonly extent: TileExtent;
  readonly nominalExtent: TileExtent;
  readonly channels: Record<string, ChannelTileRecord>;
  readonly provenance: SourceProvenance[];
}

export interface TileIndexShard {
  readonly schemaVersion: 'psychogeo.terrain.index.v1';
  readonly datasetId: string;
  readonly shardId: string;
  readonly extent: TileExtent;
  readonly tiles: TileRecord[];
}

export interface TerrainManifestV1 {
  readonly schemaVersion: 'psychogeo.terrain.v1';
  readonly datasetId: string;
  readonly createdAt: string;
  readonly generator: {
    readonly name: 'scripts/pipelines/defra-terrain';
    readonly version: 1;
  };
  readonly crs: {
    readonly horizontal: 'EPSG:27700';
    readonly horizontalUnits: 'metre';
    readonly verticalDatum: 'ODN via OSGM15/OSTN15';
    readonly verticalUnits: 'metre';
  };
  readonly source: {
    readonly provider: 'Environment Agency';
    readonly collection: 'DEFRA LIDAR Composite';
    readonly licence: 'Open Government Licence v3';
  };
  readonly bounds: TileExtent;
  readonly channels: ChannelManifest[];
  readonly storage: DatasetStorageStats;
  readonly index: {
    readonly shardTemplate: 'index/{east}_{north}.json';
    readonly shardSizeMetres: number;
    readonly shards: string[];
  };
}

export interface DsmCatalogItem {
  readonly min_ele?: number;
  readonly max_ele?: number;
  readonly valid_percent?: number;
  readonly xllcorner: number;
  readonly yllcorner: number;
  readonly nrows: number;
  readonly ncols: number;
  readonly source_filename: string;
  readonly sources?: Record<string, string>;
}
