import * as THREE from 'three';
import { glsl } from '../threact/threexample';
import { tileShaderUniforms, type TileUniformBag } from './tileShaderRuntime';

/**
 * Contours are drawn as a fixed number of independent sets. A set is a family
 * of lines at a fixed elevation spacing — or a single line, when its interval
 * is zero — with its own colour, width, softness and drift.
 *
 * Nothing is locked between sets. Two sets drifting at different speeds slide
 * through each other and a line briefly reads as two; that interference is the
 * effect, not a defect, and it is configured rather than avoided.
 */
export const CONTOUR_SET_COUNT = 4;

export type ContourSetDefaults = {
    /** Panel label only — the shader knows sets by index. */
    label: string;
    /** Metres between lines. Zero or less draws one line, at the anchor. */
    interval: number;
    /** Elevation the family is aligned to, metres. */
    anchor: number;
    /** Metres per second the family drifts; CPU-side, folded into the phase. */
    speed: number;
    /** On-screen width of the solid core, in pixels. */
    widthPx: number;
    /** Metres of soft falloff either side of each line; 0 for none. */
    falloff: number;
    /** Fade where lines crowd past what a pixel can separate. 0 keeps the tone. */
    fadeCrowded: number;
    /** Fade where the height is too coarsely quantised to place the line. */
    fadeFlat: number;
    /** Per-set multiplier; 0 skips the set entirely. */
    gain: number;
    colour: [number, number, number];
    /** 1 pins the anchor to the last picked terrain elevation. */
    followPick: number;
};

export const CONTOUR_SET_DEFAULTS: ContourSetDefaults[] = [
    {
        label: 'minor',
        interval: 5,
        anchor: 0,
        speed: 3,
        // Close to what the old code drew at this interval, where the width was
        // silently 0.283 * interval pixels — 1.4px here, 2.8px for the major.
        widthPx: 1.5,
        falloff: 0,
        fadeCrowded: 0,
        fadeFlat: 0,
        gain: 1,
        colour: [0.3, 0.5, 0.7],
        followPick: 0,
    },
    {
        label: 'major',
        interval: 10,
        anchor: 0,
        speed: 0,
        widthPx: 3,
        falloff: 0,
        fadeCrowded: 0,
        fadeFlat: 0,
        gain: 1,
        colour: [0.8, 0.5, 0.7],
        followPick: 0,
    },
    {
        label: 'coarse',
        interval: 50,
        anchor: 0,
        speed: 0,
        widthPx: 5,
        falloff: 0,
        fadeCrowded: 0.5,
        fadeFlat: 0.5,
        gain: 0,
        colour: [0.9, 0.85, 0.6],
        followPick: 0,
    },
    {
        label: 'focus',
        // Single line, parked on whatever the mouse last picked.
        interval: 0,
        anchor: 0,
        speed: 0,
        widthPx: 1.5,
        falloff: 12,
        fadeCrowded: 0,
        fadeFlat: 0,
        gain: 0,
        colour: [1, 0.6, 0.2],
        followPick: 1,
    },
];

/** Uniform name → per-set default, for every numeric array the sets use. */
const NUMERIC_KEYS: Record<string, (set: ContourSetDefaults) => number> = {
    contourInterval: (s) => s.interval,
    contourAnchor: (s) => s.anchor,
    contourPhase: () => 0,
    contourWidthPx: (s) => s.widthPx,
    contourFalloff: (s) => s.falloff,
    contourFadeCrowded: (s) => s.fadeCrowded,
    contourFadeFlat: (s) => s.fadeFlat,
    contourGain: (s) => s.gain,
    // CPU-side only: drift is integrated into contourPhase each frame, and
    // followPick redirects the anchor. Neither is declared in the shader.
    contourSpeed: (s) => s.speed,
    contourFollowPick: (s) => s.followPick,
};

function ensureNumericArray(
    shared: TileUniformBag,
    key: string,
    defaults: number[],
): void {
    const existing = shared[key]?.value;
    if (!Array.isArray(existing)) {
        shared[key] = { value: [...defaults] };
        return;
    }
    // Length changes only when CONTOUR_SET_COUNT does; keep tweaked values.
    existing.length = defaults.length;
    for (let i = 0; i < defaults.length; i++) {
        if (typeof existing[i] !== 'number') existing[i] = defaults[i];
    }
}

