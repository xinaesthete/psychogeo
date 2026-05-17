/**
 * Utilities for loading Jpeg2000 using OpenJPEGJS WASM decoder.
 *
 * Not intended (at time of writing) to robustly cover a wide range of inputs, but to handle data specific
 * to current application (single channel 16bit unsigned int, likely to change).  Should not be hard to generalise.
 *
 * This should hopefully be usable as a reasonably clean TS module, although it hides some less clean implementation detail.
 * Well a little unit testing wouldn't do us any harm... (no a little unit testing wouldn't do us any harm)
 */

import * as THREE from 'three'
import { WorkerPool } from './workerPool';


export interface FrameInfo {
    width: number; height: number; isSigned: boolean; bitsPerSample: number, componentCount: number;
}

/** Per-tile HTJ2K recode metrics from texture_worker (lossy path only). */
export interface RecodeStats {
  quality: number;
  sourceBytes: number;
  encodedBytes: number;
  bytesPerPixel: number;
  sourceBytesPerPixel: number;
  compressionVsSource: number;
  width: number;
  height: number;
  pixelCount: number;
  identicalPixels: number;
  rmseRaw: number;
  meanAbsRaw: number;
  maxAbsRaw: number;
  rmseNorm: number;
  meanAbsNorm: number;
  maxAbsNorm: number;
}

export interface TextureTile {
  texture: THREE.Texture;
  frameInfo: FrameInfo;
  recodeStats?: RecodeStats;
}
export interface PixFrame {
  frameInfo: FrameInfo;
  pixData: Uint16Array;
}
export interface TexFrame {
  frameInfo: FrameInfo;
  texData: Uint16Array;
  recodeStats?: RecodeStats;
}

/** Default HTJ2K quality for runtime recode experiment (see scripts/gebco_tiff2jph.js). */
export const DEFAULT_LOSSY_COMPRESSION_RATIO = 0.001;

/** HTJ2K setQuality(false, q): 0 ≈ lossless; higher q → more compression. */
export const MIN_LOSSY_COMPRESSION_RATIO = 0;

/**
 * Upper q for lossy encode (OpenJPH q-step style; see ojph_compress -qstep, typ. ≤ 0.5).
 * Values far above this tend to abort WASM encode.
 */
export const MAX_LOSSY_COMPRESSION_RATIO = 0.9999;

const workers = new WorkerPool(4); //chrome doesn't like it when we assign too many
workers.maxAge = 9e9;
const times: number[] = [];

function cacheKey(url: string, compressionRatio: number): string {
  return `${url}@q=${compressionRatio}`;
}

function isLossyCacheKey(key: string): boolean {
  return key.includes('@q=') && !key.endsWith('@q=1');
}

async function getTexData(url: string, fullFloat: boolean, compressionRatio = 1) : Promise<TexFrame> {
  if (url.startsWith('/ttile')) {
    const r = await fetch(url);
    const frameInfo:FrameInfo = {width: 4096, height: 4096, isSigned: true, bitsPerSample: 16, componentCount: 1};
    const buf = await r.arrayBuffer();
    const texData = new Uint16Array(buf);
    if (texData.length !== frameInfo.width * frameInfo.height) {
      console.error(`that ain't gonna work - ${texData.length} isn't expected length (${frameInfo.width*frameInfo.height})`);
    }
    return {frameInfo, texData};
  }
  const worker = await workers.getWorker();
  const t = Date.now();
  const promise = new Promise<TexFrame>((resolve, reject) => {
    if (!worker) {
      reject('failed to get worker');
      return;
    }
    worker.onmessage = m => {
      workers.releaseWorker(worker);
      const dt = Date.now() - t;
      times.push(dt);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;;
      console.log(`t: ${dt}, min: ${Math.min(...times)}, max: ${Math.max(...times)} avg: ${avg}`);
      if (typeof m.data === "string") reject(m.data);
      resolve(m.data as TexFrame);
    }
    if (compressionRatio === 1) worker.postMessage({cmd: "tex", url, fullFloat});
    else worker.postMessage({cmd: "recode", url, compressionRatio, fullFloat});
  });
  return promise;
}

function texFrameToTexture(result: TexFrame): TextureTile {
  const { frameInfo, recodeStats } = result;
  const format = THREE.RedFormat;
  const type = THREE.HalfFloatType;
  const texture = new THREE.DataTexture(result.texData, frameInfo.width, frameInfo.height, format, type);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.anisotropy = 16;
  texture.needsUpdate = true;
  return { texture, frameInfo, recodeStats };
}

/** Map slider 0…1 linearly from min to max q (0 = lossless end, 1 = max compression). */
export function qualityFromSlider(slider: number): number {
  const t = Math.min(1, Math.max(0, slider));
  return MIN_LOSSY_COMPRESSION_RATIO + t * (MAX_LOSSY_COMPRESSION_RATIO - MIN_LOSSY_COMPRESSION_RATIO);
}

/** Inverse of {@link qualityFromSlider} for syncing UI. */
export function sliderFromQuality(quality: number): number {
  const q = clampLossyQuality(quality);
  const span = MAX_LOSSY_COMPRESSION_RATIO - MIN_LOSSY_COMPRESSION_RATIO;
  if (span <= 0) return 0;
  return (q - MIN_LOSSY_COMPRESSION_RATIO) / span;
}

export function clampLossyQuality(quality: number): number {
  if (!Number.isFinite(quality) || quality < MIN_LOSSY_COMPRESSION_RATIO) {
    return MIN_LOSSY_COMPRESSION_RATIO;
  }
  return Math.min(MAX_LOSSY_COMPRESSION_RATIO, quality);
}

const textureCache = new Map<string, TextureTile>();
const inflight = new Map<string, Promise<TextureTile>>();

export async function jp2Texture(
  url: string,
  simplerDecodeHack: boolean,
  compressionRatio = 1,
): Promise<TextureTile> {
  const key = cacheKey(url, compressionRatio);
  const cached = textureCache.get(key);
  if (cached) return cached;

  let pending = inflight.get(key);
  if (!pending) {
    pending = getTexData(url, simplerDecodeHack, compressionRatio).then((result) => {
      const tile = texFrameToTexture(result);
      textureCache.set(key, tile);
      inflight.delete(key);
      return tile;
    }).catch((err) => {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, pending);
  }
  return pending;
}

/** Parallel full + lossy decode (eager path). Terrain uses staged full-then-lossy via {@link jp2Texture}. */
export async function jp2TexturePair(
  url: string,
  simplerDecodeHack: boolean,
  lossyRatio = DEFAULT_LOSSY_COMPRESSION_RATIO,
): Promise<{ full: TextureTile; lossy: TextureTile; frameInfo: FrameInfo }> {
  const [full, lossy] = await Promise.all([
    jp2Texture(url, simplerDecodeHack, 1),
    jp2Texture(url, simplerDecodeHack, lossyRatio),
  ]);
  return { full, lossy, frameInfo: full.frameInfo };
}

/** Evict runtime-recoded textures (not full-quality @q=1 entries). */
export function invalidateLossyCache(url?: string): void {
  const toDelete: string[] = [];
  for (const key of textureCache.keys()) {
    if (!isLossyCacheKey(key)) continue;
    if (url === undefined || key.startsWith(`${url}@q=`)) {
      const entry = textureCache.get(key);
      entry?.texture.dispose();
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    textureCache.delete(key);
    inflight.delete(key);
  }
}

export function newGLContext() {
  for (const entry of textureCache.values()) {
    entry.texture.dispose();
  }
  textureCache.clear();
  inflight.clear();
}
