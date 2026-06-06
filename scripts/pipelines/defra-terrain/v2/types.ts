import type { z } from 'zod';
import type {
  encodingScalarsSchema,
  leafEncodingTableSchema,
  namingConventionSchema,
  pyramidLevelSchema,
  pyramidNodeManifestSchema,
  terrainManifestV2Schema,
} from './schema.ts';

export type EncodingScalars = z.infer<typeof encodingScalarsSchema>;
export type PyramidLevel = z.infer<typeof pyramidLevelSchema>;
export type NamingConvention = z.infer<typeof namingConventionSchema>;
export type LeafEncodingTable = z.infer<typeof leafEncodingTableSchema>;
export type TerrainManifestV2 = z.infer<typeof terrainManifestV2Schema>;
export type PyramidNodeManifest = z.infer<typeof pyramidNodeManifestSchema>;

export interface ChunkFetchDescriptor {
  readonly gridRef: string;
  readonly level: number;
  readonly eastMin: number;
  readonly northMin: number;
  readonly url: string;
  readonly encoding: EncodingScalars;
  readonly width: number;
  readonly height: number;
}
