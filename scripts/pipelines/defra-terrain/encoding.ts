import type { EncodingSpec } from './types.ts';

export type NumericRaster = Float32Array | Float64Array | Int16Array | Uint16Array | number[];

const DEFRA_FLOAT_NODATA = -3.40282346639e38;

export interface RasterStats {
  readonly min: number;
  readonly max: number;
  readonly validCount: number;
  readonly totalCount: number;
  readonly validPercent: number;
}

export interface EncodedRaster {
  readonly pixels: Uint16Array | Int16Array;
  readonly encoding: EncodingSpec;
  readonly stats: RasterStats;
  readonly rmseMetres: number;
  readonly meanAbsMetres: number;
  readonly maxAbsMetres: number;
}

export function isValidHeight(value: number): boolean {
  return Number.isFinite(value) && value > DEFRA_FLOAT_NODATA / 2;
}

export function computeRasterStats(values: NumericRaster): RasterStats {
  let min = Infinity;
  let max = -Infinity;
  let validCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!isValidHeight(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    validCount += 1;
  }
  if (validCount === 0) {
    return { min: 0, max: 1, validCount, totalCount: values.length, validPercent: 0 };
  }
  return {
    min,
    max,
    validCount,
    totalCount: values.length,
    validPercent: (validCount / values.length) * 100,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function encodeUint16Normalized(values: NumericRaster): EncodedRaster {
  const stats = computeRasterStats(values);
  const pixels = new Uint16Array(values.length);
  const scale = stats.max > stats.min ? (stats.max - stats.min) / 65534 : 1;
  const offset = stats.min - scale;
  let sumSq = 0;
  let sumAbs = 0;
  let maxAbs = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!isValidHeight(value)) {
      pixels[i] = 0;
      continue;
    }
    const code = clamp(Math.round((value - offset) / scale), 1, 65535);
    pixels[i] = code;
    const reconstructed = offset + code * scale;
    const abs = Math.abs(reconstructed - value);
    sumSq += abs * abs;
    sumAbs += abs;
    maxAbs = Math.max(maxAbs, abs);
  }

  const divisor = Math.max(1, stats.validCount);
  return {
    pixels,
    stats,
    encoding: {
      kind: 'uint16-normalized',
      units: 'metre',
      nodataCode: 0,
      min: stats.min,
      max: stats.max,
      offset,
      scale,
    },
    rmseMetres: Math.sqrt(sumSq / divisor),
    meanAbsMetres: sumAbs / divisor,
    maxAbsMetres: maxAbs,
  };
}

export function encodeDeltaInt16(
  first: NumericRaster,
  last: NumericRaster,
  quantizationStep = 0.05,
  clampMin = -128,
  clampMax = 128,
): EncodedRaster {
  if (first.length !== last.length) {
    throw new Error('Delta rasters must have the same pixel count.');
  }
  const nodataCode = -32768;
  const pixels = new Int16Array(first.length);
  let min = Infinity;
  let max = -Infinity;
  let validCount = 0;
  let sumSq = 0;
  let sumAbs = 0;
  let maxAbs = 0;

  for (let i = 0; i < first.length; i += 1) {
    const a = first[i];
    const b = last[i];
    if (!isValidHeight(a) || !isValidHeight(b)) {
      pixels[i] = nodataCode;
      continue;
    }
    const delta = clamp(a - b, clampMin, clampMax);
    const code = clamp(Math.round(delta / quantizationStep), -32767, 32767);
    pixels[i] = code;
    const reconstructed = code * quantizationStep;
    const abs = Math.abs(reconstructed - delta);
    min = Math.min(min, delta);
    max = Math.max(max, delta);
    validCount += 1;
    sumSq += abs * abs;
    sumAbs += abs;
    maxAbs = Math.max(maxAbs, abs);
  }

  const totalCount = first.length;
  const divisor = Math.max(1, validCount);
  return {
    pixels,
    stats: {
      min: validCount === 0 ? 0 : min,
      max: validCount === 0 ? 0 : max,
      validCount,
      totalCount,
      validPercent: (validCount / totalCount) * 100,
    },
    encoding: {
      kind: 'int16-delta',
      units: 'metre',
      nodataCode,
      min: validCount === 0 ? 0 : min,
      max: validCount === 0 ? 0 : max,
      offset: 0,
      scale: quantizationStep,
      quantizationStep,
      clampMin,
      clampMax,
    },
    rmseMetres: Math.sqrt(sumSq / divisor),
    meanAbsMetres: sumAbs / divisor,
    maxAbsMetres: maxAbs,
  };
}
