import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MASK_RESOLUTION,
  isPinnedTier,
  rasteriseCoverageMask,
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
  const cover = (
    e: ReturnType<typeof extent>,
    over: Partial<{ ready: boolean; settled: boolean; awaited: boolean }> = {},
  ) => ({ extent: e, ready: false, settled: false, awaited: true, ...over });

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

describe('rasteriseCoverageMask', () => {
  const R = FALLBACK_MASK_RESOLUTION;
  const mask = () => new Uint8Array(R * R);
  const ready = (e: ReturnType<typeof extent>) => ({
    extent: e,
    ready: true,
    settled: true,
    awaited: true,
  });
  const cellAt = (out: Uint8Array, col: number, row: number) => out[row * R + col];

  it('masks nothing when no cover is ready', () => {
    const out = mask();
    const covered = rasteriseCoverageMask(extent(0, 0, 10_000), [
      { extent: extent(0, 0, 5_000), ready: false, settled: false, awaited: true },
    ], out);
    expect(covered).toBe(false);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('masks exactly the quadrant a ready 5 km tile covers of a 10 km fallback', () => {
    const out = mask();
    // South-west quadrant: cover edges land on cell edges at this resolution.
    expect(rasteriseCoverageMask(extent(0, 0, 10_000), [ready(extent(0, 0, 5_000))], out)).toBe(
      true,
    );
    expect(cellAt(out, 0, 0)).toBe(255);
    expect(cellAt(out, R / 2 - 1, R / 2 - 1)).toBe(255);
    // ...and nothing outside it.
    expect(cellAt(out, R / 2, R / 2 - 1)).toBe(0);
    expect(cellAt(out, R / 2 - 1, R / 2)).toBe(0);
    expect(cellAt(out, R - 1, R - 1)).toBe(0);
    expect(out.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe((R / 2) * (R / 2));
  });

  it('masks the whole tile when every quadrant is ready', () => {
    const out = mask();
    const quads = [
      ready(extent(0, 0, 5_000)),
      ready(extent(5_000, 0, 5_000)),
      ready(extent(0, 5_000, 5_000)),
      ready(extent(5_000, 5_000, 5_000)),
    ];
    expect(rasteriseCoverageMask(extent(0, 0, 10_000), quads, out)).toBe(true);
    expect(out.every((v) => v === 255)).toBe(true);
  });

  it('aligns exactly for 1 km leaves under a 10 km fallback', () => {
    const out = mask();
    rasteriseCoverageMask(extent(0, 0, 10_000), [ready(extent(3_000, 4_000, 1_000))], out);
    // 1 km is ten cells at 100 m; columns 30-39, rows 40-49.
    expect(out.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(100);
    expect(cellAt(out, 30, 40)).toBe(255);
    expect(cellAt(out, 39, 49)).toBe(255);
    expect(cellAt(out, 29, 40)).toBe(0);
    expect(cellAt(out, 40, 40)).toBe(0);
  });

  it('aligns exactly for 10 km cells under a 100 km square fallback', () => {
    const out = mask();
    rasteriseCoverageMask(extent(400_000, 100_000, 100_000), [
      ready(extent(430_000, 150_000, 10_000)),
    ], out);
    // 10 km is ten cells at 1 km; columns 30-39, rows 50-59.
    expect(out.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(100);
    expect(cellAt(out, 30, 50)).toBe(255);
    expect(cellAt(out, 39, 59)).toBe(255);
  });

  it('accumulates neighbouring covers instead of needing one to fill a cell', () => {
    // The case that broke on orbit: a 100 km fallback under 1 km leaves. Each
    // leaf is a single cell here, so nothing masks unless coverage accumulates.
    const out = mask();
    const leaves = [];
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        leaves.push(ready(extent(470_000 + i * 1_000, 120_000 + j * 1_000, 1_000)));
      }
    }
    expect(rasteriseCoverageMask(extent(400_000, 100_000, 100_000), leaves, out)).toBe(true);
    expect(out.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(25);
    expect(cellAt(out, 70, 20)).toBe(255);
    expect(cellAt(out, 74, 24)).toBe(255);
    expect(cellAt(out, 75, 20)).toBe(0);
  });

  it('leaves partially covered cells drawing rather than punching a hole', () => {
    const out = mask();
    // Smaller than one 100 m cell and misaligned, so it fills nothing.
    const covered = rasteriseCoverageMask(extent(0, 0, 10_000), [ready(extent(150, 150, 50))], out);
    expect(covered).toBe(false);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('masks only the interior cells of a cover straddling cell edges', () => {
    const out = mask();
    // Spans 150..450 m; whole cells are 200..400, i.e. columns/rows 2-3.
    rasteriseCoverageMask(extent(0, 0, 10_000), [ready(extent(150, 150, 300))], out);
    expect(out.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(4);
    expect(cellAt(out, 2, 2)).toBe(255);
    expect(cellAt(out, 1, 2)).toBe(0);
  });

  it('clears stale bits from a reused buffer', () => {
    const out = mask();
    out.fill(255);
    rasteriseCoverageMask(extent(0, 0, 10_000), [ready(extent(0, 0, 5_000))], out);
    expect(cellAt(out, R - 1, R - 1)).toBe(0);
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
