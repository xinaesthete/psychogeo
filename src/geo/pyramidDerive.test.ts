import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  cameraDistanceToExtent,
  defaultNamingConvention,
  defaultSpatialIndex,
  pickPyramidLevelForTileDistance,
} from './pyramidDerive';
import type { TerrainManifestV2 } from './pyramidTypes';

const CELL_META: TerrainManifestV2 = {
  schemaVersion: 'psychogeo.terrain.v2',
  format: 'tc-dsm-pyramid',
  datasetId: 'test',
  channelId: 'height.dsm.fz',
  ingestCell: 'SP51',
  crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN' },
  spatialIndex: defaultSpatialIndex(),
  naming: defaultNamingConvention(),
  tileMatrixSet: {
    levels: [
      { level: 0, resolutionMetres: 1, tierMetres: 1000 },
      { level: 1, resolutionMetres: 8, tierMetres: 5000 },
      { level: 2, resolutionMetres: 32, tierMetres: 10000 },
    ],
  },
  encoding: {
    codec: 'htj2k',
    sampleType: 'uint16',
    normalisation: 'perChunkScaleOffset',
    nodata: 0,
  },
  indexRoot: 'pyramid/SP51/manifest.json',
};

describe('pickPyramidLevelForTileDistance', () => {
  const tileExtent = {
    eastMin: 455000,
    eastMax: 456000,
    northMin: 215000,
    northMax: 216000,
  };

  it('picks leaf level when the camera is near the tile', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
    camera.position.set(455500, 215500, 300);
    camera.updateMatrixWorld(true);
    expect(pickPyramidLevelForTileDistance(CELL_META, camera, tileExtent)).toBe(0);
  });

  it('picks merged level 1 when the camera is far from the tile', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
    camera.position.set(455500, 215500, 8000);
    camera.updateMatrixWorld(true);
    expect(pickPyramidLevelForTileDistance(CELL_META, camera, tileExtent)).toBe(1);
  });

  it('measures distance to the closest point on the tile extent', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
    camera.position.set(450000, 210000, 500);
    camera.updateMatrixWorld(true);
    expect(cameraDistanceToExtent(camera, tileExtent)).toBeCloseTo(
      Math.hypot(5000, 5000, 500),
      0,
    );
  });
});
