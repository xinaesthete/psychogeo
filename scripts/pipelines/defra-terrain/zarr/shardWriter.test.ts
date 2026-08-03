import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32c } from './crc32c.ts';
import {
  chunkFromBytes,
  encodeShardIndex,
  shardIndexByteLength,
  writeShard,
} from './shardWriter.ts';

const EMPTY = 0xffffffffffffffffn;
const dirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tc-shard-'));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('crc32c', () => {
  it('matches the Castagnoli check vector', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
  });
});

describe('encodeShardIndex', () => {
  it('marks every slot empty when nothing was written', () => {
    const index = encodeShardIndex([2, 2], new Map());
    expect(index.length).toBe(shardIndexByteLength([2, 2]));
    const view = new DataView(index.buffer, index.byteOffset);
    for (let slot = 0; slot < 4; slot += 1) {
      expect(view.getBigUint64(slot * 16, true)).toBe(EMPTY);
      expect(view.getBigUint64(slot * 16 + 8, true)).toBe(EMPTY);
    }
  });

  it('writes offset/length pairs in C order and checksums the body', () => {
    const entries = new Map([
      [0, { offset: 0, length: 10 }],
      [3, { offset: 10, length: 7 }],
    ]);
    const index = encodeShardIndex([2, 2], entries);
    const view = new DataView(index.buffer, index.byteOffset);
    expect(view.getBigUint64(0, true)).toBe(0n);
    expect(view.getBigUint64(8, true)).toBe(10n);
    expect(view.getBigUint64(16, true)).toBe(EMPTY); // slot 1 unwritten
    expect(view.getBigUint64(48, true)).toBe(10n); // slot 3 offset
    expect(view.getBigUint64(56, true)).toBe(7n);

    const body = index.subarray(0, index.length - 4);
    expect(view.getUint32(index.length - 4, true)).toBe(crc32c(body));
  });
});

describe('writeShard', () => {
  it('lays chunks back to back and indexes them by slot', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'c', '0', '0');
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([9, 9, 9, 9, 9]);

    const stats = await writeShard(target, [2, 2], [
      chunkFromBytes([0, 0], first),
      chunkFromBytes([1, 1], second),
    ]);
    expect(stats).toEqual({
      chunkCount: 2,
      payloadBytes: 8,
      indexBytes: shardIndexByteLength([2, 2]),
    });

    const shard = new Uint8Array(await readFile(target));
    expect(shard.length).toBe(8 + shardIndexByteLength([2, 2]));

    // Recover each chunk exactly as a range-reading client would.
    const view = new DataView(shard.buffer, shard.byteOffset);
    const indexStart = shard.length - shardIndexByteLength([2, 2]);
    const slotOf = (slot: number) => ({
      offset: Number(view.getBigUint64(indexStart + slot * 16, true)),
      length: Number(view.getBigUint64(indexStart + slot * 16 + 8, true)),
    });
    const slot0 = slotOf(0);
    const slot3 = slotOf(3);
    expect(shard.subarray(slot0.offset, slot0.offset + slot0.length)).toEqual(first);
    expect(shard.subarray(slot3.offset, slot3.offset + slot3.length)).toEqual(second);
    expect(view.getBigUint64(indexStart + 16, true)).toBe(EMPTY);
  });

  it('refuses two chunks in one slot', async () => {
    const dir = await scratchDir();
    await expect(
      writeShard(path.join(dir, 'c', '0', '0'), [2, 2], [
        chunkFromBytes([0, 1], new Uint8Array([1])),
        chunkFromBytes([0, 1], new Uint8Array([2])),
      ]),
    ).rejects.toThrow(/two chunks claim slot/);
  });

  it('rejects a chunk outside the shard', async () => {
    const dir = await scratchDir();
    await expect(
      writeShard(path.join(dir, 'c', '0', '0'), [2, 2], [
        chunkFromBytes([2, 0], new Uint8Array([1])),
      ]),
    ).rejects.toThrow(/outside a/);
  });
});
