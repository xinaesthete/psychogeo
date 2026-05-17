import type { PerspectiveCamera } from "three";
import type { OrbitControls } from "three-stdlib";

const referenceDistanceByControls = new WeakMap<OrbitControls, number>();

export type SensitivityTuning = {
    panGain: number;
    zoomGain: number;
    /** Used for wheel zoom speed scaling. */
    power: number;
};

export const DEFAULT_SENSITIVITY: SensitivityTuning = {
    panGain: 1,
    zoomGain: 1,
    power: 1,
};

let sensitivityTuning: SensitivityTuning = { ...DEFAULT_SENSITIVITY };

export function getSensitivityTuning(): Readonly<SensitivityTuning> {
    return sensitivityTuning;
}

export function setSensitivityTuning(partial: Partial<SensitivityTuning>): void {
    sensitivityTuning = { ...sensitivityTuning, ...partial };
}

export function setControlsReferenceDistance(
    controls: OrbitControls,
    referenceDistance: number,
): void {
    referenceDistanceByControls.set(controls, referenceDistance);
}

export function getControlsReferenceDistance(controls: OrbitControls): number {
    const ref = referenceDistanceByControls.get(controls);
    return ref !== undefined && ref > 0 ? ref : 3000;
}

/** Camera→target distance (viewing range in Z-up OSGB). */
export function viewScaleDistance(
    camera: PerspectiveCamera,
    controls: OrbitControls,
): number {
    const t = controls.target;
    const dx = camera.position.x - t.x;
    const dy = camera.position.y - t.y;
    const dz = camera.position.z - t.z;
    return Math.max(Math.hypot(dx, dy, dz), 1);
}

export function zoomSensitivityMultiplier(
    groundDistance: number,
    controls: OrbitControls,
): number {
    const ref = getControlsReferenceDistance(controls);
    const r = Math.max(groundDistance, 1) / ref;
    const { zoomGain, power } = sensitivityTuning;
    return zoomGain * Math.pow(r, power);
}

export function dampWheelScaleForAltitude(
    scale: number,
    groundDistance: number,
    controls: OrbitControls,
): number {
    const ref = getControlsReferenceDistance(controls);
    if (groundDistance >= ref) return scale;
    const t = groundDistance / ref;
    return 1 + (scale - 1) * t * t;
}
