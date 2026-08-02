import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import {
  isCompressionExperimentEnabled,
  registerCompressionTile,
  type CompressionTileHandle,
} from './compressionExperiment';
import { GeoLOD } from './GeoLod';
import type { EncodingScalars } from './pyramidTypes';
import {
  getTileLodGeometry,
  isSharedTileGeometry,
  tileLodDistance,
  tileLodLevels,
  tileLodUniforms,
} from './tileGeometry';
import {
  applyCustomDepth,
  emptyCoverageMaskTexture,
  getTileMaterial,
  getTilePickMaterial,
  unregisterTileMaterial,
  type TileUniformBag,
} from './tileShaderRuntime';
import type {
  RasterChannel,
  RasterPayload,
  TileLoadContext,
  TileNode,
} from './tileLayerTypes';

function encodingHeightMin(encoding: EncodingScalars): number {
  return encoding.offset;
}

function encodingHeightMax(encoding: EncodingScalars): number {
  return encoding.offset + encoding.scale * 65536;
}

function textureWidthOf(texture: THREE.Texture): number | undefined {
  const image = texture.image;
  if (!image || typeof image !== 'object' || !('width' in image)) return undefined;
  const width = (image as { width?: unknown }).width;
  return typeof width === 'number' && Number.isFinite(width) ? width : undefined;
}

export type BuildGeoLodMeshOptions = {
  lodBias?: number;
  fixedLodLevel?: number;
  /**
   * Chunk URL. When given, the tile joins the HTJ2K compression experiment so
   * the analysis panel can recode it and report error against this (reference)
   * encoding. The handle is stored on the returned object's userData.
   */
  compressionUrl?: string;
};

export function buildGeoLodMesh(
  texture: THREE.Texture,
  encoding: EncodingScalars,
  extentMetres: number,
  options: BuildGeoLodMeshOptions = {},
): GeoLOD {
  const { lodBias = 3, fixedLodLevel } = options;
  const heightMin = encodingHeightMin(encoding);
  const heightMax = encodingHeightMax(encoding);
  const eleScale = heightMax - heightMin;
  const lodObj = new GeoLOD();
  lodObj.scale.set(extentMetres, extentMetres, eleScale);
  lodObj.position.z = heightMin;

  const levels = tileLodLevels(textureWidthOf(texture));
  // A fixed level finer than the texture supports has no geometry; use the
  // finest the ladder actually offers.
  const fixedLod =
    fixedLodLevel === undefined
      ? undefined
      : Math.max(fixedLodLevel, levels[0]?.lod ?? fixedLodLevel);

  const compressionOn = isCompressionExperimentEnabled();
  const uniformBags: TileUniformBag[] = [];
  const meshes: THREE.Mesh[] = [];

  // One pair of uniform objects shared by every LOD mesh of this tile, so
  // updating the mask is a single write no matter which level is drawing.
  const coverageMask: THREE.IUniform = { value: emptyCoverageMaskTexture() };
  const coverageMaskEnabled: THREE.IUniform = { value: 0 };

  for (const level of levels) {
    const uniforms: TileUniformBag = {
      heightFeild: { value: texture },
      heightMin: { value: heightMin },
      heightMax: { value: heightMax },
      ...tileLodUniforms(level),
      uvTransform: { value: new THREE.Matrix3() },
      iTime: globalUniforms.iTime,
      coverageMask,
      coverageMaskEnabled,
    };
    if (compressionOn) {
      uniforms.heightFeildLossy = { value: texture };
    }
    uniformBags.push(uniforms);
    const geo = getTileLodGeometry(level.gridSize);
    const mat = getTileMaterial(uniforms);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `GeoLod ${level.lod} (${geo.name})`;
    mesh.userData.terrainPickMaterial = getTilePickMaterial(uniforms);
    applyCustomDepth(mesh, uniforms);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
    const distance =
      fixedLod === undefined
        ? tileLodDistance(level, extentMetres, lodBias)
        : level.lod === fixedLod
          ? 0
          : Number.POSITIVE_INFINITY;
    lodObj.addLevel(mesh, distance);
  }

  if (options.compressionUrl !== undefined) {
    // Registration is unconditional so tiles already on screen join the
    // experiment when it is switched on; requestVisible is a no-op while off.
    // encoding.scale is metres per uint16 sample, which turns recode error
    // into metres for the analysis panel.
    const handle = registerCompressionTile(
      options.compressionUrl,
      false,
      uniformBags,
      undefined,
      encoding.scale,
    );
    for (const mesh of meshes) {
      const previousOnBeforeRender = mesh.onBeforeRender;
      mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
        previousOnBeforeRender(renderer, scene, camera, geometry, material, group);
        handle.requestVisible();
      };
    }
    lodObj.userData.compressionHandle = handle;
  }

  lodObj.userData.coverageMaskUniforms = { coverageMask, coverageMaskEnabled };
  return lodObj;
}

