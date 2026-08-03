import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseByteRange, withByteRange, ZarrPyramidResolver } from './zarrPyramid';

const STORE = 'https://example.test/store';
const CHANNEL = 'height.dsm.fz';
const DTM_CHANNEL = 'height.dtm';
const SCALE = 0.02151554918057802;
const OFFSET = -10.021515549180577;

function levelArray(level: number, sharded: boolean) {
  const chunkMetres = 1000 * 4 ** level;
  const chunks = [
    Math.ceil(1_300_000 / chunkMetres),
    Math.ceil(700_000 / chunkMetres),
  ];
  return {
    zarr_format: 3,
    node_type: 'array',
    shape: [chunks[0] * 1000, chunks[1] * 1000],
    data_type: 'uint16',
    chunk_grid: {
      name: 'regular',
      configuration: { chunk_shape: sharded ? [10_000, 10_000] : [1000, 1000] },
    },
    fill_value: 0,
    codecs: sharded
      ? [{ name: 'sharding_indexed', configuration: { chunk_shape: [1000, 1000] } }]
      : [{ name: 'experimental.openjph_htj2k' }],
    attributes: {
      psychogeo: { level, resolutionMetres: 4 ** level, chunkMetres, scale: SCALE, offset: OFFSET },
    },
  };
}

/** A 10x10 shard index with `present` slots filled, laid out as ZEP2 expects. */
function shardIndex(present: Map<number, { offset: number; length: number }>): ArrayBuffer {
  const slots = 100;
  const buffer = new ArrayBuffer(slots * 16 + 4);
  const view = new DataView(buffer);
  for (let slot = 0; slot < slots; slot += 1) {
    const entry = present.get(slot);
    view.setBigUint64(slot * 16, entry ? BigInt(entry.offset) : 0xffffffffffffffffn, true);
    view.setBigUint64(slot * 16 + 8, entry ? BigInt(entry.length) : 0xffffffffffffffffn, true);
  }
  return buffer;
}

function mockStore(shards: Map<string, ArrayBuffer>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url === `${STORE}/zarr.json`) {
      return json({
        zarr_format: 3,
        node_type: 'group',
        attributes: { psychogeo: { channels: [CHANNEL, DTM_CHANNEL] } },
      });
    }
    if (url === `${STORE}/${CHANNEL}/zarr.json` || url === `${STORE}/${DTM_CHANNEL}/zarr.json`) {
      const id = url.slice(STORE.length + 1, url.lastIndexOf('/'));
      return json({
        zarr_format: 3,
        node_type: 'group',
        attributes: {
          multiscales: [{ datasets: [{ path: '0' }, { path: '1' }] }],
          psychogeo: {
            channelId: id,
            encoding: { normalisation: 'globalScaleOffset', scale: SCALE, offset: OFFSET },
          },
        },
      });
    }
    const levelMatch = /\/(\d)\/zarr\.json$/.exec(url);
    if (levelMatch) return json(levelArray(Number(levelMatch[1]), true));

    const shard = shards.get(url);
    if (shard && init?.headers) {
      // Only suffix reads are used for the index; anything else is a chunk read.
      return new Response(shard, { status: 206 });
    }
    return new Response(null, { status: 404 });
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('byte range fragments', () => {
  it('round-trips through a URL fragment', () => {
    const url = withByteRange('https://x/y/c/0/0', 100, 50);
    expect(url).toBe('https://x/y/c/0/0#bytes=100-149');
    expect(parseByteRange(url)).toEqual({ url: 'https://x/y/c/0/0', range: { start: 100, end: 149 } });
  });

  it('leaves a plain URL alone', () => {
    expect(parseByteRange('https://x/y/c/0/0')).toEqual({ url: 'https://x/y/c/0/0' });
  });
});

