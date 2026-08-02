import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('actually overlaps work rather than running serially', async () => {
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    let started = 0;
    const run = mapWithConcurrency(gates, 3, async (g) => {
      started += 1;
      return g.promise;
    });
    await Promise.resolve();
    // All three lanes should be waiting before any of them completes.
    expect(started).toBe(3);
    gates.forEach((g, i) => g.resolve(i));
    expect(await run).toEqual([0, 1, 2]);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('copes with a limit larger than the item count', async () => {
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('treats a nonsensical limit as serial rather than stalling', async () => {
    expect(await mapWithConcurrency([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
  });

  it('rejects with the first error and stops starting new work', async () => {
    let started = 0;
    await expect(
      mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 2, async (i) => {
        started += 1;
        if (i === 1) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 1));
        return i;
      }),
    ).rejects.toThrow('boom');
    expect(started).toBeLessThan(20);
  });
});
