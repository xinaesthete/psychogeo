import { describe, expect, it } from 'vitest';
import {
  isPinnedTier,
  retainedShouldDrop,
  retainedStillNeeded,
  selectRetainedEvictions,
  type RetainedEntry,
} from './tileRetention';

function extent(eastMin: number, northMin: number, size: number) {
  return {
    eastMin,
    eastMax: eastMin + size,
    northMin,
    northMax: northMin + size,
  };
}

function entry(overrides: Partial<RetainedEntry> = {}): RetainedEntry {
  return {
    key: 'k',
    extent: extent(0, 0, 10_000),
    bytes: 1_000_000,
    pinned: false,
    retiredTick: 1,
    ...overrides,
  };
}

describe('isPinnedTier', () => {
  it('pins the 100 km overview tier and nothing finer', () => {
    expect(isPinnedTier(100_000)).toBe(true);
    expect(isPinnedTier(10_000)).toBe(false);
    expect(isPinnedTier(1_000)).toBe(false);
  });
});

describe('retainedStillNeeded', () => {
  const retained = extent(0, 0, 10_000);
  const cover = (e: ReturnType<typeof extent>, over: Partial<{ settled: boolean; awaited: boolean }> = {}) => ({
    extent: e,
    settled: false,
    awaited: true,
    ...over,
  });

  it('keeps drawing while an overlapping replacement is still loading', () => {
    expect(
      retainedStillNeeded(retained, [
        cover(extent(0, 0, 5_000), { settled: true }),
        cover(extent(5_000, 0, 5_000)),
      ]),
    ).toBe(true);
  });

  it('stands down once every overlapping replacement is ready', () => {
    expect(
      retainedStillNeeded(retained, [
        cover(extent(0, 0, 5_000), { settled: true }),
        cover(extent(5_000, 0, 5_000), { settled: true }),
      ]),
    ).toBe(false);
  });

  it('ignores unsettled tiles that do not overlap it', () => {
    expect(retainedStillNeeded(retained, [cover(extent(50_000, 50_000, 5_000))])).toBe(false);
  });

  it('is not needed when nothing active covers that ground at all', () => {
    expect(retainedStillNeeded(retained, [])).toBe(false);
  });

  it('covers the zoom-out case: a coarse replacement over several fine tiles', () => {
    const fine = extent(2_000, 2_000, 1_000);
    expect(retainedStillNeeded(fine, [cover(extent(0, 0, 10_000))])).toBe(true);
    expect(retainedStillNeeded(fine, [cover(extent(0, 0, 10_000), { settled: true })])).toBe(false);
  });

  it('does not wait on an off-screen tile, which will never be scheduled to load', () => {
    expect(retainedStillNeeded(retained, [cover(extent(0, 0, 10_000), { awaited: false })])).toBe(
      false,
    );
  });

  it('still waits on a tile that has not been frustum-tested yet', () => {
    // Freshly reconciled tiles are unobserved; treating them as off-screen
    // would drop the fallback for the frame before the first visibility pass.
    expect(retainedStillNeeded(retained, [cover(extent(0, 0, 10_000), { awaited: true })])).toBe(
      true,
    );
  });

  it('stops waiting on a tile whose fetch failed', () => {
    expect(retainedStillNeeded(retained, [cover(extent(0, 0, 10_000), { settled: true })])).toBe(
      false,
    );
  });
});

describe('retainedShouldDrop', () => {
  const bounds = extent(0, 0, 20_000);

  it('drops fallbacks that have left the query bounds', () => {
    expect(retainedShouldDrop(entry({ extent: extent(500_000, 500_000, 10_000) }), bounds)).toBe(
      true,
    );
  });

  it('keeps fallbacks still inside the query bounds', () => {
    expect(retainedShouldDrop(entry({ extent: extent(5_000, 5_000, 10_000) }), bounds)).toBe(false);
  });

  it('never drops a pinned overview tile, however far away it is', () => {
    expect(
      retainedShouldDrop(
        entry({ pinned: true, extent: extent(500_000, 500_000, 100_000) }),
        bounds,
      ),
    ).toBe(false);
  });
});

describe('selectRetainedEvictions', () => {
  it('evicts nothing while under budget', () => {
    const entries = [entry({ key: 'a' }), entry({ key: 'b' })];
    expect(selectRetainedEvictions(entries, 10_000_000)).toEqual([]);
  });

  it('evicts least recently retired first, and only as far as needed', () => {
    const entries = [
      entry({ key: 'newest', retiredTick: 30 }),
      entry({ key: 'oldest', retiredTick: 10 }),
      entry({ key: 'middle', retiredTick: 20 }),
    ];
    // 3 MB resident, 2 MB budget — one eviction suffices.
    expect(selectRetainedEvictions(entries, 2_000_000)).toEqual(['oldest']);
  });

  it('evicts as many as the budget demands', () => {
    const entries = [
      entry({ key: 'a', retiredTick: 1 }),
      entry({ key: 'b', retiredTick: 2 }),
      entry({ key: 'c', retiredTick: 3 }),
    ];
    expect(selectRetainedEvictions(entries, 0)).toEqual(['a', 'b', 'c']);
  });

  it('never evicts pinned tiles, and does not count them against the budget', () => {
    const entries = [
      entry({ key: 'overview', pinned: true, bytes: 50_000_000, retiredTick: 1 }),
      entry({ key: 'detail', bytes: 1_000_000, retiredTick: 2 }),
    ];
    expect(selectRetainedEvictions(entries, 2_000_000)).toEqual([]);
  });

  it('still reports pinned-only pools as fitting a zero budget', () => {
    const entries = [entry({ key: 'overview', pinned: true, bytes: 50_000_000 })];
    expect(selectRetainedEvictions(entries, 0)).toEqual([]);
  });
});
