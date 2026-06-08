#!/usr/bin/env node
import { inspectDataset } from './inspect.ts';
import {
  defaultTileConcurrency,
  defaultGroupConcurrency,
  ingestDefraTerrain,
  parseConcurrencyFlag,
  type IngestProgressEvent,
} from './ingest.ts';
import { scanDefraZips, summarizeScan } from './scan.ts';
import { CHANNELS } from './manifest.ts';
import type { TerrainChannelId } from './types.ts';
import { DEFAULT_MIN_FREE_BYTES } from './v2/diskSpace.ts';
import { ingestDefraTerrainV2, type IngestV2ProgressEvent } from './v2/ingest.ts';
import { inspectDatasetV2 } from './v2/inspect.ts';
import { formatBytes, formatDuration, formatMetricsSummary, readIngestMetrics } from './v2/metrics.ts';
import { formatRegionPlan, planRegionIngest } from './v2/plan.ts';
import { parseRegionArg } from './v2/region.ts';
import { validateDatasetV2 } from './v2/validate.ts';
import { syncCheckpointsFromDisk } from './v2/syncCheckpoints.ts';

const startTime = Date.now();

interface CliArgs {
  readonly command: string;
  readonly input?: string;
  readonly out?: string;
  readonly dataset?: string;
  readonly datasetId?: string;
  readonly cell?: string;
  readonly region?: string;
  readonly bounds?: string;
  readonly baseline?: string;
  readonly channel?: string;
  readonly pyramidPreset?: string;
  readonly pyramidLevels?: string;
  readonly tileConcurrency?: string;
  readonly groupConcurrency?: string;
  readonly minFreeGb?: string;
  readonly progress: boolean;
  readonly noMerge: boolean;
  readonly skipValidation: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm pipeline:defra -- scan --input <dir>',
    '  pnpm pipeline:defra -- ingest --input <dir> --out <dataset-dir> [--dataset-id <id>]',
    '      [--tile-concurrency <n>] [--group-concurrency <n>] [--progress]',
    '  pnpm pipeline:defra -- inspect --dataset <dataset-dir>',
    '  pnpm pipeline:defra -- plan-v2 --input <dir> [--region <gridRef> | --cell <gridRef> | --bounds <csv>]',
    '      [--baseline <prior-dataset-dir>]',
    '  pnpm pipeline:defra -- ingest-v2 --input <dir> --out <dataset-dir>',
    '      [--region <gridRef> | --cell <gridRef> | --bounds eastMin,northMin,eastMax,northMax]',
    '      [--channel height.dsm.fz] [--dataset-id <id>]',
    '      [--pyramid-preset cell|regional|national] [--pyramid-levels <path.json>]',
    '        Pyramid: preset selects overview depths (default cell). --pyramid-levels overrides preset.',
    '      [--tile-concurrency <n>] [--group-concurrency <n>] [--min-free-gb <n>] [--no-merge] [--skip-validation] [--progress]',
    '  pnpm pipeline:defra -- validate-v2 --dataset <dataset-dir>',
    '  pnpm pipeline:defra -- sync-checkpoints-v2 --input <dir> --out <dataset-dir>',
    '      [--region <gridRef> | --cell <gridRef> | --bounds eastMin,northMin,eastMax,northMax]',
    '  pnpm pipeline:defra -- inspect-v2 --dataset <dataset-dir>',
    '',
    'Region examples:',
    '  --region SP51     one 10 km cell',
    '  --region SP       100 km square (batch all cells with data)',
    '  --region S        500 km band (all cells whose 100 km pair starts with S)',
    '  --bounds 450000,210000,460000,220000   explicit easting/northing box',
  ].join('\n');
}

function parseArgs(argv: string[]): CliArgs {
  const cleanArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const command = cleanArgv[0] ?? '';
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < cleanArgv.length; i += 1) {
    const arg = cleanArgv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const value = cleanArgv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      flags.add(arg.slice(2));
      continue;
    }
    values.set(arg.slice(2), value);
    i += 1;
  }
  return {
    command,
    input: values.get('input'),
    out: values.get('out'),
    dataset: values.get('dataset'),
    datasetId: values.get('dataset-id'),
    cell: values.get('cell'),
    region: values.get('region'),
    bounds: values.get('bounds'),
    baseline: values.get('baseline'),
    channel: values.get('channel'),
    pyramidPreset: values.get('pyramid-preset'),
    pyramidLevels: values.get('pyramid-levels'),
    tileConcurrency: values.get('tile-concurrency'),
    groupConcurrency: values.get('group-concurrency'),
    minFreeGb: values.get('min-free-gb'),
    progress: flags.has('progress'),
    noMerge: flags.has('no-merge'),
    skipValidation: flags.has('skip-validation'),
  };
}

function parseMinFreeBytes(value: string | undefined): number {
  if (!value) return DEFAULT_MIN_FREE_BYTES;
  const gib = Number.parseFloat(value);
  if (!Number.isFinite(gib) || gib <= 0) {
    throw new Error('--min-free-gb must be a positive number');
  }
  return Math.round(gib * 1024 * 1024 * 1024);
}

