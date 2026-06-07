import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices } from '../threact/threexample';
import { GeoLOD } from './LodUtils';
import type { EncodingScalars } from './pyramidTypes';
import {
  applyCustomDepth,
  getTileMaterial,
  getTilePickMaterial,
  type TileUniformBag,
} from './tileShaderRuntime';
import type {
  RasterChannel,
  RasterPayload,
  TileLoadContext,
  TileNode,
} from './tileLayerTypes';

const LOD_LEVELS = 12;
const tileBBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 1));
const tileBSphere = new THREE.Sphere();
tileBBox.getBoundingSphere(tileBSphere);

function makeTileGeometry(s: number) {
  const geo = new THREE.BufferGeometry();
  geo.drawRange.count = (s - 1) * (s - 1) * 6;
  geo.setIndex(computeTriangleGridIndices(s, s));
  geo.boundingSphere = tileBSphere;
  geo.boundingBox = tileBBox;
  geo.name = `tileGeom (${s}, ${geo.drawRange.count/3} triangles)`
  return geo;
}

const tileGeom: THREE.BufferGeometry[] = [];
for (let i = 0; i < LOD_LEVELS; i += 1) {
  tileGeom.push(makeTileGeometry(Math.floor(4096 / Math.pow(2, i))));
}

function getLodUniforms(lod: number) {
  const s = Math.pow(2, lod);
  const w = 4096 / s;
  const e = 1 / (w - 1);
  return {
    EPS: { value: new THREE.Vector2(e, e) },
    gridSizeX: { value: w },
    gridSizeY: { value: w },
    LOD: { value: lod / LOD_LEVELS },
  };
}

function encodingHeightMin(encoding: EncodingScalars): number {
  return encoding.offset;
}

function encodingHeightMax(encoding: EncodingScalars): number {
  return encoding.offset + encoding.scale * 65536;
}

export function buildGeoLodMesh(
  texture: THREE.Texture,
  encoding: EncodingScalars,
  extentMetres: number,
  lodBias = 3,
  fixedLodLevel?: number,
): GeoLOD {
  const heightMin = encodingHeightMin(encoding);
  const heightMax = encodingHeightMax(encoding);
  const eleScale = heightMax - heightMin;
  const lodObj = new GeoLOD();
  lodObj.scale.set(extentMetres, extentMetres, eleScale);
  lodObj.position.z = heightMin;

  for (let lod = 0; lod < LOD_LEVELS; lod += 1) {
    const uniforms: TileUniformBag = {
      heightFeild: { value: texture },
      heightMin: { value: heightMin },
      heightMax: { value: heightMax },
      ...getLodUniforms(lod),
      uvTransform: { value: new THREE.Matrix3() },
      iTime: globalUniforms.iTime,
    };
    const geo = tileGeom[lod];
    const mat = getTileMaterial(uniforms);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `GeoLod ${lod} (${geo.name})`
    mesh.userData.terrainPickMaterial = getTilePickMaterial(uniforms);
    applyCustomDepth(mesh, uniforms);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const distance = fixedLodLevel === undefined
      ? Math.pow(2, lod - lodBias) * extentMetres
      : lod === fixedLodLevel
        ? 0
        : Number.POSITIVE_INFINITY;
    lodObj.addLevel(mesh, distance);
  }

  return lodObj;
}

export interface PyramidHeightChannelParams {
  lodBias?: number;
  fixedLodLevel?: number;
}

export class PyramidHeightChannel implements RasterChannel<PyramidHeightChannelParams> {
  readonly id = 'height.primary';
  readonly params: PyramidHeightChannelParams;

  constructor(params: PyramidHeightChannelParams = {}) {
    this.params = params;
  }

  async load(ctx: TileLoadContext): Promise<RasterPayload> {
    const { texture } = await JP2.jp2Texture(ctx.payloadUrl, false, 1, undefined, ctx.signal);
    if (ctx.signal.aborted || ctx.generation !== ctx.tile.userData.generation) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const bytes =
      texture.image &&
      typeof texture.image === 'object' &&
      'data' in texture.image &&
      texture.image.data instanceof Uint16Array
        ? texture.image.data.byteLength
        : 0;
    return {
      texture,
      extent: ctx.tile.extent,
      bytes,
      dispose() {
        texture.dispose();
      },
    };
  }

  unload(_payload: RasterPayload): void {
    // HTJ2K textures are owned by the jp2Texture module cache.
  }

  applyToTile(tile: TileNode, payload: RasterPayload): void {
    const encoding = tile.userData.encoding as EncodingScalars;
    const extentMetres = tile.userData.extentMetres as number;
    const lodBias = this.params.lodBias ?? 3;
    const mesh = buildGeoLodMesh(
      payload.texture,
      encoding,
      extentMetres,
      lodBias,
      this.params.fixedLodLevel,
    );
    mesh.name = `GeoLodMesh ${tile.name}`;
    const placeholder = tile.userData.placeholder as THREE.Object3D | undefined;
    if (placeholder) {
      tile.remove(placeholder);
      placeholder.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      tile.userData.placeholder = undefined;
    }
    tile.add(mesh);
    tile.userData.geoLod = mesh;
  }

  detachFromTile(tile: TileNode): void {
    const mesh = tile.userData.geoLod as GeoLOD | undefined;
    if (mesh) {
      tile.remove(mesh);
      mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      tile.userData.geoLod = undefined;
    }
  }
}
