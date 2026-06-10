import * as THREE from 'three';
import type { TileExtent } from './pyramidOsgb';

const ndcCorners = [
  new THREE.Vector3(-1, -1, 0),
  new THREE.Vector3(1, -1, 0),
  new THREE.Vector3(1, 1, 0),
  new THREE.Vector3(-1, 1, 0),
];

const scratchNdc = new THREE.Vector3();
const scratchNear = new THREE.Vector3();
const scratchFar = new THREE.Vector3();
const scratchWorld = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchForward = new THREE.Vector3();

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

function intersectGroundAlongViewRay(
  camera: THREE.Camera,
  ndcX: number,
  ndcY: number,
  target: THREE.Vector3,
): boolean {
  scratchNdc.set(ndcX, ndcY, 0);
  scratchNdc.unproject(camera);
  scratchNear.copy(scratchNdc);
  scratchNdc.set(ndcX, ndcY, 1);
  scratchNdc.unproject(camera);
  scratchFar.copy(scratchNdc);
  const origin = camera.position;
  scratchDir.copy(scratchFar).sub(scratchNear);
  if (Math.abs(scratchDir.z) < 1e-9) return false;
  const t = -origin.z / scratchDir.z;
  if (t < 0) return false;
  target.copy(origin).addScaledVector(scratchDir, t);
  return true;
}

function extendBoundsTowardHorizon(
  camera: THREE.Camera,
  bounds: TileExtent,
  hitCount: number,
): TileExtent {
  if (hitCount >= 4) return bounds;
  camera.getWorldDirection(scratchForward);
  const forwardGroundX = scratchForward.x;
  const forwardGroundY = scratchForward.y;
  const forwardGroundLen = Math.hypot(forwardGroundX, forwardGroundY);
  if (forwardGroundLen < 1e-9) return bounds;

  const altitude = Math.max(camera.position.z, 1);
  const pitch = Math.asin(
    THREE.MathUtils.clamp(scratchForward.z / scratchForward.length(), -1, 1),
  );
  const pitchAboveHorizon = Math.max(Math.PI / 2 - Math.abs(pitch), 0.05);
  const horizonReach = Math.min(
    altitude / Math.tan(pitchAboveHorizon),
    camera instanceof THREE.PerspectiveCamera ? camera.far : 100_000,
  );
  const reach = hitCount === 0 ? Math.max(horizonReach, 5000) : horizonReach;
  const horizonEast = camera.position.x + (forwardGroundX / forwardGroundLen) * reach;
  const horizonNorth = camera.position.y + (forwardGroundY / forwardGroundLen) * reach;

  return {
    eastMin: Math.min(bounds.eastMin, horizonEast),
    eastMax: Math.max(bounds.eastMax, horizonEast),
    northMin: Math.min(bounds.northMin, horizonNorth),
    northMax: Math.max(bounds.northMax, horizonNorth),
  };
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
    const hit =
      intersectGroundAlongViewRay(camera, corner.x, corner.y, scratchWorld) ||
      intersectGroundPlane(camera, corner, scratchWorld);
    if (!hit) continue;
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

  const bounds = { eastMin, eastMax, northMin, northMax };
  return extendBoundsTowardHorizon(camera, bounds, hitCount);
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