function formatBytesLegacy(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
}

function formatProgress(event: IngestProgressEvent): string {
  const dt = Date.now() - startTime;
  const totalSeconds = Math.floor(dt / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const pre = `[defra] (${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')})`;
  switch (event.phase) {
    case 'scan':
      return `${pre} scanned ${event.groups} source groups (tile×${event.tileConcurrency}, group×${event.groupConcurrency})`;
    case 'resume':
      return `${pre} resuming: ${event.completedGroups} groups done, ${event.remainingGroups} remaining`;
    case 'recover':
      return `${pre} ${event.message}`;
    case 'group-start':
      return `${pre} group ${event.groupIndex}/${event.groupCount}: ${event.tileRef} ${event.year}`;
    case 'group-skip':
      return `${pre} skip ${event.groupIndex}/${event.groupCount}: ${event.tileRef} ${event.year} (existing shard ${event.shardId})`;
    case 'tile':
      return `${pre} tile ${event.tileIndex}/${event.tileCount}: ${event.tileId}, ${event.channels} channels, ${formatBytesLegacy(event.bytes)}`;
    case 'channel-failed':
      return `${pre} ${event.tileRef} ${event.tileId} ${event.channelId}: ${event.message}`;
    case 'tile-skip':
      return `${pre} skip tile ${event.tileRef} ${event.tileId}: ${event.message}`;
    case 'group-complete':
      return `${pre} complete ${event.tileRef}: ${event.tiles} tiles, ${event.channels} channels, ${formatBytesLegacy(event.bytes)}`;
    case 'complete':
      return `${pre} wrote ${event.tileCount} tiles, ${event.channelCount} channel payloads, ${event.shardCount} shards, ${formatBytesLegacy(event.totalPayloadBytes)} payload`;
  }
}

function progressLogger(enabled: boolean): ((event: IngestProgressEvent) => void) | undefined {
  if (!enabled) return undefined;
  return (event) => {
    console.error(formatProgress(event));
  };
}

function formatV2Progress(event: IngestV2ProgressEvent): string {
  const dt = Date.now() - startTime;
  const totalSeconds = Math.floor(dt / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const pre = `[defra-v2] (${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')})`;
  switch (event.phase) {
    case 'scan':
      return `${pre} scanned ${event.groups} source groups across ${event.cells} cells${event.skippedGroups > 0 ? ` (${event.skippedGroups} skipped)` : ''}`;
    case 'resume':
      return `${pre} resuming: ${event.completedGroups} groups and ${event.completedCells} cells done, ${event.remainingGroups} groups and ${event.remainingCells} cells remaining`;
    case 'sync-checkpoints':
      return `${pre} synced checkpoints from disk: ${event.pyramidCells} pyramid cells, ${event.completedGroups} groups, ${event.completedCells} merged cells (+${event.addedGroups} groups, +${event.addedCells} cells), region summary ${event.regionSummaryCells} cells`;
    case 'cell-start':
      return `${pre} cell ${event.cellIndex}/${event.cellCount}: ${event.cell}`;
    case 'cell-skip':
      return `${pre} skip cell ${event.cellIndex}/${event.cellCount}: ${event.cell} (already complete)`;
    case 'group-start':
      return `${pre} group ${event.groupIndex}/${event.groupCount}: ${event.tileRef}`;
    case 'group-skip':
      if (event.reason) {
        return `${pre} skip ${event.tileRef}: ${event.reason}`;
      }
      return `${pre} skip ${event.groupIndex}/${event.groupCount}: ${event.tileRef} (already complete)`;
    case 'tile':
      return `${pre} leaf ${event.tileRef} ${event.eastMin}_${event.northMin} (${formatBytes(event.bytes)})`;
    case 'group-complete':
      return `${pre} complete ${event.tileRef}: ${event.presentSlots} leaf slots (${formatBytes(event.bytes)})`;
    case 'merge-level':
      return `${pre} merge L${event.level} ${event.gridRef}`;
    case 'merge-complete':
      return `${pre} merged ${event.levels} pyramid levels`;
    case 'complete':
      return `${pre} wrote ${event.leafChunks} leaf chunks across ${event.groups} groups, ${formatBytes(event.outputBytes)}, ${formatDuration(event.elapsedMs)}`;
  }
}

function progressLoggerV2(enabled: boolean): ((event: IngestV2ProgressEvent) => void) | undefined {
  if (!enabled) return undefined;
  return (event) => {
    console.error(formatV2Progress(event));
  };
}

function parsePyramidPreset(value: string | undefined): 'cell' | 'regional' | 'national' | undefined {
  if (!value) return undefined;
  if (value === 'cell' || value === 'regional' || value === 'national') return value;
  throw new Error(`Unknown --pyramid-preset: ${value}`);
}

function parseChannelId(value: string | undefined): TerrainChannelId | undefined {
  if (!value) return undefined;
  const channel = CHANNELS.find((entry) => entry.id === value);
  if (!channel) throw new Error(`Unknown --channel: ${value}`);
  return channel.id;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'scan') {
    if (!args.input) throw new Error('--input is required for scan');
    console.log(summarizeScan(await scanDefraZips(args.input)));
    return;
  }
  if (args.command === 'ingest') {
    if (!args.input) throw new Error('--input is required for ingest');
    if (!args.out) throw new Error('--out is required for ingest');
    const tileConcurrency = parseConcurrencyFlag(args.tileConcurrency, defaultTileConcurrency());
    const groupConcurrency = parseConcurrencyFlag(args.groupConcurrency, 1);
    const result = await ingestDefraTerrain({
      inputDir: args.input,
      outDir: args.out,
      datasetId: args.datasetId,
      tileConcurrency,
      groupConcurrency,
      onProgress: progressLogger(args.progress),
    });
    console.log(
      `wrote ${result.manifestPath} (${result.shardCount} shards, ${result.tileCount} tiles, ${result.channelCount} channel payloads)`,
    );
    return;
  }
  if (args.command === 'inspect') {
    if (!args.dataset) throw new Error('--dataset is required for inspect');
    console.log(await inspectDataset(args.dataset));
    return;
  }
  if (args.command === 'plan-v2') {
    if (!args.input) throw new Error('--input is required for plan-v2');
    const region = parseRegionArg({
      region: args.region,
      cell: args.cell,
      bounds: args.bounds,
    });
    const plan = await planRegionIngest({
      inputDir: args.input,
      region,
      baselineMetricsDir: args.baseline,
    });
    console.log(formatRegionPlan(plan));
    return;
  }
  if (args.command === 'ingest-v2') {
    if (!args.input) throw new Error('--input is required for ingest-v2');
    if (!args.out) throw new Error('--out is required for ingest-v2');
    const region = parseRegionArg({
      region: args.region,
      cell: args.cell,
      bounds: args.bounds,
    });
    const tileConcurrency = parseConcurrencyFlag(args.tileConcurrency, defaultTileConcurrency());
    const groupConcurrency = parseConcurrencyFlag(args.groupConcurrency, defaultGroupConcurrency());
    const result = await ingestDefraTerrainV2({
      inputDir: args.input,
      outDir: args.out,
      region,
      datasetId: args.datasetId,
      channelId: parseChannelId(args.channel),
      pyramidPreset: parsePyramidPreset(args.pyramidPreset),
      pyramidLevelsPath: args.pyramidLevels,
      tileConcurrency,
      groupConcurrency,
      runMerge: !args.noMerge,
      minFreeBytes: parseMinFreeBytes(args.minFreeGb),
      skipValidation: args.skipValidation,
      onProgress: progressLoggerV2(args.progress),
    });
    const metrics = await readIngestMetrics(args.out);
    const lines = [
      'dataset validation: ok',
      `wrote ${result.metricsPath} (${result.cellCount} cells, ${result.groupCount} groups, ${result.leafChunkCount} leaf chunks)`,
      formatMetricsSummary(metrics ?? {
        region,
        regionLabel: '',
        startedAt: '',
        finishedAt: '',
        elapsedMs: result.elapsedMs,
        cellCount: result.cellCount,
        groupCount: result.groupCount,
        leafChunks: result.leafChunkCount,
        sourceZipBytes: 0,
        outputBytes: result.outputBytes,
        encodeMs: 0,
        mergeMs: 0,
        cells: [],
      }),
    ];
    if (result.metadataPath) lines.unshift(`wrote ${result.metadataPath}`);
    if (result.regionSummaryPath) lines.unshift(`wrote ${result.regionSummaryPath}`);
    console.log(lines.join('\n'));
    return;
  }
  if (args.command === 'validate-v2') {
    if (!args.dataset) throw new Error('--dataset is required for validate-v2');
    const errors = await validateDatasetV2(args.dataset);
    if (errors.length > 0) {
      throw new Error(`dataset validation failed:\n${errors.map((entry) => `- ${entry}`).join('\n')}`);
    }
    console.log('dataset validation: ok');
    return;
  }
  if (args.command === 'sync-checkpoints-v2') {
    if (!args.input) throw new Error('--input is required for sync-checkpoints-v2');
    if (!args.out) throw new Error('--out is required for sync-checkpoints-v2');
    const region = parseRegionArg({
      region: args.region,
      cell: args.cell,
      bounds: args.bounds,
    });
    const allGroups = await scanDefraZips(args.input);
    const result = await syncCheckpointsFromDisk({
      outDir: args.out,
      inputGroups: allGroups,
      region,
      pyramidPreset: parsePyramidPreset(args.pyramidPreset),
    });
    console.log(
      [
        `synced checkpoints from ${result.pyramidCells} pyramid cells`,
        `${result.completedGroups} completed groups (+${result.addedGroups})`,
        `${result.completedCells} merged cells (+${result.addedCells})`,
        `region summary lists ${result.regionSummaryCells} cells`,
      ].join('\n'),
    );
    return;
  }
  if (args.command === 'inspect-v2') {
    if (!args.dataset) throw new Error('--dataset is required for inspect-v2');
    console.log(await inspectDatasetV2(args.dataset));
    return;
  }
  throw new Error(usage());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
