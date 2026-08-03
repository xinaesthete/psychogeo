import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStoreIndex } from '../../../../src/geo/zarrStoreIndex.ts';
import { globalScaleOffset } from './globalScale.ts';
import { renormalisedLevels } from './levels.ts';
import { chunkFromBytes, writeShard } from './shardWriter.ts';
import {
  buildRenormChannelMetadata,
  buildRenormLevelMetadata,
  buildStoreRootMetadata,
} from './storeMetadata.ts';
import { buildStoreIndex, STORE_INDEX_FILENAME } from './storeIndex.ts';
import type { TerrainManifestV2 } from '../v2/types.ts';

const CHANNEL = 'height.dsm.fz';
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * A real store, in miniature: the pass's own metadata builders and its own
 * shard writer, so the index is built from the format rather than from a
 * hand-drawn imitation of it.
 */
async function buildFixtureStore(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tc-index-'));
  created.push(dir);
  const levels = renormalisedLevels(5);
  const encoding = globalScaleOffset();
  const source = {
    channelId: CHANNEL,
    datasetId: 'tc-test',
    format: 'tc-dsm-pyramid',
    crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN' },
  } as TerrainManifestV2;

  await writeJson(path.join(dir, 'zarr.json'), buildStoreRootMetadata([CHANNEL]));
  await writeJson(
    path.join(dir, CHANNEL, 'zarr.json'),
    buildRenormChannelMetadata(source, levels, encoding, false),
  );
  for (const level of levels) {
    await writeJson(
      path.join(dir, CHANNEL, String(level.level), 'zarr.json'),
      buildRenormLevelMetadata(level, encoding),
    );
  }

  // One level-0 shard holding three chunks, at slots 0, 5 and 99.
  await writeShard(path.join(dir, CHANNEL, '0', 'c', '12', '34'), [10, 10], [
    chunkFromBytes([0, 0], new Uint8Array([1, 2, 3, 4])),
    chunkFromBytes([0, 5], new Uint8Array([5, 6, 7])),
    chunkFromBytes([9, 9], new Uint8Array([8, 9])),
  ]);
  // One unsharded level-4 chunk, which is a plain object.
  await mkdir(path.join(dir, CHANNEL, '4', 'c', '2'), { recursive: true });
  await writeFile(path.join(dir, CHANNEL, '4', 'c', '2', '1'), new Uint8Array([42]));
  return dir;
}

describe('buildStoreIndex', () => {
  it('round-trips a store through the reader that consumes it', async () => {
    const dir = await buildFixtureStore();
    const summary = await buildStoreIndex(dir);
    expect(summary.shards).toBe(1);
    expect(summary.chunks).toBe(4); // three inner chunks plus the unsharded one

    const index = parseStoreIndex(new Uint8Array(await readFile(path.join(dir, STORE_INDEX_FILENAME))));
    expect(index).toBeDefined();
    expect(index!.channels).toEqual([CHANNEL]);

    const channel = index!.channel();
    expect(channel!.levels.map((l) => l.level)).toEqual([0, 1, 2, 3, 4]);
    expect(channel!.levels[0].shardChunks).toEqual([10, 10]);
    expect(channel!.levels[4].shardChunks).toBeNull();

    // Offsets and lengths survive, and absent slots stay absent.
    const slots = channel!.shardSlots(0, 12, 34);
    expect(slots).toBeDefined();
    expect(slots!.length).toBe(100);
    expect(slots!.filter(Boolean).length).toBe(3);
    expect(slots![0]).toEqual({ offset: 0, length: 4 });
    expect(slots![5]).toEqual({ offset: 4, length: 3 });
    expect(slots![99]).toEqual({ offset: 7, length: 2 });
    expect(slots![1]).toBeNull();

    // A shard that was never written is absent rather than empty.
    expect(channel!.shardSlots(0, 0, 0)).toBeUndefined();

    // Unsharded levels carry which coordinates exist, so the reader stops
    // probing for the rest.
    expect(channel!.hasChunk(4, 2, 1)).toBe(true);
    expect(channel!.hasChunk(4, 0, 0)).toBe(false);
  });

  it('agrees with the shard indices it was built from', async () => {
    // The index is a cache of the store; if it ever disagrees with the shard's
    // own trailing index the reader would fetch the wrong bytes.
    const dir = await buildFixtureStore();
    await buildStoreIndex(dir);
    const index = parseStoreIndex(new Uint8Array(await readFile(path.join(dir, STORE_INDEX_FILENAME))));
    const slots = index!.channel()!.shardSlots(0, 12, 34)!;

    const shard = new Uint8Array(await readFile(path.join(dir, CHANNEL, '0', 'c', '12', '34')));
    for (const [slot, expected] of [[0, [1, 2, 3, 4]], [5, [5, 6, 7]], [99, [8, 9]]] as const) {
      const entry = slots[slot]!;
      expect([...shard.subarray(entry.offset, entry.offset + entry.length)]).toEqual([...expected]);
    }
  });

  it('refuses a store whose root names no channels', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tc-index-bare-'));
    created.push(dir);
    await writeJson(path.join(dir, 'zarr.json'), { zarr_format: 3, node_type: 'group', attributes: {} });
    await expect(buildStoreIndex(dir)).rejects.toThrow(/no psychogeo.channels/);
  });
});
