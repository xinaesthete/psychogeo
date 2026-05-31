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

type CompressionTilePhase = 'idle' | 'loading' | 'ready' | 'failed';

type CompressionTileRecord = {
  url: string;
  /** Passed to jp2Texture as simplerDecodeHack (10m DTM vs 1m DSM). */
  simplerDecodeHack: boolean;
  /** 10m DTM: metre domain from /ttile/ used to denormalise /ltile/ uint16 recode. */
  heightRangeMetres?: HeightRange;
  uniformBags: TileUniformBag[];
  lossyGeneration: number;
  /** Single source of truth for this tile's recode state; counters are derived from phases. */
  phase: CompressionTilePhase;
  displayedQuality?: number;
  pendingQuality?: number;
  failedQuality?: number;
  transitionProgress: number;
  alive: boolean;
  aliveTimer?: ReturnType<typeof setTimeout>;
};

const trackedTiles = new Set<CompressionTileRecord>();
const TILE_ALIVE_GRACE_MS = 1500;

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
    shared.heightBlend = { value: 1 };
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
  const record: CompressionTileRecord = {
    url,
    simplerDecodeHack,
    heightRangeMetres,
    uniformBags,
    lossyGeneration: 0,
    phase: 'idle',
    transitionProgress: 0,
    alive: false,
  };
  trackedTiles.add(record);
  if (loadStatus.shaderEnabled) {
    const full = textureUniformValue(uniformBags[0], 'heightFeild');
    if (full) {
      syncVisibleLossyUniforms(record, full);
    }
  }
  if (loadStatus.shaderEnabled) {
    emitStatus();
  }
  return {
    requestVisible: () => requestLossyForVisibleRecord(record),
  };
}

function syncVisibleLossyUniforms(record: CompressionTileRecord, fullTexture: THREE.Texture): void {
  for (const bag of record.uniformBags) {
    if (!bag.heightFeildLossy) {
      bag.heightFeildLossy = { value: fullTexture };
    } else if (!(bag.heightFeildLossy.value instanceof THREE.Texture)) {
      bag.heightFeildLossy.value = fullTexture;
    }
    if (!bag.heightFeildLossyNext) {
      bag.heightFeildLossyNext = { value: bag.heightFeildLossy.value };
    }
    if (!bag.compressionLossyMorph) {
      bag.compressionLossyMorph = { value: 0 };
    }
    if (!bag.compressionLoading) {
      bag.compressionLoading = { value: 0 };
    }
  }
}

function setLossyCurrent(record: CompressionTileRecord, texture: THREE.Texture): void {
  for (const bag of record.uniformBags) {
    bag.heightFeildLossy ??= { value: texture };
    bag.heightFeildLossy.value = texture;
    bag.heightFeildLossyNext ??= { value: texture };
    bag.heightFeildLossyNext.value = texture;
    bag.compressionLossyMorph ??= { value: 0 };
    bag.compressionLossyMorph.value = 0;
  }
}

function setLossyPending(record: CompressionTileRecord, texture: THREE.Texture): void {
  for (const bag of record.uniformBags) {
    bag.heightFeildLossyNext ??= { value: texture };
    bag.heightFeildLossyNext.value = texture;
    bag.compressionLossyMorph ??= { value: 0 };
    bag.compressionLossyMorph.value = 0;
    bag.compressionLoading ??= { value: 0 };
    bag.compressionLoading.value = 0;
  }
}

function setLossyLoading(record: CompressionTileRecord, loading: boolean): void {
  for (const bag of record.uniformBags) {
    bag.compressionLoading ??= { value: 0 };
    bag.compressionLoading.value = loading ? 1 : 0;
  }
}

function clearPendingTransition(record: CompressionTileRecord): void {
  const full = textureUniformValue(record.uniformBags[0], 'heightFeild');
  const current = textureUniformValue(record.uniformBags[0], 'heightFeildLossy');
  const pending = textureUniformValue(record.uniformBags[0], 'heightFeildLossyNext');
  if (pending && pending !== current && pending !== full && record.pendingQuality !== undefined) {
    invalidateLossyCache(record.url, record.pendingQuality);
  }
  for (const bag of record.uniformBags) {
    if (bag.heightFeildLossy && current) {
      bag.heightFeildLossy.value = current;
    }
    if (bag.heightFeildLossyNext) {
      bag.heightFeildLossyNext.value = current ?? full ?? bag.heightFeildLossyNext.value;
    }
    if (bag.compressionLossyMorph) {
      bag.compressionLossyMorph.value = 0;
    }
    if (bag.compressionLoading) {
      bag.compressionLoading.value = 0;
    }
  }
  record.pendingQuality = undefined;
  record.transitionProgress = 0;
}

