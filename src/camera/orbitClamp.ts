import * as THREE from "three";

export type OrbitPitchLimits = {
    /** Radians above horizon; the view may not tilt shallower than this. */
    minPitch: number;
    /** Radians above horizon; the view may not tilt steeper than this. */
    maxPitch: number;
    /** Camera must stay this many radians above the pivot's ground plane. */
    minOffsetElevation?: number;
};

const DEFAULT_MIN_OFFSET_ELEVATION = 0.02;

const _cross = new THREE.Vector3();

function clampNumber(value: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, value));
}

/**
 * Clamp a pitch rotation (radians about `axis`; positive tilts the view up
 * toward the horizon) for an orbit that rotates both the camera offset from
 * the pivot and the view direction by the same angle.
 *
 * Two constraints, both exact:
 * - The view direction is perpendicular to the pitch axis, so its elevation
 *   changes by exactly the rotation angle. Bounding it to
 *   [-maxPitch, -minPitch] means the view can never be rotated through nadir,
 *   which would flip the roll-free camera basis.
 * - The offset is generally NOT perpendicular to the axis (cursor-anchored
 *   pivot), so its post-rotation height is solved from
 *   z(θ) = A·cosθ + B·sinθ to keep the camera above the pivot's ground plane.
 *
 * If the current pose already violates a bound, the bound only prevents it
 * from getting worse — it never forces a jump.
 *
 * Preconditions: `axis` is unit length and horizontal (z = 0); `viewDir` is
 * unit length.
 */
export function clampOrbitElevation(
    offset: THREE.Vector3,
    viewDir: THREE.Vector3,
    axis: THREE.Vector3,
    elevation: number,
    limits: OrbitPitchLimits,
): number {
    const viewEl = Math.asin(clampNumber(viewDir.z, -1, 1));
    let lo = -limits.maxPitch - viewEl;
    let hi = -limits.minPitch - viewEl;

    const a = offset.z;
    const b = _cross.crossVectors(axis, offset).z;
    const r = Math.hypot(a, b);
    if (r > 1e-9) {
        const minOffsetEl =
            limits.minOffsetElevation ?? DEFAULT_MIN_OFFSET_ELEVATION;
        const zMin = offset.length() * Math.sin(minOffsetEl);
        const c = Math.asin(clampNumber(zMin / r, -1, 1));
        const phi = Math.atan2(a, b);
        lo = Math.max(lo, c - phi);
        hi = Math.min(hi, Math.PI - c - phi);
    }

    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
    return clampNumber(elevation, lo, hi);
}
