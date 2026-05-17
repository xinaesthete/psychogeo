import * as THREE from "three";
import type { OrbitControls } from "three-stdlib";
import { TERRAIN_WORLD_UP } from "./mapControls";

export type SmoothZoomOptions = {
    /** Scales wheel delta → zoom step (deck.gl default 0.01). */
    speed?: number;
    /** Smoothing time constant (ms); lower = snappier. */
    smoothMs?: number;
    /** Ms after last wheel event before zoom inertia is cancelled. */
    wheelIdleMs?: number;
    /** Ignore wheel deltas for this long after idle (trackpad momentum). */
    wheelCooldownMs?: number;
};

export const DEFAULT_SMOOTH_ZOOM: Required<SmoothZoomOptions> = {
    speed: 0.028,
    smoothMs: 90,
    wheelIdleMs: 80,
    wheelCooldownMs: 180,
};

/** Live tuning (e.g. from Leva); read on each wheel tick / frame. */
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

/** deck.gl-style wheel scale from pixel delta. */
export function wheelDeltaToScale(delta: number, speed = 0.01): number {
    let scale = 2 / (1 + Math.exp(-Math.abs(delta * speed)));
    if (delta < 0 && scale !== 0) {
        scale = 1 / scale;
    }
    return scale;
}

function distanceToTarget(controls: OrbitControls, camera: THREE.PerspectiveCamera): number {
    return camera.position.distanceTo(controls.target);
}

function clampDistance(controls: OrbitControls, d: number): number {
    return Math.max(controls.minDistance, Math.min(controls.maxDistance, d));
}

/** Ground plane through the orbit target (horizontal in Z-up OSGB space). */
function groundPlane(controls: OrbitControls): THREE.Plane {
    _plane.setFromNormalAndCoplanarPoint(TERRAIN_WORLD_UP, controls.target);
    return _plane;
}

/** World point on the ground under the cursor, if the ray hits the plane. */
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

/**
 * Zoom about the ground point under the cursor.
 * Camera and target move together so the orbit offset is unchanged — avoids a
 * lookAt() snap when OrbitControls.update() runs after smoothing ends.
 */
function zoomAboutAnchor(
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

    const nextDist = clampDistance(controls, dist * distanceRatio);
    _offset.multiplyScalar(nextDist / dist);

    const newCamera = _anchor.copy(anchor).add(_offset);
    const delta = newCamera.clone().sub(camera.position);
    camera.position.copy(newCamera);
    controls.target.add(delta);
    return true;
}

/**
 * deck.gl-style scroll zoom: delta-proportional scale + smooth approach to target distance.
 * Disables OrbitControls built-in wheel handling.
 */
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

    let targetDistance = distanceToTarget(controls, camera);
    let cursorX = 0;
    let cursorY = 0;
    let smoothing = false;
    let wheelIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let ignoreWheelUntil = 0;

    const stopSmoothing = () => {
        smoothing = false;
        targetDistance = distanceToTarget(controls, camera);
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
        if (performance.now() < ignoreWheelUntil) return;

        cursorX = event.clientX;
        cursorY = event.clientY;

        const scale = wheelDeltaToScale(event.deltaY, tuning.speed);
        const current = distanceToTarget(controls, camera);
        targetDistance = clampDistance(controls, current * scale);
        smoothing = true;
        scheduleWheelIdle();
    };

    const originalUpdate = controls.update.bind(controls);
    controls.update = function updateWithSmoothZoom() {
        if (smoothing) {
            const current = distanceToTarget(controls, camera);
            const alpha =
                tuning.smoothMs <= 0 ? 1 : 1 - Math.exp(-20 / tuning.smoothMs);
            const next = current + (targetDistance - current) * alpha;
            const ratio = current > 1e-6 ? next / current : 1;
            zoomAboutAnchor(controls, camera, domElement, cursorX, cursorY, ratio);
            if (Math.abs(targetDistance - distanceToTarget(controls, camera)) < 0.5) {
                smoothing = false;
            }
            return true;
        }
        return originalUpdate();
    };

    domElement.addEventListener("wheel", onWheel, { passive: false });

    return () => {
        if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer);
        domElement.removeEventListener("wheel", onWheel);
        controls.update = originalUpdate;
        controls.enableZoom = true;
    };
}
