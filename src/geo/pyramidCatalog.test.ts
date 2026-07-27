import * as THREE from 'three';
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
    levels: {
      '2': { min: 30, max: 120, scale: 0.02, offset: 30 },
    },
  };
  const leafManifest = {
    gridRef: 'SP51ne',
    levels: {
      '1': { min: 40, max: 90, scale: 0.01, offset: 40 },
    },
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

  it('resolves leaf chunks across a multi-cell region summary', async () => {
    const baseUrl = 'https://example.test/region-dataset/';
    const handlers = {
      [`${baseUrl}metadata.json`]: {
        schemaVersion: 'psychogeo.terrain.v2',
        format: 'tc-dsm-pyramid',
        datasetId: 'test-sp5',
        channelId: 'height.dsm.fz',
        ingestCell: 'SP5',
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
        indexRoot: indexRootForCell('SP50'),
        regionSummary: 'index/region-summary.json',
      },
      [`${baseUrl}index/region-summary.json`]: {
        region: { kind: 'grid-ref', gridRef: 'SP5' },
        regionLabel: 'SP5',
        cells: [
          { cell: 'SP50', indexRoot: indexRootForCell('SP50'), groupCount: 4, leafChunks: 100, outputBytes: 1 },
          { cell: 'SP51', indexRoot: indexRootForCell('SP51'), groupCount: 4, leafChunks: 100, outputBytes: 1 },
        ],
      },
      [`${baseUrl}pyramid/SP51/manifest.json`]: {
        gridRef: 'SP51',
        children: ['SP51ne'],
        coverage: 'partial',
      },
      [`${baseUrl}pyramid/SP51/SP51ne/manifest.json`]: {
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
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(handlers);
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      const resolver = new PyramidCatalogResolver(catalog);
      const chunks = await resolver.resolveChunksInBounds(
        { eastMin: 455100, eastMax: 455900, northMin: 215100, northMax: 215900 },
        0,
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.eastMin).toBe(455000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves adaptive chunks near the camera at leaf level', async () => {
    const baseUrl = 'https://example.test/dataset/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildFixtureHandlers(baseUrl));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      const resolver = new PyramidCatalogResolver(catalog);
      const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
      camera.position.set(455500, 215500, 300);
      camera.updateMatrixWorld(true);
      const chunks = await resolver.resolveChunksInBoundsAdaptive(
        { eastMin: 455100, eastMax: 455900, northMin: 215100, northMax: 215900 },
        camera,
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.level).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves adaptive chunks far from the camera at merged level 1', async () => {
    const baseUrl = 'https://example.test/dataset/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildFixtureHandlers(baseUrl));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      const resolver = new PyramidCatalogResolver(catalog);
      const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
      camera.position.set(455500, 215500, 8000);
      camera.updateMatrixWorld(true);
      const chunks = await resolver.resolveChunksInBoundsAdaptive(
        { eastMin: 455100, eastMax: 455900, northMin: 215100, northMax: 215900 },
        camera,
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.level).toBe(1);
      expect(chunks[0]?.extentMetres).toBe(5000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not emit overlapping L2 and L1 chunks for the same ingest cell', async () => {
    const baseUrl = 'https://example.test/dataset/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildFixtureHandlers(baseUrl));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      const resolver = new PyramidCatalogResolver(catalog);
      const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
      camera.position.set(455500, 215500, 8000);
      camera.updateMatrixWorld(true);
      const chunks = await resolver.resolveChunksInBoundsAdaptive(
        { eastMin: 450000, eastMax: 500000, northMin: 210000, northMax: 220000 },
        camera,
      );
      const levels = new Set(chunks.map((chunk) => chunk.level));
      expect(levels.has(2) && levels.has(1)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const NATIONAL_PYRAMID_LEVELS = [
    { level: 0, resolutionMetres: 1, tierMetres: 1000 },
    { level: 1, resolutionMetres: 8, tierMetres: 5000 },
    { level: 2, resolutionMetres: 32, tierMetres: 10000 },
    { level: 3, resolutionMetres: 125, tierMetres: 100000 },
    { level: 4, resolutionMetres: 500, tierMetres: 100000 },
  ];

  function buildNationalHandlers(baseUrl: string, includeSquare: boolean): Record<string, unknown> {
    const cellRoot = (cell: string) => ({
      gridRef: cell,
      children: [],
      coverage: 'complete',
      levels: {
        '2': { min: 30, max: 120, scale: 0.02, offset: 30 },
      },
    });
    const handlers: Record<string, unknown> = {
      [`${baseUrl}metadata.json`]: {
        schemaVersion: 'psychogeo.terrain.v2',
        format: 'tc-dsm-pyramid',
        datasetId: 'test-national',
        channelId: 'height.dsm.fz',
        ingestCell: 'SP50',
        crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN' },
        spatialIndex: defaultSpatialIndex(),
        naming: defaultNamingConvention(),
        tileMatrixSet: { levels: NATIONAL_PYRAMID_LEVELS },
        encoding: {
          codec: 'htj2k',
          sampleType: 'uint16',
          normalisation: 'perChunkScaleOffset',
          nodata: 0,
        },
        indexRoot: indexRootForCell('SP50'),
        regionSummary: 'index/region-summary.json',
      },
      [`${baseUrl}index/region-summary.json`]: {
        region: { kind: 'grid-ref', gridRef: 'SP' },
        regionLabel: 'SP',
        cells: [
          { cell: 'SP50', indexRoot: indexRootForCell('SP50'), groupCount: 4, leafChunks: 100, outputBytes: 1 },
          { cell: 'SP51', indexRoot: indexRootForCell('SP51'), groupCount: 4, leafChunks: 100, outputBytes: 1 },
        ],
      },
      [`${baseUrl}pyramid/SP50/manifest.json`]: cellRoot('SP50'),
      [`${baseUrl}pyramid/SP51/manifest.json`]: cellRoot('SP51'),
    };
    if (includeSquare) {
      handlers[`${baseUrl}pyramid/SP/manifest.json`] = {
        gridRef: 'SP',
        children: ['SP50', 'SP51'],
        levels: {
          '3': { min: 30, max: 120, scale: 0.02, offset: 30 },
          '4': { min: 30, max: 120, scale: 0.03, offset: 30 },
        },
      };
    }
    return handlers;
  }

  it('picks 100 km levels by resolution-based viewport thresholds', async () => {
    const baseUrl = 'https://example.test/national/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildNationalHandlers(baseUrl, true));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      expect(pickPyramidLevelForViewport(catalog, 26000)).toBe(2);
      expect(pickPyramidLevelForViewport(catalog, 130000)).toBe(3);
      expect(pickPyramidLevelForViewport(catalog, 400000)).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves one square chunk per 100 km square at coarse levels', async () => {
    const baseUrl = 'https://example.test/national/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildNationalHandlers(baseUrl, true));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      const resolver = new PyramidCatalogResolver(catalog);
      const chunks = await resolver.resolveChunksInBounds(
        { eastMin: 440000, eastMax: 470000, northMin: 200000, northMax: 230000 },
        3,
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.gridRef).toBe('SP');
      expect(chunks[0]?.level).toBe(3);
      expect(chunks[0]?.eastMin).toBe(400000);
      expect(chunks[0]?.northMin).toBe(200000);
      expect(chunks[0]?.extentMetres).toBe(100000);
      expect(chunks[0]?.width).toBe(800);
      expect(chunks[0]?.height).toBe(800);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to cell-tier chunks when the square is not finalized', async () => {
    const baseUrl = 'https://example.test/national-partial/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(buildNationalHandlers(baseUrl, false));
    try {
      const catalog = await loadPyramidDataset(`${baseUrl}metadata.json`);
      const resolver = new PyramidCatalogResolver(catalog);
      const chunks = await resolver.resolveChunksInBounds(
        { eastMin: 440000, eastMax: 470000, northMin: 200000, northMax: 230000 },
        3,
      );
      expect(chunks).toHaveLength(2);
      expect(new Set(chunks.map((chunk) => chunk.level))).toEqual(new Set([2]));
      expect(new Set(chunks.map((chunk) => chunk.gridRef))).toEqual(new Set(['SP50', 'SP51']));
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