export type CoverageMaskUniforms = {
  readonly coverageMask: THREE.IUniform;
  readonly coverageMaskEnabled: THREE.IUniform;
};

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
    const payloadUrl = ctx.payloadUrl;
    const { texture } = await JP2.jp2Texture(payloadUrl, false, 1, undefined, ctx.signal);
    if (ctx.signal.aborted || ctx.generation !== ctx.tile.userData.generation) {
      // jp2Texture pinned the cache entry for us; nobody will display it.
      JP2.releaseTexture(payloadUrl);
      throw new DOMException('Aborted', 'AbortError');
    }
    const textureSourceUrl = texture.userData.sourceUrl;
    if (typeof textureSourceUrl === 'string' && textureSourceUrl !== payloadUrl) {
      throw new Error(`texture source mismatch: expected ${payloadUrl}, got ${textureSourceUrl}`);
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

  unload(payload: RasterPayload): void {
    // HTJ2K textures are owned by the jp2Texture module cache; drop this
    // tile's pin so the cache can evict under memory pressure.
    const url = payload.texture.userData.sourceUrl;
    if (typeof url === 'string') {
      JP2.releaseTexture(url);
    }
  }

  evictCachedPayload(payloadUrl: string): void {
    JP2.evictTextureCacheEntry(payloadUrl);
  }

  applyToTile(tile: TileNode, payload: RasterPayload): void {
    const encoding = tile.userData.encoding as EncodingScalars;
    const extentMetres = tile.userData.extentMetres as number;
    const lodBias = this.params.lodBias ?? 3;
    const payloadUrl = tile.userData.payloadUrl;
    const mesh = buildGeoLodMesh(payload.texture, encoding, extentMetres, {
      lodBias,
      fixedLodLevel: this.params.fixedLodLevel,
      compressionUrl: typeof payloadUrl === 'string' ? payloadUrl : undefined,
    });
    mesh.name = `GeoLodMesh ${tile.name}`;
    tile.add(mesh);
    tile.userData.geoLod = mesh;
    const sync = tile.userData.syncDebugLabel;
    if (typeof sync === 'function') sync();
  }

  detachFromTile(tile: TileNode): void {
    const mesh = tile.userData.geoLod as GeoLOD | undefined;
    if (mesh) {
      const compressionHandle = mesh.userData.compressionHandle as
        | CompressionTileHandle
        | undefined;
      compressionHandle?.release();
      tile.remove(mesh);
      mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          // Tile index buffers are shared by every tile at that grid size —
          // disposing one frees the GPU buffer for all of them, forcing a
          // multi-hundred-MB re-upload on the next frame that uses it.
          if (!isSharedTileGeometry(child.geometry)) {
            child.geometry.dispose();
          }
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) {
            unregisterTileMaterial(material);
            material.dispose();
          }
          if (child.customDepthMaterial) child.customDepthMaterial.dispose();
          if (child.customDistanceMaterial) child.customDistanceMaterial.dispose();
          const pickMaterial = child.userData.terrainPickMaterial;
          if (pickMaterial instanceof THREE.Material) pickMaterial.dispose();
        }
      });
      tile.userData.geoLod = undefined;
    }
    const sync = tile.userData.syncDebugLabel;
    if (typeof sync === 'function') sync();
  }
}
