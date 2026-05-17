import * as THREE from "three";
import type { PerspectiveCamera } from "three";
import type { OrbitControls } from "three-stdlib";
import { getSensitivityTuning } from "./cameraSensitivity";
import { groundDistanceAtCursor } from "./groundDistance";
import { TERRAIN_WORLD_UP } from "./mapControls";

const _right = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _move = new THREE.Vector3();

/** Meters shifted on the ground plane per pixel of pointer drag. */
export function groundMetersPerPixel(
    camera: PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
    clientX: number,
    clientY: number,
): number {
    const g = groundDistanceAtCursor(
        camera,
        domElement,
        controls,
        clientX,
        clientY,
    );
    const fovRad = (camera.fov * Math.PI) / 180;
    const base =
        (2 * g * Math.tan(fovRad / 2)) / Math.max(domElement.clientHeight, 1);
    const { panGain } = getSensitivityTuning();
    return base * panGain;
}

export function applyGroundPan(
    camera: PerspectiveCamera,
    controls: OrbitControls,
    domElement: HTMLElement,
    clientX: number,
    clientY: number,
    deltaX: number,
    deltaY: number,
): void {
    const mpp = groundMetersPerPixel(
        camera,
        controls,
        domElement,
        clientX,
        clientY,
    );
    _right.setFromMatrixColumn(camera.matrix, 0);
    _forward.crossVectors(TERRAIN_WORLD_UP, _right).normalize();
    _move
        .copy(_right)
        .multiplyScalar(-deltaX * mpp)
        .addScaledVector(_forward, deltaY * mpp);
    camera.position.add(_move);
    controls.target.add(_move);
}

/**
 * Left-drag pan on the Z=0 ground plane (replaces OrbitControls pan).
 * OrbitControls keeps rotate / middle dolly.
 */
export function attachGroundPlanePan(
    controls: OrbitControls,
    camera: PerspectiveCamera,
    domElement: HTMLElement,
): () => void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        domElement.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
        if (!dragging) return;
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        if (dx === 0 && dy === 0) return;
        applyGroundPan(
            camera,
            controls,
            domElement,
            event.clientX,
            event.clientY,
            dx,
            dy,
        );
    };

    const endDrag = (event: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        if (domElement.hasPointerCapture(event.pointerId)) {
            domElement.releasePointerCapture(event.pointerId);
        }
    };

    domElement.addEventListener("pointerdown", onPointerDown);
    domElement.addEventListener("pointermove", onPointerMove);
    domElement.addEventListener("pointerup", endDrag);
    domElement.addEventListener("pointercancel", endDrag);

    return () => {
        domElement.removeEventListener("pointerdown", onPointerDown);
        domElement.removeEventListener("pointermove", onPointerMove);
        domElement.removeEventListener("pointerup", endDrag);
        domElement.removeEventListener("pointercancel", endDrag);
    };
}
