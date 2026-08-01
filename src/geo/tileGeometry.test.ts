import { describe, expect, it } from 'vitest';
import {
  TILE_BASE_GRID,
  TILE_LOD_LEVELS,
  getTileLodGeometry,
  isSharedTileGeometry,
  tileLodDistance,
  tileLodLevels,
  tileLodUniforms,
} from './tileGeometry';

describe('tileGeometry', () => {
  it('returns the same geometry instance for a grid size', () => {
    const a = getTileLodGeometry(64);
    const b = getTileLodGeometry(64);
    expect(a).toBe(b);
    expect(isSharedTileGeometry(a)).toBe(true);
    expect(a.drawRange.count).toBe(63 * 63 * 6);
  });

  it('caps the finest level at the texture resolution', () => {
    // A 1000 px leaf chunk needs the 1024 grid; the 2048 and 4096 grids
    // (96 MiB and 384 MiB of indices) would only interpolate the same data.
    const levels = tileLodLevels(1000);
    expect(levels[0].gridSize).toBe(1024);
    expect(levels[0].lod).toBe(2);
    expect(levels.every((level) => level.gridSize <= 1024)).toBe(true);
  });

  it('uses the full ladder for 4096 px legacy textures', () => {
    const levels = tileLodLevels(4096);
    expect(levels[0].gridSize).toBe(TILE_BASE_GRID);
    expect(levels[0].lod).toBe(0);
    expect(levels).toHaveLength(TILE_LOD_LEVELS);
  });

  it('keeps switch distances tied to the grid size, not the ladder position', () => {
    // Regression: reindexing levels after dropping the finest ones would
    // show a coarser mesh than before at the same camera distance.
    const full = tileLodLevels(4096);
    const capped = tileLodLevels(1000);
    for (const level of capped) {
      const same = full.find((entry) => entry.gridSize === level.gridSize);
      expect(same).toBeDefined();
      expect(tileLodDistance(level, 1000, 3)).toBe(tileLodDistance(same!, 1000, 3));
    }
  });

  it('derives grid uniforms consistent with the geometry', () => {
    const [level] = tileLodLevels(1000);
    const uniforms = tileLodUniforms(level);
    expect(uniforms.gridSizeX.value).toBe(1024);
    expect(uniforms.gridSizeY.value).toBe(1024);
    expect(uniforms.EPS.value.x).toBeCloseTo(1 / 1023, 12);
    // LOD stays absolute so debug shading matches the legacy ladder.
    expect(uniforms.LOD.value).toBeCloseTo(2 / TILE_LOD_LEVELS, 12);
  });

  it('falls back to the full ladder without a texture width', () => {
    expect(tileLodLevels()[0].gridSize).toBe(TILE_BASE_GRID);
    expect(tileLodLevels(0)[0].gridSize).toBe(TILE_BASE_GRID);
  });

  it('rounds a non-power-of-two texture up to the covering grid', () => {
    expect(tileLodLevels(625)[0].gridSize).toBe(1024);
    expect(tileLodLevels(800)[0].gridSize).toBe(1024);
    expect(tileLodLevels(312)[0].gridSize).toBe(512);
    expect(tileLodLevels(200)[0].gridSize).toBe(256);
  });

  it('builds an index buffer wide enough for the vertex count', () => {
    const small = getTileLodGeometry(32);
    expect(small.getIndex()?.array).toBeInstanceOf(Uint16Array);
    const large = getTileLodGeometry(256);
    expect(large.getIndex()?.array).toBeInstanceOf(Uint32Array);
  });
});
