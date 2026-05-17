import * as THREE from "three";
import type { PerspectiveCamera } from "three";
import { configureTerrainCamera, TERRAIN_WORLD_UP } from "./mapControls";
import type { MapCameraControls } from "./MapCameraControls";
import type { EastNorth } from "../geo/Coordinates";

/** OSGB-native camera view for the Three.js terrain renderer. */
export type TerrainViewState = {
    target: EastNorth;
    distance: number;
    /** Radians, azimuth around Z (0 = +Y / north in scene space). */
    bearing: number;
    /** Radians above the horizontal plane. */
    pitch: number;
};

/** Typical 3D map oblique view (radians above horizon). */
export const OBLIQUE_PITCH = Math.PI / 4;

const _yUp = new THREE.Vector3(0, 1, 0);
const _offset = new THREE.Vector3();
const _spherical = new THREE.Spherical();
const _quat = new THREE.Quaternion();
const _quatInverse = new THREE.Quaternion();
const _basisMatrix = new THREE.Matrix4();
const _basisRight = new THREE.Vector3();
const _basisUp = new THREE.Vector3();
const _negViewDir = new THREE.Vector3();

function worldOffsetToSpherical(
    offset: THREE.Vector3,
    worldUp: THREE.Vector3,
): THREE.Spherical {
    _quat.setFromUnitVectors(worldUp, _yUp);
    _offset.copy(offset).applyQuaternion(_quat);
    return _spherical.setFromVector3(_offset);
}

function sphericalToWorldOffset(
    spherical: THREE.Spherical,
    worldUp: THREE.Vector3,
): THREE.Vector3 {
    _offset.setFromSpherical(spherical);
    _quatInverse.copy(_quat.setFromUnitVectors(worldUp, _yUp)).invert();
    return _offset.applyQuaternion(_quatInverse);
}

export function readSphericalFromCamera(
    camera: PerspectiveCamera,
    target: THREE.Vector3,
): Pick<TerrainViewState, "distance" | "bearing" | "pitch"> {
    _offset.subVectors(camera.position, target);
    worldOffsetToSpherical(_offset, camera.up);
    return {
        distance: _spherical.radius,
        bearing: _spherical.theta,
        pitch: Math.PI / 2 - _spherical.phi,
    };
}

/**
 * Orient the camera to look along viewDirection with zero roll relative to worldUp.
 * The view axis is fixed, so points on that ray (including an off-center pivot) stay
 * on the same screen pixels.
 */
export function setCameraRollFreeViewDirection(
    camera: PerspectiveCamera,
    viewDirection: THREE.Vector3,
    worldUp: THREE.Vector3 = TERRAIN_WORLD_UP,
    headingFallback = 0,
): void {
    configureTerrainCamera(camera);
    _basisRight.crossVectors(viewDirection, worldUp);
    if (_basisRight.lengthSq() < 1e-10) {
        _basisRight.set(
            Math.cos(headingFallback),
            Math.sin(headingFallback),
            0,
        );
    }
    _basisRight.normalize();
    _basisUp.crossVectors(_basisRight, viewDirection).normalize();
    _negViewDir.copy(viewDirection).negate();
    _basisMatrix.makeBasis(_basisRight, _basisUp, _negViewDir);
    camera.quaternion.setFromRotationMatrix(_basisMatrix);
    camera.up.copy(worldUp);
    camera.updateMatrixWorld();
}

export function applySphericalToCamera(
    camera: PerspectiveCamera,
    target: THREE.Vector3,
    bearing: number,
    pitch: number,
    distance: number,
): void {
    configureTerrainCamera(camera);
    _spherical.radius = distance;
    _spherical.theta = bearing;
    _spherical.phi = Math.PI / 2 - pitch;
    sphericalToWorldOffset(_spherical, TERRAIN_WORLD_UP);
    camera.position.copy(target).add(_offset);
    camera.lookAt(target);
    camera.up.copy(TERRAIN_WORLD_UP);
    camera.updateMatrixWorld();
}

export function terrainViewStateFromCamera(
    camera: PerspectiveCamera,
    target: THREE.Vector3,
): TerrainViewState {
    const s = readSphericalFromCamera(camera, target);
    return {
        target: { east: target.x, north: target.y },
        ...s,
    };
}

export function applyTerrainViewState(
    controls: MapCameraControls,
    state: TerrainViewState,
): void {
    controls.setViewState(state);
}

export function resetNorthUpOblique(
    controls: MapCameraControls,
    pitch = OBLIQUE_PITCH,
): void {
    controls.resetNorthUpOblique(pitch);
}

export function onTerrainViewStateChange(
    controls: MapCameraControls,
    listener: (state: TerrainViewState) => void,
): () => void {
    const handler = () => {
        listener(controls.getViewState());
    };
    controls.addEventListener("change", handler);
    return () => controls.removeEventListener("change", handler);
}
