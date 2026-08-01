import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { clampOrbitElevation } from "./orbitClamp";

const UP = new THREE.Vector3(0, 0, 1);
const MIN_PITCH = 0.05;
const MAX_PITCH = Math.PI / 2 - 0.02;
const LIMITS = { minPitch: MIN_PITCH, maxPitch: MAX_PITCH };

/** Unit view direction looking north, tilted `pitch` radians below horizon. */
function viewDirAtPitch(pitch: number): THREE.Vector3 {
    return new THREE.Vector3(0, Math.cos(pitch), -Math.sin(pitch));
}

function pitchAxisFor(viewDir: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3().crossVectors(viewDir, UP).normalize();
}

function viewPitchAfter(viewDir: THREE.Vector3, axis: THREE.Vector3, el: number): number {
    const rotated = viewDir.clone().applyAxisAngle(axis, el);
    return -Math.asin(rotated.z);
}

describe("clampOrbitElevation", () => {
    it("lets a steep view tilt all the way back up to minPitch", () => {
        // Regression: the old offset-based clamp had an inverted sign, which
        // from an 80° start blocked tilt-up at ~71° instead of minPitch.
        const pitch0 = THREE.MathUtils.degToRad(80);
        const viewDir = viewDirAtPitch(pitch0);
        const axis = pitchAxisFor(viewDir);
        const offset = viewDir.clone().multiplyScalar(-3000);

        const el = clampOrbitElevation(offset, viewDir, axis, 2, LIMITS);
        expect(viewPitchAfter(viewDir, axis, el)).toBeCloseTo(MIN_PITCH, 6);
    });

    it("stops tilt-down exactly at maxPitch, never through nadir", () => {
        // Regression: the inverted clamp allowed the view to rotate past 90°,
        // flipping the roll-free basis.
        const pitch0 = THREE.MathUtils.degToRad(80);
        const viewDir = viewDirAtPitch(pitch0);
        const axis = pitchAxisFor(viewDir);
        const offset = viewDir.clone().multiplyScalar(-3000);

        const el = clampOrbitElevation(offset, viewDir, axis, -2, LIMITS);
        expect(viewPitchAfter(viewDir, axis, el)).toBeCloseTo(MAX_PITCH, 6);
        expect(viewPitchAfter(viewDir, axis, el)).toBeLessThan(Math.PI / 2);
    });

    it("allows full tilt when the pivot is directly under the camera", () => {
        // Old clamp keyed off the pivot-offset elevation (≈90° here), which
        // blocked tilting even though the view pitch was moderate.
        const pitch0 = THREE.MathUtils.degToRad(45);
        const viewDir = viewDirAtPitch(pitch0);
        const axis = pitchAxisFor(viewDir);
        const offset = new THREE.Vector3(0, 0, 2000);

        const down = clampOrbitElevation(offset, viewDir, axis, -2, LIMITS);
        expect(viewPitchAfter(viewDir, axis, down)).toBeCloseTo(MAX_PITCH, 6);

        const upEl = clampOrbitElevation(offset, viewDir, axis, 2, LIMITS);
        expect(viewPitchAfter(viewDir, axis, upEl)).toBeCloseTo(MIN_PITCH, 6);
    });

    it("keeps the camera above the pivot ground plane for a far pivot", () => {
        // Cursor near the top of the screen: shallow pivot ray, steeper view.
        // Tilting up must stop when the camera would sink below the pivot
        // plane, before the view-pitch bound is reached.
        const pitch0 = THREE.MathUtils.degToRad(40);
        const viewDir = viewDirAtPitch(pitch0);
        const axis = pitchAxisFor(viewDir);
        const offsetPitch = THREE.MathUtils.degToRad(15);
        const radius = 3000;
        const offset = new THREE.Vector3(
            0,
            -Math.cos(offsetPitch) * radius,
            Math.sin(offsetPitch) * radius,
        );

        const el = clampOrbitElevation(offset, viewDir, axis, 1, LIMITS);
        const rotated = offset.clone().applyAxisAngle(axis, el);
        expect(rotated.z).toBeCloseTo(radius * Math.sin(0.02), 4);
        expect(viewPitchAfter(viewDir, axis, el)).toBeGreaterThan(MIN_PITCH);
    });

    it("negative minPitch lets the view graze above the horizon", () => {
        const pitch0 = THREE.MathUtils.degToRad(40);
        const viewDir = viewDirAtPitch(pitch0);
        const axis = pitchAxisFor(viewDir);
        // Pivot under the camera so the ground guard cannot bind on tilt-up.
        const offset = new THREE.Vector3(0, 0, 2000);
        const minPitch = THREE.MathUtils.degToRad(-10);

        const el = clampOrbitElevation(offset, viewDir, axis, 2, {
            minPitch,
            maxPitch: MAX_PITCH,
        });
        expect(viewPitchAfter(viewDir, axis, el)).toBeCloseTo(minPitch, 6);
    });

    it("negative minOffsetElevation lets the camera sink below the pivot plane", () => {
        const pitch0 = THREE.MathUtils.degToRad(40);
        const viewDir = viewDirAtPitch(pitch0);
        const axis = pitchAxisFor(viewDir);
        const offsetPitch = THREE.MathUtils.degToRad(15);
        const radius = 3000;
        const offset = new THREE.Vector3(
            0,
            -Math.cos(offsetPitch) * radius,
            Math.sin(offsetPitch) * radius,
        );
        const minOffsetElevation = THREE.MathUtils.degToRad(-20);

        const el = clampOrbitElevation(offset, viewDir, axis, 1, {
            minPitch: MIN_PITCH,
            maxPitch: MAX_PITCH,
            minOffsetElevation,
        });
        const rotated = offset.clone().applyAxisAngle(axis, el);
        expect(rotated.z).toBeLessThan(0);
        expect(rotated.z).toBeCloseTo(radius * Math.sin(minOffsetElevation), 4);
    });

    it("lets a below-plane pose rotate back in after limits tighten", () => {
        // Camera below the pivot plane looking up (reached under relaxed
        // limits), then limits restored to defaults: tilting back down must
        // recover; tilting further up stays blocked.
        const viewDir = viewDirAtPitch(THREE.MathUtils.degToRad(-20));
        const axis = pitchAxisFor(viewDir);
        const offset = viewDir.clone().multiplyScalar(-3000);
        expect(offset.z).toBeLessThan(0);

        expect(clampOrbitElevation(offset, viewDir, axis, -0.5, LIMITS)).toBeCloseTo(-0.5, 6);
        expect(clampOrbitElevation(offset, viewDir, axis, 0.5, LIMITS)).toBe(0);
    });

    it("never forces a jump when the pose starts out of bounds", () => {
        const pitch0 = MAX_PITCH + 0.01;
        const viewDir = viewDirAtPitch(pitch0);
        const axis = pitchAxisFor(viewDir);
        const offset = viewDir.clone().multiplyScalar(-3000);

        expect(clampOrbitElevation(offset, viewDir, axis, -0.5, LIMITS)).toBe(0);
        const upEl = clampOrbitElevation(offset, viewDir, axis, 0.3, LIMITS);
        expect(upEl).toBeCloseTo(0.3, 6);
    });

    it("clamps symmetrically regardless of bearing", () => {
        const pitch0 = THREE.MathUtils.degToRad(60);
        for (const bearingDeg of [0, 45, 135, 250]) {
            const bearing = THREE.MathUtils.degToRad(bearingDeg);
            const viewDir = viewDirAtPitch(pitch0).applyAxisAngle(UP, bearing);
            const axis = pitchAxisFor(viewDir);
            const offset = viewDir.clone().multiplyScalar(-1500);
            const el = clampOrbitElevation(offset, viewDir, axis, -3, LIMITS);
            expect(viewPitchAfter(viewDir, axis, el)).toBeCloseTo(MAX_PITCH, 6);
        }
    });
});