/** Derive total/pending/completed/failed from live tile phases; transition phase when all done. */
function recomputeAndEmitStatus(): void {
  if (!loadStatus.shaderEnabled) return;
  let total = 0, pending = 0, completed = 0, failed = 0;
  for (const record of trackedTiles) {
    if (!record.alive) continue;
    total++;
    if (record.phase === 'loading') pending++;
    else if (record.phase === 'ready') completed++;
    else if (record.phase === 'failed') failed++;
  }
  // Derive recodePhase from live counts; 'idle' is only set/cleared by startLossyRecode /
  // syncCompressionExperiment — never derived.
  let recodePhase = loadStatus.recodePhase;
  if (recodePhase !== 'idle') {
    if (pending > 0) recodePhase = 'running';
    else if (total > 0) recodePhase = 'done';
    // total === 0: keep current phase ('running' while waiting for first visible tiles)
  }
  const justFinished = recodePhase === 'done' && loadStatus.recodePhase === 'running';
  setLoadStatus({ total, pending, completed, failed, recodePhase });
  if (justFinished) {
    recodeReport = { ...recodeReport, failedCount: failed };
    rebuildReportAggregate();
    applyModuleUpdate();
  }
}

function disposeTileLossyPayload(record: CompressionTileRecord): void {
  for (const bag of record.uniformBags) {
    delete bag.heightFeildLossy;
    delete bag.heightFeildLossyNext;
    delete bag.compressionLossyMorph;
    delete bag.compressionLoading;
  }
  record.displayedQuality = undefined;
  record.pendingQuality = undefined;
  record.failedQuality = undefined;
  record.transitionProgress = 0;
  invalidateLossyCache(record.url);
}

function expireVisibleRecord(record: CompressionTileRecord): void {
  record.alive = false;
  record.aliveTimer = undefined;
  if (record.phase === 'loading') {
    record.lossyGeneration += 1;
    record.phase = 'idle';
  }
  clearPendingTransition(record);
  setLossyLoading(record, false);
  disposeTileLossyPayload(record);
  recomputeAndEmitStatus();
}

function touchVisibleRecord(record: CompressionTileRecord): void {
  record.alive = true;
  if (record.aliveTimer) {
    clearTimeout(record.aliveTimer);
  }
  record.aliveTimer = setTimeout(() => expireVisibleRecord(record), TILE_ALIVE_GRACE_MS);
}

function getLossyTexture(record: CompressionTileRecord): THREE.Texture | undefined {
  const current = textureUniformValue(record.uniformBags[0], 'heightFeildLossy');
  return current;
}

function textureUniformValue(bag: TileUniformBag, key: string): THREE.Texture | undefined {
  const value = bag[key]?.value;
  return value instanceof THREE.Texture ? value : undefined;
}

function countLossyTargets(): number {
  return trackedTiles.size;
}

function noteLossyFinished(record: CompressionTileRecord, ok: boolean): void {
  record.phase = ok ? 'ready' : 'failed';
  setLossyLoading(record, false);
  recomputeAndEmitStatus();
}

async function loadLossyForRecord(
  record: CompressionTileRecord,
  generation: number,
  quality: number,
): Promise<void> {
  const { url, simplerDecodeHack, heightRangeMetres } = record;

  try {
    const lossy = await jp2Texture(url, simplerDecodeHack, quality, heightRangeMetres);
    if (record.lossyGeneration !== generation) {
      invalidateLossyCache(url, quality);
      return;
    }
    const current = getLossyTexture(record);
    record.pendingQuality = quality;
    record.failedQuality = undefined;

    if (lossy.recodeStats) {
      recordTileRecodeStats(url, lossy.recodeStats);
    }

    if (current && current !== lossy.texture) {
      setLossyPending(record, lossy.texture);
    } else {
      setLossyCurrent(record, lossy.texture);
    }
    noteLossyFinished(record, true);
  } catch (e) {
    if (record.lossyGeneration !== generation) return;
    record.failedQuality = quality;
    console.error('lossy height load failed', url, e);
    noteLossyFinished(record, false);
  }
}

