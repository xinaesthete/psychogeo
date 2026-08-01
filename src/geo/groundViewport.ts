import * as THREE from 'three';
import type { TileExtent } from './pyramidOsgb';

const ndcCorners: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Cap on how far ground-plane bounds extend from the camera (metres). */
const MAX_GROUND_REACH_METRES = 1_000_000;

const scratchNear = new THREE.Vector3();
const scratchFar = new THREE.Vector3();
const scratchDir = new THREE.Vector3();

function groundReach(camera: THREE.Camera): number {
  const far =
    camera instanceof THREE.PerspectiveCamera ? camera.far : MAX_GROUND_REACH_METRES;
  return Math.min(far, MAX_GROUND_REACH_METRES);
}

/**
 * OSGB ground-plane bounds visible to the camera (z = 0).
 *
 * Each frustum corner ray contributes one point: its ground intersection
 * (clamped to the far-plane reach), or — when the ray passes at or above the
 * horizon — a point at full reach along the ray's own azimuth, since a flat
 * ground plane is visible out to the far plane under that ray. Keeping each
 * corner's azimuth preserves the wide lateral spread of the visible wedge
 * near the horizon. Bounds are seeded with the camera's ground position so
 * terrain underfoot survives extreme up-tilted views.
 */
export function groundViewportBounds(camera: THREE.Camera): TileExtent {
  camera.updateMatrixWorld(true);
  const reach = groundReach(camera);
  const origin = camera.position;
  let eastMin = origin.x;
  let eastMax = origin.x;
  let northMin = origin.y;
  let northMax = origin.y;

  for (const [x, y] of ndcCorners) {
    scratchNear.set(x, y, 0).unproject(camera);
    scratchFar.set(x, y, 1).unproject(camera);
    scratchDir.subVectors(scratchFar, scratchNear);

    let east: number;
    let north: number;
    const t =
      Math.abs(scratchDir.z) > 1e-12 ? -scratchNear.z / scratchDir.z : -1;
    if (t > 0) {
      east = scratchNear.x + scratchDir.x * t;
      north = scratchNear.y + scratchDir.y * t;
      const dx = east - origin.x;
      const dy = north - origin.y;
      const d = Math.hypot(dx, dy);
      if (d > reach) {
        east = origin.x + (dx / d) * reach;
        north = origin.y + (dy / d) * reach;
      }
    } else {
      const h = Math.hypot(scratchDir.x, scratchDir.y);
      if (h < 1e-12) continue;
      east = origin.x + (scratchDir.x / h) * reach;
      north = origin.y + (scratchDir.y / h) * reach;
    }

    eastMin = Math.min(eastMin, east);
    eastMax = Math.max(eastMax, east);
    northMin = Math.min(northMin, north);
    northMax = Math.max(northMax, north);
  }

  return { eastMin, eastMax, northMin, northMax };
}

export function viewportSpanMetres(bounds: TileExtent): number {
  return Math.max(bounds.eastMax - bounds.eastMin, bounds.northMax - bounds.northMin);
}

export function boundsChangedSignificantly(
  previous: TileExtent | null,
  next: TileExtent,
  thresholdFraction = 0.12,
): boolean {
  if (!previous) return true;
  const prevSpan = viewportSpanMetres(previous);
  const nextSpan = viewportSpanMetres(next);
  if (Math.abs(nextSpan - prevSpan) / Math.max(prevSpan, 1) > thresholdFraction) return true;
  const prevCx = (previous.eastMin + previous.eastMax) / 2;
  const prevCy = (previous.northMin + previous.northMax) / 2;
  const nextCx = (next.eastMin + next.eastMax) / 2;
  const nextCy = (next.northMin + next.northMax) / 2;
  const shift = Math.hypot(nextCx - prevCx, nextCy - prevCy);
  return shift / Math.max(prevSpan, 1) > thresholdFraction;
}

/** Pad bounds to chunk grid to avoid edge churn while panning. */
export function snapBoundsToGrid(bounds: TileExtent, stepMetres: number): TileExtent {
  if (stepMetres <= 0) return bounds;
  return {
    eastMin: Math.floor(bounds.eastMin / stepMetres) * stepMetres,
    eastMax: Math.ceil(bounds.eastMax / stepMetres) * stepMetres,
    northMin: Math.floor(bounds.northMin / stepMetres) * stepMetres,
    northMax: Math.ceil(bounds.northMax / stepMetres) * stepMetres,
  };
}

/** Ground span visible at camera distance (metres on ground). */
export function viewportMetresFromCameraDistance(
  camera: THREE.PerspectiveCamera,
  distanceMetres: number,
): number {
  const fovRad = (camera.fov * Math.PI) / 180;
  const span = 2 * distanceMetres * Math.tan(fovRad / 2);
  return span * Math.max(1, camera.aspect);
}
