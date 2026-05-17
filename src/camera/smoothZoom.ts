import * as THREE from "three";
import type { OrbitControls } from "three-stdlib";
import {
    dampWheelScaleForAltitude,
    getControlsReferenceDistance,
    zoomSensitivityMultiplier,
} from "./cameraSensitivity";
import { TERRAIN_WORLD_UP } from "./mapControls";

export type SmoothZoomOptions = {
    speed?: number;
    smoothMs?: number;
    wheelIdleMs?: number;
    wheelCooldownMs?: number;
};

export const DEFAULT_SMOOTH_ZOOM: Required<SmoothZoomOptions> = {
    speed: 0.035,
    smoothMs: 90,
    wheelIdleMs: 80,
    wheelCooldownMs: 180,
};

let tuning: Required<SmoothZoomOptions> = { ...DEFAULT_SMOOTH_ZOOM };

export function getSmoothZoomTuning(): Readonly<Required<SmoothZoomOptions>> {
    return tuning;
}

export function setSmoothZoomTuning(partial: SmoothZoomOptions): void {
    tuning = { ...tuning, ...partial };
}

const _plane = new THREE.Plane();
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _anchor = new THREE.Vector3();
const _offset = new THREE.Vector3();

export function wheelDeltaToScale(delta: number, speed = 0.01): number {
    let scale = 2 / (1 + Math.exp(-Math.abs(delta * speed)));
    if (delta < 0 && scale !== 0) {
        scale = 1 / scale;
    }
    return scale;
}

function groundPlane(controls: OrbitControls): THREE.Plane {
    _plane.setFromNormalAndCoplanarPoint(TERRAIN_WORLD_UP, controls.target);
    return _plane;
}

function anchorUnderCursor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    controls: OrbitControls,
    clientX: number,
    clientY: number,
): THREE.Vector3 | null {
    const rect = domElement.getBoundingClientRect();
    _ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    camera.updateMatrixWorld();
    _raycaster.setFromCamera(_ndc, camera);
    return _raycaster.ray.intersectPlane(groundPlane(controls), _anchor) ? _anchor : null;
}

export function groundDistanceAtCursor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    controls: OrbitControls,
    clientX: number,
    clientY: number,
): number {
    const anchor = anchorUnderCursor(camera, domElement, controls, clientX, clientY);
    if (anchor) {
        return Math.max(camera.position.distanceTo(anchor), 1);
    }
    return Math.max(camera.position.z - controls.target.z, 1);
}

function groundZoomLimits(controls: OrbitControls): { min: number; max: number } {
    const ref = getControlsReferenceDistance(controls);
    return { min: Math.max(ref / 50, 10), max: ref * 20 };
}

function clampGroundDistance(controls: OrbitControls, d: number): number {
    const { min, max } = groundZoomLimits(controls);
    return Math.max(min, Math.min(max, d));
}

/** Zoom about cursor; moves camera + target together (stable orbit bearing). */
export function zoomAboutAnchor(
    controls: OrbitControls,
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    clientX: number,
    clientY: number,
    distanceRatio: number,
): boolean {
    const anchor = anchorUnderCursor(camera, domElement, controls, clientX, clientY);
    if (!anchor) {
        _offset.subVectors(camera.position, controls.target);
        if (_offset.lengthSq() < 1e-12) return false;
        _offset.multiplyScalar(distanceRatio);
        camera.position.copy(controls.target).add(_offset);
        return true;
    }

    _offset.subVectors(camera.position, anchor);
    const dist = _offset.length();
    if (dist < 1e-6) return false;

    const limits = groundZoomLimits(controls);
    const nextDist = Math.max(limits.min, Math.min(limits.max, dist * distanceRatio));
    _offset.multiplyScalar(nextDist / dist);

    const newCamera = _anchor.copy(anchor).add(_offset);
    const delta = newCamera.clone().sub(camera.position);
    camera.position.copy(newCamera);
    controls.target.add(delta);
    return true;
}

export function attachSmoothWheelZoom(
    controls: OrbitControls,
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    options: SmoothZoomOptions = {},
): () => void {
    if (options.speed !== undefined || options.smoothMs !== undefined) {
        setSmoothZoomTuning(options);
    }

    controls.enableZoom = false;

    let targetGroundDistance = groundDistanceAtCursor(camera, domElement, controls, 0, 0);
    let cursorX = 0;
    let cursorY = 0;
    let smoothing = false;
    let wheelIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let ignoreWheelUntil = 0;

    const stopSmoothing = () => {
        smoothing = false;
        targetGroundDistance = groundDistanceAtCursor(
            camera,
            domElement,
            controls,
            cursorX,
            cursorY,
        );
    };

    const scheduleWheelIdle = () => {
        if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer);
        wheelIdleTimer = setTimeout(() => {
            wheelIdleTimer = undefined;
            stopSmoothing();
            ignoreWheelUntil = performance.now() + tuning.wheelCooldownMs;
        }, tuning.wheelIdleMs);
    };

    const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() < ignoreWheelUntil) return;

        cursorX = event.clientX;
        cursorY = event.clientY;

        const ground = groundDistanceAtCursor(
            camera,
            domElement,
            controls,
            cursorX,
            cursorY,
        );
        const speed =
            tuning.speed * zoomSensitivityMultiplier(ground, controls);
        let scale = wheelDeltaToScale(event.deltaY, speed);
        scale = dampWheelScaleForAltitude(scale, ground, controls);

        if (tuning.smoothMs <= 0) {
            zoomAboutAnchor(controls, camera, domElement, cursorX, cursorY, scale);
            return;
        }

        targetGroundDistance = clampGroundDistance(controls, ground * scale);
        smoothing = true;
        scheduleWheelIdle();
    };

    const panWrappedUpdate = controls.update.bind(controls);
    controls.update = function updateWithSmoothZoom() {
        if (smoothing) {
            const current = groundDistanceAtCursor(
                camera,
                domElement,
                controls,
                cursorX,
                cursorY,
            );
            const alpha = 1 - Math.exp(-20 / tuning.smoothMs);
            const next = current + (targetGroundDistance - current) * alpha;
            const ratio = current > 1e-6 ? next / current : 1;
            zoomAboutAnchor(controls, camera, domElement, cursorX, cursorY, ratio);
            if (
                Math.abs(
                    targetGroundDistance -
                        groundDistanceAtCursor(
                            camera,
                            domElement,
                            controls,
                            cursorX,
                            cursorY,
                        ),
                ) < 0.5
            ) {
                smoothing = false;
            }
            return true;
        }
        return panWrappedUpdate();
    };

    domElement.addEventListener("wheel", onWheel, { passive: false, capture: true });

    return () => {
        if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer);
        domElement.removeEventListener("wheel", onWheel, { capture: true });
        controls.update = panWrappedUpdate;
        controls.enableZoom = true;
    };
}
