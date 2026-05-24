import { useSyncExternalStore } from 'react';
import * as THREE from 'three';
import {
  clampLossyQuality,
  DEFAULT_LOSSY_COMPRESSION_RATIO,
  invalidateLossyCache,
  jp2Texture,
  type HeightRange,
  type RecodeStats,
} from '../openjpegjs/jp2kloader';
import type { TileUniformBag } from './tileShaderRuntime';
import { applyModuleUpdate, tileShaderUniforms } from './tileShaderRuntime';

export type CompressionBlendMode = 'mix' | 'wave' | 'split' | 'deltaEmissive';

export const compressionBlendModes: readonly CompressionBlendMode[] = [
  'mix',
  'wave',
  'split',
  'deltaEmissive',
];

export const compressionBlendModeIndex: Record<CompressionBlendMode, number> = {
  mix: 0,
  wave: 1,
  split: 2,
  deltaEmissive: 3,
};

export type CompressionRecodePhase = 'idle' | 'running' | 'done';

export type CompressionLoadStatus = {
  /** Shader experiment active (dual height path). */
  shaderEnabled: boolean;
  recodePhase: CompressionRecodePhase;
  total: number;
  pending: number;
  completed: number;
  failed: number;
};

export type CompressionTileRecodeStats = RecodeStats & {
  url: string;
  tileLabel: string;
};

export type CompressionRecodeReport = {
  quality: number;
  tileCount: number;
  failedCount: number;
  totalSourceBytes: number;
  totalEncodedBytes: number;
  /** Sum of encoded / sum of source across tiles. */
  aggregateCompressionVsSource: number;
  /** Weighted mean of per-tile RMSE (normalized 0–1 height). */
  meanRmseNorm: number;
  maxRmseNorm: number;
  maxAbsNorm: number;
  meanIdenticalFraction: number;
  tiles: CompressionTileRecodeStats[];
};

type CompressionTileRecord = {
  url: string;
  /** Passed to jp2Texture as simplerDecodeHack (10m DTM vs 1m DSM). */
  simplerDecodeHack: boolean;
  /** 10m DTM: metre domain from /ttile/ used to denormalise /ltile/ uint16 recode. */
  heightRangeMetres?: HeightRange;
  uniformBags: TileUniformBag[];
  lossyGeneration: number;
  appliedQuality?: number;
  failedQuality?: number;
  loadingQuality?: number;
};

const trackedTiles = new Set<CompressionTileRecord>();

export type CompressionTileHandle = {
  requestVisible(): void;
};

let lossyCompressionRatio = DEFAULT_LOSSY_COMPRESSION_RATIO;

let loadStatus: CompressionLoadStatus = {
  shaderEnabled: false,
  recodePhase: 'idle',
  total: 0,
  pending: 0,
  completed: 0,
  failed: 0,
};

const statusListeners = new Set<() => void>();
const reportListeners = new Set<() => void>();

const emptyReport = (): CompressionRecodeReport => ({
  quality: lossyCompressionRatio,
  tileCount: 0,
  failedCount: 0,
  totalSourceBytes: 0,
  totalEncodedBytes: 0,
  aggregateCompressionVsSource: 0,
  meanRmseNorm: 0,
  maxRmseNorm: 0,
  maxAbsNorm: 0,
  meanIdenticalFraction: 0,
  tiles: [],
});

let recodeReport: CompressionRecodeReport = emptyReport();

function emitStatus(): void {
  for (const listener of statusListeners) {
    listener();
  }
}

function setLoadStatus(patch: Partial<CompressionLoadStatus>): void {
  loadStatus = { ...loadStatus, ...patch };
  emitStatus();
}

export function getLossyCompressionRatio(): number {
  return clampLossyQuality(lossyCompressionRatio);
}

export function setLossyCompressionRatio(ratio: number): void {
  lossyCompressionRatio = clampLossyQuality(ratio);
}

function emitReport(): void {
  for (const listener of reportListeners) {
    listener();
  }
}

function tileLabelFromUrl(url: string): string {
  const parts = url.split('/');
  return parts[parts.length - 1] ?? url;
}

function rebuildReportAggregate(): void {
  const tiles = recodeReport.tiles;
  if (tiles.length === 0) {
    recodeReport = { ...emptyReport(), quality: lossyCompressionRatio };
    emitReport();
    return;
  }
  let totalSourceBytes = 0;
  let totalEncodedBytes = 0;
  let rmseSum = 0;
  let maxRmseNorm = 0;
  let maxAbsNorm = 0;
  let identicalSum = 0;
  let pixelSum = 0;
  for (const t of tiles) {
    totalSourceBytes += t.sourceBytes;
    totalEncodedBytes += t.encodedBytes;
    rmseSum += t.rmseNorm * t.pixelCount;
    pixelSum += t.pixelCount;
    if (t.rmseNorm > maxRmseNorm) maxRmseNorm = t.rmseNorm;
    if (t.maxAbsNorm > maxAbsNorm) maxAbsNorm = t.maxAbsNorm;
    identicalSum += t.identicalPixels;
  }
  recodeReport = {
    ...recodeReport,
    quality: lossyCompressionRatio,
    tileCount: tiles.length,
    totalSourceBytes,
    totalEncodedBytes,
    aggregateCompressionVsSource:
      totalSourceBytes > 0 ? totalEncodedBytes / totalSourceBytes : 0,
    meanRmseNorm: pixelSum > 0 ? rmseSum / pixelSum : 0,
    maxRmseNorm,
    maxAbsNorm,
    meanIdenticalFraction: pixelSum > 0 ? identicalSum / pixelSum : 0,
  };
  emitReport();
}

