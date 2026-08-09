import { parentPort } from 'node:worker_threads';
import { downsampleReduce } from '../raster.ts';
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

/**
 * Reduce a 4x4 block of children into one coarse chunk.
 *
 * The children are read on the main thread — the shard reader and its index
 * cache live there — and everything after that is codec work: 16 decodes, an
 * assemble, a downsample and an encode. That is the heaviest single unit in the
 * pass and it was the half still running serially.
 */
export type ReduceTask = {
  readonly kind: 'reduce';
  readonly id: number;
  readonly children: ReadonlyArray<{
    readonly bytes: Uint8Array;
    readonly originY: number;
    readonly originX: number;
  }>;
  readonly block: number;
  readonly encoding: ScaleOffset;
  readonly sourceResolutionMetres: number;
  readonly targetResolutionMetres: number;
  readonly blockSize: number;
  readonly bias: number;
  readonly ditherSeed?: number;
};

export type CodecTask = RequantiseTask | EncodeTask | ReduceTask;

export type CodecResult =
  | {
      readonly id: number;
      /** Null when nothing decoded, so there is no coarse chunk to write. */
      readonly bytes: Uint8Array | null;
      /** Indices of children that would not decode. Each is a hole. */
      readonly failed?: readonly number[];
    }
  | { readonly id: number; readonly error: string };

export type CodecOutcome = { bytes: Uint8Array | null; failed: number[] };

export async function runCodecTask(task: CodecTask): Promise<CodecOutcome> {
  const dither = task.ditherSeed === undefined ? undefined : seededRandom(task.ditherSeed);
  if (task.kind === 'requantise') {
    const decoded = await decodeChunk(task.codestream);
    const heights = dequantiseToHeights(decoded.raw, task.from);
    const raw = quantiseHeights(heights, { encoding: task.to, dither });
    return { bytes: await encodeChunk(raw, decoded.width, decoded.height), failed: [] };
  }
  if (task.kind === 'encode') {
    const raw = quantiseHeights(task.values, { encoding: task.encoding, dither });
    return { bytes: await encodeChunk(raw, task.width, task.height), failed: [] };
  }

  const { block } = task;
  const pixels = new Float32Array(block * block).fill(Number.NaN);
  const failed: number[] = [];
  let any = false;
  for (let i = 0; i < task.children.length; i += 1) {
    const child = task.children[i];
    // A child that will not decode costs its own quadrant, which the downsample
    // already treats as absent. Reported by index so the caller can name it.
    try {
      const decoded = await decodeChunk(child.bytes);
      any = true;
      const heights = dequantiseToHeights(decoded.raw, task.encoding);
      for (let y = 0; y < decoded.height; y += 1) {
        pixels.set(
          heights.subarray(y * decoded.width, (y + 1) * decoded.width),
          (child.originY + y) * block + child.originX,
        );
      }
    } catch {
      failed.push(i);
    }
  }
  if (!any) return { bytes: null, failed };

  const reduced = downsampleReduce(
    {
      pixels,
      width: block,
      height: block,
      resolutionMetres: task.sourceResolutionMetres,
      // Only used to derive the output extent, which the caller ignores —
      // placement comes from the chunk coordinate, not the raster extent.
      extent: { eastMin: 0, eastMax: block, northMin: 0, northMax: block },
    },
    task.targetResolutionMetres,
    task.blockSize,
    task.bias,
  );
  const raw = quantiseHeights(reduced.pixels, { encoding: task.encoding, dither });
  return { bytes: await encodeChunk(raw, reduced.width, reduced.height), failed };
}

if (parentPort) {
  const port = parentPort;
  port.on('message', (task: CodecTask) => {
    void runCodecTask(task).then(
      ({ bytes, failed }) => {
        // Transfer rather than copy: a level-0 chunk is ~1 MB and there are
        // 150k of them.
        port.postMessage({ id: task.id, bytes, failed } satisfies CodecResult,
          bytes ? [bytes.buffer as ArrayBuffer] : []);
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
