import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeUint16Normalized } from './encoding.ts';
import { encodeHtj2k } from './htj2k.ts';

interface FrameInfo {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: number;
  readonly componentCount: number;
  readonly isSigned: boolean;
}

interface DecoderInstance {
  getEncodedBuffer(size: number): Uint8Array;
  decode(): void;
  getDecodedBuffer(): Uint8Array;
  getFrameInfo(): FrameInfo;
}

interface OpenJphModule {
  readonly HTJ2KDecoder: new () => DecoderInstance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOpenJphModule(value: unknown): value is OpenJphModule {
  return isRecord(value) && typeof value.HTJ2KDecoder === 'function';
}

async function openJphModule(): Promise<OpenJphModule> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return Promise.resolve(
        new Response(readFileSync(input), {
          headers: {
            'Content-Type': 'application/wasm',
          },
        }),
      );
    }
    return originalFetch(input, init);
  };
  const moduleValue = await import('../../../public/openjphjs.js');
  globalThis.fetch = originalFetch;
  const defaultValue = moduleValue.default;
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (!isOpenJphModule(defaultValue)) throw new Error('OpenJPH module shape was not recognised.');
  return defaultValue;
}

async function decodeU16(bytes: Uint8Array): Promise<Uint16Array> {
  const moduleValue = await openJphModule();
  const decoder = new moduleValue.HTJ2KDecoder();
  const encodedBuffer = decoder.getEncodedBuffer(bytes.length);
  encodedBuffer.set(bytes);
  decoder.decode();
  const decoded = decoder.getDecodedBuffer();
  return new Uint16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);
}

describe('OpenJPH height encoding', () => {
  it('encodes lossy single-channel rasters with color transform disabled', async () => {
    const values = new Float32Array(64 * 64);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        values[y * 64 + x] = 100 + x * 0.25 + y * 0.5;
      }
    }

    const encoded = encodeUint16Normalized(values);
    const bytes = await encodeHtj2k(encoded, 64, 64, 0.05);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('writes 16-bit height samples as bytes so lossless round-trips exact code values', async () => {
    const values = new Float32Array(64 * 64);
    for (let i = 0; i < values.length; i += 1) values[i] = i;

    const encoded = encodeUint16Normalized(values);
    const bytes = await encodeHtj2k(encoded, 64, 64, 0);
    const decoded = await decodeU16(bytes);

    expect(Array.from(decoded.slice(0, 16))).toEqual(Array.from(encoded.pixels.slice(0, 16)));
    expect(Array.from(decoded.slice(2048, 2064))).toEqual(Array.from(encoded.pixels.slice(2048, 2064)));
  });
});
