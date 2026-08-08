import { describe, expect, it } from 'vitest';
import type { DefraTileGroup } from '../scan.ts';
import { gridRefToBounds } from '../v2/osgb.ts';
import { dequantiseToHeights, quantiseHeights } from './globalScale.ts';
import { renormalisedLevel } from './levels.ts';
import { placeInShard } from './pyramidBuild.ts';
import {
  chunkFromRaster,
  chunksForExtent,
  differenceRasters,
  dzChannelSpec,
  DZ_MAX_METRES,
  DZ_MIN_METRES,
  dzScaleOffset,
  lzChannelSpec,
  passThrough,
  quadsWith,
} from './sourceChannel.ts';
import { globalScaleOffset } from './globalScale.ts';

const LEVEL0 = renormalisedLevel(0);

const group = (tileRef: string, kinds: string[]): DefraTileGroup => ({
  tileRef,
  year: 2022,
  sources: Object.fromEntries(
    kinds.map((kind) => [kind, { product: kind, returnKind: kind, year: 2022, tileRef, zipPath: `${tileRef}-${kind}.zip`, zipBasename: `${tileRef}-${kind}.zip` }]),
  ) as DefraTileGroup['sources'],
});

describe('dzScaleOffset', () => {
  it('puts the range floor on raw 1, leaving raw 0 for nodata', () => {
    const encoding = dzScaleOffset();
    expect(1 * encoding.scale + encoding.offset).toBeCloseTo(DZ_MIN_METRES, 10);
    expect(401 * encoding.scale + encoding.offset).toBeCloseTo(0, 10);
  });

  it('round-trips a difference within half a step', () => {
    const encoding = dzScaleOffset();
    const values = new Float32Array([-30.15, -0.02, 0, 0.03, 12.47, 68.351]);
    const back = dequantiseToHeights(quantiseHeights(values, { encoding }), encoding);
    for (let i = 0; i < values.length; i += 1) {
      expect(Math.abs(back[i] - values[i])).toBeLessThanOrEqual(encoding.scale / 2 + 1e-6);
    }
  });

  it('keeps nodata distinct from a dz of zero', () => {
    // A dz of exactly 0 is the commonest real value in the country — a fifth of
    // samples — so it must not collide with the nodata code.
    const encoding = dzScaleOffset();
    const raw = quantiseHeights(new Float32Array([0, Number.NaN]), { encoding });
    expect(raw[0]).toBe(401);
    expect(raw[1]).toBe(0);
  });
});

describe('differenceRasters', () => {
  it('subtracts, keeps negatives, and drops a pixel either side is missing', () => {
    const first = new Float32Array([10, 5, -9999, 3, 20]);
    const last = new Float32Array([2, 8, 1, -9999, 20]);
    const { values, clamped } = differenceRasters(first, last);
    expect(values[0]).toBeCloseTo(8);
    // Negative dz is survey disagreement and is kept, not floored at zero.
    expect(values[1]).toBeCloseTo(-3);
    expect(values[2]).toBeNaN();
    expect(values[3]).toBeNaN();
    expect(values[4]).toBe(0);
    expect(clamped).toBe(0);
  });

  it('clamps to the encodable range and counts what it clamped', () => {
    const { values, clamped } = differenceRasters(
      new Float32Array([1000, -1000]),
      new Float32Array([0, 0]),
    );
    expect(values[0]).toBe(DZ_MAX_METRES);
    expect(values[1]).toBe(DZ_MIN_METRES);
    expect(clamped).toBe(2);
  });
});

describe('chunksForExtent', () => {
  it('covers a 5 km quad with 25 chunks, all in one shard', () => {
    const coords = chunksForExtent(LEVEL0, gridRefToBounds('SU42ne'));
    expect(coords).toHaveLength(25);
    const keys = new Set(coords.map((coord) => placeInShard(LEVEL0, coord).key));
    expect(keys.size).toBe(1);
  });

  it('indexes y from the north edge of the sheet', () => {
    // SU42ne runs to 130000 N, and the sheet starts at 1300000 N, so its top
    // row is chunk 1170. Getting this backwards would mirror the country.
    const bounds = gridRefToBounds('SU42ne');
    expect(bounds.northMax).toBe(130000);
    const coords = chunksForExtent(LEVEL0, bounds);
    const ys = coords.map((coord) => coord[0]);
    expect(Math.min(...ys)).toBe(1170);
    expect(Math.max(...ys)).toBe(1174);
    expect(Math.min(...coords.map((coord) => coord[1]))).toBe(445);
  });
});

