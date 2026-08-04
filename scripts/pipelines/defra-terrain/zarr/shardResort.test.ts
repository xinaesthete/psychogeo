import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodeShardIndex,
  isSlotOrdered,
  resortShard,
  resortStore,
} from './shardResort.ts';
import { chunkFromBytes, encodeShardIndex, shardIndexByteLength, writeShard } from './shardWriter.ts';

const SHARD: readonly [number, number] = [2, 2];
const INDEX_BYTES = shardIndexByteLength(SHARD);
const dirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tc-resort-'));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A payload byte pattern unique to a slot, so a misplaced chunk is unmistakable. */
const chunkBytes = (slot: number, length: number) => new Uint8Array(length).fill(slot + 1);

/**
 * Write a shard by hand with the payload in an arbitrary order — what the
 * renormalise pass produced before `writeShard` sorted.
 */
async function writeScrambled(
  filePath: string,
  layout: ReadonlyArray<{ slot: number; length: number }>,
): Promise<void> {
  const entries = new Map<number, { offset: number; length: number }>();
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const { slot, length } of layout) {
    parts.push(chunkBytes(slot, length));
    entries.set(slot, { offset, length });
    offset += length;
  }
  const payload = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    payload.set(part, at);
    at += part.length;
  }
  const index = encodeShardIndex(SHARD, entries);
  const file = new Uint8Array(payload.length + index.length);
  file.set(payload, 0);
  file.set(index, payload.length);
  await writeFile(filePath, file);
}

async function readEntries(filePath: string) {
  const bytes = new Uint8Array(await readFile(filePath));
  const index = bytes.subarray(bytes.length - INDEX_BYTES);
  return { bytes, entries: decodeShardIndex(index, SHARD) };
}

describe('writeShard slot ordering', () => {
  it('lays chunks out in slot order whatever order the caller supplies', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'c', '0', '0');
    await writeShard(target, SHARD, [
      chunkFromBytes([1, 1], chunkBytes(3, 5)),
      chunkFromBytes([0, 0], chunkBytes(0, 3)),
      chunkFromBytes([1, 0], chunkBytes(2, 7)),
    ]);

    const { entries } = await readEntries(target);
    expect(entries.map((entry) => entry.slot)).toEqual([0, 2, 3]);
    expect(entries.map((entry) => entry.offset)).toEqual([0, 3, 10]);
    expect(isSlotOrdered(entries)).toBe(true);
  });
});

describe('isSlotOrdered', () => {
  it('accepts a gap-free run from zero', () => {
    expect(isSlotOrdered([
      { slot: 0, offset: 0, length: 4 },
      { slot: 2, offset: 4, length: 6 },
    ])).toBe(true);
  });

  it('rejects a gap, even when the offsets ascend', () => {
    // A gap costs a coalescing client the dead bytes between two chunks it
    // asked for, so an ascending-but-holey shard is not what this pass wants.
    expect(isSlotOrdered([
      { slot: 0, offset: 0, length: 4 },
      { slot: 2, offset: 8, length: 6 },
    ])).toBe(false);
  });

  it('rejects a payload that does not start at zero', () => {
    expect(isSlotOrdered([{ slot: 0, offset: 16, length: 4 }])).toBe(false);
  });
});

describe('resortShard', () => {
  it('moves each chunk to its slot position and keeps its bytes', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'shard');
    await writeScrambled(target, [
      { slot: 3, length: 5 },
      { slot: 0, length: 3 },
      { slot: 2, length: 7 },
    ]);

    const result = await resortShard(target, SHARD, { verify: true });
    expect(result).toEqual({ status: 'sorted', chunks: 3, payloadBytes: 15 });

    const { bytes, entries } = await readEntries(target);
    expect(entries.map((entry) => entry.slot)).toEqual([0, 2, 3]);
    expect(isSlotOrdered(entries)).toBe(true);
    // The point of the exercise: a client asking for slots 2 and 3 together now
    // gets one contiguous range rather than two ends of the file.
    expect(entries[1].offset + entries[1].length).toBe(entries[2].offset);
    for (const entry of entries) {
      expect(bytes.subarray(entry.offset, entry.offset + entry.length)).toEqual(
        chunkBytes(entry.slot, entry.length),
      );
    }
    expect(bytes.length).toBe(15 + INDEX_BYTES);
  });

  it('leaves an ordered shard alone and is safe to run twice', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'shard');
    await writeScrambled(target, [
      { slot: 3, length: 5 },
      { slot: 0, length: 3 },
    ]);

    await resortShard(target, SHARD);
    const first = new Uint8Array(await readFile(target));
    const again = await resortShard(target, SHARD, { verify: true });
    expect(again.status).toBe('ordered');
    expect(new Uint8Array(await readFile(target))).toEqual(first);
  });

  it('skips a shard with nothing in it', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'shard');
    await writeFile(target, encodeShardIndex(SHARD, new Map()));
    expect((await resortShard(target, SHARD)).status).toBe('skipped');
  });

  it('refuses an index that points past the payload rather than rewriting it', async () => {
    // Truncation or a bad index has to stop the pass: rewriting from it would
    // turn a recoverable store into a silently wrong one.
    const dir = await scratchDir();
    const target = path.join(dir, 'shard');
    await writeScrambled(target, [
      { slot: 3, length: 5 },
      { slot: 0, length: 3 },
    ]);
    const bytes = new Uint8Array(await readFile(target));
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setBigUint64(bytes.length - INDEX_BYTES + 8, 500n, true); // slot 0 claims 500 bytes
    await writeFile(target, bytes);

    await expect(resortShard(target, SHARD)).rejects.toThrow(/past the/);
    // The original is still there, untouched.
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });
});