function recordTileRecodeStats(url: string, stats: RecodeStats): void {
  recodeReport.tiles.push({
    ...stats,
    url,
    tileLabel: tileLabelFromUrl(url),
  });
  rebuildReportAggregate();
}

export function getCompressionRecodeReport(): CompressionRecodeReport {
  return recodeReport;
}

export function subscribeCompressionRecodeReport(listener: () => void): () => void {
  reportListeners.add(listener);
  return () => reportListeners.delete(listener);
}

export function useCompressionRecodeReport(): CompressionRecodeReport {
  return useSyncExternalStore(
    subscribeCompressionRecodeReport,
    getCompressionRecodeReport,
    getCompressionRecodeReport,
  );
}

export function getCompressionLoadStatus(): CompressionLoadStatus {
  return loadStatus;
}

export function subscribeCompressionLoadStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function formatCompressionLoadStatus(status: CompressionLoadStatus): string {
  if (!status.shaderEnabled) {
    return 'Off';
  }
  if (status.recodePhase === 'idle') {
    const n = countLossyTargets();
    if (n === 0) {
      return 'Shader on — waiting for height tiles';
    }
    return `Shader on — ${n} tile(s) tracked`;
  }
  if (status.total === 0) {
    return 'Waiting for visible height tiles';
  }
  if (status.pending > 0) {
    const failed = status.failed > 0 ? `, ${status.failed} failed` : '';
    return `Visible recode ${status.completed}/${status.total} (${status.pending} in flight${failed})`;
  }
  if (status.failed > 0) {
    return `Visible recode errors — ${status.completed}/${status.total} ok, ${status.failed} failed`;
  }
  return `Visible lossy rasters ready (${status.completed}/${status.total})`;
}

export function useCompressionLoadStatus(): CompressionLoadStatus {
  return useSyncExternalStore(
    subscribeCompressionLoadStatus,
    getCompressionLoadStatus,
    getCompressionLoadStatus,
  );
}

export function ensureCompressionShaderUniforms(shared: typeof tileShaderUniforms): void {
  if (!('compressionEnabled' in shared)) {
    shared.compressionEnabled = { value: 0 };
  }
  if (!('heightBlend' in shared)) {
    shared.heightBlend = { value: 0 };
  }
  if (!('compressionWaveAmp' in shared)) {
    shared.compressionWaveAmp = { value: 1 };
  }
  if (!('compressionWaveFreq' in shared)) {
    shared.compressionWaveFreq = { value: 12 };
  }
  if (!('compressionWaveSpeed' in shared)) {
    shared.compressionWaveSpeed = { value: 0.5 };
  }
  if (!('compressionBlendMode' in shared)) {
    shared.compressionBlendMode = { value: 0 };
  }
  if (!('compressionDeltaScale' in shared)) {
    shared.compressionDeltaScale = { value: 80 };
  }
  if (!('compressionHeightGain' in shared)) {
    shared.compressionHeightGain = { value: 1 };
  }
}

export function registerCompressionTile(
  url: string,
  simplerDecodeHack: boolean,
  uniformBags: TileUniformBag[],
  heightRangeMetres?: HeightRange,
): CompressionTileHandle {
  const record: CompressionTileRecord = { url, simplerDecodeHack, heightRangeMetres, uniformBags, lossyGeneration: 0 };
  trackedTiles.add(record);
  if (loadStatus.shaderEnabled) {
    emitStatus();
  }
  return {
    requestVisible: () => requestLossyForVisibleRecord(record),
  };
}

function disposeLossyTexture(tex: THREE.Texture | undefined, full: THREE.Texture): void {
  if (tex && tex !== full) {
    tex.dispose();
  }
}

function addLossyUniform(bag: TileUniformBag, fullTexture: THREE.Texture): void {
  if (!bag.heightFeildLossy) {
    bag.heightFeildLossy = { value: fullTexture };
  } else {
    bag.heightFeildLossy.value = fullTexture;
  }
}

function textureUniformValue(bag: TileUniformBag, key: string): THREE.Texture | undefined {
  const value = bag[key]?.value;
  return value instanceof THREE.Texture ? value : undefined;
}

function countLossyTargets(): number {
  return trackedTiles.size;
}