describe('chunkFromRaster', () => {
  const raster = {
    width: 2000,
    height: 2000,
    extent: { eastMin: 445000, northMax: 130000 },
    resolutionMetres: 1,
  };

  /** value = row * 10000 + col, so a misplaced window is obvious. */
  const values = (() => {
    const out = new Float32Array(raster.width * raster.height);
    for (let row = 0; row < raster.height; row += 1) {
      for (let col = 0; col < raster.width; col += 1) out[row * raster.width + col] = row * 10000 + col;
    }
    return out;
  })();

  it('takes the north-west chunk from the raster origin without flipping', () => {
    const tile = chunkFromRaster(values, raster, [1170, 445], LEVEL0);
    expect(tile[0]).toBe(0);
    expect(tile[1]).toBe(1);
    expect(tile[1000]).toBe(10000); // one row down in both
  });

  it('offsets by whole chunks going south and east', () => {
    const tile = chunkFromRaster(values, raster, [1171, 446], LEVEL0);
    expect(tile[0]).toBe(1000 * 10000 + 1000);
  });

  it('leaves ground the raster does not reach as nodata', () => {
    const tile = chunkFromRaster(values, raster, [1172, 445], LEVEL0); // third row, raster is 2 chunks tall
    expect(tile.every((value) => Number.isNaN(value))).toBe(true);
  });
});

describe('quadsWith', () => {
  const quads = [group('SU42ne', ['FZ', 'LZ']), group('SU42nw', ['FZ']), group('SU42se', ['LZ'])];

  it('takes only quads carrying every product the channel needs', () => {
    const both = quadsWith(quads, ['FZ', 'LZ']);
    expect(both.usable.map((entry) => entry.tileRef)).toEqual(['SU42ne']);
    expect(both.skippedIncomplete).toBe(2);
  });

  it('accepts more quads for a single-product channel than for a difference', () => {
    // The whole point of storing LZ rather than dz is that it needs less: a
    // quad with LZ but no FZ still contributes a surface.
    const lzOnly = quadsWith(quads, ['LZ']);
    expect(lzOnly.usable.map((entry) => entry.tileRef)).toEqual(['SU42ne', 'SU42se']);
  });

  it('filters on a grid-ref prefix', () => {
    const { usable } = quadsWith(
      [group('SU42ne', ['FZ', 'LZ']), group('SU43ne', ['FZ', 'LZ'])],
      ['FZ', 'LZ'],
      'SU42',
    );
    expect(usable.map((entry) => entry.tileRef)).toEqual(['SU42ne']);
  });

  it('names a quad it cannot place instead of throwing', () => {
    // DEFRA ships OV00sw, and the grid library rejects the bottom row of the O
    // square. A national run walks ~5,900 uncurated quads, so one it cannot
    // place has to be a reported skip — throwing would lose nine hours.
    const { usable, unplaceable } = quadsWith(
      [group('OV00sw', ['LZ']), group('SU42ne', ['LZ'])],
      ['LZ'],
    );
    expect(usable.map((entry) => entry.tileRef)).toEqual(['SU42ne']);
    expect(unplaceable).toEqual(['OV00sw']);
  });
});

describe('channel specs', () => {
  it('puts LZ on exactly the height channel encoding', () => {
    // Load-bearing: dz is recovered as (fz_raw - lz_raw) * scale, which is only
    // exact while the two surfaces share a scale and their offsets cancel.
    expect(lzChannelSpec().encoding).toEqual(globalScaleOffset());
  });

  it('recovers dz from two height-encoded surfaces within two half-steps', () => {
    const encoding = globalScaleOffset();
    const fz = new Float32Array([120.31, 45.02, 8.5]);
    const lz = new Float32Array([118.02, 45.02, 3.25]);
    const fzRaw = quantiseHeights(fz, { encoding });
    const lzRaw = quantiseHeights(lz, { encoding });
    for (let i = 0; i < fz.length; i += 1) {
      const derived = (fzRaw[i] - lzRaw[i]) * encoding.scale;
      expect(Math.abs(derived - (fz[i] - lz[i]))).toBeLessThanOrEqual(encoding.scale + 1e-9);
    }
    // Tighter than the stored dz layer's own half-step, which is the argument.
    expect(encoding.scale).toBeLessThan(dzScaleOffset().scale / 2);
  });

  it('passes LZ through untouched but maps its nodata sentinel to NaN', () => {
    const { values, clamped } = lzChannelSpec().combine([new Float32Array([12.5, -9999, 0])]);
    expect(values[0]).toBeCloseTo(12.5);
    expect(values[1]).toBeNaN();
    expect(values[2]).toBe(0);
    expect(clamped).toBe(0);
  });

  it('needs one product for LZ and two for dz', () => {
    expect(lzChannelSpec().needs).toEqual(['LZ']);
    expect(dzChannelSpec().needs).toEqual(['FZ', 'LZ']);
  });
});

describe('passThrough', () => {
  it('turns every nodata sentinel the composite uses into NaN', () => {
    const out = passThrough(new Float32Array([1.5, -9999, -3.4028234663852886e38, Number.NaN, 0]));
    expect(out[0]).toBeCloseTo(1.5);
    expect([out[1], out[2], out[3]].every(Number.isNaN)).toBe(true);
    expect(out[4]).toBe(0);
  });
});
