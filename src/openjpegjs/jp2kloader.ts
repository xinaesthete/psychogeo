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

export interface HeightRange {
  min: number;
  max: number;
}

/** Decode IEEE 754 binary16 half-float bits (matches texture_worker / ttile toHalf). */
export function halfBitsToFloat(bits: number): number {
  const sign = (bits & 0x8000) >> 15;
  const exponent = (bits & 0x7c00) >> 10;
  const mantissa = bits & 0x03ff;

  if (exponent === 0) {
    if (mantissa === 0) return sign ? -0 : 0;
    const m = mantissa / 1024;
    const v = m * Math.pow(2, -14);
    return sign ? -v : v;
  }
  if (exponent === 0x1f) {
    return mantissa ? NaN : sign ? -Infinity : Infinity;
  }
  const e = exponent - 15;
  const m = 1 + mantissa / 1024;
  const v = m * Math.pow(2, e);
  return sign ? -v : v;
}

const TTILE_NODATA_METRE = 3000;

/** Metre domain from /ttile/ half-float height (GeoTIFF extract path). */
export function estimateHeightRangeFromHalfMetresTexture(texData: Uint16Array): HeightRange {
  let min = Infinity;
  let max = -Infinity;
  const step = Math.max(1, Math.floor(texData.length / 5000));
  for (let i = 0; i < texData.length; i += step) {
    const metres = halfBitsToFloat(texData[i]);
    if (!Number.isFinite(metres) || metres <= -199 || metres >= TTILE_NODATA_METRE) continue;
    min = Math.min(min, metres);
    max = Math.max(max, metres);
  }
  if (!Number.isFinite(min) || max <= min) {
    return { min: 0, max: 1 };
  }
  return { min, max };
}

export interface TextureTile {
  texture: THREE.Texture;
  frameInfo: FrameInfo;
  recodeStats?: RecodeStats;
  /** Per-tile elevation domain (10m DTM float metres → shader uniforms). */
  heightRange?: HeightRange;
}
export interface PixFrame {
  frameInfo: FrameInfo;
  pixData: Uint16Array;
}
export interface TexFrame {
  frameInfo: FrameInfo;
  texData: Uint16Array;
  recodeStats?: RecodeStats;
  heightRange?: HeightRange;
}

/** Default HTJ2K quality for runtime recode experiment (see scripts/gebco_tiff2jph.js). */
export const DEFAULT_LOSSY_COMPRESSION_RATIO = 0.9;

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

/** HTJ2K worker fetch URL (10m DTM may use `/ttile/` for fast GeoTIFF extract when experiment is off). */
function workerHeightUrl(url: string): string {
  if (url.startsWith('/ttile/')) return '/ltile/' + url.slice(7);
  return url;
}

async function getTexData(
  url: string,
  fullFloat: boolean,
  compressionRatio = 1,
  heightRangeMetres?: HeightRange,
) : Promise<TexFrame> {
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
      const frame = m.data as TexFrame;
      resolve(frame);
    }
    const workerUrl = workerHeightUrl(url);
    if (compressionRatio === 1) worker.postMessage({cmd: "tex", url: workerUrl, fullFloat});
    else worker.postMessage({cmd: "recode", url: workerUrl, compressionRatio, fullFloat, heightRangeMetres});
  });
  return promise;
}

function texFrameToTexture(result: TexFrame): TextureTile {
  const { frameInfo, recodeStats, heightRange } = result;
  const format = THREE.RedFormat;
  const type = THREE.HalfFloatType;
  const texture = new THREE.DataTexture(result.texData, frameInfo.width, frameInfo.height, format, type);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.anisotropy = 16;
  texture.needsUpdate = true;
  return { texture, frameInfo, recodeStats, heightRange };
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
  heightRangeMetres?: HeightRange,
): Promise<TextureTile> {
  const key = cacheKey(url, compressionRatio);
  const cached = textureCache.get(key);
  if (cached) return cached;

  let pending = inflight.get(key);
  if (!pending) {
    pending = getTexData(url, simplerDecodeHack, compressionRatio, heightRangeMetres).then((result) => {
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
export function invalidateLossyCache(url?: string, compressionRatio?: number): void {
  const exactKey =
    url !== undefined && compressionRatio !== undefined
      ? cacheKey(url, compressionRatio)
      : undefined;
  const toDelete: string[] = [];
  for (const key of textureCache.keys()) {
    if (!isLossyCacheKey(key)) continue;
    if (
      exactKey === key ||
      (exactKey === undefined && (url === undefined || key.startsWith(`${url}@q=`)))
    ) {
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
