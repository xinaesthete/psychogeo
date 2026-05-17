import * as THREE from "three";
import { MOUSE, TOUCH } from "three";
import { OrbitControls } from "three-stdlib";
import type { EastNorth } from "../geo/Coordinates";
import { setControlsReferenceDistance } from "./cameraSensitivity";
import { attachGroundPlanePan } from "./groundPan";
import { attachSmoothWheelZoom } from "./smoothZoom";

export type MapControlsOptions = {
    initialDistance?: number;
    referenceDistance?: number;
};

const DEFAULT_MIN_POLAR = 0.15;
const DEFAULT_MAX_POLAR = Math.PI / 2 - 0.05;

export const TERRAIN_WORLD_UP = new THREE.Vector3(0, 0, 1);

export function configureTerrainCamera(camera: THREE.PerspectiveCamera): void {
    camera.up.copy(TERRAIN_WORLD_UP);
}

export function createMapStyleControls(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    options: MapControlsOptions = {},
): OrbitControls {
    const controls = new OrbitControls(camera, domElement);
    applyMapStylePreset(controls);
    const refDistance =
        options.referenceDistance ?? options.initialDistance ?? 3000;
    if (options.initialDistance !== undefined) {
        configureTerrainZoomLimits(controls, options.initialDistance);
    }
    setControlsReferenceDistance(controls, refDistance);

    const detachPan = attachGroundPlanePan(controls, camera, domElement);
    const detachSmoothZoom = attachSmoothWheelZoom(controls, camera, domElement);

    const nativeDispose = controls.dispose.bind(controls);
    controls.dispose = () => {
        detachSmoothZoom();
        detachPan();
        nativeDispose();
    };
    return controls;
}

export function enhanceMapStyleControls(
    controls: OrbitControls,
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    referenceDistance = 3000,
): () => void {
    applyMapStylePreset(controls);
    setControlsReferenceDistance(controls, referenceDistance);
    const detachPan = attachGroundPlanePan(controls, camera, domElement);
    const detachZoom = attachSmoothWheelZoom(controls, camera, domElement);
    return () => {
        detachZoom();
        detachPan();
    };
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
    controls.enablePan = false;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.enableDamping = false;
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
    setControlsReferenceDistance(controls, camZ);
    controls.target.set(coord.east, coord.north, 0);
    camera.position.set(coord.east, coord.north, camZ);
    controls.update();
}

const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _intersection = new THREE.Vector3();

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

export const mapStyleOrbitProps = {
    screenSpacePanning: false,
    zoomToCursor: true,
    enableDamping: false,
    enableZoom: false,
    enablePan: false,
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
