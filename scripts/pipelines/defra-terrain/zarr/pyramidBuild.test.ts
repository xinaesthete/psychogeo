import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { globalScaleOffset } from './globalScale.ts';
import { buildCoarseLevels, heightReduction } from './pyramidBuild.ts';
import { renormalisedLevels } from './levels.ts';
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
