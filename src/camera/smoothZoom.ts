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

export function wheelDeltaToScale(delta: number, speed = 0.01): number {
    let scale = 2 / (1 + Math.exp(-Math.abs(delta * speed)));
    if (delta < 0 && scale !== 0) {
        scale = 1 / scale;
    }
    return scale;
}