function noteLossyFinished(ok: boolean): void {
  if (ok) {
    setLoadStatus({
      completed: loadStatus.completed + 1,
      pending: Math.max(0, loadStatus.pending - 1),
    });
  } else {
    setLoadStatus({
      failed: loadStatus.failed + 1,
      pending: Math.max(0, loadStatus.pending - 1),
    });
  }
  if (loadStatus.pending === 0 && loadStatus.recodePhase === 'running') {
    setLoadStatus({ recodePhase: 'done' });
    recodeReport = { ...recodeReport, failedCount: loadStatus.failed };
    rebuildReportAggregate();
    const u = tileShaderUniforms;
    if (u.heightBlend) u.heightBlend.value = 1;
    applyModuleUpdate();
  }
}

async function loadLossyForRecord(
  record: CompressionTileRecord,
  generation: number,
  quality: number,
): Promise<void> {
  const { url, simplerDecodeHack, heightRangeMetres, uniformBags } = record;

  try {
    const lossy = await jp2Texture(url, simplerDecodeHack, quality, heightRangeMetres);
    if (record.lossyGeneration !== generation) return;
    record.loadingQuality = undefined;
    record.appliedQuality = quality;
    record.failedQuality = undefined;

    if (lossy.recodeStats) {
      recordTileRecodeStats(url, lossy.recodeStats);
    }

    for (const bag of uniformBags) {
      const full = textureUniformValue(bag, 'heightFeild');
      if (!full) continue;
      disposeLossyTexture(textureUniformValue(bag, 'heightFeildLossy'), full);
      addLossyUniform(bag, lossy.texture);
      lossy.texture.needsUpdate = true;
    }
    noteLossyFinished(true);
  } catch (e) {
    if (record.lossyGeneration !== generation) return;
    record.loadingQuality = undefined;
    record.failedQuality = quality;
    console.error('lossy height load failed', url, e);
    noteLossyFinished(false);
  }
}

function requestLossyForVisibleRecord(record: CompressionTileRecord): void {
  if (!loadStatus.shaderEnabled || !isCompressionExperimentEnabled()) return;

  const quality = getLossyCompressionRatio();
  if (
    record.appliedQuality === quality ||
    record.loadingQuality === quality ||
    record.failedQuality === quality
  ) {
    return;
  }

  for (const bag of record.uniformBags) {
    const full = textureUniformValue(bag, 'heightFeild');
    if (full) addLossyUniform(bag, full);
  }

  record.loadingQuality = quality;
  record.failedQuality = undefined;
  const generation = ++record.lossyGeneration;
  setLoadStatus({
    recodePhase: 'running',
    total: loadStatus.total + 1,
    pending: loadStatus.pending + 1,
  });
  void loadLossyForRecord(record, generation, quality);
}

function prepareLossyUniforms(): void {
  for (const record of trackedTiles) {
    for (const bag of record.uniformBags) {
      const full = textureUniformValue(bag, 'heightFeild');
      if (full) addLossyUniform(bag, full);
    }
  }
}

function cancelLossyLoads(): void {
  for (const record of trackedTiles) {
    record.lossyGeneration += 1;
    record.loadingQuality = undefined;
  }
}

function teardownLossyTextures(): void {
  cancelLossyLoads();
  for (const record of trackedTiles) {
    for (const bag of record.uniformBags) {
      const full = textureUniformValue(bag, 'heightFeild');
      if (full) disposeLossyTexture(textureUniformValue(bag, 'heightFeildLossy'), full);
      delete bag.heightFeildLossy;
    }
    record.appliedQuality = undefined;
    record.failedQuality = undefined;
  }
  invalidateLossyCache();
}

/** Begin a visible-tile recode epoch. Rendered tiles enqueue themselves via onBeforeRender. */
export function startLossyRecode(): void {
  if (!loadStatus.shaderEnabled) return;

  cancelLossyLoads();
  teardownLossyTextures();
  invalidateLossyCache();

  if (tileShaderUniforms.heightBlend) {
    tileShaderUniforms.heightBlend.value = 1;
  }

  recodeReport = { ...emptyReport(), quality: lossyCompressionRatio };
  emitReport();

  setLoadStatus({
    recodePhase: 'running',
    total: 0,
    pending: 0,
    completed: 0,
    failed: 0,
  });
}

/** Sync experiment shader from TerrainOptions / Leva (does not start recode). */
export function syncCompressionExperiment(enabled: boolean): void {
  ensureCompressionShaderUniforms(tileShaderUniforms);
  const u = tileShaderUniforms;
  const wasEnabled = u.compressionEnabled.value > 0.5;
  u.compressionEnabled.value = enabled ? 1 : 0;

  if (enabled && !wasEnabled) {
    prepareLossyUniforms();
    applyModuleUpdate();
    setLoadStatus({
      shaderEnabled: true,
      recodePhase: 'idle',
      total: 0,
      pending: 0,
      completed: 0,
      failed: 0,
    });
    return;
  }

  if (!enabled && wasEnabled) {
    teardownLossyTextures();
    u.heightBlend.value = 0;
    applyModuleUpdate();
    setLoadStatus({
      shaderEnabled: false,
      recodePhase: 'idle',
      total: 0,
      pending: 0,
      completed: 0,
      failed: 0,
    });
  }
}

export function isCompressionExperimentEnabled(): boolean {
  return tileShaderUniforms.compressionEnabled?.value > 0.5;
}
