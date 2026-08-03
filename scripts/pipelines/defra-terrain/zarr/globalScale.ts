/**
 * One scale/offset for the whole country, replacing the per-chunk pair the v2
 * pyramid records in every manifest.
 *
 * Measured on real tiles (python/codec-eval): dropping per-chunk normalisation
 * makes files 31-44% *smaller*, because a per-chunk step of ~1.4 mm is roughly
 * 100x finer than DEFRA LIDAR's ~±150 mm vertical accuracy and most of those
 * bits were encoding sensor noise losslessly. The national step below is
 * ~21.5 mm — still an order of magnitude inside the sensor — and it lets the
 * Zarr store drop the `encoding/scale` and `encoding/offset` companion arrays
 * for a plain array-level transform.
 */

/** Lowest real ground in Britain is about -4 m; a little headroom below that. */
export const NATIONAL_HEIGHT_MIN = -10;
/**
 * Ben Nevis is 1345 m and this is a surface model, so the cap has to clear the
 * highest ground plus whatever stands on it. Tall masts sit on lower ground
 * (Emley Moor tops out near 590 m), so 1400 m covers the country.
 */
export const NATIONAL_HEIGHT_MAX = 1400;

/** Raw 0 is reserved for nodata, so the signal occupies 1..65535. */
export const RAW_MIN = 1;
export const RAW_MAX = 65535;
export const RAW_LEVELS = RAW_MAX - RAW_MIN; // 65534

export const NODATA_RAW = 0;

export type ScaleOffset = {
  readonly scale: number;
  readonly offset: number;
};

/** `height = raw * scale + offset`, matching what the tile shader already does. */
export function globalScaleOffset(
  min = NATIONAL_HEIGHT_MIN,
  max = NATIONAL_HEIGHT_MAX,
): ScaleOffset {
  const scale = (max - min) / RAW_LEVELS;
  return { scale, offset: min - scale };
}

export function rawToHeight(raw: number, encoding: ScaleOffset): number {
  return raw * encoding.scale + encoding.offset;
}

/**
 * Triangular-PDF dither, ±1 level, which makes the quantisation error
 * independent of the signal and so breaks up banding on surfaces smoother than
 * one step. It roughly doubles the normal error while decorrelating it, and
 * costs 0.4-2.6% in size, so it is a flag rather than a default — see
 * python/codec-eval.
 *
 * Deterministic in the chunk seed so a re-run reproduces the same store.
 */
function triangularDither(random: () => number): number {
  return random() - random();
}

/** Small deterministic PRNG (mulberry32) — a fixed store should be reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type QuantiseOptions = {
  readonly encoding: ScaleOffset;
  /** Omit for plain rounding. */
  readonly dither?: () => number;
};

/**
 * Heights in metres to globally normalised uint16. NaN — which is what the
 * downsample filters produce for a footprint with no valid samples — becomes
 * nodata.
 */
export function quantiseHeights(
  heights: Float32Array | Float64Array,
  options: QuantiseOptions,
): Uint16Array {
  const { scale, offset } = options.encoding;
  const dither = options.dither;
  const out = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i += 1) {
    const height = heights[i];
    if (!Number.isFinite(height)) {
      out[i] = NODATA_RAW;
      continue;
    }
    let level = (height - offset) / scale;
    if (dither) level += triangularDither(dither);
    const rounded = Math.round(level);
    out[i] = rounded < RAW_MIN ? RAW_MIN : rounded > RAW_MAX ? RAW_MAX : rounded;
  }
  return out;
}

/**
 * Globally normalised uint16 back to metres, with nodata as NaN so the
 * downsample filters skip it.
 */
export function dequantiseToHeights(raw: Uint16Array, encoding: ScaleOffset): Float32Array {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw[i] === NODATA_RAW ? Number.NaN : raw[i] * encoding.scale + encoding.offset;
  }
  return out;
}

/**
 * Per-chunk normalised uint16 (what v2 stores) back to metres, using that
 * chunk's own scalars from its manifest.
 */
export function dequantisePerChunk(
  raw: Uint16Array,
  encoding: ScaleOffset,
): Float32Array {
  return dequantiseToHeights(raw, encoding);
}