describe('ZarrPyramidResolver', () => {
  it('reads the level ladder and the shared encoding', async () => {
    globalThis.fetch = mockStore(new Map()) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);
    expect(resolver).toBeDefined();
    expect(resolver!.encoding.scale).toBeCloseTo(SCALE, 12);
    expect(resolver!.levels.map((l) => l.resolutionMetres)).toEqual([1, 4]);
    expect(resolver!.levels[0].chunkGrid).toEqual([1300, 700]);
    expect(resolver!.levels[0].shardChunks).toEqual([10, 10]);
    // The tree picks a level from this, so it has to carry the ground size.
    expect(resolver!.catalogRef.meta.tileMatrixSet.levels[1].tierMetres).toBe(4000);
  });

  it('opens the first channel the root declares, and reports the rest', async () => {
    globalThis.fetch = mockStore(new Map()) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);
    expect(resolver!.channelId).toBe(CHANNEL);
    expect(resolver!.availableChannels).toEqual([CHANNEL, DTM_CHANNEL]);
  });

  it('opens a named channel instead of the first', async () => {
    globalThis.fetch = mockStore(new Map()) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE, DTM_CHANNEL);
    expect(resolver!.channelId).toBe(DTM_CHANNEL);
    expect(resolver!.levels[0].baseUrl).toBe(`${STORE}/${DTM_CHANNEL}/0`);
  });

  it('refuses a channel the store does not declare', async () => {
    globalThis.fetch = mockStore(new Map()) as unknown as typeof fetch;
    expect(await ZarrPyramidResolver.load(STORE, 'height.nope')).toBeUndefined();
  });

  it('opens a channel group addressed directly', async () => {
    // How the dataset URL control selects a channel: no new syntax, just point
    // at the channel rather than the store.
    globalThis.fetch = mockStore(new Map()) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(`${STORE}/${DTM_CHANNEL}`);
    expect(resolver!.channelId).toBe(DTM_CHANNEL);
    expect(resolver!.levels[0].baseUrl).toBe(`${STORE}/${DTM_CHANNEL}/0`);
  });

  it('refuses a root that names no channels rather than guessing one', async () => {
    // The shape written before the root carried a channel list. Guessing
    // `height.dsm.fz` here would work until a store had something else.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${STORE}/zarr.json`) {
        return new Response(
          JSON.stringify({ zarr_format: 3, node_type: 'group', attributes: { psychogeo: {} } }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    expect(await ZarrPyramidResolver.load(STORE)).toBeUndefined();
  });

  it('prefers a consolidated index, and asks for nothing else', async () => {
    // The whole point: no zarr.json per level, no suffix read per shard.
    const header = {
      psychogeo: { storeIndexVersion: 1 },
      channels: [{
        channelId: CHANNEL,
        encoding: { normalisation: 'globalScaleOffset', scale: SCALE, offset: OFFSET },
        levels: [{
          level: 0, path: '0', resolutionMetres: 1, chunkMetres: 1000, chunkPixels: 1000,
          chunkGrid: [1300, 700], shardChunks: [10, 10], recordCount: 1,
        }],
      }],
    };
    const body = new Uint8Array(8 + 100 * 8);
    const bv = new DataView(body.buffer);
    bv.setUint32(0, 117, true);
    bv.setUint32(4, 44, true);
    bv.setUint32(8, 0, true); bv.setUint32(12, 500, true); // slot 0
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const bytes = new Uint8Array(12 + headerBytes.length + body.length);
    const hv = new DataView(bytes.buffer);
    hv.setUint32(0, 0x497a4750, true);
    hv.setUint32(4, 1, true);
    hv.setUint32(8, headerBytes.length, true);
    bytes.set(headerBytes, 12);
    bytes.set(body, 12 + headerBytes.length);

    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url === `${STORE}/psychogeo-index.bin`) return new Response(bytes, { status: 200 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const resolver = await ZarrPyramidResolver.load(STORE);
    expect(resolver).toBeDefined();
    expect(resolver!.levels.map((l) => l.chunkMetres)).toEqual([1000]);

    const chunks = await resolver!.resolveChunksInBounds(
      { eastMin: 440_000, eastMax: 441_000, northMin: 129_000, northMax: 130_000 },
      0,
    );
    expect(chunks.map((c) => c.url)).toEqual([`${STORE}/${CHANNEL}/0/c/117/44#bytes=0-499`]);
    expect(asked).toEqual([`${STORE}/psychogeo-index.bin`]);
  });

  it('falls back to reading the store when there is no index', async () => {
    const store = mockStore(new Map());
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('psychogeo-index.bin')) return new Response(null, { status: 404 });
      return store(input, init);
    }) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);
    expect(resolver!.levels.map((l) => l.resolutionMetres)).toEqual([1, 4]);
  });

  it('emits one descriptor per present chunk, with its byte range', async () => {
    // Two 1 km chunks at the north-west of shard (117, 44): slots 0 and 1.
    const present = new Map([
      [0, { offset: 0, length: 500 }],
      [1, { offset: 500, length: 700 }],
    ]);
    const shards = new Map([[`${STORE}/${CHANNEL}/0/c/117/44`, shardIndex(present)]]);
    globalThis.fetch = mockStore(shards) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);

    const chunks = await resolver!.resolveChunksInBounds(
      { eastMin: 440_100, eastMax: 441_900, northMin: 129_100, northMax: 129_900 },
      0,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].eastMin).toBe(440_000);
    expect(chunks[0].northMin).toBe(129_000);
    expect(chunks[0].url).toBe(`${STORE}/${CHANNEL}/0/c/117/44#bytes=0-499`);
    expect(chunks[1].url).toBe(`${STORE}/${CHANNEL}/0/c/117/44#bytes=500-1199`);
    expect(chunks[0].width).toBe(1000);
    expect(chunks[0].extentMetres).toBe(1000);
  });

  it('skips chunks the shard marks empty rather than inventing URLs', async () => {
    const shards = new Map([[`${STORE}/${CHANNEL}/0/c/117/44`, shardIndex(new Map([[0, { offset: 0, length: 500 }]]))]]);
    globalThis.fetch = mockStore(shards) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);
    const chunks = await resolver!.resolveChunksInBounds(
      { eastMin: 440_100, eastMax: 443_900, northMin: 126_100, northMax: 129_900 },
      0,
    );
    expect(chunks).toHaveLength(1);
  });

  it('returns nothing where no shard exists at all', async () => {
    globalThis.fetch = mockStore(new Map()) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);
    const chunks = await resolver!.resolveChunksInBounds(
      { eastMin: 200_000, eastMax: 202_000, northMin: 700_000, northMax: 702_000 },
      0,
    );
    expect(chunks).toEqual([]);
  });

  it('fetches each shard index once however many chunks want it', async () => {
    const present = new Map(Array.from({ length: 9 }, (_, i) => [i, { offset: i * 100, length: 100 }] as const));
    const shards = new Map([[`${STORE}/${CHANNEL}/0/c/117/44`, shardIndex(present)]]);
    const fetchMock = mockStore(shards);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);
    await resolver!.resolveChunksInBounds(
      { eastMin: 440_100, eastMax: 442_900, northMin: 127_100, northMax: 129_900 },
      0,
    );
    const indexFetches = fetchMock.mock.calls.filter(
      ([url]) => String(url) === `${STORE}/${CHANNEL}/0/c/117/44`,
    );
    expect(indexFetches).toHaveLength(1);
  });

  it('refines near the camera and leaves distant ground coarse', async () => {
    // Both levels fully populated, so the only thing deciding the level is
    // distance. A single level for the whole viewport would return one or the
    // other, never both — which is what an oblique view actually needs, since
    // its ground footprint runs to the horizon.
    const full = new Map(Array.from({ length: 100 }, (_, i) => [i, { offset: i * 10, length: 10 }] as const));
    const shards = new Map<string, ArrayBuffer>();
    for (let y = 116; y <= 118; y += 1) {
      for (let x = 43; x <= 45; x += 1) shards.set(`${STORE}/${CHANNEL}/0/c/${y}/${x}`, shardIndex(full));
    }
    for (let y = 28; y <= 30; y += 1) {
      for (let x = 10; x <= 12; x += 1) shards.set(`${STORE}/${CHANNEL}/1/c/${y}/${x}`, shardIndex(full));
    }
    globalThis.fetch = mockStore(shards) as unknown as typeof fetch;
    const resolver = await ZarrPyramidResolver.load(STORE);

    const camera = { position: { x: 445_000, y: 125_000, z: 200 } } as never;
    const chunks = await resolver!.resolveChunksInBoundsAdaptive(
      { eastMin: 440_000, eastMax: 452_000, northMin: 118_000, northMax: 130_000 },
      camera,
    );
    const levels = new Set(chunks.map((chunk) => chunk.level));
    expect(levels.has(0)).toBe(true);
    expect(levels.has(1)).toBe(true);

    // The finest chunks are the ones under the camera, the coarse ones further off.
    const distance = (chunk: (typeof chunks)[number]) =>
      Math.hypot(chunk.eastMin + chunk.extentMetres / 2 - 445_000, chunk.northMin + chunk.extentMetres / 2 - 125_000);
    const fine = chunks.filter((chunk) => chunk.level === 0);
    const coarse = chunks.filter((chunk) => chunk.level === 1);
    expect(Math.min(...fine.map(distance))).toBeLessThan(Math.min(...coarse.map(distance)));
  });

  it('checks an unsharded level for presence instead of assuming it', async () => {
    // Level 4 has no shard index to consult, so without a probe every national
    // grid coordinate looks present and the tree queues a chunk per 404.
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'HEAD') {
        seen.push(url);
        return new Response(null, { status: url.endsWith('/c/4/1') ? 200 : 404 });
      }
      if (url === `${STORE}/zarr.json`) {
        return new Response(JSON.stringify({ zarr_format: 3, node_type: 'group', attributes: { psychogeo: { channels: [CHANNEL] } } }));
      }
      if (url === `${STORE}/${CHANNEL}/zarr.json`) {
        return new Response(JSON.stringify({
          zarr_format: 3,
          node_type: 'group',
          attributes: {
            multiscales: [{ datasets: [{ path: '4' }] }],
            psychogeo: { encoding: { normalisation: 'globalScaleOffset', scale: SCALE, offset: OFFSET } },
          },
        }));
      }
      if (/\/4\/zarr\.json$/.test(url)) return new Response(JSON.stringify(levelArray(4, false)));
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const resolver = await ZarrPyramidResolver.load(STORE);
    const chunks = await resolver!.resolveChunksInBounds(
      { eastMin: 260_000, eastMax: 700_000, northMin: 20_000, northMax: 800_000 },
      4,
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.url)).toEqual([`${STORE}/${CHANNEL}/4/c/4/1`]);
  });

  it('refuses a store that still carries per-chunk scalars', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${STORE}/zarr.json`) {
        return new Response(JSON.stringify({ zarr_format: 3, node_type: 'group', attributes: {} }));
      }
      if (url === `${STORE}/${CHANNEL}/zarr.json`) {
        return new Response(
          JSON.stringify({
            zarr_format: 3,
            node_type: 'group',
            attributes: { psychogeo: { encoding: { normalisation: 'perChunkScaleOffset' } } },
          }),
        );
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    expect(await ZarrPyramidResolver.load(STORE)).toBeUndefined();
  });
});
