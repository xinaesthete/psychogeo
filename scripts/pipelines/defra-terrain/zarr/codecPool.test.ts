import { describe, expect, it } from 'vitest';
import { createCodecRunner, mapWithRunner } from './codecPool.ts';
import { globalScaleOffset } from './globalScale.ts';
import { decodeChunk } from './chunkCodec.ts';

describe('createCodecRunner', () => {
  it('runs inline when there is no worker file, rather than failing', () => {
    // A build that cannot find its worker must degrade to the path every
    // existing verification already covers, not stop.
    expect(createCodecRunner({ size: 8 }).size).toBe(0);
    expect(createCodecRunner({ size: 0, workerUrl: new URL('file:///nope.mjs') }).size).toBe(0);
  });

  it('encodes through the inline runner exactly as the codec would', async () => {
    const runner = createCodecRunner({ size: 0 });
    const encoding = globalScaleOffset();
    const values = new Float32Array(64 * 64);
    for (let i = 0; i < values.length; i += 1) values[i] = 100 + (i % 37) * 0.5;

    const bytes = await runner.run({
      kind: 'encode',
      id: 1,
      values,
      width: 64,
      height: 64,
      encoding,
    });
    const decoded = await decodeChunk(bytes);
    expect(decoded.width).toBe(64);
    expect(decoded.raw[0] * encoding.scale + encoding.offset).toBeCloseTo(100, 1);
    await runner.close();
  });
});

describe('mapWithRunner', () => {
  it('keeps results in input order however they finish', async () => {
    // Completion order is free to vary — writeShard sorts by slot — but the
    // caller pairs results back to items by index, so the array must not.
    const items = [40, 5, 30, 1, 20];
    const out = await mapWithRunner(items, 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return new Uint8Array([item]);
    });
    expect(out.map((bytes) => bytes![0])).toEqual(items);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithRunner(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return new Uint8Array(1);
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('passes a failure through as an absent result', async () => {
    const out = await mapWithRunner([1, 2, 3], 2, async (item) =>
      item === 2 ? undefined : new Uint8Array([item]),
    );
    expect(out[1]).toBeUndefined();
    expect(out[0]![0]).toBe(1);
  });
});
