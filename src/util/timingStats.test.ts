import { describe, expect, it } from 'vitest';
import { TimingStats } from './timingStats';

describe('TimingStats', () => {
  it('reports zeroed stats before any sample', () => {
    const stats = new TimingStats();
    expect(stats.snapshot()).toEqual({ count: 0, meanMs: 0, minMs: 0, maxMs: 0 });
    expect(String(stats)).toBe('no samples');
  });

  it('tracks count, mean, min and max', () => {
    const stats = new TimingStats();
    for (const ms of [10, 30, 20]) stats.record(ms);
    expect(stats.snapshot()).toEqual({ count: 3, meanMs: 20, minMs: 10, maxMs: 30 });
  });

  it('keeps memory flat regardless of sample count', () => {
    // The array version spread an ever-growing list into Math.min on every
    // sample, which overflows the stack at this scale.
    const stats = new TimingStats();
    for (let i = 0; i < 200_000; i += 1) stats.record(i % 500);
    const s = stats.snapshot();
    expect(s.count).toBe(200_000);
    expect(s.minMs).toBe(0);
    expect(s.maxMs).toBe(499);
    expect(s.meanMs).toBeGreaterThan(0);
  });

  it('ignores non-finite samples rather than poisoning the mean', () => {
    const stats = new TimingStats();
    stats.record(10);
    stats.record(Number.NaN);
    stats.record(Number.POSITIVE_INFINITY);
    expect(stats.snapshot()).toEqual({ count: 1, meanMs: 10, minMs: 10, maxMs: 10 });
  });

  it('resets back to empty', () => {
    const stats = new TimingStats();
    stats.record(42);
    stats.reset();
    expect(stats.snapshot()).toEqual({ count: 0, meanMs: 0, minMs: 0, maxMs: 0 });
  });
});
