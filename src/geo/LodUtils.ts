import * as THREE from 'three';
import { WebGLRenderer } from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices } from '../threact/threexample';
import { DsmCatItem, getImageFilename } from './TileLoaderUK';
import { applyCustomDepth, getTileMaterial } from './TileShader';

//BBox & BSphere centred rather than at tile origin
const tileBSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0), 1); //nb radius is wide, but could still potentially miss hills?
const tileBBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 1));
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

function renderMip(renderer: WebGLRenderer, texture: THREE.Texture, size: number) {
  return texture; //TODO: implement & use this properly.
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0, 2);
  camera.position.set(0.5, 0.5, -2);
  camera.lookAt(0.5, 0.5, 0);
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  //TODO: filter nicely.
  const mat = new THREE.MeshBasicMaterial({map: texture});
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 1, 0);
  mesh.scale.set(-1, -1, 1);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const oldTarget = renderer.getRenderTarget();
  const target = new THREE.WebGLRenderTarget(size, size, {...texture});
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(oldTarget);
  return target.texture;
}

export async function getTileMesh(info: DsmCatItem, lowRes = false, lodBias = 3) {
  //let's call this differently for a low-res layer.
  // let info = getTileProperties(coord, lowRes) || nullInfo;
  // if (info.mesh) return info; //!!! this breaks when more than one scene uses the same tile.
  //// but we'll still be using a cached texture.

  const sources = info.sources;
  const source = !sources ? info.source_filename : sources[2000] || sources[1000] || sources[500]!;
  const url = getImageFilename(source, lowRes);
  console.log("getTileMesh filename", url);

  const { texture, frameInfo } = await JP2.jp2Texture(url, lowRes); //lowRes also means 'fullFloat' at the moment
  /// or does it? 
  const w = frameInfo.width, h = frameInfo.height;
  const lodObj = new GeoLOD();
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
    if (lowRes && lod > 4) {
      const oldBeforeRender = mesh.onBeforeRender;
      mesh.onBeforeRender = (renderer) => {
        const s = w / Math.pow(2, lod - 4);
        uniforms.heightFeild.value = renderMip(renderer, texture, s);
        mesh.onBeforeRender = oldBeforeRender;
      }
    }
    applyCustomDepth(mesh, uniforms);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    //lodBias is a +ve integer, higher values mean lower geometric detail
    lodObj.addLevel(mesh, Math.pow(2, lod - lodBias) * s);
  }

  info.mesh = lodObj;
  return info;
}

////////////////
////////////////
////////////////
////////////////

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _bbox = new THREE.Box3();
/**
 * Starting out as fairly much of a direct copy of `THREE.LOD`.
 * Want to behave differently in terms of how `distanceTo` is computed (to BoundingBox).
 * May want to reduce matrix operations, adding / removing children rather than setting visible?
 * May want to do some 
 */
class GeoLOD extends THREE.Object3D {
  _currentLevel = 0;
  autoUpdate = true;
  levels: {object: THREE.Object3D, distance: number}[];
  get isLOD() { return true; }
  constructor() {
    super();
    this.type = 'GeoLOD';
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
      const distance = _bbox.distanceToPoint(_v1) / (camera as any).zoom;
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
  toJSON( meta: any ) {
    const data = super.toJSON(meta);
    data.object.levels = [];
    const levels = this.levels;
    for (let i=0, l=levels.length; i<l; i++) {
      const level = levels[i];
      data.object.levels.push({
        object: level.object.uuid,
        distance: level.distance
      });
    }
    return data;
  }
}
