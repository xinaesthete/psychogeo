import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseByteRange, withByteRange, ZarrPyramidResolver } from './zarrPyramid';

const STORE = 'https://example.test/store';
const CHANNEL = 'height.dsm.fz';
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
      return json({ zarr_format: 3, node_type: 'group', attributes: { psychogeo: { channelId: CHANNEL } } });
    }
    if (url === `${STORE}/${CHANNEL}/zarr.json`) {
      return json({
        zarr_format: 3,
        node_type: 'group',
        attributes: {
          multiscales: [{ datasets: [{ path: '0' }, { path: '1' }] }],
          psychogeo: { encoding: { normalisation: 'globalScaleOffset', scale: SCALE, offset: OFFSET } },
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
