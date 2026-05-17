export type PanInertiaOptions = {
    /** Per-second exponential decay; 0 disables coasting. */
    damping?: number;
    /** Minimum release speed (px/s) to start coasting. */
    minSpeedPxPerSec?: number;
    /** EMA time constant for pointer velocity while dragging (ms). */
    velocitySmoothMs?: number;
};

export const DEFAULT_PAN_INERTIA: Required<PanInertiaOptions> = {
    damping: 7,
    minSpeedPxPerSec: 24,
    velocitySmoothMs: 90,
};

let tuning: Required<PanInertiaOptions> = { ...DEFAULT_PAN_INERTIA };

export function getPanInertiaTuning(): Readonly<Required<PanInertiaOptions>> {
    return tuning;
}

export function setPanInertiaTuning(partial: PanInertiaOptions): void {
    tuning = { ...tuning, ...partial };
}
