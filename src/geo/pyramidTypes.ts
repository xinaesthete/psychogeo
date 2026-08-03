import type { z } from 'zod';
import type {
  encodingScalarsSchema,
  leafEncodingTableSchema,
  namingConventionSchema,
  pyramidLevelSchema,
  pyramidNodeManifestSchema,
  terrainManifestV2Schema,
} from './pyramidSchema';

export type EncodingScalars = z.infer<typeof encodingScalarsSchema>;
export type PyramidLevel = z.infer<typeof pyramidLevelSchema>;
export type NamingConvention = z.infer<typeof namingConventionSchema>;
export type LeafEncodingTable = z.infer<typeof leafEncodingTableSchema>;
export type TerrainManifestV2 = z.infer<typeof terrainManifestV2Schema>;
export type PyramidNodeManifest = z.infer<typeof pyramidNodeManifestSchema>;

/**
 * What `PyramidTileTree` needs from a dataset, whichever kind it is.
 *
 * The v2 manifest tree and the renormalised zarr store answer the same three
 * questions, so the tree does not need to know which one it is drawing.
 */
export interface PyramidResolver {
  readonly catalogRef: { readonly meta: TerrainManifestV2 };
  clearCache(): void;
  resolveChunksInBoundsAdaptive(
    bounds: { eastMin: number; eastMax: number; northMin: number; northMax: number },
    camera: import('three').Camera,
  ): Promise<ChunkFetchDescriptor[]>;
}

export interface ChunkFetchDescriptor {
  readonly gridRef: string;
  readonly level: number;
  readonly eastMin: number;
  readonly northMin: number;
  readonly url: string;
  readonly encoding: EncodingScalars;
  readonly width: number;
  readonly height: number;
  readonly extentMetres: number;
}
