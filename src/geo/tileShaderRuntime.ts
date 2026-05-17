import * as THREE from 'three';

/** Per-material uniform bag (per-tile refs + shared tileShaderUniforms). */
export type TileUniformBag = Record<string, THREE.IUniform>;

/** Shared terrain-shader tunables (Leva + GLSL). Same object refs on every tile. */
export const tileShaderUniforms = {
  contourSpeed: { value: 3.0 },
  contourInterval: { value: 5.0 },
  contourEmissive: { value: new THREE.Vector3(0.3, 0.5, 0.7) },
  majorContourInterval: { value: 10.0 },
  majorContourEmissive: { value: new THREE.Vector3(0.8, 0.5, 0.7) },
  heightEmissiveScale: { value: 1 / 2000 },
  lodSat: { value: 0.8 },
  lodVal: { value: 0.1 },
  contourStrength: { value: 0.3 },
} satisfies Record<string, THREE.IUniform>;

export function mergeTileUniforms(perTile: TileUniformBag): TileUniformBag {
  return { ...tileShaderUniforms, ...perTile };
}

type PatchBeforeCompile = NonNullable<THREE.Material['onBeforeCompile']>;

export type TileShaderImpl = {
  patchShaderBeforeCompile: (uniforms: TileUniformBag) => PatchBeforeCompile;
  createTileLoadingMaterial: () => THREE.ShaderMaterial;
  applyCustomDepthForViewshed: (mesh: THREE.Mesh) => void;
};

type RegisteredEntry = {
  mat: THREE.MeshStandardMaterial;
  uniforms: TileUniformBag;
  depth?: THREE.MeshDepthMaterial;
  dist?: THREE.MeshDistanceMaterial;
};

let currentImpl: TileShaderImpl | null = null;
let shaderGeneration = 0;
let tileLoadingMaterial: THREE.ShaderMaterial | null = null;

const registry = new Set<RegisteredEntry>();

function programCacheKey(): string {
  return `tile-shader-${shaderGeneration}`;
}

function attachCacheKey(material: THREE.Material): void {
  material.customProgramCacheKey = programCacheKey;
}

function registerEntry(entry: RegisteredEntry): void {
  registry.add(entry);
}

export function installTileShaderImpl(impl: TileShaderImpl): void {
  currentImpl = impl;
  tileLoadingMaterial = impl.createTileLoadingMaterial();
  recompileRegisteredMaterials();
}

export function getTileLoadingMaterial(): THREE.ShaderMaterial {
  if (!tileLoadingMaterial) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  return tileLoadingMaterial;
}

export function getTileMaterial(perTileUniforms: TileUniformBag): THREE.MeshStandardMaterial {
  if (!currentImpl) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  const uniforms = mergeTileUniforms(perTileUniforms);
  const mat = new THREE.MeshStandardMaterial({ flatShading: false });
  mat.onBeforeCompile = currentImpl.patchShaderBeforeCompile(uniforms);
  attachCacheKey(mat);
  registerEntry({ mat, uniforms });
  return mat;
}

export function applyCustomDepth(mesh: THREE.Mesh, perTileUniforms: TileUniformBag): void {
  if (!currentImpl) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  const uniforms = mergeTileUniforms(perTileUniforms);
  const surface = mesh.material;
  if (!(surface instanceof THREE.MeshStandardMaterial)) return;

  const depth = (mesh.customDepthMaterial = new THREE.MeshDepthMaterial());
  const dist = (mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial());

  if (surface.displacementMap !== null) {
    depth.displacementMap = dist.displacementMap = surface.displacementMap;
    depth.displacementScale = dist.displacementScale = surface.displacementScale;
    depth.displacementBias = dist.displacementBias = surface.displacementBias;
    return;
  }

  const patch = currentImpl.patchShaderBeforeCompile(uniforms);
  depth.onBeforeCompile = patch;
  dist.onBeforeCompile = patch;
  attachCacheKey(depth);
  attachCacheKey(dist);

  const entry = [...registry].find((e) => e.mat === surface);
  if (entry) {
    entry.depth = depth;
    entry.dist = dist;
  } else {
    registerEntry({ mat: surface, uniforms, depth, dist });
  }
}

export function applyCustomDepthForViewshed(mesh: THREE.Mesh): void {
  if (!currentImpl) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  currentImpl.applyCustomDepthForViewshed(mesh);
}

export function recompileRegisteredMaterials(): void {
  if (!currentImpl) return;
  shaderGeneration += 1;
  for (const entry of registry) {
    const patch = currentImpl.patchShaderBeforeCompile(entry.uniforms);
    entry.mat.onBeforeCompile = patch;
    entry.mat.needsUpdate = true;
    attachCacheKey(entry.mat);
    if (entry.depth) {
      entry.depth.onBeforeCompile = patch;
      entry.depth.needsUpdate = true;
      attachCacheKey(entry.depth);
    }
    if (entry.dist) {
      entry.dist.onBeforeCompile = patch;
      entry.dist.needsUpdate = true;
      attachCacheKey(entry.dist);
    }
  }
}
