import {
    EventDispatcher,
    Plane,
    Raycaster,
    Vector2,
    Vector3,
    type PerspectiveCamera,
} from "three";
import type { EastNorth } from "../geo/Coordinates";
import { getSensitivityTuning, setControlsReferenceDistance } from "./cameraSensitivity";
import { TERRAIN_WORLD_UP, configureTerrainCamera } from "./mapControls";
import { getPanInertiaTuning } from "./panInertia";
import {
    DEFAULT_SMOOTH_ZOOM,
    getSmoothZoomTuning,
    wheelDeltaToScale,
} from "./smoothZoom";
import {
    NADIR_PITCH,
    OBLIQUE_PITCH,
    type TerrainViewState,
    applySphericalToCamera,
    readSphericalFromCamera,
    setCameraRollFreeViewDirection,
} from "./viewState";

export type MapCameraControlsOptions = {
    referenceDistance?: number;
    rotateSpeed?: number;
    pickWorldPoint?: (clientX: number, clientY: number) => Vector3 | null;
    onAnchorPoint?: (point: Vector3, source: TerrainAnchorSource) => void;
    onDoubleClickAnchorPoint?: (point: Vector3) => void;
};

const GROUND_PLANE = new Plane(new Vector3(0, 0, 1), 0);
const _ndc = new Vector2();
const _raycaster = new Raycaster();
const _anchor = new Vector3();
const _viewDir = new Vector3();
const _right = new Vector3();
const _forward = new Vector3();
const _move = new Vector3();
const _offset = new Vector3();
const _delta = new Vector3();
const _axis = new Vector3();

type DragMode = "pan" | "rotate" | "dolly" | null;

type ActivePointer = { x: number; y: number };
export type TerrainAnchorSource = "terrain" | "ground-plane" | "target";
type AnchorOptions = {
    emit?: boolean;
};

/** Ignore pinch when finger span is below this (px). */
const MIN_PINCH_SPAN_PX = 24;

function normalizeAngleDelta(delta: number): number {
    let d = delta;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
}

type MapCameraControlsEventMap = {
    change: object;
    start: object;
    end: object;
};

/**
 * Map-style terrain camera: ground pan, cursor-anchored rotate and zoom.
 * Single spherical view state (bearing, pitch, distance) about a ground target.
 * Two-finger touch: horizontal pan, vertical pitch, pinch zoom, twist bearing.
 */
export class MapCameraControls extends EventDispatcher<MapCameraControlsEventMap> {
    readonly target = new Vector3();
    readonly camera: PerspectiveCamera;
    readonly domElement: HTMLElement;

    rotateSpeed = 1;
    minDistance = 10;
    maxDistance = 60_000;
    minPitch = 0.05;
    /** Radians above horizon; near π/2 allows near-nadir views. */
    maxPitch = NADIR_PITCH;

    private bearing = 0;
    private pitch = OBLIQUE_PITCH;
    private distance = 3000;

    private dragMode: DragMode = null;
    private lastPointerX = 0;
    private lastPointerY = 0;
    private rotatePivot = new Vector3();
    /** Slant range camera↔pivot, fixed for the duration of a right-drag. */
    private orbitRadius = 0;
    private readonly orbitStartOffset = new Vector3();
    private readonly orbitStartViewDir = new Vector3();
    private orbitStartBearing = 0;
    private orbitAz = 0;
    private orbitEl = 0;

    private smoothing = false;
    private targetGroundDistance = 1;
    private readonly zoomAnchor = new Vector3();
    private hasZoomAnchor = false;
    private wheelIdleTimer: ReturnType<typeof setTimeout> | undefined;
    private ignoreWheelUntil = 0;

    private panInertiaActive = false;
    private panVelX = 0;
    private panVelY = 0;
    private panMetersPerPixel = 1;
    private lastPanClientX = 0;
    private lastPanClientY = 0;
    private lastPointerMoveTime = 0;
    private lastUpdateTime = 0;

    private readonly activePointers = new Map<number, ActivePointer>();
    private touchGesture = false;
    private gestureSpan = 1;
    private gestureAngle = 0;
    private gestureMidX = 0;
    private gestureMidY = 0;
    private pickWorldPoint?: (clientX: number, clientY: number) => Vector3 | null;
    private onAnchorPoint?: (point: Vector3, source: TerrainAnchorSource) => void;
    private onDoubleClickAnchorPoint?: (point: Vector3) => void;

