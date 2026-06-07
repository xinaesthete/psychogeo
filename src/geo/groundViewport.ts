import * as THREE from 'three';
import type { TileExtent } from './pyramidOsgb';

const ndcCorners = [
  new THREE.Vector3(-1, -1, 0),
  new THREE.Vector3(1, -1, 0),
  new THREE.Vector3(1, 1, 0),
  new THREE.Vector3(-1, 1, 0),
];

const scratchNdc = new THREE.Vector3();
const scratchWorld = new THREE.Vector3();
const scratchDir = new THREE.Vector3();

function intersectGroundPlane(
  camera: THREE.Camera,
  ndc: THREE.Vector3,
  target: THREE.Vector3,
): boolean {
  scratchNdc.copy(ndc);
  scratchNdc.unproject(camera);
  const origin = camera.position;
  scratchDir.copy(scratchNdc).sub(origin);
  if (Math.abs(scratchDir.z) < 1e-9) return false;
  const t = -origin.z / scratchDir.z;
  if (t < 0) return false;
  target.copy(origin).addScaledVector(scratchDir, t);
  return true;
}

/** OSGB ground-plane bounds visible to the camera (z = 0). */
export function groundViewportBounds(camera: THREE.Camera): TileExtent {
  camera.updateMatrixWorld(true);
  let eastMin = Infinity;
  let eastMax = -Infinity;
  let northMin = Infinity;
  let northMax = -Infinity;
  let hitCount = 0;

  for (const corner of ndcCorners) {
    if (!intersectGroundPlane(camera, corner, scratchWorld)) continue;
    eastMin = Math.min(eastMin, scratchWorld.x);
    eastMax = Math.max(eastMax, scratchWorld.x);
    northMin = Math.min(northMin, scratchWorld.y);
    northMax = Math.max(northMax, scratchWorld.y);
    hitCount += 1;
  }

  if (hitCount === 0) {
    const fallback = 5000;
    return {
      eastMin: camera.position.x - fallback,
      eastMax: camera.position.x + fallback,
      northMin: camera.position.y - fallback,
      northMax: camera.position.y + fallback,
    };
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
