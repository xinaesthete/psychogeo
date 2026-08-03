import { describe, expect, it, vi } from 'vitest';
import { attemptWithRetries, retryDelay } from './tileLayerManager';

const never = () => false;
const noWait = async () => {};

describe('attemptWithRetries', () => {
  it('returns the first success without waiting', async () => {
    const load = vi.fn(async () => 'tile');
    const wait = vi.fn(noWait);
    expect(await attemptWithRetries(load, never, wait)).toBe('tile');
    expect(load).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('recovers from a transient failure', async () => {
    // The case that left four permanent black tiles: one failure, good data,
    // and nothing to ask again.
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('decode blipped');
      return 'tile';
    });
    expect(await attemptWithRetries(load, never, noWait)).toBe('tile');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt limit and reports the last failure', async () => {
    const load = vi.fn(async () => {
      throw new Error('still broken');
    });
    await expect(attemptWithRetries(load, never, noWait)).rejects.toThrow('still broken');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('honours a lower attempt limit', async () => {
    const load = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(attemptWithRetries(load, never, noWait, 1)).rejects.toThrow('nope');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not retry work that was cancelled', async () => {
    // A superseded or off-screen load is not a failure to recover from, and
    // retrying it would resurrect work the tree has already moved past.
    const load = vi.fn(async () => {
      throw new Error('aborted');
    });
    const wait = vi.fn(noWait);
    await expect(attemptWithRetries(load, () => true, wait)).rejects.toThrow('aborted');
    expect(load).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops if the work is cancelled while waiting to retry', async () => {
    // The abort lands during the backoff — an aborted sleep resolves rather
    // than rejecting, so without the second check this would try again.
    let cancelled = false;
    const load = vi.fn(async () => {
      throw new Error('gone');
    });
    await expect(
      attemptWithRetries(load, () => cancelled, async () => {
        cancelled = true;
      }),
    ).rejects.toThrow('gone');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('backs off further with each attempt', () => {
    expect(retryDelay(1)).toBeLessThan(retryDelay(2));
    expect(retryDelay(2)).toBeLessThan(retryDelay(3));
  });
});
