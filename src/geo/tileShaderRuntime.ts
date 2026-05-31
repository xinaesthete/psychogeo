import * as THREE from 'three';

/** Per-material uniform bag (per-tile refs + shared tileShaderUniforms). */
export type TileUniformBag = Record<string, THREE.IUniform>;

/**
 * Stable shared uniforms — same object identity for Leva, materials, and HMR.
 * Keys are added by the hot-reloadable module via `ensureUniforms`; values are preserved across reloads.
 */
export const tileShaderUniforms: Record<string, THREE.IUniform> = {};

export function mergeTileUniforms(perTile: TileUniformBag): TileUniformBag {
  return { ...tileShaderUniforms, ...perTile };
}

type PatchBeforeCompile = NonNullable<THREE.Material['onBeforeCompile']>;

export type TileShaderFrameContext = {
  uniforms: typeof tileShaderUniforms;
  dt: number;
  nowMs: number;
};

/** Hot-reloadable tile shader module (see TileShader.ts). */
export type TileShaderModule = {
  /** Register any missing uniform keys on the stable shared bag (do not reset existing values). */
  ensureUniforms: (shared: typeof tileShaderUniforms) => void;
  /** Per-frame logic (contour phase, etc.) — replaced on HMR without losing uniform values. */
  updateFrame: (ctx: TileShaderFrameContext) => void;
  patchShaderBeforeCompile: (uniforms: TileUniformBag) => PatchBeforeCompile;
  createTileLoadingMaterial: () => THREE.ShaderMaterial;
  createTerrainPickMaterial: (uniforms: TileUniformBag) => THREE.ShaderMaterial;
  applyCustomDepthForViewshed: (mesh: THREE.Mesh) => void;
};

type RegisteredEntry = {
  mat: THREE.MeshStandardMaterial;
  perTileUniforms: TileUniformBag;
  depth?: THREE.MeshDepthMaterial;
  dist?: THREE.MeshDistanceMaterial;
};

let currentModule: TileShaderModule | null = null;
let shaderGeneration = 0;
let tileLoadingMaterial: THREE.ShaderMaterial | null = null;
let lastTickMs = 0;

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

/**
 * Install or hot-reload the tile shader module: sync uniforms, refresh loading material,
 * re-merge uniforms on all registered tiles, recompile GPU programs.
 */
export function installTileShaderModule(module: TileShaderModule): void {
  currentModule = module;
  module.ensureUniforms(tileShaderUniforms);
  tileLoadingMaterial = module.createTileLoadingMaterial();
  applyModuleUpdate();
}

/** Re-run after HMR when GLSL, uniform layout, or update logic changed. */
export function applyModuleUpdate(): void {
  recompileRegisteredMaterials();
}

/** Once per frame before terrain render (Threact + R3F). Survives HMR via module delegate. */
export function tickTileShader(nowMs = performance.now()): void {
  if (!currentModule) return;
  const dt = lastTickMs > 0 ? Math.min((nowMs - lastTickMs) / 1000, 0.2) : 0;
  lastTickMs = nowMs;
  currentModule.updateFrame({ uniforms: tileShaderUniforms, dt, nowMs });
}

/** @deprecated Use tickTileShader */
export const advanceContourPhase = tickTileShader;

export function getTileLoadingMaterial(): THREE.ShaderMaterial {
  if (!tileLoadingMaterial) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  return tileLoadingMaterial;
}

export function getTileMaterial(perTileUniforms: TileUniformBag): THREE.MeshStandardMaterial {
  if (!currentModule) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  const uniforms = mergeTileUniforms(perTileUniforms);
  const mat = new THREE.MeshStandardMaterial({ flatShading: false });
  mat.onBeforeCompile = currentModule.patchShaderBeforeCompile(uniforms);
  attachCacheKey(mat);
  registerEntry({ mat, perTileUniforms });
  return mat;
}

export function getTilePickMaterial(perTileUniforms: TileUniformBag): THREE.ShaderMaterial {
  if (!currentModule) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  return currentModule.createTerrainPickMaterial(mergeTileUniforms(perTileUniforms));
}

export function applyCustomDepth(mesh: THREE.Mesh, perTileUniforms: TileUniformBag): void {
  if (!currentModule) {
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

  const patch = currentModule.patchShaderBeforeCompile(uniforms);
  depth.onBeforeCompile = patch;
  dist.onBeforeCompile = patch;
  attachCacheKey(depth);
  attachCacheKey(dist);

  const entry = [...registry].find((e) => e.mat === surface);
  if (entry) {
    entry.depth = depth;
    entry.dist = dist;
  } else {
    registerEntry({ mat: surface, perTileUniforms });
  }
}

export function applyCustomDepthForViewshed(mesh: THREE.Mesh): void {
  if (!currentModule) {
    throw new Error('TileShader not installed — import ./TileShader from the app entry');
  }
  currentModule.applyCustomDepthForViewshed(mesh);
}

export function recompileRegisteredMaterials(): void {
  if (!currentModule) return;
  shaderGeneration += 1;
  for (const entry of registry) {
    const uniforms = mergeTileUniforms(entry.perTileUniforms);
    const patch = currentModule.patchShaderBeforeCompile(uniforms);
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
