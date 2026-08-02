import { describe, expect, it } from 'vitest';
import { WorkerPool } from './workerPool';

type FakeWorker = { id: number; terminated: boolean };

function fakePool(size: number) {
  let nextId = 0;
  const created: FakeWorker[] = [];
  const pool = new WorkerPool(size, () => {
    const w: FakeWorker = { id: nextId++, terminated: false };
    created.push(w);
    return {
      terminate() {
        w.terminated = true;
      },
    } as unknown as Worker;
  });
  // Age-based retirement is a separate concern; keep it out of these cases.
  pool.maxAge = Number.MAX_SAFE_INTEGER;
  return { pool, created };
}

describe('WorkerPool', () => {
  it('creates workers on demand rather than up front', async () => {
    const { pool, created } = fakePool(4);
    expect(created).toHaveLength(0);
    await pool.getWorker();
    expect(created).toHaveLength(1);
  });

  it('hands out distinct workers up to the pool size', async () => {
    const { pool, created } = fakePool(3);
    const a = await pool.getWorker();
    const b = await pool.getWorker();
    const c = await pool.getWorker();
    expect(new Set([a, b, c]).size).toBe(3);
    expect(created).toHaveLength(3);
  });

  it('queues once every worker is busy, and a release serves the waiter', async () => {
    const { pool, created } = fakePool(1);
    const a = await pool.getWorker();
    let served: Worker | undefined;
    const pending = pool.getWorker().then((w) => {
      served = w;
    });
    // Nothing free: the request must not have been satisfied yet.
    await Promise.resolve();
    expect(served).toBeUndefined();
    expect(created).toHaveLength(1);

    pool.releaseWorker(a!);
    await pending;
    expect(served).toBe(a);
  });

  it('replaces a killed worker so the slot is not lost', async () => {
    // The decode path kills workers that error or time out; the pool must
    // terminate them and stand up a replacement, or capacity leaks away.
    const { pool, created } = fakePool(2);
    const a = await pool.getWorker();
    pool.releaseWorker(a!, true);

    expect(created[0].terminated).toBe(true);
    expect(created).toHaveLength(2);

    const next = await pool.getWorker();
    expect(next).not.toBe(a);
  });

  it('hands the replacement to a queued waiter after a kill', async () => {
    const { pool } = fakePool(1);
    const a = await pool.getWorker();
    let served: Worker | undefined;
    const pending = pool.getWorker().then((w) => {
      served = w;
    });

    pool.releaseWorker(a!, true);
    await pending;
    expect(served).toBeDefined();
    expect(served).not.toBe(a);
  });

  it('survives repeated kills without losing capacity', async () => {
    const { pool } = fakePool(2);
    for (let i = 0; i < 12; i += 1) {
      const w = await pool.getWorker();
      expect(w).toBeDefined();
      pool.releaseWorker(w!, true);
    }
    // Both slots must still be usable after all that churn.
    const a = await pool.getWorker();
    const b = await pool.getWorker();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });
});
