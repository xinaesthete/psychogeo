import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeChunk, encodeChunk } from './chunkCodec.ts';
import { globalScaleOffset } from './globalScale.ts';
import { buildCoarseLevels, heightReduction, shardIsComplete } from './pyramidBuild.ts';
import { CHUNK_PIXELS, renormalisedLevel, renormalisedLevels } from './levels.ts';
import { chunkFromBytes, writeShard } from './shardWriter.ts';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tc-pyramid-'));
  dirs.push(dir);
  return dir;
}

describe('buildCoarseLevels', () => {
  it('reports a chunk it cannot decode instead of ending the run', async () => {
    // A national pass walks hundreds of thousands of chunks and the sources are
    // not curated. One bad chunk has to cost its own square kilometre, not the
    // hours of completed work behind it — but it must be counted, or a store
    // with holes looks exactly like a store without them.
    const channelDir = await scratchDir();
    const levels = renormalisedLevels(2);
    const coords: Array<readonly [number, number]> = [];
    const entries = [];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        coords.push([y, x]);
        // Not a codestream. `decodeChunk` will reject it.
        entries.push(chunkFromBytes([y, x], new Uint8Array([0xde, 0xad, 0xbe, 0xef])));
      }
    }
    await writeShard(path.join(channelDir, '0', 'c', '0', '0'), levels[0].shardChunks!, entries);

    const failed: Array<{ level: number; reason: string }> = [];
    const result = await buildCoarseLevels({
      channelDir,
      levels,
      encoding: globalScaleOffset(),
      baseCoords: coords,
      reduction: heightReduction,
      levelMetadata: () => ({ zarr_format: 3, node_type: 'array' }),
      onProgress: (event) => {
        if (event.kind === 'failed') failed.push({ level: event.level, reason: event.reason });
      },
    });

    // Every one of the 16 children failed, and every failure was announced.
    expect(result.failures).toBe(16);
    expect(failed).toHaveLength(16);
    expect(failed.every((entry) => entry.level === 0)).toBe(true);
    expect(failed[0].reason).toBeTruthy();
    // No parent was invented from children that never decoded.
    expect(result.levels[0].chunks).toBe(0);
  });
});

describe('buildCoarseLevels resume', () => {
  // Level 4 is the first unsharded level, so build it from level 3 directly.
  const levels = [renormalisedLevel(3), renormalisedLevel(4)];
  const topChunk = (channelDir: string) => path.join(channelDir, '4', 'c', '0', '0');

  async function writeChildren(channelDir: string, coords: ReadonlyArray<readonly [number, number]>) {
    const entries = [];
    for (const coord of coords) {
      const raw = new Uint16Array(CHUNK_PIXELS * CHUNK_PIXELS).fill(1000 + coord[0] * 4 + coord[1]);
      entries.push(chunkFromBytes(coord, await encodeChunk(raw, CHUNK_PIXELS, CHUNK_PIXELS)));
    }
    await writeShard(path.join(channelDir, '3', 'c', '0', '0'), levels[0].shardChunks!, entries);
  }

  async function build(
    channelDir: string,
    baseCoords: ReadonlyArray<readonly [number, number]>,
    rebuiltCoords: ReadonlyArray<readonly [number, number]>,
  ) {
    return buildCoarseLevels({
      channelDir,
      levels,
      encoding: globalScaleOffset(),
      baseCoords,
      rebuiltCoords,
      reduction: heightReduction,
      levelMetadata: () => ({ zarr_format: 3, node_type: 'array' }),
    });
  }

  /** Samples the parent actually covers, so a partial reduction is visible. */
  async function coverage(file: string): Promise<number> {
    const { raw } = await decodeChunk(await readFile(file));
    let valid = 0;
    for (const value of raw) if (value !== 0) valid += 1;
    return valid;
  }

  it('rebuilds an unsharded parent when a child below it changed', async () => {
    // What cost the LZ store its level 4. The object carries no index, so
    // nothing about the file distinguishes a chunk reduced from two children
    // from one reduced from sixteen, and the old check called existence
    // completeness — leaving a --region run's leftovers in place forever.
    const channelDir = await scratchDir();
    const narrow: Array<readonly [number, number]> = [[0, 0], [0, 1]];
    await writeChildren(channelDir, narrow);
    await build(channelDir, narrow, narrow);
    const before = await coverage(topChunk(channelDir));

    const wide: Array<readonly [number, number]> = [...narrow, [1, 0], [1, 1]];
    const added: Array<readonly [number, number]> = [[1, 0], [1, 1]];
    await writeChildren(channelDir, wide);
    await build(channelDir, wide, added);

    expect(await coverage(topChunk(channelDir))).toBeGreaterThan(before);
  }, 120_000);

  it('leaves the parent alone when nothing below it was rebuilt', async () => {
    // The other half: a plain resume must not re-encode a pyramid that is
    // already right, or every retry of a national run pays for it again.
    const channelDir = await scratchDir();
    const coords: Array<readonly [number, number]> = [[0, 0], [0, 1]];
    await writeChildren(channelDir, coords);
    await build(channelDir, coords, coords);
    const stamp = await stat(topChunk(channelDir));

    await build(channelDir, coords, []);

    expect((await stat(topChunk(channelDir))).mtimeMs).toBe(stamp.mtimeMs);
  }, 120_000);
});

describe('shardIsComplete', () => {
  it('refuses a shard that a narrower run left short', async () => {
    // The bug that cost the LZ store its coarse levels. A --region SU42 run
    // wrote the level-3 shard covering most of England holding the two chunks
    // SU42 reaches; the national run found the file present, skipped it, and
    // never built the other 53. Nothing failed and nothing was logged.
    const dir = await scratchDir();
    const levels = renormalisedLevels(2);
    const target = path.join(dir, 'c', '1', '0');
    await writeShard(target, levels[0].shardChunks!, [
      chunkFromBytes([8, 6], new Uint8Array([1, 2, 3])),
      chunkFromBytes([8, 7], new Uint8Array([4, 5, 6])),
    ]);

    const written: Array<readonly [number, number]> = [[18, 6], [18, 7]];
    const wanted: Array<readonly [number, number]> = [...written, [18, 8]];

    expect((await shardIsComplete(target, levels[0], written))?.complete).toBe(true);
    expect((await shardIsComplete(target, levels[0], wanted))?.complete).toBe(false);
  });

  it('reports nothing for a shard that is not there', async () => {
    const dir = await scratchDir();
    const levels = renormalisedLevels(2);
    expect(await shardIsComplete(path.join(dir, 'nope'), levels[0], [[0, 0]])).toBeUndefined();
  });
});
