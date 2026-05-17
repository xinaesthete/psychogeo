import type { PerspectiveCamera } from "three";
import type { MapCameraControls } from "./MapCameraControls";

const referenceDistanceByControls = new WeakMap<MapCameraControls, number>();

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
    controls: MapCameraControls,
    referenceDistance: number,
): void {
    referenceDistanceByControls.set(controls, referenceDistance);
}

export function getControlsReferenceDistance(controls: MapCameraControls): number {
    const ref = referenceDistanceByControls.get(controls);
    return ref !== undefined && ref > 0 ? ref : 3000;
}

/** Camera→target distance (viewing range in Z-up OSGB). */
export function viewScaleDistance(
    camera: PerspectiveCamera,
    target: { x: number; y: number; z: number },
): number {
    const dx = camera.position.x - target.x;
    const dy = camera.position.y - target.y;
    const dz = camera.position.z - target.z;
    return Math.max(Math.hypot(dx, dy, dz), 1);
}

export function zoomSensitivityMultiplier(
    groundDistance: number,
    controls: MapCameraControls,
): number {
    const ref = getControlsReferenceDistance(controls);
    const r = Math.max(groundDistance, 1) / ref;
    const { zoomGain, power } = sensitivityTuning;
    return zoomGain * Math.pow(r, power);
}

export function dampWheelScaleForAltitude(
    scale: number,
    groundDistance: number,
    controls: MapCameraControls,
): number {
    const ref = getControlsReferenceDistance(controls);
    if (groundDistance >= ref) return scale;
    const t = groundDistance / ref;
    return 1 + (scale - 1) * t * t;
}
