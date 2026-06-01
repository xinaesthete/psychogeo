import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { EncodedRaster } from './encoding.ts';

interface FrameInfo {
  readonly bitsPerSample: number;
  readonly isSigned: boolean;
  readonly width: number;
  readonly height: number;
  readonly componentCount: number;
}

interface EncoderInstance {
  setQuality(lossless: boolean, quality: number): void;
  setIsUsingColorTransform(enabled: boolean): void;
  getDecodedBuffer(frameInfo: FrameInfo): Uint16Array | Int16Array;
  encode(): void;
  getEncodedBuffer(): Uint8Array;
}

type EncoderConstructor = new () => EncoderInstance;

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null;
}

function isEncoderConstructor(value: unknown): value is EncoderConstructor {
  return typeof value === 'function';
}

function isEncoderInstance(value: unknown): value is EncoderInstance {
  if (!isRecord(value)) return false;
  return (
    typeof value.setQuality === 'function' &&
    typeof value.setIsUsingColorTransform === 'function' &&
    typeof value.getDecodedBuffer === 'function' &&
    typeof value.encode === 'function' &&
    typeof value.getEncodedBuffer === 'function'
  );
}

function patchNodeFetchForOpenJph(): () => void {
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
  return () => {
    globalThis.fetch = originalFetch;
  };
}

let encoderConstructorPromise: Promise<EncoderConstructor> | null = null;

async function getEncoderConstructor(): Promise<EncoderConstructor> {
  if (encoderConstructorPromise) return encoderConstructorPromise;
  encoderConstructorPromise = new Promise((resolve, reject) => {
    const restoreFetch = patchNodeFetchForOpenJph();
    try {
      const require = createRequire(path.join(process.cwd(), 'scripts/pipelines/defra-terrain/htj2k.ts'));
      const moduleValue: unknown = require(path.resolve('public/openjphjs.js'));
      const startedAt = Date.now();
      const poll = () => {
        if (isRecord(moduleValue)) {
          const constructorValue = moduleValue.HTJ2KEncoder;
          if (isEncoderConstructor(constructorValue)) {
            restoreFetch();
            resolve(constructorValue);
            return;
          }
        }
        if (Date.now() - startedAt > 5000) {
          restoreFetch();
          reject(new Error('Timed out waiting for OpenJPH runtime initialisation.'));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    } catch (error) {
      restoreFetch();
      reject(error);
    }
  });
  return encoderConstructorPromise;
}

export async function encodeHtj2k(
  raster: EncodedRaster,
  width: number,
  height: number,
  lossyQuality: number,
): Promise<Uint8Array> {
  const Encoder = await getEncoderConstructor();
  const encoder = new Encoder();
  if (!isEncoderInstance(encoder)) throw new Error('OpenJPH encoder has an unexpected shape.');
  const signed = raster.pixels instanceof Int16Array;
  const frameInfo: FrameInfo = {
    bitsPerSample: 16,
    isSigned: signed,
    width,
    height,
    componentCount: 1,
  };
  encoder.setQuality(lossyQuality === 0, lossyQuality);
  encoder.setIsUsingColorTransform(false);
  const decodedBuffer = encoder.getDecodedBuffer(frameInfo);
  decodedBuffer.set(raster.pixels);
  encoder.encode();
  return new Uint8Array(encoder.getEncodedBuffer());
}
