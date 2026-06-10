import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices } from '../threact/threexample';
import {
  isCompressionExperimentEnabled,
  registerCompressionTile,
} from './compressionExperiment';
import { DsmCatItem, getImageFilename } from './TileLoaderUK';
import {
  applyCustomDepth,
  getTileMaterial,
  getTilePickMaterial,
  type TileUniformBag,
} from './tileShaderRuntime';

export {
  collectGeoLodDebugSnapshot,
  GeoLOD,
  geoLodShadowStateKey,
  geoLodStateKey,
  setViewshedLodObserver,
  type GeoLodDebugSnapshot,
  type GeoLodDebugTile,
  type ViewshedLodObserver,
} from './GeoLod';
import { GeoLOD } from './GeoLod';

const tileBBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 1));
const tileBSphere = new THREE.Sphere();
tileBBox.getBoundingSphere(tileBSphere);
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
const tileGeom: THREE.BufferGeometry[] = [];
for (let i=0; i<LOD_LEVELS; i++) {
    tileGeom.push(makeTileGeometry(Math.floor(4096 / Math.pow(2, i))));
}
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

export interface GetTileMeshOptions {
  compressionExperiment?: boolean;
}

export async function getTileMesh(
  info: DsmCatItem,
  lowRes = false,
  lodBias = 3,
  meshOptions: GetTileMeshOptions = {},
) {
  const sources = info.sources;
  const source = !sources ? info.source_filename : sources[2000] || sources[1000] || sources[500]!;
  const displayUrl = getImageFilename(source, lowRes, false);
  const recodeUrl = getImageFilename(source, lowRes, true);
  const compressionOn =
    meshOptions.compressionExperiment ?? isCompressionExperimentEnabled();
  console.log("getTileMesh filename", displayUrl, recodeUrl);

  const { texture } = await JP2.jp2Texture(displayUrl, lowRes);
  const lodObj = new GeoLOD();
  const s = info.extentMetres ?? (lowRes ? 40960 : 1000);
  const heightMin = lowRes ? 0 : (info.min_ele ?? 0);
  const heightMax = lowRes ? 1 : (info.max_ele ?? 1);
  const eleScale = lowRes ? 1 : info.max_ele! - info.min_ele!;
  lodObj.scale.set(s, s, eleScale);
  lodObj.position.z = lowRes ? 0 : (info.min_ele ?? 0);

  let metreRangeForRecode: JP2.HeightRange | undefined;
  const textureImage = texture.image;
  const texturePixelData =
    textureImage &&
    typeof textureImage === 'object' &&
    'data' in textureImage &&
    textureImage.data instanceof Uint16Array
      ? textureImage.data
      : undefined;
  if (lowRes && recodeUrl && texturePixelData) {
    metreRangeForRecode = JP2.estimateHeightRangeFromHalfMetresTexture(texturePixelData);
  }

  const uniformBags: TileUniformBag[] = [];
  const tileMeshes: THREE.Mesh[] = [];

  for (let lod = 0; lod < LOD_LEVELS; lod++) {
    const uvTransform = new THREE.Matrix3();
    const uniforms: TileUniformBag = {
      heightFeild: { value: texture },
      heightMin: { value: heightMin }, heightMax: { value: heightMax },
      ...getLodUniforms(lod),
      uvTransform: { value: uvTransform },
      iTime: globalUniforms.iTime,
    };
    if (compressionOn) {
      uniforms.heightFeildLossy = { value: texture };
    }
    uniformBags.push(uniforms);
    const geo = tileGeom[lod];

    const mat = getTileMaterial(uniforms);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.terrainPickMaterial = getTilePickMaterial(uniforms);
    tileMeshes.push(mesh);
    applyCustomDepth(mesh, uniforms);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    lodObj.addLevel(mesh, Math.pow(2, lod - lodBias) * s);
  }

  const compressionHandle = registerCompressionTile(recodeUrl, lowRes, uniformBags, metreRangeForRecode);
  for (const mesh of tileMeshes) {
    const previousOnBeforeRender = mesh.onBeforeRender;
    mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      previousOnBeforeRender(renderer, scene, camera, geometry, material, group);
      compressionHandle.requestVisible();
    };
  }

  info.mesh = lodObj;
  return info;
}