describe('resortStore', () => {
  async function fixtureStore(): Promise<string> {
    const dir = await scratchDir();
    await writeFile(
      path.join(dir, 'zarr.json'),
      JSON.stringify({
        zarr_format: 3,
        node_type: 'group',
        attributes: { psychogeo: { channels: ['height.dsm.fz'] } },
      }),
    );
    const channelDir = path.join(dir, 'height.dsm.fz');
    await writeFile(
      path.join(await mkdirp(channelDir), 'zarr.json'),
      JSON.stringify({
        zarr_format: 3,
        node_type: 'group',
        attributes: { multiscales: [{ datasets: [{ path: '0' }, { path: '1' }] }] },
      }),
    );
    await writeFile(
      path.join(await mkdirp(path.join(channelDir, '0')), 'zarr.json'),
      JSON.stringify({
        zarr_format: 3,
        node_type: 'array',
        shape: [4000, 4000],
        chunk_grid: { configuration: { chunk_shape: [2000, 2000] } },
        codecs: [{ name: 'sharding_indexed', configuration: { chunk_shape: [1000, 1000] } }],
        attributes: { psychogeo: { level: 0 } },
      }),
    );
    // An unsharded level: nothing to reorder, and it must not trip the walk.
    await writeFile(
      path.join(await mkdirp(path.join(channelDir, '1')), 'zarr.json'),
      JSON.stringify({
        zarr_format: 3,
        node_type: 'array',
        shape: [1000, 1000],
        chunk_grid: { configuration: { chunk_shape: [1000, 1000] } },
        codecs: [],
        attributes: { psychogeo: { level: 1 } },
      }),
    );
    await mkdirp(path.join(channelDir, '0', 'c', '0'));
    await writeScrambled(path.join(channelDir, '0', 'c', '0', '0'), [
      { slot: 3, length: 5 },
      { slot: 1, length: 4 },
    ]);
    await writeScrambled(path.join(channelDir, '0', 'c', '0', '1'), [
      { slot: 0, length: 2 },
      { slot: 1, length: 6 },
    ]);
    return dir;
  }

  it('reports what it would do without touching the store', async () => {
    const dir = await fixtureStore();
    const before = await readFile(path.join(dir, 'height.dsm.fz', '0', 'c', '0', '0'));
    const summary = await resortStore({ storeDir: dir, dryRun: true });
    expect(summary.sorted).toBe(1); // c/0/0 is scrambled, c/0/1 already ascends
    expect(summary.alreadyOrdered).toBe(1);
    expect(summary.levels).toHaveLength(1); // the unsharded level is not listed
    expect(new Uint8Array(await readFile(path.join(dir, 'height.dsm.fz', '0', 'c', '0', '0'))))
      .toEqual(new Uint8Array(before));
  });

  it('rewrites every sharded level and converges on a second pass', async () => {
    const dir = await fixtureStore();
    const first = await resortStore({ storeDir: dir, verify: true });
    expect(first.sorted).toBe(1);
    expect(first.bytes).toBe(17);

    const second = await resortStore({ storeDir: dir, verify: true });
    expect(second.sorted).toBe(0);
    expect(second.alreadyOrdered).toBe(2);
  });
});

async function mkdirp(dir: string): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  return dir;
}