    constructor(
        camera: PerspectiveCamera,
        domElement: HTMLElement,
        options: MapCameraControlsOptions = {},
    ) {
        super();
        this.camera = camera;
        this.domElement = domElement;
        configureTerrainCamera(camera);

        const ref = options.referenceDistance ?? 3000;
        this.distance = ref;
        setControlsReferenceDistance(this, ref);
        if (options.rotateSpeed !== undefined) {
            this.rotateSpeed = options.rotateSpeed;
        }
        this.pickWorldPoint = options.pickWorldPoint;
        this.onAnchorPoint = options.onAnchorPoint;
        this.onDoubleClickAnchorPoint = options.onDoubleClickAnchorPoint;

        this.applyCameraFromState();
        this.domElement.style.touchAction = "none";
        this.bindListeners();
    }

    /** @deprecated OrbitControls compat — limits apply to slant range. */
    get minPolarAngle(): number {
        return Math.PI / 2 - this.maxPitch;
    }

    set minPolarAngle(v: number) {
        this.maxPitch = Math.PI / 2 - v;
    }

    get maxPolarAngle(): number {
        return Math.PI / 2 - this.minPitch;
    }

    set maxPolarAngle(v: number) {
        this.minPitch = Math.PI / 2 - v;
    }

    configureZoomLimits(camZ: number): void {
        this.minDistance = Math.max(camZ / 50, 10);
        this.maxDistance = camZ * 20;
        this.clampDistance();
        this.applyCameraFromState();
    }

    setTerrainTarget(coord: EastNorth, camZ: number): void {
        setControlsReferenceDistance(this, camZ);
        this.target.set(coord.east, coord.north, 0);
        this.distance = camZ;
        this.configureZoomLimits(camZ);
        this.applyCameraFromState();
        this.dispatchChange();
    }

    setWorldPickProvider(
        provider: ((clientX: number, clientY: number) => Vector3 | null) | undefined,
    ): void {
        this.pickWorldPoint = provider;
    }

    setAnchorPointListener(
        listener: ((point: Vector3, source: TerrainAnchorSource) => void) | undefined,
    ): void {
        this.onAnchorPoint = listener;
    }

    setDoubleClickAnchorPointListener(
        listener: ((point: Vector3) => void) | undefined,
    ): void {
        this.onDoubleClickAnchorPoint = listener;
    }

    getViewState(): TerrainViewState {
        return {
            target: { east: this.target.x, north: this.target.y },
            distance: this.distance,
            bearing: this.bearing,
            pitch: this.pitch,
        };
    }

    setViewState(state: TerrainViewState): void {
        this.target.set(state.target.east, state.target.north, 0);
        this.distance = state.distance;
        this.bearing = state.bearing;
        this.pitch = state.pitch;
        this.clampAngles();
        this.clampDistance();
        this.applyCameraFromState();
        this.dispatchChange();
    }

    resetNorthUp(): void {
        this.resetNorthUpOblique(NADIR_PITCH);
    }

    resetNorthUpOblique(pitch = OBLIQUE_PITCH): void {
        this.bearing = 0;
        this.pitch = pitch;
        this.clampAngles();
        this.applyCameraFromState();
        this.dispatchChange();
    }

    syncStateFromCamera(): void {
        const s = readSphericalFromCamera(this.camera, this.target);
        this.distance = s.distance;
        this.bearing = s.bearing;
        this.pitch = s.pitch;
        this.clampAngles();
        this.clampDistance();
    }

    applyCameraFromState(): void {
        applySphericalToCamera(
            this.camera,
            this.target,
            this.bearing,
            this.pitch,
            this.distance,
        );
    }

    update(): boolean {
        const now = performance.now();
        const dtSec =
            this.lastUpdateTime > 0
                ? Math.min((now - this.lastUpdateTime) / 1000, 0.05)
                : 0;
        this.lastUpdateTime = now;

        let changed = false;
        if (this.panInertiaActive && dtSec > 0) {
            changed = this.tickPanInertia(dtSec);
        }
        if (this.smoothing) {
            changed = this.tickSmoothZoom() || changed;
        }
        return changed;
    }

    dispose(): void {
        this.unbindListeners();
        if (this.wheelIdleTimer !== undefined) {
            clearTimeout(this.wheelIdleTimer);
        }
    }

    private clampDistance(): void {
        this.distance = Math.max(
            this.minDistance,
            Math.min(this.maxDistance, this.distance),
        );
    }

