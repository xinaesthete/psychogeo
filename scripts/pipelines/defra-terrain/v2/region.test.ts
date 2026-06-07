import { describe, expect, it } from 'vitest';
import type { DefraTileGroup } from '../scan.ts';
import {
  discoverTenKmCells,
  filterGroupsByRegion,
  parseRegionArg,
  parseRegionBounds,
  parseRegionGridRef,
  tileRefMatchesRegion,
} from './region.ts';

function group(tileRef: string): DefraTileGroup {
  return { tileRef, year: 2022, sources: {} };
}

describe('region', () => {
  it('parses grid ref tiers and bounds', () => {
    expect(parseRegionGridRef('SP51')).toEqual({ kind: 'grid-ref', gridRef: 'SP51' });
    expect(parseRegionGridRef('SP')).toEqual({ kind: 'grid-ref', gridRef: 'SP' });
    expect(parseRegionGridRef('S')).toEqual({ kind: 'grid-ref', gridRef: 'S' });
    expect(parseRegionGridRef('SP5')).toEqual({ kind: 'grid-ref', gridRef: 'SP5' });
    expect(parseRegionBounds(450000, 210000, 460000, 220000)).toEqual({
      kind: 'bounds',
      bounds: { eastMin: 450000, northMin: 210000, eastMax: 460000, northMax: 220000 },
    });
  });

  it('prefers bounds over grid ref when parsing CLI args', () => {
    expect(
      parseRegionArg({
        region: 'SP',
        bounds: '450000,210000,460000,220000',
      }).kind,
    ).toBe('bounds');
  });

  it('matches 10 km, 100 km, and 500 km prefixes', () => {
    const sp51 = { kind: 'grid-ref' as const, gridRef: 'SP51' };
    const sp = { kind: 'grid-ref' as const, gridRef: 'SP' };
    const s = { kind: 'grid-ref' as const, gridRef: 'S' };

    expect(tileRefMatchesRegion('SP51ne', sp51)).toBe(true);
    expect(tileRefMatchesRegion('SP50ne', sp51)).toBe(false);
    expect(tileRefMatchesRegion('SP51ne', sp)).toBe(true);
    expect(tileRefMatchesRegion('SP60ne', sp)).toBe(true);
    expect(tileRefMatchesRegion('SP51ne', s)).toBe(true);
    expect(tileRefMatchesRegion('SU31ne', s)).toBe(true);
    expect(tileRefMatchesRegion('TQ31ne', s)).toBe(false);
  });

  it('matches explicit bounds', () => {
    const region = parseRegionBounds(455000, 215000, 456000, 216000);
    expect(tileRefMatchesRegion('SP51ne', region)).toBe(true);
    expect(tileRefMatchesRegion('SP50ne', region)).toBe(false);
  });

  it('discovers 10 km cells from filtered groups', () => {
    const groups = [group('SP51ne'), group('SP51nw'), group('SP52ne'), group('SU31ne')];
    const sp = { kind: 'grid-ref' as const, gridRef: 'SP' };
    expect(filterGroupsByRegion(groups, sp).map((entry) => entry.tileRef)).toEqual([
      'SP51ne',
      'SP51nw',
      'SP52ne',
    ]);
    expect(discoverTenKmCells(groups, sp)).toEqual(['SP51', 'SP52']);
  });
});
