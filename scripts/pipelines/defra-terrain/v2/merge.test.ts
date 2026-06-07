import { describe, expect, it } from 'vitest';
import { mosaicRasters } from './merge.ts';

describe('v2 merge', () => {
  it('keeps row 0 north-up when mosaicking child rasters', () => {
    const merged = mosaicRasters(
      [
        {
          extent: { eastMin: 0, eastMax: 2, northMin: 2, northMax: 4 },
          width: 2,
          height: 2,
          pixels: new Float32Array([
            10, 11,
            12, 13,
          ]),
        },
        {
          extent: { eastMin: 0, eastMax: 2, northMin: 0, northMax: 2 },
          width: 2,
          height: 2,
          pixels: new Float32Array([
            20, 21,
            22, 23,
          ]),
        },
      ],
      { eastMin: 0, eastMax: 2, northMin: 0, northMax: 4 },
      1,
    );

    expect(Array.from(merged.pixels)).toEqual([
      10, 11,
      12, 13,
      20, 21,
      22, 23,
    ]);
  });
});
