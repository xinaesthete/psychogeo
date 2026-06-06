import { describe, expect, it } from 'vitest';
import { defaultNamingConvention, defaultSpatialIndex, indexRootForCell } from './derive.ts';
import { NATIONAL_PYRAMID_LEVELS } from './presets.ts';
import { parseMetadataJson } from './schema.ts';

describe('presets', () => {
  it('accepts a four-level national pyramid configuration without code changes', () => {
    const parsed = parseMetadataJson({
      schemaVersion: 'psychogeo.terrain.v2',
      format: 'tc-dsm-pyramid',
      datasetId: 'terracognita-defra-v2-sp51',
      channelId: 'height.dsm.fz',
      ingestCell: 'SP51',
      crs: {
        horizontal: 'EPSG:27700',
        verticalDatum: 'ODN via OSGM15/OSTN15',
      },
      spatialIndex: defaultSpatialIndex(),
      naming: defaultNamingConvention(),
      tileMatrixSet: { levels: NATIONAL_PYRAMID_LEVELS },
      encoding: {
        codec: 'htj2k',
        sampleType: 'uint16',
        normalisation: 'perChunkScaleOffset',
        nodata: 0,
      },
      indexRoot: indexRootForCell('SP51'),
    });
    expect(parsed.tileMatrixSet.levels).toHaveLength(5);
    expect(parsed.tileMatrixSet.levels[4]?.resolutionMetres).toBe(512);
  });
});
