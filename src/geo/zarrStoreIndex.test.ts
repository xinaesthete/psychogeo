import { describe, expect, it } from 'vitest';
import { parseStoreIndex } from './zarrStoreIndex';

const MAGIC = 0x497a4750;

function build(header: unknown, body: Uint8Array, opts: { magic?: number; version?: number } = {}): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(12 + headerBytes.length + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, opts.magic ?? MAGIC, true);
  view.setUint32(4, opts.version ?? 1, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  out.set(body, 12 + headerBytes.length);
  return out;
}

const level = (over: Record<string, unknown> = {}) => ({
  level: 0,
  path: '0',
  resolutionMetres: 1,
  chunkMetres: 1000,
  chunkPixels: 1000,
  chunkGrid: [1300, 700],
  shardChunks: [2, 2],
  recordCount: 1,
  ...over,
});

/** One 2x2 shard at (3, 4) with slots 0 and 3 present. */
function shardBody(): Uint8Array {
  const out = new Uint8Array(8 + 4 * 8);
  const v = new DataView(out.buffer);
  v.setUint32(0, 3, true);
  v.setUint32(4, 4, true);
  const slots: Array<[number, number]> = [[0, 10], [0, 0], [0, 0], [10, 20]];
  slots.forEach(([offset, length], i) => {
    v.setUint32(8 + i * 8, offset, true);
    v.setUint32(8 + i * 8 + 4, length, true);
  });
  return out;
}

const oneLevel = (body = shardBody(), over = {}) =>
  build({ psychogeo: { storeIndexVersion: 1 }, channels: [{ channelId: 'height.dsm.fz', encoding: { scale: 1, offset: 0 }, levels: [level(over)] }] }, body);

describe('parseStoreIndex', () => {
  it('reads shard slots, treating zero length as absent', () => {
    const index = parseStoreIndex(oneLevel());
    expect(index!.channels).toEqual(['height.dsm.fz']);
    const slots = index!.channel()!.shardSlots(0, 3, 4)!;
    expect(slots.length).toBe(4);
    expect(slots[0]).toEqual({ offset: 0, length: 10 });
    expect(slots[1]).toBeNull();
    expect(slots[3]).toEqual({ offset: 10, length: 20 });
    expect(index!.channel()!.shardSlots(0, 9, 9)).toBeUndefined();
  });

  it('reads present coordinates for an unsharded level', () => {
    const body = new Uint8Array(16);
    const v = new DataView(body.buffer);
    v.setUint32(0, 2, true); v.setUint32(4, 1, true);
    v.setUint32(8, 5, true); v.setUint32(12, 0, true);
    const index = parseStoreIndex(oneLevel(body, { shardChunks: null, recordCount: 2 }));
    const channel = index!.channel()!;
    expect(channel.hasChunk(0, 2, 1)).toBe(true);
    expect(channel.hasChunk(0, 5, 0)).toBe(true);
    expect(channel.hasChunk(0, 1, 1)).toBe(false);
  });

  it('selects a channel by name and reports them all', () => {
    const bytes = build({
      psychogeo: { storeIndexVersion: 1 },
      channels: [
        { channelId: 'height.dsm.fz', encoding: {}, levels: [] },
        { channelId: 'height.dtm', encoding: {}, levels: [] },
      ],
    }, new Uint8Array(0));
    const index = parseStoreIndex(bytes)!;
    expect(index.channels).toEqual(['height.dsm.fz', 'height.dtm']);
    expect(index.channel()!.channelId).toBe('height.dsm.fz');
    expect(index.channel('height.dtm')!.channelId).toBe('height.dtm');
    expect(index.channel('height.nope')).toBeUndefined();
  });

  // Every rejection below makes the resolver fall back to reading the store
  // directly, so a bad index costs a round trip rather than a wrong chunk.
  it('rejects anything it does not recognise rather than guessing', () => {
    expect(parseStoreIndex(new Uint8Array(4))).toBeUndefined();
    expect(parseStoreIndex(oneLevel(shardBody()).map((v, i) => (i === 0 ? v ^ 0xff : v)) as Uint8Array)).toBeUndefined();
    expect(parseStoreIndex(build({ channels: [] }, new Uint8Array(0), { version: 2 }))).toBeUndefined();
    expect(parseStoreIndex(build({ channels: [] }, new Uint8Array(0)))).toBeUndefined();
  });

  it('rejects a body too short for the records the header promises', () => {
    // Truncation has to be caught: reading past the end would hand the
    // resolver garbage offsets that still look like numbers.
    const truncated = oneLevel(shardBody().subarray(0, 16));
    expect(parseStoreIndex(truncated)).toBeUndefined();
  });
});
