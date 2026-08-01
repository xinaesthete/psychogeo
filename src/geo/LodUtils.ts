import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import {
  isCompressionExperimentEnabled,
  registerCompressionTile,
} from './compressionExperiment';
import {
  getTileLodGeometry,
  tileLodDistance,
  tileLodLevels,
  tileLodUniforms,
} from './tileGeometry';
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

  const textureWidth =
    texturePixelData && texture.image && typeof texture.image === 'object' && 'width' in texture.image
      ? (texture.image as { width?: number }).width
      : undefined;

  for (const level of tileLodLevels(textureWidth)) {
    const uvTransform = new THREE.Matrix3();
    const uniforms: TileUniformBag = {
      heightFeild: { value: texture },
      heightMin: { value: heightMin }, heightMax: { value: heightMax },
      ...tileLodUniforms(level),
      uvTransform: { value: uvTransform },
      iTime: globalUniforms.iTime,
    };
    if (compressionOn) {
      uniforms.heightFeildLossy = { value: texture };
    }
    uniformBags.push(uniforms);
    const geo = getTileLodGeometry(level.gridSize);

    const mat = getTileMaterial(uniforms);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.terrainPickMaterial = getTilePickMaterial(uniforms);
    tileMeshes.push(mesh);
    applyCustomDepth(mesh, uniforms);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    lodObj.addLevel(mesh, tileLodDistance(level, s, lodBias));
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

