import * as THREE from "three";
import { MOUSE, TOUCH } from "three";
import { OrbitControls } from "three-stdlib";
import type { EastNorth } from "../geo/Coordinates";

export type MapControlsOptions = {
    /** Initial camera distance; also used to derive min/max zoom when set. */
    initialDistance?: number;
};

const DEFAULT_MIN_POLAR = 0.15;
const DEFAULT_MAX_POLAR = Math.PI / 2 - 0.05;

/** Scene uses OSGB east/north on XY and elevation on Z (not Three.js default Y-up). */
export const TERRAIN_WORLD_UP = new THREE.Vector3(0, 0, 1);

export function configureTerrainCamera(camera: THREE.PerspectiveCamera): void {
    camera.up.copy(TERRAIN_WORLD_UP);
}

/** Google Maps–style mouse/touch bindings on OrbitControls. */
export function createMapStyleControls(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    options: MapControlsOptions = {},
): OrbitControls {
    const controls = new OrbitControls(camera, domElement);
    applyMapStylePreset(controls);
    if (options.initialDistance !== undefined) {
        configureTerrainZoomLimits(controls, options.initialDistance);
    }
    return controls;
}

export function applyMapStylePreset(controls: OrbitControls): void {
    controls.mouseButtons = {
        LEFT: MOUSE.PAN,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.ROTATE,
    };
    controls.touches = {
        ONE: TOUCH.PAN,
        TWO: TOUCH.DOLLY_ROTATE,
    };
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minPolarAngle = DEFAULT_MIN_POLAR;
    controls.maxPolarAngle = DEFAULT_MAX_POLAR;
}

export function configureTerrainZoomLimits(controls: OrbitControls, camZ: number): void {
    controls.minDistance = Math.max(camZ / 50, 10);
    controls.maxDistance = camZ * 20;
}

export function setTerrainCameraTarget(
    controls: OrbitControls,
    camera: THREE.PerspectiveCamera,
    coord: EastNorth,
    camZ: number,
): void {
    configureTerrainCamera(camera);
    controls.target.set(coord.east, coord.north, 0);
    camera.position.set(coord.east, coord.north, camZ);
    // Let OrbitControls orient the camera; lookAt() assumes Y-up and breaks ground-plane pan.
    controls.update();
}

const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _intersection = new THREE.Vector3();

/** Double-click zooms toward the ground point under the cursor. */
export function attachDoubleClickZoom(
    controls: OrbitControls,
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    factor = 0.5,
): () => void {
    const onDblClick = (event: MouseEvent) => {
        const rect = domElement.getBoundingClientRect();
        _ndc.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        _raycaster.setFromCamera(_ndc, camera);
        if (!_raycaster.ray.intersectPlane(_plane, _intersection)) return;

        controls.target.copy(_intersection);
        const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
        offset.multiplyScalar(factor);
        camera.position.copy(controls.target).add(offset);
        controls.update();
    };
    domElement.addEventListener("dblclick", onDblClick);
    return () => domElement.removeEventListener("dblclick", onDblClick);
}

/** Props compatible with @react-three/drei OrbitControls. */
export const mapStyleOrbitProps = {
    screenSpacePanning: false,
    zoomToCursor: true,
    enableDamping: true,
    dampingFactor: 0.08,
    minPolarAngle: DEFAULT_MIN_POLAR,
    maxPolarAngle: DEFAULT_MAX_POLAR,
    mouseButtons: {
        LEFT: MOUSE.PAN,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.ROTATE,
    },
    touches: {
        ONE: TOUCH.PAN,
        TWO: TOUCH.DOLLY_ROTATE,
    },
} as const;
