import * as THREE from "three";
import type { PerspectiveCamera } from "three";
import type { OrbitControls } from "three-stdlib";
/** Horizontal ground plane (terrain target elevation is Z=0 in OSGB setup). */
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _anchor = new THREE.Vector3();
const _viewDir = new THREE.Vector3();

function anchorUnderCursor(
    camera: PerspectiveCamera,
    domElement: HTMLElement,
    controls: OrbitControls,
    clientX: number,
    clientY: number,
): THREE.Vector3 | null {
    const rect = domElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    _ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    camera.updateMatrixWorld();
    _raycaster.setFromCamera(_ndc, camera);
    return _raycaster.ray.intersectPlane(GROUND_PLANE, _anchor) ? _anchor : null;
}

/** Slant range from camera to the ground plane along the view ray (meters). */
export function groundDistanceAtCursor(
    camera: PerspectiveCamera,
    domElement: HTMLElement,
    controls: OrbitControls,
    clientX: number,
    clientY: number,
): number {
    const anchor = anchorUnderCursor(camera, domElement, controls, clientX, clientY);
    if (anchor) {
        return Math.max(camera.position.distanceTo(anchor), 1);
    }

    camera.getWorldDirection(_viewDir);
    if (Math.abs(_viewDir.z) < 1e-6) {
        return Math.max(camera.position.z, 1);
    }
    const t = -camera.position.z / _viewDir.z;
    if (t <= 0) {
        return Math.max(camera.position.z, 1);
    }
    return Math.max(t, 1);
}

export function anchorOnGroundAtCursor(
    camera: PerspectiveCamera,
    domElement: HTMLElement,
    controls: OrbitControls,
    clientX: number,
    clientY: number,
): THREE.Vector3 | null {
    return anchorUnderCursor(camera, domElement, controls, clientX, clientY);
}
