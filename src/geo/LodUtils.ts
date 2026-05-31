import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices } from '../threact/threexample';
import {
  isCompressionExperimentEnabled,
  registerCompressionTile,
} from './compressionExperiment';
import { DsmCatItem, getImageFilename } from './TileLoaderUK';
import { viewshedAwareLodDistance } from './viewshedConfig';
import {
  applyCustomDepth,
  getTileMaterial,
  getTilePickMaterial,
  type TileUniformBag,
} from './tileShaderRuntime';

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
  const s = lowRes ? 40960 : 1000;
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

////////////////
////////////////
////////////////
////////////////

const _v1 = new THREE.Vector3();
const _bbox = new THREE.Box3();

export type ViewshedLodObserver = {
  position: THREE.Vector3;
  radius: number;
};

export type GeoLodDebugTile = {
  uuid: string;
  currentLevel: number;
  renderCameraDistance: number;
  lodDistance: number;
  viewshedDistance?: number;
};

export type GeoLodDebugSnapshot = {
  observer: {
    position: { x: number; y: number; z: number };
    radius: number;
  } | null;
  visibleTileCount: number;
  visibleLevelCounts: Record<string, number>;
  sampleTiles: GeoLodDebugTile[];
};

let viewshedLodObserver: ViewshedLodObserver | null = null;

export function setViewshedLodObserver(observer: ViewshedLodObserver | null): void {
  viewshedLodObserver = observer
    ? { position: observer.position.clone(), radius: observer.radius }
    : null;
}

function vectorDebug(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

export function collectGeoLodDebugSnapshot(
  roots: THREE.Object3D[],
  maxSamples = 64,
): GeoLodDebugSnapshot {
  const sampleTiles: GeoLodDebugTile[] = [];
  const visibleLevelCounts: Record<string, number> = {};
  let visibleTileCount = 0;

  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof GeoLOD) || !object.visible) return;
      visibleTileCount += 1;
      const level = object.getCurrentLevel();
      const levelKey = String(level);
      visibleLevelCounts[levelKey] = (visibleLevelCounts[levelKey] ?? 0) + 1;
      if (sampleTiles.length < maxSamples) {
        sampleTiles.push(object.getDebugTile());
      }
    });
  }

  return {
    observer: viewshedLodObserver
      ? {
          position: vectorDebug(viewshedLodObserver.position),
          radius: viewshedLodObserver.radius,
        }
      : null,
    visibleTileCount,
    visibleLevelCounts,
    sampleTiles,
  };
}

export function geoLodStateKey(roots: THREE.Object3D[]): string {
  const parts: string[] = [];
  for (const root of roots) {
    root.traverse((object) => {
      if (object instanceof GeoLOD) {
        parts.push(`${object.uuid}:${object.getCurrentLevel()}`);
      }
    });
  }
  return parts.join('|');
}
/**
 * Starting out as fairly much of a direct copy of `THREE.LOD`.
 * Want to behave differently in terms of how `distanceTo` is computed (to BoundingBox).
 * May want to reduce matrix operations, adding / removing children rather than setting visible?
 * May want to do some 
 */
export class GeoLOD extends THREE.Object3D {
  _currentLevel = 0;
  autoUpdate = true;
  levels: {object: THREE.Object3D, distance: number}[];
  private lastRenderCameraDistance = 0;
  private lastLodDistance = 0;
  private lastViewshedDistance: number | undefined;
  get isLOD() { return true; }
  constructor() {
    super();
    this.levels = [];
    this.frustumCulled = false;
  }
  copy(source: this)  {
    super.copy(source, false);
    const levels = source.levels;
    for (let i = 0, l = levels.length; i<l; i++) {
      const level = levels[i];
      this.addLevel(level.object.clone(), level.distance);
    }
    this.autoUpdate = source.autoUpdate;
    return this;
  }
  addLevel(object: THREE.Object3D, distance = 0) {
    distance = Math.abs(distance);
    const levels = this.levels;
    let l: number;
    for (l=0; l<levels.length; l++) {
      if (distance < levels[l].distance) {
        break;
      }
    }
    levels.splice(l, 0, {distance, object});
    this.add(object);
    return this;
  }
  getCurrentLevel() {
    return this._currentLevel;
  }
  getObjectForDistance( distance: number ) {
    const levels = this.levels;
    if (levels.length > 0) {
      let i = 1, l = levels.length;
      for (; i<l; i++) {
        if (distance < levels[i].distance) {
          break;
        }
      }
      return levels[i-1].object;
    }
    return null;
  }
  getDebugTile(): GeoLodDebugTile {
    return {
      uuid: this.uuid,
      currentLevel: this._currentLevel,
      renderCameraDistance: this.lastRenderCameraDistance,
      lodDistance: this.lastLodDistance,
      viewshedDistance: this.lastViewshedDistance,
    };
  }
  /** Not clever enough to cast into procedural geometry etc. Will require async with special render pass. */
  raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    const levels = this.levels;
    if (levels.length > 0) {
      //distance to bbox, properly transformed (UNTESTED)
      _bbox.copy(tileBBox);
      _bbox.applyMatrix4(this.matrixWorld); //may not be needed every time.
      //_v1.setFromMatrixPosition(this.matrixWorld);
      const distance = _bbox.distanceToPoint(raycaster.ray.origin);// raycaster.ray.origin.distanceTo(_v1);
      this.getObjectForDistance(distance)?.raycast(raycaster, intersects);
    }
  }
  update(camera: THREE.Camera) {
    const levels = this.levels;
    _bbox.copy(tileBBox);
    _bbox.applyMatrix4(this.matrixWorld); //may not be needed every time.
    if (levels.length > 1) {
      _v1.setFromMatrixPosition(camera.matrixWorld);
      //_v2.setFromMatrixPosition(this.matrixWorld);
      const zoom = camera instanceof THREE.PerspectiveCamera ? camera.zoom : 1;
      const renderCameraDistance = _bbox.distanceToPoint(_v1) / zoom;
      const viewshedDistance = viewshedLodObserver
        ? _bbox.distanceToPoint(viewshedLodObserver.position)
        : undefined;
      const distance = viewshedDistance === undefined
        ? renderCameraDistance
        : viewshedAwareLodDistance(
            renderCameraDistance,
            viewshedDistance,
            viewshedLodObserver?.radius ?? 0,
          );
      this.lastRenderCameraDistance = renderCameraDistance;
      this.lastLodDistance = distance;
      this.lastViewshedDistance = viewshedDistance;
      levels[0].object.visible = true;
      let i = 1, l = levels.length;
      for (; i<l; i++) {
        if (distance >= levels[i].distance) {
          levels[i-1].object.visible = false;
          levels[i].object.visible = true;
        } else {
          break;
        }
      }
      this._currentLevel = i-1;
      for (; i<l; i++) {
        levels[i].object.visible = false;
      }
    }
  }
  toJSON( meta?: THREE.JSONMeta ) {
    const data = super.toJSON(meta);
    const objectData = data.object as THREE.Object3DJSONObject & {
      levels: { object: string; distance: number }[];
    };
    objectData.levels = [];
    const levels = this.levels;
    for (let i=0, l=levels.length; i<l; i++) {
      const level = levels[i];
      objectData.levels.push({
        object: level.object.uuid,
        distance: level.distance
      });
    }
    return data;
  }
}
