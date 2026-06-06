import type { PyramidLevel } from './types.ts';

export type PyramidPresetName = 'cell' | 'regional' | 'national';

export const CELL_PYRAMID_LEVELS: PyramidLevel[] = [
  { level: 0, resolutionMetres: 1, tierMetres: 1000 },
  { level: 1, resolutionMetres: 8, tierMetres: 5000 },
  { level: 2, resolutionMetres: 32, tierMetres: 10000 },
];

export const REGIONAL_PYRAMID_LEVELS: PyramidLevel[] = [
  { level: 0, resolutionMetres: 1, tierMetres: 1000 },
  { level: 1, resolutionMetres: 8, tierMetres: 5000 },
  { level: 2, resolutionMetres: 32, tierMetres: 10000 },
  { level: 3, resolutionMetres: 128, tierMetres: 100000 },
];

export const NATIONAL_PYRAMID_LEVELS: PyramidLevel[] = [
  { level: 0, resolutionMetres: 1, tierMetres: 1000 },
  { level: 1, resolutionMetres: 8, tierMetres: 5000 },
  { level: 2, resolutionMetres: 32, tierMetres: 10000 },
  { level: 3, resolutionMetres: 128, tierMetres: 100000 },
  { level: 4, resolutionMetres: 512, tierMetres: 100000 },
];

export function pyramidLevelsForPreset(preset: PyramidPresetName): PyramidLevel[] {
  switch (preset) {
    case 'cell':
      return CELL_PYRAMID_LEVELS;
    case 'regional':
      return REGIONAL_PYRAMID_LEVELS;
    case 'national':
      return NATIONAL_PYRAMID_LEVELS;
  }
}