function ensureColourArray(shared: TileUniformBag): void {
    const defaults = CONTOUR_SET_DEFAULTS.map((s) => new THREE.Vector3(...s.colour));
    const existing = shared.contourEmissive?.value;
    if (!Array.isArray(existing)) {
        shared.contourEmissive = { value: defaults };
        return;
    }
    existing.length = defaults.length;
    for (let i = 0; i < defaults.length; i++) {
        if (!(existing[i] instanceof THREE.Vector3)) existing[i] = defaults[i];
    }
}

/** Add missing keys only, so Leva tweaks and phases survive a hot reload. */
export function ensureContourUniforms(shared: TileUniformBag): void {
    for (const [key, pick] of Object.entries(NUMERIC_KEYS)) {
        ensureNumericArray(shared, key, CONTOUR_SET_DEFAULTS.map(pick));
    }
    ensureColourArray(shared);
    if (!shared.contourStrength) shared.contourStrength = { value: 0.3 };
}

export function advanceContourPhases(uniforms: TileUniformBag, dt: number): void {
    const phases = uniforms.contourPhase?.value;
    const speeds = uniforms.contourSpeed?.value;
    const intervals = uniforms.contourInterval?.value;
    if (!Array.isArray(phases) || !Array.isArray(speeds)) return;
    for (let i = 0; i < phases.length; i++) {
        let phase = phases[i] + speeds[i] * dt;
        const interval = Array.isArray(intervals) ? intervals[i] : 0;
        // Wrap at the set's own interval, which leaves every line where it was.
        // The phase reaches the GPU as a float32, and an unwrapped one climbs
        // far enough over a long session to quantise the line positions — the
        // old single phase had reached 2024 metres in one sitting. A single-line
        // set has no period to wrap at, so it is left to drift.
        if (interval > 0) phase = ((phase % interval) + interval) % interval;
        phases[i] = phase;
    }
}

/**
 * Park every follow-pick set on this elevation (world Z is metres above datum,
 * which is what the shader compares against). Called from the terrain anchor,
 * so the line lands wherever the mouse last resolved to ground.
 */
export function setContourPickElevation(elevation: number): void {
    const anchors = tileShaderUniforms.contourAnchor?.value;
    const follow = tileShaderUniforms.contourFollowPick?.value;
    if (!Array.isArray(anchors) || !Array.isArray(follow)) return;
    for (let i = 0; i < anchors.length; i++) {
        if (follow[i] > 0) anchors[i] = elevation;
    }
}

export function readContourNumber(
    uniforms: TileUniformBag,
    key: string,
    index: number,
): number {
    const values = uniforms[key]?.value;
    if (!Array.isArray(values)) return 0;
    const value: unknown = values[index];
    return typeof value === 'number' ? value : 0;
}

export function writeContourNumber(
    uniforms: TileUniformBag,
    key: string,
    index: number,
    value: number,
): void {
    const values = uniforms[key]?.value;
    if (Array.isArray(values)) values[index] = value;
}

export function readContourColour(
    uniforms: TileUniformBag,
    index: number,
): THREE.Vector3 | null {
    const values = uniforms.contourEmissive?.value;
    if (!Array.isArray(values)) return null;
    const value: unknown = values[index];
    return value instanceof THREE.Vector3 ? value : null;
}

