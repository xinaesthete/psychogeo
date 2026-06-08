import { describe, expect, it } from 'vitest';
import { CELL_PYRAMID_LEVELS } from './presets.ts';
import {
  parseMetadataJson,
  parseNodeManifestJson,
  safeParseMetadataJson,
  safeParseNodeManifestJson,
} from './schema.ts';
import { defaultNamingConvention, defaultSpatialIndex, indexRootForCell } from './derive.ts';

function sampleMetadata() {
  return {
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
    tileMatrixSet: { levels: CELL_PYRAMID_LEVELS },
    encoding: {
      codec: 'htj2k',
      sampleType: 'uint16',
      normalisation: 'perChunkScaleOffset',
      nodata: 0,
    },
    indexRoot: indexRootForCell('SP51'),
  };
}

describe('schema', () => {
  it('parses valid metadata', () => {
    const parsed = parseMetadataJson(sampleMetadata());
    expect(parsed.ingestCell).toBe('SP51');
  });

  it('parses skipped group entries', () => {
    const parsed = parseMetadataJson({
      ...sampleMetadata(),
      skippedGroups: [{ tileRef: 'SZ69se', year: 2022, reason: 'no DSM source (found DTM only)' }],
    });
    expect(parsed.skippedGroups).toHaveLength(1);
  });

  it('rejects non-increasing pyramid resolutions', () => {
    const result = safeParseMetadataJson({
      ...sampleMetadata(),
      tileMatrixSet: {
        levels: [
          { level: 0, resolutionMetres: 1, tierMetres: 1000 },
          { level: 1, resolutionMetres: 1, tierMetres: 5000 },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('parses a node manifest with dense leaf encoding', () => {
    const enc = {
      min: Array.from({ length: 25 }, () => 42),
      max: Array.from({ length: 25 }, () => 88),
      scale: Array.from({ length: 25 }, () => 0.001),
      offset: Array.from({ length: 25 }, () => 42),
    };
    const parsed = parseNodeManifestJson({
      gridRef: 'SP51ne',
      leaf: {
        stepMetres: 1000,
        cols: 5,
        rows: 5,
        missing: [7],
        enc,
      },
    });
    expect(parsed.leaf?.missing).toEqual([7]);
  });

  it('rejects invalid child grid references', () => {
    const result = safeParseNodeManifestJson({
      gridRef: 'SP51',
      children: ['SP50ne'],
    });
    expect(result.success).toBe(false);
  });
});
