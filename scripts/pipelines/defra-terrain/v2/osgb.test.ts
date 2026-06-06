import { describe, expect, it } from 'vitest';
import {
  childGridRefs,
  filterGroupsByCellPrefix,
  gridRefToBounds,
  normalizeGridRef,
  parentGridRef,
} from './osgb.ts';

describe('osgb', () => {
  it('normalizes 5 km grid references', () => {
    expect(normalizeGridRef('SP51NE')).toBe('SP51ne');
  });

  it('maps SP51 to a 10 km extent', () => {
    expect(gridRefToBounds('SP51')).toEqual({
      eastMin: 450000,
      eastMax: 460000,
      northMin: 210000,
      northMax: 220000,
    });
  });

  it('maps SP51ne to the northeast 5 km quadrant', () => {
    expect(gridRefToBounds('SP51ne')).toEqual({
      eastMin: 455000,
      eastMax: 460000,
      northMin: 215000,
      northMax: 220000,
    });
  });

  it('derives parent and child grid references', () => {
    expect(parentGridRef('SP51ne')).toBe('SP51');
    expect(parentGridRef('SP51')).toBe('SP');
    expect(childGridRefs('SP51')).toEqual(['SP51ne', 'SP51nw', 'SP51se', 'SP51sw']);
  });

  it('filters DEFRA groups by ingest cell', () => {
    expect(filterGroupsByCellPrefix('SP51ne', 'SP51')).toBe(true);
    expect(filterGroupsByCellPrefix('SP50ne', 'SP51')).toBe(false);
  });
});
