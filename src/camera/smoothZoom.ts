import { Vector3, type PerspectiveCamera } from "three";
import type { OrbitControls } from "three-stdlib";
import {
    dampWheelScaleForAltitude,
    getControlsReferenceDistance,
    zoomSensitivityMultiplier,
} from "./cameraSensitivity";
import {
    anchorOnGroundAtCursor,
    groundDistanceAtCursor,
} from "./groundDistance";

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

const _offset = new Vector3();
const _delta = new Vector3();

export function wheelDeltaToScale(delta: number, speed = 0.01): number {
    let scale = 2 / (1 + Math.exp(-Math.abs(delta * speed)));
    if (delta < 0 && scale !== 0) {
        scale = 1 / scale;
    }
    return scale;
}

function groundZoomLimits(controls: OrbitControls): { min: number; max: number } {
    const ref = getControlsReferenceDistance(controls);
    return { min: Math.max(ref / 50, 10), max: ref * 20 };
}

function clampGroundDistance(controls: OrbitControls, d: number): number {
    const { min, max } = groundZoomLimits(controls);
    return Math.max(min, Math.min(max, d));
}

/**
 * Zoom toward the ground point under the cursor.
 * Camera and target move by the same delta so bearing is stable; slant range still changes.
 */
export function zoomAboutAnchor(
    controls: OrbitControls,
    camera: PerspectiveCamera,
    domElement: HTMLElement,
    clientX: number,
    clientY: number,
    distanceRatio: number,
): boolean {
    const anchor = anchorOnGroundAtCursor(
        camera,
        domElement,
        controls,
        clientX,
        clientY,
    );
    if (!anchor) {
        _offset.subVectors(camera.position, controls.target);
        if (_offset.lengthSq() < 1e-12) return false;
        _offset.multiplyScalar(distanceRatio);
        _delta.copy(controls.target).add(_offset).sub(camera.position);
        camera.position.add(_delta);
        controls.target.add(_delta);
        return true;
    }

    _offset.subVectors(camera.position, anchor);
    const dist = _offset.length();
    if (dist < 1e-6) return false;

    const limits = groundZoomLimits(controls);
    const nextDist = Math.max(limits.min, Math.min(limits.max, dist * distanceRatio));
    _offset.multiplyScalar(nextDist / dist);
    _delta.copy(anchor).add(_offset).sub(camera.position);
    camera.position.add(_delta);
    controls.target.add(_delta);
    return true;
}

export function attachSmoothWheelZoom(
    controls: OrbitControls,
    camera: PerspectiveCamera,
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

    const finishSmoothing = () => {
        if (!smoothing) return;
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
            finishSmoothing();
            ignoreWheelUntil = performance.now() + tuning.wheelCooldownMs;
        }, tuning.wheelIdleMs);
    };

    const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() < ignoreWheelUntil) return;

        cursorX = event.clientX;
        cursorY = event.clientY;

        const actualGround = groundDistanceAtCursor(
            camera,
            domElement,
            controls,
            cursorX,
            cursorY,
        );
        const speed =
            tuning.speed * zoomSensitivityMultiplier(actualGround, controls);
        let scale = wheelDeltaToScale(event.deltaY, speed);
        scale = dampWheelScaleForAltitude(scale, actualGround, controls);

        if (tuning.smoothMs <= 0) {
            zoomAboutAnchor(controls, camera, domElement, cursorX, cursorY, scale);
            return;
        }

        targetGroundDistance = clampGroundDistance(controls, actualGround * scale);
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
                finishSmoothing();
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
