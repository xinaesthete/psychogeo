import { describe, expect, it } from 'vitest';
import { computeRasterStats, encodeDeltaInt16, encodeUint16Normalized } from './encoding.ts';

describe('terrain raster encoding', () => {
  it('computes stats while ignoring DEFRA float nodata', () => {
    expect(computeRasterStats(new Float32Array([3, -3.40282346639e38, 7]))).toMatchObject({
      min: 3,
      max: 7,
      validCount: 2,
      totalCount: 3,
    });
  });

  it('normalises heights with code 0 reserved for nodata', () => {
    const encoded = encodeUint16Normalized(new Float32Array([10, 20, -3.40282346639e38]));
    expect(encoded.pixels[0]).toBeGreaterThan(0);
    expect(encoded.pixels[1]).toBeGreaterThan(encoded.pixels[0]);
    expect(encoded.pixels[2]).toBe(0);
    expect(encoded.encoding.kind).toBe('uint16-normalized');
    expect(encoded.maxAbsMetres).toBeLessThan(0.001);
  });

  it('quantises first-return minus last-return deltas', () => {
    const encoded = encodeDeltaInt16(new Float32Array([12, 15, 1]), new Float32Array([10, 14, -3.40282346639e38]), 0.5);
    expect(encoded.pixels[0]).toBe(4);
    expect(encoded.pixels[1]).toBe(2);
    expect(encoded.pixels[2]).toBe(-32768);
    expect(encoded.encoding.kind).toBe('int16-delta');
  });
});
