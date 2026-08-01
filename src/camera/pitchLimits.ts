export type PitchLimitOptions = {
    /**
     * Shallowest view pitch (degrees below horizon). 0 grazes the horizon;
     * negative lets the view look above it.
     */
    minViewPitchDeg?: number;
    /**
     * Minimum camera elevation above the orbit pivot's ground plane
     * (degrees). Negative lets the camera drop below the pivot, looking up
     * at it (e.g. a hilltop seen from the valley).
     */
    minCameraElevationDeg?: number;
};

export const DEFAULT_PITCH_LIMITS: Required<PitchLimitOptions> = {
    minViewPitchDeg: 2.9,
    minCameraElevationDeg: 1.1,
};

let tuning: Required<PitchLimitOptions> = { ...DEFAULT_PITCH_LIMITS };

export function getPitchLimitTuning(): Readonly<Required<PitchLimitOptions>> {
    return tuning;
}

export function setPitchLimitTuning(partial: PitchLimitOptions): void {
    tuning = { ...tuning, ...partial };
}