/** Uniform declarations and helpers, spliced into the fragment preamble. */
export const contourFragmentGlsl = glsl`
    #define CONTOUR_SETS ${CONTOUR_SET_COUNT}
    uniform float contourInterval[CONTOUR_SETS];
    uniform float contourAnchor[CONTOUR_SETS];
    uniform float contourPhase[CONTOUR_SETS];
    uniform float contourWidthPx[CONTOUR_SETS];
    uniform float contourFalloff[CONTOUR_SETS];
    uniform float contourFadeCrowded[CONTOUR_SETS];
    uniform float contourFadeFlat[CONTOUR_SETS];
    uniform float contourGain[CONTOUR_SETS];
    uniform vec3 contourEmissive[CONTOUR_SETS];
    uniform float contourStrength;

    /**
     * Elevation distance in metres from h to the nearest line of a set. A
     * non-positive interval means one line at the anchor, not a family.
     */
    float contourDistance(float h, float interval, float anchor) {
        if (interval <= 0.) return abs(h - anchor);
        float t = (h - anchor) / interval;
        return abs(t - floor(t + 0.5)) * interval;
    }

    /**
     * Coverage of one set at this fragment. hSlope is the elevation change per
     * pixel in metres and hQuantum the size of the step the height arrives
     * quantised to; both come from the caller, which owns how height is
     * sampled. See heightSlopePerPixel — dFdx(h) is not a usable stand-in.
     */
    float contourSetCoverage(int i, float h, float hSlope, float hQuantum) {
        float interval = contourInterval[i];
        float d = contourDistance(h, interval, contourAnchor[i] + contourPhase[i]);
        // Antialiasing width: a pixel's worth of elevation, or one quantisation
        // step where that is the coarser of the two and no edge can be placed
        // more precisely than it anyway.
        float aa = max(hSlope, hQuantum);

        // The core is specified in pixels, so changing the interval no longer
        // silently changes how thick the lines are. Capped at half an interval:
        // that is where neighbours meet and the set reads as solid tone.
        float halfCore = 0.5 * contourWidthPx[i] * hSlope;
        // Floored at half a quantisation step, because d is only known to
        // within that. A thinner line falls between two representable heights:
        // it draws where the surface happens to step across the level and not
        // in between, so a single contour comes out as a row of separate marks
        // — the several-nearby-lines artefact. On flat ground the floor wins
        // and the line is as wide as the height resolution really justifies.
        halfCore = max(halfCore, 0.5 * hQuantum);
        if (interval > 0.) halfCore = min(halfCore, 0.5 * interval);
        float core = 1. - smoothstep(halfCore - 0.5 * aa, halfCore + 0.5 * aa, d);

        // The flat end of unresolvable. Where the floor above is what set the
        // width, the line's on-screen thickness IS its positional uncertainty:
        // hQuantum metres of slop spread over hQuantum/hSlope pixels. Past a
        // dozen or so pixels that is a slab, not a contour, and fading it is
        // the honest answer — the same one paper maps give to flat ground.
        //
        // Measured against the width actually asked for, so a deliberately fat
        // line is left alone: only slop the request did not account for fades.
        if (contourFadeFlat[i] > 0.) {
            float excessPx = hQuantum / max(hSlope, 1e-9) - contourWidthPx[i];
            core *= mix(1., 1. - smoothstep(2., 12., excessPx), contourFadeFlat[i]);
        }

        // Falloff is in metres of elevation instead, so it holds the same
        // vertical extent however the ground is angled — a halo around a line
        // rather than a fatter line. It is a distance readout rather than a
        // line, so how coarsely height is quantised does not blur it, and the
        // flat fade above deliberately leaves it alone.
        float cover = core;
        if (contourFalloff[i] > 0.) {
            cover = max(cover, 1. - smoothstep(0., contourFalloff[i], d));
        }

        // The crowded end. Once a pixel spans more than about half an interval
        // the family is past Nyquist. Left alone the lines pile up into tone,
        // which is a look worth keeping; this dials in the tidier alternative
        // of dropping the set out where it can no longer be resolved.
        if (interval > 0. && contourFadeCrowded[i] > 0.) {
            float perPixel = hSlope / interval;
            cover *= mix(1., 1. - smoothstep(0.25, 0.5, perPixel), contourFadeCrowded[i]);
        }
        return cover * contourGain[i];
    }

    vec3 contourRadiance(float h, float hSlope, float hQuantum) {
        vec3 sum = vec3(0.);
        for (int i = 0; i < CONTOUR_SETS; i++) {
            if (contourGain[i] <= 0.) continue;
            sum += contourSetCoverage(i, h, hSlope, hQuantum) * contourEmissive[i];
        }
        return sum * contourStrength;
    }
`;
