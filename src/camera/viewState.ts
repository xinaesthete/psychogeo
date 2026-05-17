import * as THREE from "three";
import type { OrbitControls } from "three-stdlib";
import { configureTerrainCamera, TERRAIN_WORLD_UP } from "./mapControls";
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

const _yUp = new THREE.Vector3(0, 1, 0);
const _offset = new THREE.Vector3();
const _spherical = new THREE.Spherical();
const _quat = new THREE.Quaternion();
const _quatInverse = new THREE.Quaternion();

/** Match OrbitControls internal Y-up spherical coords while the scene is Z-up. */
function worldOffsetToSpherical(offset: THREE.Vector3, worldUp: THREE.Vector3): THREE.Spherical {
    _quat.setFromUnitVectors(worldUp, _yUp);
    _offset.copy(offset).applyQuaternion(_quat);
    return _spherical.setFromVector3(_offset);
}

function sphericalToWorldOffset(spherical: THREE.Spherical, worldUp: THREE.Vector3): THREE.Vector3 {
    _offset.setFromSpherical(spherical);
    _quatInverse.copy(_quat.setFromUnitVectors(worldUp, _yUp)).invert();
    return _offset.applyQuaternion(_quatInverse);
}

export function terrainViewStateFromCamera(
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
): TerrainViewState {
    _offset.subVectors(camera.position, target);
    worldOffsetToSpherical(_offset, camera.up);
    return {
        target: { east: target.x, north: target.y },
        distance: _spherical.radius,
        bearing: _spherical.theta,
        pitch: Math.PI / 2 - _spherical.phi,
    };
}

export function applyTerrainViewState(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    state: TerrainViewState,
): void {
    configureTerrainCamera(camera);
    controls.target.set(state.target.east, state.target.north, 0);
    _spherical.radius = state.distance;
    _spherical.theta = state.bearing;
    _spherical.phi = Math.PI / 2 - state.pitch;
    sphericalToWorldOffset(_spherical, TERRAIN_WORLD_UP);
    camera.position.copy(controls.target).add(_offset);
    controls.update();
}

export function onTerrainViewStateChange(
    controls: OrbitControls,
    camera: THREE.PerspectiveCamera,
    listener: (state: TerrainViewState) => void,
): () => void {
    const handler = () => {
        listener(terrainViewStateFromCamera(camera, controls.target));
    };
    controls.addEventListener("change", handler);
    return () => controls.removeEventListener("change", handler);
}
