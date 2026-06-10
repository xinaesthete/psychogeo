import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GeoLOD, setViewshedLodObserver } from './GeoLod';

function makeGeoLod(extentMetres = 1000): GeoLOD {
  const lodObj = new GeoLOD();
  lodObj.scale.set(extentMetres, extentMetres, 100);
  for (let lod = 0; lod < 4; lod += 1) {
    const mesh = new THREE.Mesh();
    lodObj.addLevel(mesh, Math.pow(2, lod - 3) * extentMetres);
  }
  return lodObj;
}

describe('GeoLOD', () => {
  it('uses only the active camera distance for LOD selection', () => {
    const geoLod = makeGeoLod();
    geoLod.position.set(455500, 215500, 0);
    geoLod.updateMatrixWorld(true);

    const mainCamera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
    mainCamera.position.set(455500, 215500, 800);
    mainCamera.updateMatrixWorld(true);

    setViewshedLodObserver({
      position: new THREE.Vector3(455500, 215500, 2),
      radius: 10_000,
    });

    geoLod.update(mainCamera);
    const mainLevel = geoLod.getCurrentLevel();

    const shadowCamera = new THREE.PerspectiveCamera(90, 1, 1, 10_000);
    shadowCamera.position.set(455500, 215500, 2);
    shadowCamera.updateMatrixWorld(true);
    geoLod.update(shadowCamera);
    const shadowLevel = geoLod.getCurrentLevel();

    expect(mainLevel).toBeGreaterThan(shadowLevel);
    expect(geoLod.getLevelForCamera(mainCamera)).toBe(mainLevel);
    expect(geoLod.getLevelForWorldPoint(shadowCamera.position)).toBe(shadowLevel);
  });
});
