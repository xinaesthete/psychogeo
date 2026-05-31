import * as THREE from "three";
import type { PerspectiveCamera } from "three";
import type { EastNorth } from "../geo/Coordinates";
import { setControlsReferenceDistance } from "./cameraSensitivity";
import { MapCameraControls, type MapCameraControlsOptions } from "./MapCameraControls";

export type MapControlsOptions = MapCameraControlsOptions & {
    initialDistance?: number;
};

export const TERRAIN_WORLD_UP = new THREE.Vector3(0, 0, 1);

export function configureTerrainCamera(camera: PerspectiveCamera): void {
    camera.up.set(0, 0, 1);
}

export function createMapStyleControls(
    camera: PerspectiveCamera,
    domElement: HTMLElement,
    options: MapControlsOptions = {},
): MapCameraControls {
    const refDistance =
        options.referenceDistance ?? options.initialDistance ?? 3000;
    const controls = new MapCameraControls(camera, domElement, {
        referenceDistance: refDistance,
        rotateSpeed: options.rotateSpeed,
        pickWorldPoint: options.pickWorldPoint,
        onAnchorPoint: options.onAnchorPoint,
        onDoubleClickAnchorPoint: options.onDoubleClickAnchorPoint,
    });
    if (options.initialDistance !== undefined) {
        controls.configureZoomLimits(options.initialDistance);
    }
    setControlsReferenceDistance(controls, refDistance);
    return controls;
}

/** @deprecated Use createMapStyleControls — there is no separate enhance step. */
export function enhanceMapStyleControls(
    controls: MapCameraControls,
    _camera: PerspectiveCamera,
    _domElement: HTMLElement,
    referenceDistance = 3000,
): () => void {
    setControlsReferenceDistance(controls, referenceDistance);
    return () => {};
}

export function configureTerrainZoomLimits(
    controls: MapCameraControls,
    camZ: number,
): void {
    controls.configureZoomLimits(camZ);
}

export function setTerrainCameraTarget(
    controls: MapCameraControls,
    _camera: PerspectiveCamera,
    coord: EastNorth,
    camZ: number,
): void {
    controls.setTerrainTarget(coord, camZ);
}
