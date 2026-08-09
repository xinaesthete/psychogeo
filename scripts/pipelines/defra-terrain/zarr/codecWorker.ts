import { parentPort } from 'node:worker_threads';
import { decodeChunk, encodeChunk } from './chunkCodec.ts';
import {
  dequantiseToHeights,
  quantiseHeights,
  seededRandom,
  type ScaleOffset,
} from './globalScale.ts';

/**
 * The CPU half of a chunk, off the main thread.
 *
 * Measured at 55.4 ms per chunk, of which decode, requantise and encode are
 * ~82% and every millisecond of it is openjph. The national height run sat at
 * ~170% CPU on a twelve-core machine for 2 h 43 min, so the cores were there.
 *
 * Deliberately pure: a task carries everything it needs and returns bytes. No
 * filesystem, no archive handle, no shard state. Reads stay on the main thread
 * where the ordering and resume logic already live, and where a worker would
 * otherwise need its own copy of the source store.
 */

export type RequantiseTask = {
  readonly kind: 'requantise';
  readonly id: number;
  /** A stored codestream to bring onto a new scale. */
  readonly codestream: Uint8Array;
  readonly from: ScaleOffset;
  readonly to: ScaleOffset;
  /** Already combined with the chunk coordinate; omit for plain rounding. */
  readonly ditherSeed?: number;
};

export type EncodeTask = {
  readonly kind: 'encode';
  readonly id: number;
  /** Metres, NaN for absent. */
  readonly values: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly encoding: ScaleOffset;
  readonly ditherSeed?: number;
};

export type CodecTask = RequantiseTask | EncodeTask;

export type CodecResult =
  | { readonly id: number; readonly bytes: Uint8Array }
  | { readonly id: number; readonly error: string };

export async function runCodecTask(task: CodecTask): Promise<Uint8Array> {
  const dither = task.ditherSeed === undefined ? undefined : seededRandom(task.ditherSeed);
  if (task.kind === 'requantise') {
    const decoded = await decodeChunk(task.codestream);
    const heights = dequantiseToHeights(decoded.raw, task.from);
    const raw = quantiseHeights(heights, { encoding: task.to, dither });
    return encodeChunk(raw, decoded.width, decoded.height);
  }
  const raw = quantiseHeights(task.values, { encoding: task.encoding, dither });
  return encodeChunk(raw, task.width, task.height);
}

if (parentPort) {
  const port = parentPort;
  port.on('message', (task: CodecTask) => {
    void runCodecTask(task).then(
      (bytes) => {
        // Transfer rather than copy: a level-0 chunk is ~1 MB and there are
        // 150k of them.
        port.postMessage({ id: task.id, bytes } satisfies CodecResult, [
          bytes.buffer as ArrayBuffer,
        ]);
      },
      (error: unknown) => {
        port.postMessage({
          id: task.id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies CodecResult);
      },
    );
  });
}
