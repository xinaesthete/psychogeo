import { describe, expect, it } from 'vitest';
import { mapPool } from './concurrency.ts';

describe('mapPool', () => {
  it('runs all items with bounded concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapPool([1, 2, 3, 4, 5], 2, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
