export const DEFAULT_VIEWSHED_SOURCE_HEIGHT = 1.7;
export const DEFAULT_VIEWSHED_SHADOW_RADIUS = 10_000;
export const DEFAULT_VIEWSHED_SHADOW_MAP_SIZE = 2048;
export const DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE = 2;

const MIN_SHADOW_RADIUS = 10;
const MIN_SHADOW_MAP_SIZE = 256;
const MAX_SHADOW_MAP_SIZE = 8192;
const MIN_SHADOW_NEAR = 0.01;

export type ViewshedShadowOptions = {
  radius?: number;
  mapSize?: number;
  near?: number;
  sourceHeight?: number;
  nearScale?: number;
};

export type ViewshedShadowConfig = {
  radius: number;
  mapSize: number;
  near: number;
  nearScale: number;
};

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export function resolveViewshedShadowConfig(
  options: ViewshedShadowOptions = {},
): ViewshedShadowConfig {
  const radius = Math.max(
    MIN_SHADOW_RADIUS,
    finiteOrDefault(options.radius, DEFAULT_VIEWSHED_SHADOW_RADIUS),
  );
  const nearScale = Math.max(
    0,
    finiteOrDefault(options.nearScale, DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE),
  );
  const derivedNear =
    finiteOrDefault(options.sourceHeight, DEFAULT_VIEWSHED_SOURCE_HEIGHT) *
    nearScale;
  const near = Math.max(
    MIN_SHADOW_NEAR,
    Math.min(finiteOrDefault(options.near, derivedNear), radius * 0.5),
  );
  const mapSize = Math.max(
    MIN_SHADOW_MAP_SIZE,
    Math.min(
      MAX_SHADOW_MAP_SIZE,
      Math.round(finiteOrDefault(options.mapSize, DEFAULT_VIEWSHED_SHADOW_MAP_SIZE)),
    ),
  );
  return { radius, mapSize, near, nearScale };
}

export function viewshedAwareLodDistance(
  renderCameraDistance: number,
  viewshedDistance: number,
  viewshedRadius: number,
): number {
  if (viewshedRadius <= 0 || viewshedDistance > viewshedRadius) {
    return renderCameraDistance;
  }
  return Math.min(renderCameraDistance, viewshedDistance);
}
