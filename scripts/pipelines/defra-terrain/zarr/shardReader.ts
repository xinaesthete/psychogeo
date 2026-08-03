import { open } from 'node:fs/promises';
import path from 'node:path';
import { chunkKey } from './grid.ts';
import { shardIndexByteLength } from './shardWriter.ts';

const EMPTY = 0xffffffffffffffffn;

/**
 * Pull one inner chunk back out of a written shard.
 *
 * Coarse levels are built from the level below, so the pass has to read back
 * what it just wrote. Doing that through the shard index — suffix read for the
 * index, then a ranged read for the chunk — exercises exactly the access
 * pattern the browser will use, so a mistake here shows up locally rather than
 * in the viewer.
 */
export class ShardReader {
  private readonly indexCache = new Map<string, Array<{ offset: number; length: number } | null>>();

  constructor(
    private readonly levelDir: string,
    private readonly shardChunks: readonly [number, number] | null,
  ) {}

  private locate(coord: readonly [number, number]) {
    if (!this.shardChunks) {
      return { file: path.join(this.levelDir, chunkKey(coord)), slot: null as number | null };
    }
    const [perY, perX] = this.shardChunks;
    const shard: readonly [number, number] = [Math.floor(coord[0] / perY), Math.floor(coord[1] / perX)];
    const slot = (coord[0] % perY) * perX + (coord[1] % perX);
    return { file: path.join(this.levelDir, chunkKey(shard)), slot };
  }

  private async readIndex(file: string): Promise<Array<{ offset: number; length: number } | null> | undefined> {
    const cached = this.indexCache.get(file);
    if (cached) return cached;
    if (!this.shardChunks) return undefined;
    const indexBytes = shardIndexByteLength(this.shardChunks);
    let handle;
    try {
      handle = await open(file, 'r');
    } catch {
      return undefined;
    }
    try {
      const { size } = await handle.stat();
      const buffer = new Uint8Array(indexBytes);
      await handle.read(buffer, 0, indexBytes, size - indexBytes);
      const view = new DataView(buffer.buffer, buffer.byteOffset);
      const slots = this.shardChunks[0] * this.shardChunks[1];
      const entries: Array<{ offset: number; length: number } | null> = [];
      for (let slot = 0; slot < slots; slot += 1) {
        const offset = view.getBigUint64(slot * 16, true);
        const length = view.getBigUint64(slot * 16 + 8, true);
        entries.push(offset === EMPTY ? null : { offset: Number(offset), length: Number(length) });
      }
      this.indexCache.set(file, entries);
      return entries;
    } finally {
      await handle.close();
    }
  }

  async read(coord: readonly [number, number]): Promise<Uint8Array | undefined> {
    const { file, slot } = this.locate(coord);
    if (slot === null) {
      let handle;
      try {
        handle = await open(file, 'r');
      } catch {
        return undefined;
      }
      try {
        const { size } = await handle.stat();
        const buffer = new Uint8Array(size);
        await handle.read(buffer, 0, size, 0);
        return buffer;
      } finally {
        await handle.close();
      }
    }
    const entries = await this.readIndex(file);
    const entry = entries?.[slot];
    if (!entry) return undefined;
    const handle = await open(file, 'r');
    try {
      const buffer = new Uint8Array(entry.length);
      await handle.read(buffer, 0, entry.length, entry.offset);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  /** Drop cached shard indices — call between levels so memory stays bounded. */
  clear(): void {
    this.indexCache.clear();
  }
}
