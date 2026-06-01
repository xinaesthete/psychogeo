import { describe, expect, it } from 'vitest';
import { encodeUint16Normalized } from './encoding.ts';
import { encodeHtj2k } from './htj2k.ts';

describe('OpenJPH height encoding', () => {
  it('encodes lossy single-channel rasters with color transform disabled', async () => {
    const values = new Float32Array(64 * 64);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        values[y * 64 + x] = 100 + x * 0.25 + y * 0.5;
      }
    }

    const encoded = encodeUint16Normalized(values);
    const bytes = await encodeHtj2k(encoded, 64, 64, 0.05);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
