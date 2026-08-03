import { describe, expect, it } from 'vitest';
import {
  CHUNK_PIXELS,
  childChunkCoords,
  chunkCoordFor,
  parentChunkCoord,
  renormalisedLevel,
  renormalisedLevels,
} from './levels.ts';
import {
  dequantiseToHeights,
  globalScaleOffset,
  NATIONAL_HEIGHT_MAX,
  NATIONAL_HEIGHT_MIN,
  NODATA_RAW,
  quantiseHeights,
  RAW_MAX,
  RAW_MIN,
  seededRandom,
} from './globalScale.ts';

describe('renormalisedLevels', () => {
  it('steps resolution by 4 and keeps one chunk shape throughout', () => {
    const levels = renormalisedLevels();
    expect(levels.map((entry) => entry.resolutionMetres)).toEqual([1, 4, 16, 64, 256]);
    expect(levels.map((entry) => entry.chunkMetres)).toEqual([1000, 4000, 16000, 64000, 256000]);
    for (const level of levels) {
      expect(level.chunkShape).toEqual([CHUNK_PIXELS, CHUNK_PIXELS]);
    }
  });

  it('covers the sheet exactly where the chunk size divides it', () => {
    expect(renormalisedLevel(0).chunkGrid).toEqual([1300, 700]);
    expect(renormalisedLevel(0).shape).toEqual([1_300_000, 700_000]);
    expect(renormalisedLevel(1).chunkGrid).toEqual([325, 175]);
  });

  it('rounds up where it does not — 1300 km is not a whole number of 64 km', () => {
    // 1300000 = 2^5 * 40625, so 16 km divides the sheet and 64 km does not.
    expect(renormalisedLevel(2).chunkGrid).toEqual([82, 44]); // 81.25, 43.75
    expect(renormalisedLevel(3).chunkGrid).toEqual([21, 11]); // 20.3, 10.9
    expect(renormalisedLevel(4).chunkGrid).toEqual([6, 3]);
  });

  it('stops sharding once a level has few enough chunks', () => {
    expect(renormalisedLevel(0).shardChunks).toEqual([10, 10]);
    expect(renormalisedLevel(3).shardChunks).toEqual([10, 10]); // 21 x 11
    expect(renormalisedLevel(4).shardChunks).toBeNull(); // 6 x 3
  });
});

describe('chunk coordinates', () => {
  it('places row 0 at the north edge at every level', () => {
    for (const level of renormalisedLevels()) {
      expect(chunkCoordFor(level, 0, 1_300_000)).toEqual([0, 0]);
    }
  });

  it('agrees between levels — a 4 km chunk holds the 1 km chunk at its corner', () => {
    const fine = renormalisedLevel(0);
    const coarse = renormalisedLevel(1);
    const fineCoord = chunkCoordFor(fine, 456_000, 216_000);
    const coarseCoord = chunkCoordFor(coarse, 456_000, 216_000);
    expect(parentChunkCoord(fineCoord)).toEqual(coarseCoord);
  });

  it('gives a coarse chunk exactly sixteen children, round-tripping to itself', () => {
    const children = childChunkCoords([3, 5]);
    expect(children).toHaveLength(16);
    for (const child of children) {
      expect(parentChunkCoord(child)).toEqual([3, 5]);
    }
  });
});

describe('globalScaleOffset', () => {
  const encoding = globalScaleOffset();

  it('spans the national range across 1..65535', () => {
    expect(encoding.scale * 1000).toBeCloseTo(21.52, 2);
    expect(RAW_MIN * encoding.scale + encoding.offset).toBeCloseTo(NATIONAL_HEIGHT_MIN, 9);
    expect(RAW_MAX * encoding.scale + encoding.offset).toBeCloseTo(NATIONAL_HEIGHT_MAX, 9);
  });

  it('round-trips heights inside half a step', () => {
    const heights = new Float32Array([-10, 0, 12.34, 137.5, 1345, 1400]);
    const round = dequantiseToHeights(quantiseHeights(heights, { encoding }), encoding);
    for (let i = 0; i < heights.length; i += 1) {
      expect(Math.abs(round[i] - heights[i])).toBeLessThanOrEqual(encoding.scale / 2 + 1e-6);
    }
  });

  it('maps NaN to nodata and back', () => {
    const raw = quantiseHeights(new Float32Array([Number.NaN, 100]), { encoding });
    expect(raw[0]).toBe(NODATA_RAW);
    expect(Number.isNaN(dequantiseToHeights(raw, encoding)[0])).toBe(true);
  });

  it('clamps rather than wrapping outside the national range', () => {
    const raw = quantiseHeights(new Float32Array([-5000, 9000]), { encoding });
    expect(raw[0]).toBe(RAW_MIN);
    expect(raw[1]).toBe(RAW_MAX);
  });

  it('never lets dither reach nodata or wrap the top', () => {
    const dither = seededRandom(1);
    const edges = new Float32Array(512).fill(NATIONAL_HEIGHT_MIN);
    edges.set(new Float32Array(256).fill(NATIONAL_HEIGHT_MAX), 256);
    const raw = quantiseHeights(edges, { encoding, dither });
    expect(Math.min(...raw)).toBeGreaterThanOrEqual(RAW_MIN);
    expect(Math.max(...raw)).toBeLessThanOrEqual(RAW_MAX);
  });

  it('is reproducible for a given seed and moves values off the plain lattice', () => {
    const heights = new Float32Array(4096);
    for (let i = 0; i < heights.length; i += 1) heights[i] = 100 + i * 0.0005; // a very gentle ramp
    const plain = quantiseHeights(heights, { encoding });
    const first = quantiseHeights(heights, { encoding, dither: seededRandom(7) });
    const second = quantiseHeights(heights, { encoding, dither: seededRandom(7) });
    expect(Array.from(second)).toEqual(Array.from(first));
    // The ramp climbs far less than one step over its length, so undithered it
    // terraces into a handful of levels; dither should spread it.
    expect(new Set(first).size).toBeGreaterThan(new Set(plain).size);
  });
});
