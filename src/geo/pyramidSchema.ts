import { z } from 'zod';
import { isChildGridRef, tierMetresForGridRef } from './pyramidOsgb';

const terrainChannelIds = [
  'height.dsm.base',
  'height.dsm.fz',
  'height.dsm.lz',
  'height.aux.dz',
  'height.dtm',
] as const;

export const terrainChannelIdSchema = z.enum(terrainChannelIds);

export const encodingScalarsSchema = z.object({
  min: z.number(),
  max: z.number(),
  scale: z.number(),
  offset: z.number(),
});

export const pyramidLevelSchema = z.object({
  level: z.number().int().nonnegative(),
  resolutionMetres: z.number().positive(),
  tierMetres: z.number().positive(),
});

export const skippedGroupSchema = z.object({
  tileRef: z.string().min(2),
  year: z.number().int(),
  reason: z.string().min(1),
});

export const spatialTierSchema = z.object({
  suffix: z.string(),
  cellMetres: z.number().positive(),
});

export const namingConventionSchema = z.object({
  nodeDir: z.string(),
  nodeManifest: z.string(),
  mergedChunk: z.string(),
  leafChunk: z.string(),
  leafChunkId: z.string(),
});

export const tileMatrixSetSchema = z
  .object({
    levels: z.array(pyramidLevelSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const tiers = value.levels;
    for (let i = 0; i < tiers.length; i += 1) {
      if (tiers[i].level !== i) {
        ctx.addIssue({
          code: 'custom',
          message: `levels[${i}].level must be ${i}`,
          path: ['levels', i, 'level'],
        });
      }
      if (i > 0 && tiers[i].resolutionMetres <= tiers[i - 1].resolutionMetres) {
        ctx.addIssue({
          code: 'custom',
          message: `resolutionMetres must strictly increase at index ${i}`,
          path: ['levels', i, 'resolutionMetres'],
        });
      }
      if (i > 0 && tiers[i].tierMetres < tiers[i - 1].tierMetres) {
        ctx.addIssue({
          code: 'custom',
          message: `tierMetres must be non-decreasing at index ${i}`,
          path: ['levels', i, 'tierMetres'],
        });
      }
    }
  });

export const terrainManifestV2Schema = z
  .object({
    schemaVersion: z.literal('psychogeo.terrain.v2'),
    format: z.literal('tc-dsm-pyramid'),
    datasetId: z.string().min(1),
    channelId: terrainChannelIdSchema,
    ingestCell: z.string().min(2),
    crs: z.object({
      horizontal: z.literal('EPSG:27700'),
      verticalDatum: z.string(),
    }),
    spatialIndex: z.object({
      scheme: z.literal('osgb-national-grid'),
      tiers: z.array(spatialTierSchema).min(1),
    }),
    naming: namingConventionSchema,
    tileMatrixSet: tileMatrixSetSchema,
    encoding: z.object({
      codec: z.literal('htj2k'),
      sampleType: z.literal('uint16'),
      normalisation: z.literal('perChunkScaleOffset'),
      nodata: z.number().int(),
    }),
    indexRoot: z.string().min(1),
    regionSummary: z.string().min(1).optional(),
    skippedGroups: z.array(skippedGroupSchema).optional(),
    createdAt: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const allowedTiers = new Set(value.spatialIndex.tiers.map((tier) => tier.cellMetres));
    for (const [index, level] of value.tileMatrixSet.levels.entries()) {
      if (!allowedTiers.has(level.tierMetres)) {
        ctx.addIssue({
          code: 'custom',
          message: `levels[${index}].tierMetres ${level.tierMetres} is not listed in spatialIndex.tiers`,
          path: ['tileMatrixSet', 'levels', index, 'tierMetres'],
        });
      }
    }
  });

export const leafEncodingTableSchema = z
  .object({
    stepMetres: z.number().positive(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    missing: z.array(z.number().int().nonnegative()).optional(),
    enc: z.object({
      min: z.array(z.number()),
      max: z.array(z.number()),
      scale: z.array(z.number()),
      offset: z.array(z.number()),
    }),
  })
  .superRefine((value, ctx) => {
    const slotCount = value.cols * value.rows;
    const arrays = [value.enc.min, value.enc.max, value.enc.scale, value.enc.offset];
    for (const [name, array] of arrays.entries()) {
      if (array.length !== slotCount) {
        ctx.addIssue({
          code: 'custom',
          message: `enc array ${name} length ${array.length} must equal ${slotCount}`,
          path: ['enc'],
        });
      }
    }
    if (value.missing) {
      const seen = new Set<number>();
      for (const index of value.missing) {
        if (index >= slotCount) {
          ctx.addIssue({
            code: 'custom',
            message: `missing index ${index} out of range [0, ${slotCount})`,
            path: ['missing'],
          });
        }
        if (seen.has(index)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate missing index ${index}`,
            path: ['missing'],
          });
        }
        seen.add(index);
      }
    }
  });

export const pyramidNodeManifestSchema = z
  .object({
    gridRef: z.string().min(2),
    coverage: z.enum(['partial', 'complete']).optional(),
    children: z.array(z.string()).optional(),
    levels: z.record(z.string(), encodingScalarsSchema).optional(),
    leaf: leafEncodingTableSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.children) {
      for (const [index, child] of value.children.entries()) {
        if (!isChildGridRef(value.gridRef, child)) {
          ctx.addIssue({
            code: 'custom',
            message: `children[${index}] ${child} is not a descendant of ${value.gridRef}`,
            path: ['children', index],
          });
        }
        if (tierMetresForGridRef(child) >= tierMetresForGridRef(value.gridRef)) {
          ctx.addIssue({
            code: 'custom',
            message: `children[${index}] must be a finer spatial tier than ${value.gridRef}`,
            path: ['children', index],
          });
        }
      }
    }
  });

export function parseMetadataJson(value: unknown) {
  return terrainManifestV2Schema.parse(value);
}

export function parseNodeManifestJson(value: unknown) {
  return pyramidNodeManifestSchema.parse(value);
}

export function safeParseMetadataJson(value: unknown) {
  return terrainManifestV2Schema.safeParse(value);
}

export function safeParseNodeManifestJson(value: unknown) {
  return pyramidNodeManifestSchema.safeParse(value);
}
