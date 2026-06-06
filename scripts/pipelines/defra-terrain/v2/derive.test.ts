import { describe, expect, it } from 'vitest';
import { CELL_PYRAMID_LEVELS } from './presets.ts';
import {
  defaultNamingConvention,
  leafChunkDatasetPath,
  leafSlotBounds,
  leafSlotsInBounds,
  levelsForNode,
  mergedChunkDatasetPath,
  nodeManifestPath,
  pixelDimensions,
} from './derive.ts';
import { gridRefToBounds } from './osgb.ts';

describe('derive', () => {
  const naming = defaultNamingConvention();

  it('builds nested manifest and chunk paths for SP51', () => {
    expect(nodeManifestPath('SP51', 'SP51')).toBe('pyramid/SP51/manifest.json');
    expect(nodeManifestPath('SP51', 'SP51ne')).toBe('pyramid/SP51/SP51ne/manifest.json');
    expect(mergedChunkDatasetPath('SP51', 'SP51ne', 1, naming)).toBe('pyramid/SP51/SP51ne/1/SP51ne.j2c');
    expect(leafChunkDatasetPath('SP51', 'SP51ne', 455000, 215000, naming)).toBe(
      'pyramid/SP51/SP51ne/0/455000_215000.j2c',
    );
  });

  it('selects pyramid levels applicable to a node tier', () => {
    expect(levelsForNode('SP51ne', CELL_PYRAMID_LEVELS).map((level) => level.level)).toEqual([1]);
    expect(levelsForNode('SP51', CELL_PYRAMID_LEVELS).map((level) => level.level)).toEqual([2]);
  });

  it('derives leaf slot bounds and viewport selection', () => {
    const cellBounds = gridRefToBounds('SP51ne');
    expect(leafSlotBounds(cellBounds, 0, 0, 1000)).toEqual({
      eastMin: 455000,
      eastMax: 456000,
      northMin: 215000,
      northMax: 216000,
    });
    const slots = leafSlotsInBounds(
      cellBounds,
      { eastMin: 455100, eastMax: 455900, northMin: 215100, northMax: 215900 },
      5,
      5,
      1000,
    );
    expect(slots).toEqual([{ col: 0, row: 0, index: 0 }]);
  });

  it('derives pixel dimensions from tier and resolution', () => {
    expect(pixelDimensions(5000, 8)).toEqual({ width: 625, height: 625 });
    expect(pixelDimensions(10000, 32)).toEqual({ width: 313, height: 313 });
  });
});
