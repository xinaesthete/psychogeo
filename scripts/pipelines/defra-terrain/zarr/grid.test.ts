import { describe, expect, it } from 'vitest';
import { gridRefToBounds } from '../v2/osgb.ts';
import {
  chunkCoordForExtent,
  chunkKey,
  defaultShardMetres,
  levelGrid,
  NATIONAL_EXTENT,
  shardPlacement,
} from './grid.ts';

describe('levelGrid', () => {
  it('sizes the 1 m level to the whole national sheet', () => {
    const grid = levelGrid({ level: 0, resolutionMetres: 1, tierMetres: 1000 });
    expect(grid.chunkPixels).toBe(1000);
    expect(grid.resolutionMetres).toBe(1);
    expect(grid.shape).toEqual([1_300_000, 700_000]);
    expect(grid.chunkGrid).toEqual([1300, 700]);
    expect(grid.shardChunks).toEqual([10, 10]);
    expect(grid.shardShape).toEqual([10_000, 10_000]);
  });

  it('reports the resolution the pixels actually have, not the nominal one', () => {
    // 10 km / 32 m rounds to 313 px, so the pixels are 31.949 m. Recording 32
    // would put every level-2 chunk in slightly the wrong place.
    const grid = levelGrid({ level: 2, resolutionMetres: 32, tierMetres: 10_000 });
    expect(grid.chunkPixels).toBe(313);
    expect(grid.nominalResolutionMetres).toBe(32);
    expect(grid.resolutionMetres).toBeCloseTo(10_000 / 313, 10);
    expect(grid.shape).toEqual([130 * 313, 70 * 313]);
  });

  it('leaves the 100 km tier unsharded — one chunk per square already', () => {
    const grid = levelGrid({ level: 3, resolutionMetres: 125, tierMetres: 100_000 });
    expect(grid.chunkPixels).toBe(800);
    expect(grid.chunkGrid).toEqual([13, 7]);
    expect(grid.shardChunks).toBeNull();
    expect(defaultShardMetres(100_000)).toBeNull();
  });

  it('rejects a tier the national sheet does not divide into', () => {
    expect(() => levelGrid({ level: 0, resolutionMetres: 1, tierMetres: 3000 })).toThrow(/whole number/);
  });
});

describe('chunkCoordForExtent', () => {
  const grid = levelGrid({ level: 0, resolutionMetres: 1, tierMetres: 1000 });

  it('puts row 0 at the north edge', () => {
    expect(
      chunkCoordForExtent(grid, { eastMin: 0, eastMax: 1000, northMin: 1_299_000, northMax: 1_300_000 }),
    ).toEqual([0, 0]);
  });

  it('maps a leaf by its south-west corner', () => {
    const coord = chunkCoordForExtent(grid, {
      eastMin: 455_000,
      eastMax: 456_000,
      northMin: 215_000,
      northMax: 216_000,
    });
    expect(coord).toEqual([(NATIONAL_EXTENT.northMax - 216_000) / 1000, 455]);
  });

  it('agrees with the OSGB bounds of a 10 km cell', () => {
    const tenKm = levelGrid({ level: 2, resolutionMetres: 32, tierMetres: 10_000 });
    const bounds = gridRefToBounds('SU42');
    const [y, x] = chunkCoordForExtent(tenKm, bounds);
    expect(x).toBe(bounds.eastMin / 10_000);
    expect(y).toBe((NATIONAL_EXTENT.northMax - bounds.northMax) / 10_000);
  });

  it('rejects an extent off the sheet', () => {
    expect(() =>
      chunkCoordForExtent(grid, { eastMin: 800_000, eastMax: 801_000, northMin: 0, northMax: 1000 }),
    ).toThrow(/outside the national grid/);
  });
});

describe('shardPlacement', () => {
  const grid = levelGrid({ level: 0, resolutionMetres: 1, tierMetres: 1000 });

  it('splits a chunk coordinate into shard and local parts', () => {
    expect(shardPlacement(grid, [1084, 455])).toEqual({ shard: [108, 45], local: [4, 5] });
  });

  it('is the identity for an unsharded level', () => {
    const coarse = levelGrid({ level: 4, resolutionMetres: 500, tierMetres: 100_000 });
    expect(shardPlacement(coarse, [3, 4])).toEqual({ shard: [3, 4], local: [0, 0] });
  });

  it('encodes zarr v3 default chunk keys', () => {
    expect(chunkKey([108, 45])).toBe('c/108/45');
  });
});
