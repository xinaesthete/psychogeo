export const DEFAULT_VIEWSHED_SOURCE_HEIGHT = 1.7;
export const DEFAULT_VIEWSHED_SHADOW_RADIUS = 10_000;
export const DEFAULT_VIEWSHED_SHADOW_MAP_SIZE = 2048;
export const DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE = 2;
export const DEFAULT_VIEWSHED_EFFECTIVE_EARTH_RADIUS = 6_371_000;
export const DEFAULT_VIEWSHED_REFRACTION_FACTOR = 1;

const MIN_SHADOW_RADIUS = 10;
const MIN_SHADOW_MAP_SIZE = 256;
const MAX_SHADOW_MAP_SIZE = 8192;
const MIN_SHADOW_NEAR = 0.01;
const MIN_EFFECTIVE_EARTH_RADIUS = 1_000;
const MIN_REFRACTION_FACTOR = 0.1;
const MAX_REFRACTION_FACTOR = 10;

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

export type ViewshedGeoidProjectionOptions = {
  enabled?: boolean;
  effectiveEarthRadius?: number;
  refractionFactor?: number;
};

export type ViewshedGeoidProjectionConfig = {
  enabled: boolean;
  earthRadius: number;
  refractionFactor: number;
  effectiveRadius: number;
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

export function resolveViewshedGeoidProjectionConfig(
  options: ViewshedGeoidProjectionOptions = {},
): ViewshedGeoidProjectionConfig {
  const earthRadius = Math.max(
    MIN_EFFECTIVE_EARTH_RADIUS,
    finiteOrDefault(
      options.effectiveEarthRadius,
      DEFAULT_VIEWSHED_EFFECTIVE_EARTH_RADIUS,
    ),
  );
  const refractionFactor = Math.max(
    MIN_REFRACTION_FACTOR,
    Math.min(
      MAX_REFRACTION_FACTOR,
      finiteOrDefault(
        options.refractionFactor,
        DEFAULT_VIEWSHED_REFRACTION_FACTOR,
      ),
    ),
  );
  return {
    enabled: options.enabled ?? false,
    earthRadius,
    refractionFactor,
    effectiveRadius: earthRadius * refractionFactor,
  };
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
