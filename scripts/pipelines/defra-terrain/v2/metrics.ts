import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RegionSpec } from './region.ts';
import { regionLabel } from './region.ts';

export interface MergeStepMetrics {
  readonly level: number;
  readonly tierMetres: number;
  readonly gridRef: string;
  readonly loadMs: number;
  readonly downsampleMs: number;
  readonly downsampleUploadMs: number;
  readonly downsampleKernelMs: number;
  readonly downsampleReadbackMs: number;
  readonly mosaicMs: number;
  readonly encodeMs: number;
  readonly totalMs: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
}

export interface MergeMetricsSummary {
  readonly stepCount: number;
  readonly loadMs: number;
  readonly downsampleMs: number;
  readonly downsampleUploadMs: number;
  readonly downsampleKernelMs: number;
  readonly downsampleReadbackMs: number;
  readonly mosaicMs: number;
  readonly encodeMs: number;
  readonly totalMs: number;
}

export interface CellIngestMetrics {
  readonly cell: string;
  readonly groupCount: number;
  readonly leafChunks: number;
  readonly sourceZipBytes: number;
  readonly outputBytes: number;
  readonly elapsedMs: number;
  readonly encodeMs: number;
  readonly mergeMs: number;
  readonly mergeSteps?: readonly MergeStepMetrics[];
}

export interface IngestMetrics {
  readonly region: RegionSpec;
  readonly regionLabel: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly cellCount: number;
  readonly groupCount: number;
  readonly leafChunks: number;
  readonly sourceZipBytes: number;
  readonly outputBytes: number;
  readonly encodeMs: number;
  readonly mergeMs: number;
  readonly mergeSteps: readonly MergeStepMetrics[];
  readonly mergeSummary: MergeMetricsSummary;
  readonly cells: readonly CellIngestMetrics[];
}

export interface IngestMetricsRates {
  readonly msPerGroup: number;
  readonly outputBytesPerLeafChunk: number;
  readonly outputBytesPerGroup: number;
  readonly sourceBytesPerGroup: number;
}

const METRICS_FILE = 'index/ingest-metrics.json';

function summarizeMergeSteps(steps: readonly MergeStepMetrics[]): MergeMetricsSummary {
  return steps.reduce<MergeMetricsSummary>(
    (summary, step) => ({
      stepCount: summary.stepCount + 1,
      loadMs: summary.loadMs + step.loadMs,
      downsampleMs: summary.downsampleMs + step.downsampleMs,
      downsampleUploadMs: summary.downsampleUploadMs + step.downsampleUploadMs,
      downsampleKernelMs: summary.downsampleKernelMs + step.downsampleKernelMs,
      downsampleReadbackMs: summary.downsampleReadbackMs + step.downsampleReadbackMs,
      mosaicMs: summary.mosaicMs + step.mosaicMs,
      encodeMs: summary.encodeMs + step.encodeMs,
      totalMs: summary.totalMs + step.totalMs,
    }),
    {
      stepCount: 0,
      loadMs: 0,
      downsampleMs: 0,
      downsampleUploadMs: 0,
      downsampleKernelMs: 0,
      downsampleReadbackMs: 0,
      mosaicMs: 0,
      encodeMs: 0,
      totalMs: 0,
    },
  );
}

export class IngestMetricsCollector {
  private readonly startedAt = Date.now();
  private encodeMs = 0;
  private mergeMs = 0;
  private outputBytes = 0;
  private readonly cells: CellIngestMetrics[] = [];
  private readonly mergeSteps: MergeStepMetrics[] = [];
  private readonly region: RegionSpec;

  constructor(region: RegionSpec) {
    this.region = region;
  }

  addOutputBytes(bytes: number): void {
    this.outputBytes += bytes;
  }

  addEncodeMs(ms: number): void {
    this.encodeMs += ms;
  }

  addMergeMs(ms: number): void {
    this.mergeMs += ms;
  }

  recordCell(entry: CellIngestMetrics): void {
    this.cells.push(entry);
  }

  recordMergeStep(step: MergeStepMetrics): void {
    this.mergeSteps.push(step);
  }

