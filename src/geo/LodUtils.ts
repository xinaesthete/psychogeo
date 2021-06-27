import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices } from '../threact/threexample';
import { DsmCatItem, getImageFilename } from './TileLoaderUK';
import { applyCustomDepth, getTileMaterial } from './TileShader';

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
  const geo = new THREE.BufferGeometry();
  geo.drawRange.count = (s-1) * (s-1) * 6;
  geo.setIndex(computeTriangleGridIndices(s, s));
  //would these be able to account for displacement if computed automatically?
  geo.boundingSphere = tileBSphere;
  geo.boundingBox = tileBBox;
  return geo;
}

const LOD_LEVELS = 12;
/** by LOD, 0 is 2k, 1 is 1k, 2 is 500... powers of 2 might've been nice if the original data was like that */
///// chchchanging....
const tileGeom: THREE.BufferGeometry[] = [];
for (let i=0; i<LOD_LEVELS; i++) {
    tileGeom.push(makeTileGeometry(Math.floor(4096 / Math.pow(2, i))));
}
// let lodFalloffFactor = 100; //TODO control this depending on hardware etc.
// function getTileLOD(dist: number, tilePx: number, tileM: number) {
//     const tileRes = tileM / tilePx;
//     const d = dist/tileRes;
//     return Math.pow(2, Math.min(LOD_LEVELS-1, Math.round(Math.sqrt(d/lodFalloffFactor))));
// }
function getLodUniforms(lod: number) {
  const s = Math.pow(2, lod);//1, 2, 4, ...
  const w = 4096 / s; //4096, 2048, 1024, ...
  const e = 1/(w-1);
  const gridSizeX = {value: w};
  const gridSizeY = {value: w};
  const EPS = {value: new THREE.Vector2(e, e)};
  const LOD = {value: lod/LOD_LEVELS};
  return {EPS, gridSizeX, gridSizeY, LOD};
}

export async function getTileMesh(info: DsmCatItem, lowRes = false, lodBias = 5) {
  //let's call this differently for a low-res layer.
  // let info = getTileProperties(coord, lowRes) || nullInfo;
  // if (info.mesh) return info; //!!! this breaks when more than one scene uses the same tile.
  //// but we'll still be using a cached texture.

  const sources = info.sources;
  const source = !sources ? info.source_filename : sources[2000] || sources[1000] || sources[500]!;
  const url = getImageFilename(source, lowRes);

  const { texture, frameInfo } = await JP2.jp2Texture(url, lowRes); //lowRes also means 'fullFloat' at the moment
  const w = frameInfo.width, h = frameInfo.height;
  const lodObj = new THREE.LOD();
  const s = lowRes ? 40960 : 1000;
  // for now there's a weak convention that lowRes also means non-normalised data
  // and doesn't include stats. that might change, and we should more clearly flag.
  const eleScale = lowRes ? 1 : info.max_ele! - info.min_ele!;
  lodObj.scale.set(s, s, eleScale);
  lodObj.position.z = info.min_ele ?? 0;

  for (let lod = 0; lod < LOD_LEVELS; lod++) {
    if (false && lod <= 3) {
      //considering QuadTree so that when zoomed-in we can cull some parts
      //first pass, non-recursive but splitting up first few lod levels
      //needs more work to be useful.
      let g = new THREE.Group();
      for (let y=0; y<2; y++) {
        for (let x=0; x<2; x++) {
          const uvTransform = new THREE.Matrix3();
          // uvTransform.translate(x/2, y/2);
          // uvTransform.scale(0.5, 0.5);
          uvTransform.setUvTransform(0, 0, 0.5, 0.5, 0, x, y);
          const uniforms = {
            heightFeild: { value: texture },
            heightMin: { value: info.min_ele ?? 0 }, heightMax: { value: info.max_ele ?? 1 },
            ...getLodUniforms(lod+1),
            uvTransform: { value: uvTransform },
            iTime: globalUniforms.iTime,
          };
          //nb, using regular bbox will mean no culling of submeshes.
          const geo = tileGeom[lod+1];
      
          const mat = getTileMaterial(uniforms);
          // mat.wireframe = true;
          const mesh = new THREE.Mesh(geo, mat);
          applyCustomDepth(mesh, uniforms);
          // mesh.scale.set(1, 1, 1);
          // mesh.position.set(x/2, y/2, 0);
          // mesh.updateMatrix();
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          g.add(mesh);
        }
      }
      lodObj.addLevel(g, Math.pow(2, lod - lodBias) * s);
      continue;
    }
    const uvTransform = new THREE.Matrix3();
    // uvTransform.scale(0.5, 0.5);
    const uniforms = {
      heightFeild: { value: texture },
      heightMin: { value: info.min_ele ?? 0 }, heightMax: { value: info.max_ele ?? 1 },
      ...getLodUniforms(lod),
      uvTransform: { value: uvTransform },
      iTime: globalUniforms.iTime,
    };
    const geo = tileGeom[lod]; //regardless of image geom, for now

    const mat = getTileMaterial(uniforms);
    // mat.wireframe = true;
    const mesh = new THREE.Mesh(geo, mat);
    applyCustomDepth(mesh, uniforms);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    //lodBias is a +ve integer, higher values mean lower geometric detail
    lodObj.addLevel(mesh, Math.pow(2, lod - lodBias) * s);
  }

  info.mesh = lodObj;
  return info;
}
