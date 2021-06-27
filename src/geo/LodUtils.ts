import * as THREE from 'three';
import { computeTriangleGridIndices } from '../threact/threexample';
// import { attributeless } from './TileLoaderUK';

const _bb = new THREE.Box3();
/**
 * this isn't used currently, but if we want to go back to a more custom LOD, it could be useful.
 * @param p1 
 * @param p2 
 * @returns 
 */
function distanceToBBox(p1: THREE.Vector3, p2: THREE.Mesh) {
  //_bb.setFromObject(p2); //nb, this does a redundant updateWorldMatrix(), so let's cut to the chase
  if (!p2.geometry.boundingBox) throw 'expected bounding box';
  _bb.copy(p2.geometry.boundingBox!);
  //come to think of it, this is also a bit of a waste
  _bb.applyMatrix4(p2.matrixWorld);
  return _bb.distanceToPoint(p1);
}

const tileBSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.8);
const tileBBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
function makeTileGeometry(s: number) {
  let geo : THREE.BufferGeometry;
  const attributeless = true;//XXX
  if (attributeless) {
      geo = new THREE.BufferGeometry();
      geo.drawRange.count = (s-1) * (s-1) * 6;
      geo.setIndex(computeTriangleGridIndices(s, s));
  } else {
      geo = new THREE.PlaneBufferGeometry(1, 1, s, s);
      geo.translate(0.5, 0.5, 0.5);
      geo.computeVertexNormals();
  }
  //would these be able to account for displacement if computed automatically?
  geo.boundingSphere = tileBSphere;
  geo.boundingBox = tileBBox;
  return geo;
}

export const LOD_LEVELS = 12;
/** by LOD, 0 is 2k, 1 is 1k, 2 is 500... powers of 2 might've been nice if the original data was like that */
///// chchchanging....
export const tileGeom: THREE.BufferGeometry[] = [];
for (let i=0; i<LOD_LEVELS; i++) {
    tileGeom.push(makeTileGeometry(Math.floor(4096 / Math.pow(2, i))));
}
// let lodFalloffFactor = 100; //TODO control this depending on hardware etc.
// function getTileLOD(dist: number, tilePx: number, tileM: number) {
//     const tileRes = tileM / tilePx;
//     const d = dist/tileRes;
//     return Math.pow(2, Math.min(LOD_LEVELS-1, Math.round(Math.sqrt(d/lodFalloffFactor))));
// }
export function getLodUniforms(lod: number) {
  const s = Math.pow(2, lod);//1, 2, 4, ...
  const w = 4096 / s; //4096, 2048, 1024, ...
  const e = 1/(w-1);
  const gridSizeX = {value: w};
  const gridSizeY = {value: w};
  const EPS = {value: new THREE.Vector2(e, e)};
  const LOD = {value: lod/LOD_LEVELS};
  return {EPS, gridSizeX, gridSizeY, LOD};
}