function requestLossyForVisibleRecord(record: CompressionTileRecord): void {
  if (!loadStatus.shaderEnabled || !isCompressionExperimentEnabled()) return;
  touchVisibleRecord(record);

  if (loadStatus.recodePhase === 'idle') return;

  const quality = getLossyCompressionRatio();
  // Only 'idle' tiles load. 'loading', 'ready', and 'failed' phases all gate until
  // startLossyRecode resets them to 'idle' for the next epoch.
  if (record.phase !== 'idle') return;
  // Guard against re-loading a quality that's already displayed (e.g. same-quality re-enable).
  if (record.displayedQuality === quality) return;

  for (const bag of record.uniformBags) {
    const full = textureUniformValue(bag, 'heightFeild');
    if (full) syncVisibleLossyUniforms(record, full);
  }

  record.phase = 'loading';
  record.failedQuality = undefined;
  setLossyLoading(record, true);
  const generation = ++record.lossyGeneration;
  recomputeAndEmitStatus();
  void loadLossyForRecord(record, generation, quality);
}

function prepareLossyUniforms(): void {
  for (const record of trackedTiles) {
    for (const bag of record.uniformBags) {
      const full = textureUniformValue(bag, 'heightFeild');
      if (full) syncVisibleLossyUniforms(record, full);
    }
  }
}

function cancelLossyLoads(): void {
  for (const record of trackedTiles) {
    if (record.phase === 'loading') {
      record.lossyGeneration += 1;
      record.phase = 'idle';
    }
    setLossyLoading(record, false);
    clearPendingTransition(record);
  }
}

function teardownLossyTextures(): void {
  cancelLossyLoads();
  for (const record of trackedTiles) {
    if (record.aliveTimer) {
      clearTimeout(record.aliveTimer);
      record.aliveTimer = undefined;
    }
    disposeTileLossyPayload(record);
    record.displayedQuality = undefined;
    record.pendingQuality = undefined;
    record.failedQuality = undefined;
    record.transitionProgress = 0;
    record.alive = false;
  }
  invalidateLossyCache();
}

/** Begin a visible-tile recode epoch. Rendered tiles enqueue themselves via onBeforeRender. */
export function startLossyRecode(): void {
  if (!loadStatus.shaderEnabled) return;

  // Cancel any in-flight loads and reset all tile phases to idle so they re-enqueue.
  for (const record of trackedTiles) {
    if (record.phase === 'loading') {
      record.lossyGeneration += 1;
    }
    record.phase = 'idle';
    record.failedQuality = undefined;
    clearPendingTransition(record);
    setLossyLoading(record, false);
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

export function advanceCompressionTransitions(dt: number): void {
  const transitionRate = dt <= 0 ? 0 : dt / 0.35;
  if (transitionRate <= 0) return;
  for (const record of trackedTiles) {
    if (record.pendingQuality === undefined) continue;
    record.transitionProgress = Math.min(1, record.transitionProgress + transitionRate);
    const morph = record.transitionProgress;
    for (const bag of record.uniformBags) {
      if (bag.compressionLossyMorph) {
        bag.compressionLossyMorph.value = morph;
      }
    }
    if (morph < 1) continue;

    const previousQuality = record.displayedQuality;
    const next = textureUniformValue(record.uniformBags[0], 'heightFeildLossyNext');
    if (!next) continue;
    for (const bag of record.uniformBags) {
      bag.heightFeildLossy ??= { value: next };
      bag.heightFeildLossy.value = next;
      bag.heightFeildLossyNext ??= { value: next };
      bag.heightFeildLossyNext.value = next;
      if (bag.compressionLossyMorph) {
        bag.compressionLossyMorph.value = 0;
      }
      if (bag.compressionLoading) {
        bag.compressionLoading.value = 0;
      }
    }
    if (previousQuality !== undefined && previousQuality !== record.pendingQuality) {
      invalidateLossyCache(record.url, previousQuality);
    }
    record.displayedQuality = record.pendingQuality;
    record.pendingQuality = undefined;
    record.transitionProgress = 0;
  }
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
    u.heightBlend.value = 1;
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
