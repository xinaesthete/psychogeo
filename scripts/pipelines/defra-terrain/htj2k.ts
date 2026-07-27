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
  getDecodedBuffer(frameInfo: FrameInfo): Uint8Array;
  encode(): void;
  getEncodedBuffer(): Uint8Array;
  delete?(): void;
  isDeleted?(): boolean;
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
    // Emscripten passes a local filesystem path here ('/…' on POSIX,
    // 'C:\…' on Windows); anything that isn't an http(s) URL is a file.
    if (typeof input === 'string' && !/^https?:/i.test(input)) {
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
      // TODO(defra/openjph): replace this vendored runtime with a typed package and publishable build.
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
  try {
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
    const rasterBytes = new Uint8Array(raster.pixels.buffer, raster.pixels.byteOffset, raster.pixels.byteLength);
    const expectedBytes = width * height * 2 * frameInfo.componentCount;
    if (decodedBuffer.byteLength !== expectedBytes) {
      throw new Error(
        `HTJ2K decoded buffer size mismatch: expected=${expectedBytes}, actual=${decodedBuffer.byteLength}, width=${width}, height=${height}, signed=${signed}`,
      );
    }
    if (rasterBytes.byteLength !== expectedBytes) {
      throw new Error(
        `HTJ2K raster byte size mismatch: expected=${expectedBytes}, actual=${rasterBytes.byteLength}, width=${width}, height=${height}, signed=${signed}`,
      );
    }
    decodedBuffer.set(rasterBytes);
    encoder.encode();
    return new Uint8Array(encoder.getEncodedBuffer());
  } finally {
    if (typeof encoder.delete === 'function' && !encoder.isDeleted?.()) {
      encoder.delete();
    }
  }
}
