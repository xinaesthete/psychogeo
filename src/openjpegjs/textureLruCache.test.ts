import { describe, expect, it } from 'vitest';
import { TextureLruCache } from './textureLruCache';

type FakeTile = { texture: { dispose(): void }; disposed: boolean };

function fakeTile(): FakeTile {
  const tile: FakeTile = {
    disposed: false,
    texture: {
      dispose() {
        tile.disposed = true;
      },
    },
  };
  return tile;
}

function makeCache(budget: number, minResidencyMs = 0) {
  let time = 0;
  const cache = new TextureLruCache<FakeTile>(budget, minResidencyMs, () => time);
  return { cache, tick: (ms = 1) => (time += ms) };
}

describe('TextureLruCache', () => {
  it('evicts least-recently-used unpinned entries beyond the byte budget', () => {
    const { cache, tick } = makeCache(250);
    const a = fakeTile();
    const b = fakeTile();
    const c = fakeTile();
    cache.set('a', a, 100);
    tick();
    cache.set('b', b, 100);
    tick();
    cache.set('c', c, 100);

    expect(cache.totalBytes).toBe(200);
    expect(a.disposed).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  it('never evicts pinned entries, even over budget', () => {
    const { cache, tick } = makeCache(150);
    const a = fakeTile();
    const b = fakeTile();
    cache.set('a', a, 100);
    cache.acquire('a');
    tick();
    cache.set('b', b, 100);
    cache.acquire('b');
    tick();
    cache.set('c', fakeTile(), 100);

    // a and b are pinned and c is protected during its own insertion, so
    // the cache runs over budget rather than break a live consumer.
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(a.disposed).toBe(false);
    expect(b.disposed).toBe(false);
    expect(cache.totalBytes).toBe(300);
  });

  it('release makes an entry evictable again', () => {
    const { cache, tick } = makeCache(100);
    const a = fakeTile();
    cache.set('a', a, 100);
    cache.acquire('a');
    tick();
    cache.set('b', fakeTile(), 100);
    // Over budget, but a is pinned and b just inserted: both survive.
    expect(cache.has('a')).toBe(true);

    tick();
    cache.release('a');
    tick();
    cache.set('c', fakeTile(), 100);
    // With a unpinned, the budget pass can now clear the backlog.
    expect(cache.has('a')).toBe(false);
    expect(a.disposed).toBe(true);
  });

  it('balanced acquire/release pairs keep shared entries pinned', () => {
    const { cache, tick } = makeCache(100);
    const a = fakeTile();
    cache.set('a', a, 100);
    cache.acquire('a');
    cache.acquire('a');
    tick();
    cache.release('a');
    cache.set('b', fakeTile(), 100);
    // One pin remains — must survive the over-budget insert.
    expect(cache.has('a')).toBe(true);

    tick();
    cache.release('a');
    cache.set('c', fakeTile(), 100);
    expect(cache.has('a')).toBe(false);
  });

  it('recent use moves an entry out of the eviction line', () => {
    const { cache, tick } = makeCache(250);
    cache.set('a', fakeTile(), 100);
    tick();
    cache.set('b', fakeTile(), 100);
    tick();
    cache.get('a');
    tick();
    cache.set('c', fakeTile(), 100);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('leaves very recent entries alone even when over budget', () => {
    const { cache, tick } = makeCache(150, 10_000);
    cache.set('a', fakeTile(), 100);
    tick(100);
    cache.set('b', fakeTile(), 100);
    // Both entries are younger than the residency window: nothing evicted.
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.totalBytes).toBe(200);

    tick(20_000);
    cache.set('c', fakeTile(), 100);
    expect(cache.has('a')).toBe(false);
  });

  it('force-evict removes and disposes pinned entries', () => {
    const { cache } = makeCache(1000);
    const a = fakeTile();
    cache.set('a', a, 100);
    cache.acquire('a');
    expect(cache.evict('a')).toBe(true);
    expect(a.disposed).toBe(true);
    expect(cache.totalBytes).toBe(0);
    expect(cache.evict('a')).toBe(false);
  });

  it('replacing an entry disposes the previous tile and fixes byte accounting', () => {
    const { cache } = makeCache(1000);
    const a1 = fakeTile();
    const a2 = fakeTile();
    cache.set('a', a1, 100);
    cache.set('a', a2, 300);
    expect(a1.disposed).toBe(true);
    expect(a2.disposed).toBe(false);
    expect(cache.totalBytes).toBe(300);
  });

  it('clear disposes everything and resets accounting', () => {
    const { cache } = makeCache(1000);
    const a = fakeTile();
    const b = fakeTile();
    cache.set('a', a, 100);
    cache.set('b', b, 100);
    cache.clear();
    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(true);
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it('lowering the budget evicts immediately', () => {
    const { cache, tick } = makeCache(1000);
    cache.set('a', fakeTile(), 400);
    tick();
    cache.set('b', fakeTile(), 400);
    tick();
    cache.setBudgetBytes(500);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });
});