  finalize(totals: {
    readonly groupCount: number;
    readonly leafChunks: number;
    readonly sourceZipBytes: number;
  }): IngestMetrics {
    const finishedAt = Date.now();
    return {
      region: this.region,
      regionLabel: regionLabel(this.region),
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      elapsedMs: finishedAt - this.startedAt,
      cellCount: this.cells.length,
      groupCount: totals.groupCount,
      leafChunks: totals.leafChunks,
      sourceZipBytes: totals.sourceZipBytes,
      outputBytes: this.outputBytes,
      encodeMs: this.encodeMs,
      mergeMs: this.mergeMs,
      mergeSteps: this.mergeSteps,
      mergeSummary: summarizeMergeSteps(this.mergeSteps),
      cells: this.cells,
    };
  }
}

export function ingestMetricsRates(metrics: IngestMetrics): IngestMetricsRates {
  const groupCount = Math.max(1, metrics.groupCount);
  const leafChunks = Math.max(1, metrics.leafChunks);
  return {
    msPerGroup: metrics.elapsedMs / groupCount,
    outputBytesPerLeafChunk: metrics.outputBytes / leafChunks,
    outputBytesPerGroup: metrics.outputBytes / groupCount,
    sourceBytesPerGroup: metrics.sourceZipBytes / groupCount,
  };
}

export async function writeIngestMetrics(outDir: string, metrics: IngestMetrics): Promise<string> {
  const filePath = path.join(outDir, METRICS_FILE);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function readIngestMetrics(outDir: string): Promise<IngestMetrics | undefined> {
  try {
    const content = await readFile(path.join(outDir, METRICS_FILE), 'utf8');
    return JSON.parse(content) as IngestMetrics;
  } catch {
    return undefined;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(2)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

export function formatMergeStepSummary(step: MergeStepMetrics): string {
  const parts = [
    `load ${formatDuration(step.loadMs)}`,
    `down ${formatDuration(step.downsampleMs)}`,
    `enc ${formatDuration(step.encodeMs)}`,
    `total ${formatDuration(step.totalMs)}`,
  ];
  if (step.mosaicMs > 0) parts.splice(2, 0, `mosaic ${formatDuration(step.mosaicMs)}`);
  if (step.downsampleMs > 0) {
    parts[1] = `down ${formatDuration(step.downsampleMs)} (up ${formatDuration(step.downsampleUploadMs)}, kernel ${formatDuration(step.downsampleKernelMs)}, read ${formatDuration(step.downsampleReadbackMs)})`;
  }
  return parts.join(', ');
}

export function formatMergeSummary(summary: MergeMetricsSummary): string {
  if (summary.stepCount === 0) return 'no merge steps recorded';
  return [
    `${summary.stepCount} steps`,
    `load ${formatDuration(summary.loadMs)}`,
    `down ${formatDuration(summary.downsampleMs)} (up ${formatDuration(summary.downsampleUploadMs)}, kernel ${formatDuration(summary.downsampleKernelMs)}, read ${formatDuration(summary.downsampleReadbackMs)})`,
    `mosaic ${formatDuration(summary.mosaicMs)}`,
    `encode ${formatDuration(summary.encodeMs)}`,
    `total ${formatDuration(summary.totalMs)}`,
  ].join(', ');
}

export function formatMetricsSummary(metrics: IngestMetrics): string {
  const lines = [
    `region: ${metrics.regionLabel}`,
    `elapsed: ${formatDuration(metrics.elapsedMs)} (encode ${formatDuration(metrics.encodeMs)}, merge ${formatDuration(metrics.mergeMs)})`,
    `cells: ${metrics.cellCount}, groups: ${metrics.groupCount}, leaf chunks: ${metrics.leafChunks}`,
    `source zips: ${formatBytes(metrics.sourceZipBytes)}`,
    `output: ${formatBytes(metrics.outputBytes)}`,
  ];
  if (metrics.mergeSummary.stepCount > 0) {
    lines.push(`merge detail: ${formatMergeSummary(metrics.mergeSummary)}`);
  }
  const rates = ingestMetricsRates(metrics);
  lines.push(
    `rates: ${formatDuration(rates.msPerGroup)}/group, ${formatBytes(rates.outputBytesPerLeafChunk)}/leaf chunk`,
  );
  return lines.join('\n');
}