    private clampAngles(): void {
        this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch));
    }

    private dispatchChange(): void {
        this.dispatchEvent({ type: "change" });
    }

    private bindListeners(): void {
        const el = this.domElement;
        el.addEventListener("pointerdown", this.onPointerDown);
        el.addEventListener("pointermove", this.onPointerMove);
        el.addEventListener("pointerup", this.onPointerUp);
        el.addEventListener("pointercancel", this.onPointerUp);
        el.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
        el.addEventListener("contextmenu", this.onContextMenu);
        el.addEventListener("dblclick", this.onDblClick);
    }

    private unbindListeners(): void {
        const el = this.domElement;
        el.removeEventListener("pointerdown", this.onPointerDown);
        el.removeEventListener("pointermove", this.onPointerMove);
        el.removeEventListener("pointerup", this.onPointerUp);
        el.removeEventListener("pointercancel", this.onPointerUp);
        el.removeEventListener("wheel", this.onWheel, { capture: true });
        el.removeEventListener("contextmenu", this.onContextMenu);
        el.removeEventListener("dblclick", this.onDblClick);
    }

    private onContextMenu = (event: Event) => {
        event.preventDefault();
    };

    private onPointerDown = (event: PointerEvent) => {
        if (event.pointerType === "touch") {
            event.preventDefault();
        }

        this.setActivePointer(event.pointerId, event.clientX, event.clientY);

        if (this.activePointers.size >= 2) {
            this.beginTouchGesture();
            return;
        }

        if (event.button === 0) {
            this.dragMode = "pan";
            const anchor = this.anchorOnGround(event.clientX, event.clientY, {
                emit: true,
            });
            if (!anchor) this.onAnchorPoint?.(this.target, "target");
            this.panMetersPerPixel = this.metersPerPixelForGroundDistance(
                anchor
                    ? this.camera.position.distanceTo(anchor)
                    : this.viewDirectionGroundDistance(),
            );
        } else if (event.button === 1) {
            this.dragMode = "dolly";
            this.targetGroundDistance = this.setZoomAnchorFromScreenPoint(
                event.clientX,
                event.clientY,
                true,
            );
        } else if (event.button === 2) {
            this.dragMode = "rotate";
            this.initOrbitAboutScreenPoint(event.clientX, event.clientY);
        } else {
            this.activePointers.delete(event.pointerId);
            return;
        }

        this.stopPanInertia();
        this.panVelX = 0;
        this.panVelY = 0;
        this.lastPointerMoveTime = performance.now();

        this.lastPointerX = event.clientX;
        this.lastPointerY = event.clientY;
        this.lastPanClientX = event.clientX;
        this.lastPanClientY = event.clientY;
        this.domElement.setPointerCapture(event.pointerId);
        this.dispatchEvent({ type: "start" });
    };

    private onPointerMove = (event: PointerEvent) => {
        if (event.pointerType === "touch") {
            event.preventDefault();
        }

        if (this.activePointers.has(event.pointerId)) {
            this.setActivePointer(
                event.pointerId,
                event.clientX,
                event.clientY,
            );
        }

        if (this.touchGesture) {
            this.handleTouchGestureMove();
            return;
        }

        if (this.activePointers.size >= 2) {
            this.beginTouchGesture();
            this.handleTouchGestureMove();
            return;
        }

        if (!this.dragMode) return;
        const dx = event.clientX - this.lastPointerX;
        const dy = event.clientY - this.lastPointerY;
        this.lastPointerX = event.clientX;
        this.lastPointerY = event.clientY;
        if (dx === 0 && dy === 0) return;

        if (this.dragMode === "pan") {
            this.trackPanVelocity(dx, dy);
            this.lastPanClientX = event.clientX;
            this.lastPanClientY = event.clientY;
            this.panPixels(dx, dy, event.clientX, event.clientY);
        } else if (this.dragMode === "rotate") {
            this.rotatePixels(dx, dy);
        } else if (this.dragMode === "dolly") {
            const scale = Math.pow(0.98, dy);
            this.zoomAboutCachedAnchor(scale);
        }
        this.dispatchChange();
    };

    private onPointerUp = (event: PointerEvent) => {
        if (event.pointerType === "touch") {
            event.preventDefault();
        }

        this.activePointers.delete(event.pointerId);

        if (this.touchGesture) {
            if (this.activePointers.size < 2) {
                this.endTouchGesture();
            }
            if (this.domElement.hasPointerCapture(event.pointerId)) {
                this.domElement.releasePointerCapture(event.pointerId);
            }
            return;
        }

        if (!this.dragMode) return;
        const mode = this.dragMode;
        if (mode === "rotate") {
            this.commitOrbitAboutPivot();
        } else if (mode === "pan") {
            this.beginPanInertiaIfNeeded();
        }
        this.dragMode = null;
        if (this.domElement.hasPointerCapture(event.pointerId)) {
            this.domElement.releasePointerCapture(event.pointerId);
        }
        this.dispatchEvent({ type: "end" });
    };

    private onWheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (performance.now() < this.ignoreWheelUntil) return;
        this.stopPanInertia();

        const actualGround = this.setZoomAnchorFromScreenPoint(
            event.clientX,
            event.clientY,
            true,
        );
        const { zoomGain } = getSensitivityTuning();
        const tuning = getSmoothZoomTuning();
        const scale = wheelDeltaToScale(
            event.deltaY,
            tuning.speed * zoomGain,
        );

        if (tuning.smoothMs <= 0) {
            this.zoomAboutCachedAnchor(scale);
            this.syncStateFromCamera();
            this.dispatchChange();
            return;
        }

        this.targetGroundDistance = Math.max(actualGround * scale, 1e-3);
        this.smoothing = true;
        this.scheduleWheelIdle();
    };

    private onDblClick = (event: MouseEvent) => {
        const anchor = this.anchorOnGround(event.clientX, event.clientY, {
            emit: true,
        });
        if (!anchor) return;
        if (this.onDoubleClickAnchorPoint) {
            this.onDoubleClickAnchorPoint(anchor.clone());
            return;
        }
        this.target.copy(anchor);
        this.distance *= 0.5;
        this.clampDistance();
        this.applyCameraFromState();
        this.dispatchChange();
    };

    private scheduleWheelIdle(): void {
        if (this.wheelIdleTimer !== undefined) clearTimeout(this.wheelIdleTimer);
        const tuning = getSmoothZoomTuning();
        this.wheelIdleTimer = setTimeout(() => {
            this.wheelIdleTimer = undefined;
            this.smoothing = false;
            this.targetGroundDistance = this.currentZoomAnchorDistance();
            this.ignoreWheelUntil =
                performance.now() + tuning.wheelCooldownMs;
        }, tuning.wheelIdleMs);
    }

    private stopPanInertia(): void {
        this.panInertiaActive = false;
        this.panVelX = 0;
        this.panVelY = 0;
    }

    private trackPanVelocity(dx: number, dy: number): void {
        const now = performance.now();
        const dtSec = (now - this.lastPointerMoveTime) / 1000;
        this.lastPointerMoveTime = now;
        if (dtSec <= 0 || dtSec > 0.25) return;

        const instX = dx / dtSec;
        const instY = dy / dtSec;
        const { velocitySmoothMs } = getPanInertiaTuning();
        const alpha = 1 - Math.exp(-dtSec / (velocitySmoothMs / 1000));
        this.panVelX += (instX - this.panVelX) * alpha;
        this.panVelY += (instY - this.panVelY) * alpha;
    }

    private beginPanInertiaIfNeeded(): void {
        const { damping, minSpeedPxPerSec } = getPanInertiaTuning();
        if (damping <= 0) {
            this.stopPanInertia();
            return;
        }
        const speed = Math.hypot(this.panVelX, this.panVelY);
        if (speed < minSpeedPxPerSec) {
            this.stopPanInertia();
            return;
        }
        this.panInertiaActive = true;
        this.lastUpdateTime = performance.now();
    }

    private tickPanInertia(dtSec: number): boolean {
        const dx = this.panVelX * dtSec;
        const dy = this.panVelY * dtSec;
        if (dx !== 0 || dy !== 0) {
            this.panPixels(
                dx,
                dy,
                this.lastPanClientX,
                this.lastPanClientY,
            );
            this.dispatchChange();
        }

        const { damping, minSpeedPxPerSec } = getPanInertiaTuning();
        const decay = Math.exp(-damping * dtSec);
        this.panVelX *= decay;
        this.panVelY *= decay;

        if (Math.hypot(this.panVelX, this.panVelY) < minSpeedPxPerSec) {
            this.stopPanInertia();
        }
        return true;
    }

    private tickSmoothZoom(): boolean {
        const tuning = getSmoothZoomTuning();
        const current = this.currentZoomAnchorDistance();
        const alpha = 1 - Math.exp(-20 / tuning.smoothMs);
        const next =
            current + (this.targetGroundDistance - current) * alpha;
        const ratio = current > 1e-6 ? next / current : 1;
        this.zoomAboutCachedAnchor(ratio);
        this.syncStateFromCamera();
        this.dispatchChange();

        if (
            Math.abs(
                this.targetGroundDistance -
                    this.currentZoomAnchorDistance(),
            ) < 0.5
        ) {
            this.smoothing = false;
        }
        return true;
    }

    private rotatePixels(dx: number, dy: number): void {
        this.orbitDragDelta(dx, dy);
        this.commitOrbitAboutPivot();
    }

    /** Ground-anchored orbit pivot for right-drag and two-finger pitch/twist. */
    private initOrbitAboutScreenPoint(clientX: number, clientY: number): void {
        const anchor = this.anchorOnGround(clientX, clientY, { emit: true });
        if (anchor) {
            this.rotatePivot.copy(anchor);
        } else {
            this.rotatePivot.copy(this.target);
            this.onAnchorPoint?.(this.rotatePivot, "target");
        }
        this.target.copy(this.rotatePivot);
        this.orbitRadius = Math.max(
            this.camera.position.distanceTo(this.rotatePivot),
            this.minDistance,
        );
        this.panMetersPerPixel = this.metersPerPixelForGroundDistance(
            this.orbitRadius,
        );
        this.orbitStartOffset.subVectors(
            this.camera.position,
            this.rotatePivot,
        );
        _viewDir.set(0, 0, -1).transformDirection(this.camera.matrix);
        this.orbitStartViewDir.copy(_viewDir);
        const s = readSphericalFromCamera(this.camera, this.rotatePivot);
        this.orbitStartBearing = s.bearing;
        this.bearing = s.bearing;
        this.pitch = s.pitch;
        this.distance = this.orbitRadius;
        this.orbitAz = 0;
        this.orbitEl = 0;
    }

    /**
     * Orbit about the pivot: bearing around world Z, pitch around the view-right
     * axis (perpendicular to view and world up) so tilt feels anchored to the ray
     * under the cursor. Position and view direction get the same rotation each frame.
     */
    private orbitDragDelta(dx: number, dy: number): void {
        const h = Math.max(this.domElement.clientHeight, 1);
        const scale = this.rotateSpeed;
        this.orbitAz += (-2 * Math.PI * dx / h) * scale;
        this.orbitEl += (-2 * Math.PI * dy / h) * scale;

        _offset.copy(this.orbitStartOffset);
        _offset.applyAxisAngle(TERRAIN_WORLD_UP, this.orbitAz);

        _viewDir.copy(this.orbitStartViewDir);
        _viewDir.applyAxisAngle(TERRAIN_WORLD_UP, this.orbitAz);

        const bearing = this.orbitStartBearing + this.orbitAz;
        this.pitchAxis(_viewDir, bearing, _axis);

        const horizontal = Math.hypot(_offset.x, _offset.y);
        const elev0 =
            horizontal > 1e-9
                ? Math.atan2(_offset.z, horizontal)
                : Math.PI / 2;
        const elev = Math.max(
            this.minPitch,
            Math.min(this.maxPitch, elev0 + this.orbitEl),
        );
        this.orbitEl = elev - elev0;

        _offset.applyAxisAngle(_axis, this.orbitEl);
        _viewDir.applyAxisAngle(_axis, this.orbitEl);

        _offset.setLength(this.orbitRadius);
        this.camera.position.copy(this.rotatePivot).add(_offset);

        setCameraRollFreeViewDirection(
            this.camera,
            _viewDir,
            TERRAIN_WORLD_UP,
            bearing,
        );
    }

    /** Horizontal axis for pitch; stable bearing-based fallback near nadir. */
    private pitchAxis(
        viewDir: Vector3,
        bearing: number,
        out: Vector3,
    ): void {
        out.crossVectors(viewDir, TERRAIN_WORLD_UP);
        if (out.lengthSq() > 1e-10) {
            out.normalize();
            return;
        }
        out.set(Math.sin(bearing), -Math.cos(bearing), 0);
    }

    private commitOrbitAboutPivot(): void {
        this.target.copy(this.rotatePivot);
        this.distance = this.orbitRadius;
        const s = readSphericalFromCamera(this.camera, this.rotatePivot);
        this.bearing = s.bearing;
        this.pitch = s.pitch;
    }

    private setActivePointer(
        pointerId: number,
        clientX: number,
        clientY: number,
    ): void {
        this.activePointers.set(pointerId, { x: clientX, y: clientY });
    }

    private touchMetrics(): {
        midX: number;
        midY: number;
        span: number;
        angle: number;
    } | null {
        if (this.activePointers.size < 2) return null;
        const pts = [...this.activePointers.values()];
        const midX = (pts[0].x + pts[1].x) * 0.5;
        const midY = (pts[0].y + pts[1].y) * 0.5;
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        const span = Math.hypot(dx, dy);
        return {
            midX,
            midY,
            span: Math.max(span, 1e-6),
            angle: Math.atan2(dy, dx),
        };
    }

    private releaseAllPointerCapture(): void {
        for (const id of this.activePointers.keys()) {
            if (this.domElement.hasPointerCapture(id)) {
                this.domElement.releasePointerCapture(id);
            }
        }
    }

    private beginTouchGesture(): void {
        const m = this.touchMetrics();
        if (!m || this.touchGesture) return;

        const hadSinglePointerDrag = this.dragMode !== null;

        if (this.dragMode === "rotate") {
            this.commitOrbitAboutPivot();
        } else if (this.dragMode === "pan") {
            this.stopPanInertia();
        }

        this.dragMode = null;
        this.stopPanInertia();
        this.releaseAllPointerCapture();

        this.touchGesture = true;
        this.gestureSpan = m.span;
        this.gestureAngle = m.angle;
        this.gestureMidX = m.midX;
        this.gestureMidY = m.midY;
        this.initOrbitAboutScreenPoint(m.midX, m.midY);
        if (!hadSinglePointerDrag) {
            this.dispatchEvent({ type: "start" });
        }
    }

    private endTouchGesture(): void {
        if (!this.touchGesture) return;
        this.touchGesture = false;
        this.commitOrbitAboutPivot();
        this.dispatchEvent({ type: "end" });
    }

    private handleTouchGestureMove(): void {
        const m = this.touchMetrics();
        if (!m) return;

        const dMidX = m.midX - this.gestureMidX;
        const dMidY = m.midY - this.gestureMidY;
        let changed = false;
        let orbitChanged = false;

        if (dMidX !== 0) {
            this.panPixels(dMidX, 0, m.midX, m.midY);
            changed = true;
        }

        if (dMidY !== 0) {
            this.orbitDragDelta(0, dMidY);
            orbitChanged = true;
        }

        const dAngle = normalizeAngleDelta(m.angle - this.gestureAngle);
        if (Math.abs(dAngle) > 1e-9) {
            const h = Math.max(this.domElement.clientHeight, 1);
            const dxEquiv = (-dAngle * h) / (2 * Math.PI * this.rotateSpeed);
            this.orbitDragDelta(dxEquiv, 0);
            orbitChanged = true;
        }
        this.gestureAngle = m.angle;

        if (m.span >= MIN_PINCH_SPAN_PX) {
            const scale = this.gestureSpan / m.span;
            if (Math.abs(scale - 1) > 1e-6) {
                this.zoomAboutGroundPoint(m.midX, m.midY, scale);
                this.initOrbitAboutScreenPoint(m.midX, m.midY);
                orbitChanged = false;
                changed = true;
            }
            this.gestureSpan = m.span;
        }

        if (orbitChanged) {
            this.commitOrbitAboutPivot();
            changed = true;
        }

        this.gestureMidX = m.midX;
        this.gestureMidY = m.midY;

        if (changed) {
            this.dispatchChange();
        }
    }

    private panPixels(
        deltaX: number,
        deltaY: number,
        _clientX: number,
        _clientY: number,
    ): void {
        const mpp = this.panMetersPerPixel;
        _right.setFromMatrixColumn(this.camera.matrix, 0);
        _forward.crossVectors(TERRAIN_WORLD_UP, _right).normalize();
        _move
            .copy(_right)
            .multiplyScalar(-deltaX * mpp)
            .addScaledVector(_forward, deltaY * mpp);
        this.camera.position.add(_move);
        this.target.add(_move);
        this.syncStateFromCamera();
    }

    private setZoomAnchorFromScreenPoint(
        clientX: number,
        clientY: number,
        emitAnchor: boolean,
    ): number {
        const anchor = this.anchorOnGround(clientX, clientY, {
            emit: emitAnchor,
        });
        if (anchor) {
            this.zoomAnchor.copy(anchor);
            this.hasZoomAnchor = true;
            return Math.max(this.camera.position.distanceTo(anchor), 1e-3);
        }
        this.hasZoomAnchor = false;
        if (emitAnchor) this.onAnchorPoint?.(this.target, "target");
        return this.currentZoomAnchorDistance();
    }

    private currentZoomAnchorDistance(): number {
        if (this.hasZoomAnchor) {
            return Math.max(
                this.camera.position.distanceTo(this.zoomAnchor),
                1e-3,
            );
        }
        _offset.subVectors(this.camera.position, this.target);
        if (_offset.lengthSq() > 1e-12) {
            return Math.max(_offset.length(), 1e-3);
        }
        return this.viewDirectionGroundDistance();
    }

    private zoomAboutCachedAnchor(distanceRatio: number): boolean {
        if (!this.hasZoomAnchor) {
            _offset.subVectors(this.camera.position, this.target);
            if (_offset.lengthSq() < 1e-12) return false;
            _offset.multiplyScalar(distanceRatio);
            _delta.copy(this.target).add(_offset).sub(this.camera.position);
            this.camera.position.add(_delta);
            this.target.add(_delta);
            return true;
        }

        _offset.subVectors(this.camera.position, this.zoomAnchor);
        const dist = _offset.length();
        if (dist < 1e-6) return false;

        const nextDist = dist * distanceRatio;
        if (nextDist < 1e-6) return false;
        _offset.multiplyScalar(nextDist / dist);
        _delta.copy(this.zoomAnchor).add(_offset).sub(this.camera.position);
        this.camera.position.add(_delta);
        this.target.add(_delta);
        return true;
    }

    private zoomAboutGroundPoint(
        clientX: number,
        clientY: number,
        distanceRatio: number,
        emitAnchor = true,
    ): boolean {
        const anchor = this.anchorOnGround(clientX, clientY, {
            emit: emitAnchor,
        });
        if (!anchor) {
            if (emitAnchor) this.onAnchorPoint?.(this.target, "target");
            _offset.subVectors(this.camera.position, this.target);
            if (_offset.lengthSq() < 1e-12) return false;
            _offset.multiplyScalar(distanceRatio);
            _delta.copy(this.target).add(_offset).sub(this.camera.position);
            this.camera.position.add(_delta);
            this.target.add(_delta);
            return true;
        }

        _offset.subVectors(this.camera.position, anchor);
        const dist = _offset.length();
        if (dist < 1e-6) return false;

        const nextDist = dist * distanceRatio;
        if (nextDist < 1e-6) return false;
        _offset.multiplyScalar(nextDist / dist);
        _delta.copy(anchor).add(_offset).sub(this.camera.position);
        this.camera.position.add(_delta);
        this.target.add(_delta);
        return true;
    }

    private metersPerPixelForGroundDistance(distance: number): number {
        const fovRad = (this.camera.fov * Math.PI) / 180;
        const base =
            (2 * distance * Math.tan(fovRad / 2)) /
            Math.max(this.domElement.clientHeight, 1);
        const { panGain } = getSensitivityTuning();
        return base * panGain;
    }

    private viewDirectionGroundDistance(): number {
        this.camera.getWorldDirection(_viewDir);
        if (Math.abs(_viewDir.z) < 1e-6) {
            return Math.max(this.camera.position.z, 1e-3);
        }
        const t = -this.camera.position.z / _viewDir.z;
        return Math.max(t > 0 ? t : this.camera.position.z, 1e-3);
    }

    private anchorOnGround(
        clientX: number,
        clientY: number,
        options: AnchorOptions = {},
    ): Vector3 | null {
        const picked = this.pickWorldPoint?.(clientX, clientY);
        if (picked) {
            if (options.emit) this.onAnchorPoint?.(picked, "terrain");
            return _anchor.copy(picked);
        }

        const rect = this.domElement.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;
        _ndc.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        this.camera.updateMatrixWorld();
        _raycaster.setFromCamera(_ndc, this.camera);
        if (!_raycaster.ray.intersectPlane(GROUND_PLANE, _anchor)) {
            return null;
        }
        if (options.emit) this.onAnchorPoint?.(_anchor, "ground-plane");
        return _anchor;
    }
}
