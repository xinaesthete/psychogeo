import * as THREE from 'three';

/**
 * Shared terrain tile geometry.
 *
 * Tile meshes carry no vertex attributes — the shader pulls positions from the
 * height texture using gl_VertexID (see TileShader computePos), so the only
 * buffer is a triangle index grid. That grid depends solely on its size, so
 * one geometry per grid size serves every tile in the scene: built once,
 * uploaded once, never disposed while the page lives.
 *
 * Index buffers are big — the 4096 grid alone is 384 MiB — so grids are built
 * on first use rather than up front, and callers request only the levels their
 * height texture can actually resolve.
 */

/** Finest supported grid; matches the legacy 4096² source textures. */
export const TILE_BASE_GRID = 4096;
export const TILE_LOD_LEVELS = 12;

export type TileLodLevel = {
  /** Absolute level: grid size is TILE_BASE_GRID >> lod. Fixes shading/LOD debug colour. */
  readonly lod: number;
  readonly gridSize: number;
};

const tileBBox = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 1));
const tileBSphere = new THREE.Sphere();
tileBBox.getBoundingSphere(tileBSphere);

export function computeTriangleGridIndices(
  gridSizeX: number,
  gridSizeY: number,
): THREE.BufferAttribute {
  const n = gridSizeX * gridSizeY * 6;
  const ArrayType = n > 1 << 16 ? Uint32Array : Uint16Array;
  const data = new ArrayType(n);
  let p = 0;
  const index = (x: number, y: number) => gridSizeY * x + y;
  for (let i = 0; i < gridSizeX - 1; i += 1) {
    for (let j = 0; j < gridSizeY - 1; j += 1) {
      data[p] = index(i, j);
      data[p + 1] = index(i + 1, j);
      data[p + 2] = index(i + 1, j + 1);
      data[p + 3] = index(i, j);
      data[p + 4] = index(i + 1, j + 1);
      data[p + 5] = index(i, j + 1);
      p += 6;
    }
  }
  return new THREE.BufferAttribute(data, 1);
}

const geometryByGridSize = new Map<number, THREE.BufferGeometry>();
const sharedGeometries = new WeakSet<THREE.BufferGeometry>();

function makeTileGeometry(gridSize: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.drawRange.count = (gridSize - 1) * (gridSize - 1) * 6;
  geo.setIndex(computeTriangleGridIndices(gridSize, gridSize));
  // Positions come from the height texture, so bounds cannot be derived.
  geo.boundingSphere = tileBSphere;
  geo.boundingBox = tileBBox;
  geo.name = `tileGeom (${gridSize}, ${geo.drawRange.count / 3} triangles)`;
  return geo;
}

/**
 * The shared geometry for a grid size, building it on first request.
 * Never dispose the result — it is shared by every tile at that size.
 */
export function getTileLodGeometry(gridSize: number): THREE.BufferGeometry {
  const existing = geometryByGridSize.get(gridSize);
  if (existing) return existing;
  const geo = makeTileGeometry(gridSize);
  geometryByGridSize.set(gridSize, geo);
  sharedGeometries.add(geo);
  return geo;
}

/** True for geometry owned by this module; such geometry must not be disposed. */
export function isSharedTileGeometry(geometry: THREE.BufferGeometry): boolean {
  return sharedGeometries.has(geometry);
}

function pow2Ceil(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/**
 * LOD ladder for a tile, coarsest-first grids halving each step.
 *
 * `textureWidth` caps the finest level at the smallest power-of-two grid that
 * covers the height texture: a finer mesh would interpolate the same samples
 * into more triangles, costing vertices and a much larger index buffer for no
 * detail. A v2 pyramid chunk is at most 1024 px, so it never needs the 2048 or
 * 4096 grids (96 MiB and 384 MiB of indices respectively).
 */
export function tileLodLevels(textureWidth?: number): TileLodLevel[] {
  const finestGrid =
    textureWidth && textureWidth > 0
      ? Math.min(TILE_BASE_GRID, pow2Ceil(textureWidth))
      : TILE_BASE_GRID;
  const startLod = Math.round(Math.log2(TILE_BASE_GRID / finestGrid));
  const levels: TileLodLevel[] = [];
  for (let lod = startLod; lod < TILE_LOD_LEVELS; lod += 1) {
    const gridSize = TILE_BASE_GRID >> lod;
    if (gridSize < 2) break;
    levels.push({ lod, gridSize });
  }
  return levels;
}

/** Shader uniforms describing the grid; EPS is the UV step between vertices. */
export function tileLodUniforms(level: TileLodLevel): {
  EPS: { value: THREE.Vector2 };
  gridSizeX: { value: number };
  gridSizeY: { value: number };
  LOD: { value: number };
} {
  const w = level.gridSize;
  const e = 1 / (w - 1);
  return {
    EPS: { value: new THREE.Vector2(e, e) },
    gridSizeX: { value: w },
    gridSizeY: { value: w },
    LOD: { value: level.lod / TILE_LOD_LEVELS },
  };
}

/**
 * Switch distance for a level. Keyed to the absolute lod so dropping finer
 * levels never changes the distance at which a surviving grid is shown.
 */
export function tileLodDistance(
  level: TileLodLevel,
  extentMetres: number,
  lodBias: number,
): number {
  return Math.pow(2, level.lod - lodBias) * extentMetres;
}

export function tileGeometryStats(): {
  gridSizes: number[];
  indexBytes: number;
} {
  let indexBytes = 0;
  for (const geo of geometryByGridSize.values()) {
    const index = geo.getIndex();
    if (index) indexBytes += (index.array as ArrayLike<number> & { byteLength: number }).byteLength;
  }
  return { gridSizes: [...geometryByGridSize.keys()].sort((a, b) => b - a), indexBytes };
}
