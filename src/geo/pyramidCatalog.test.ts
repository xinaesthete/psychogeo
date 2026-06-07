import { describe, expect, it } from 'vitest';
import {
  defaultNamingConvention,
  defaultSpatialIndex,
  indexRootForCell,
  leafChunkDatasetPath,
} from './pyramidDerive';
import { parseMetadataJson, parseNodeManifestJson } from './pyramidSchema';
import {
  chunkKey,
  loadPyramidDataset,
  pickPyramidLevelForViewport,
  PyramidCatalogResolver,
  resolveDatasetHref,
} from './pyramidCatalog';

const CELL_PYRAMID_LEVELS = [
  { level: 0, resolutionMetres: 1, tierMetres: 1000 },
  { level: 1, resolutionMetres: 8, tierMetres: 5000 },
  { level: 2, resolutionMetres: 32, tierMetres: 10000 },
];

function mockFetch(handlers: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const payload = handlers[url];
    if (payload === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function buildFixtureHandlers(baseUrl: string): Record<string, unknown> {
  const meta = {
    schemaVersion: 'psychogeo.terrain.v2',
    format: 'tc-dsm-pyramid',
    datasetId: 'test-sp51',
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
  const rootManifest = {
    gridRef: 'SP51',
    children: ['SP51ne'],
    coverage: 'partial',
  };
  const leafManifest = {
    gridRef: 'SP51ne',
    leaf: {
      stepMetres: 1000,
      cols: 5,
      rows: 5,
      missing: Array.from({ length: 24 }, (_, index) => index + 1),
      enc: {
        min: Array.from({ length: 25 }, (_, index) => (index === 0 ? 42.1 : 0)),
        max: Array.from({ length: 25 }, (_, index) => (index === 0 ? 88.2 : 0)),
        scale: Array.from({ length: 25 }, (_, index) => (index === 0 ? 0.001 : 0)),
        offset: Array.from({ length: 25 }, (_, index) => (index === 0 ? 42.1 : 0)),
      },
    },
  };
  return {
    [`${baseUrl}metadata.json`]: meta,
    [`${baseUrl}pyramid/SP51/manifest.json`]: rootManifest,
    [`${baseUrl}pyramid/SP51/SP51ne/manifest.json`]: leafManifest,
  };
}

describe('pyramidCatalog', () => {
  it('validates metadata schema', () => {
    const meta = parseMetadataJson({
      schemaVersion: 'psychogeo.terrain.v2',
      format: 'tc-dsm-pyramid',
      datasetId: 'test',
      channelId: 'height.dsm.fz',
      ingestCell: 'SP51',
      crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN' },
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
    });
    expect(meta.ingestCell).toBe('SP51');
  });

  it('loads pyramid metadata via fetch', async () => {
    const baseUrl = 'https://example.test/dataset/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildFixtureHandlers(baseUrl));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      expect(catalog.meta.datasetId).toBe('test-sp51');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('delays the 10 km overview until the viewport is much wider than level 1', async () => {
    const baseUrl = 'https://example.test/dataset/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildFixtureHandlers(baseUrl));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      expect(pickPyramidLevelForViewport(catalog, 8700)).toBe(1);
      expect(pickPyramidLevelForViewport(catalog, 15800)).toBe(1);
      expect(pickPyramidLevelForViewport(catalog, 26000)).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves leaf chunks in bounds by arithmetic', async () => {
    const baseUrl = 'https://example.test/dataset/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildFixtureHandlers(baseUrl));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      const resolver = new PyramidCatalogResolver(catalog);
      const chunks = await resolver.resolveChunksInBounds(
        { eastMin: 455100, eastMax: 455900, northMin: 215100, northMax: 215900 },
        0,
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.eastMin).toBe(455000);
      expect(chunks[0]?.northMin).toBe(215000);
      const expectedRel = leafChunkDatasetPath('SP51', 'SP51ne', 455000, 215000, defaultNamingConvention());
      expect(chunks[0]?.url).toBe(resolveDatasetHref(baseUrl, expectedRel));
      expect(chunks[0]?.encoding.min).toBe(42.1);
      expect(chunkKey(chunks[0]!)).toBe('0:455000:215000');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses node manifest schema', () => {
    const enc25 = Array.from({ length: 25 }, () => 1);
    const node = parseNodeManifestJson({
      gridRef: 'SP51ne',
      leaf: {
        stepMetres: 1000,
        cols: 5,
        rows: 5,
        enc: {
          min: enc25,
          max: enc25,
          scale: enc25,
          offset: enc25,
        },
      },
    });
    expect(node.gridRef).toBe('SP51ne');
  });
});
