#!/usr/bin/env node
import { inspectDataset } from './inspect.ts';
import {
  defaultTileConcurrency,
  ingestDefraTerrain,
  parseConcurrencyFlag,
  type IngestProgressEvent,
} from './ingest.ts';
import { scanDefraZips, summarizeScan } from './scan.ts';

const startTime = Date.now(); //Temporal.Now.instant();

interface CliArgs {
  readonly command: string;
  readonly input?: string;
  readonly out?: string;
  readonly dataset?: string;
  readonly datasetId?: string;
  readonly tileConcurrency?: string;
  readonly groupConcurrency?: string;
  readonly progress: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm pipeline:defra -- scan --input <dir>',
    '  pnpm pipeline:defra -- ingest --input <dir> --out <dataset-dir> [--dataset-id <id>]',
    '      [--tile-concurrency <n>] [--group-concurrency <n>] [--progress]',
    '  pnpm pipeline:defra -- inspect --dataset <dataset-dir>',
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
    tileConcurrency: values.get('tile-concurrency'),
    groupConcurrency: values.get('group-concurrency'),
    progress: flags.has('progress'),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
}

function formatProgress(event: IngestProgressEvent): string {
  // node24 doesn't have Temporal
  // const dt = Temporal.Now.instant().since(startTime);
  // const pre = `[defra] (${dt.minutes}:${dt.seconds})`
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
      return `${pre} tile ${event.tileIndex}/${event.tileCount}: ${event.tileId}, ${event.channels} channels, ${formatBytes(event.bytes)}`;
    case 'channel-failed':
      return `${pre} ${event.tileRef} ${event.tileId} ${event.channelId}: ${event.message}`;
    case 'tile-skip':
      return `${pre} skip tile ${event.tileRef} ${event.tileId}: ${event.message}`;
    case 'group-complete':
      return `${pre} complete ${event.tileRef}: ${event.tiles} tiles, ${event.channels} channels, ${formatBytes(event.bytes)}`;
    case 'complete':
      return `${pre} wrote ${event.tileCount} tiles, ${event.channelCount} channel payloads, ${event.shardCount} shards, ${formatBytes(event.totalPayloadBytes)} payload`;
  }
}

function progressLogger(enabled: boolean): ((event: IngestProgressEvent) => void) | undefined {
  if (!enabled) return undefined;
  return (event) => {
    console.error(formatProgress(event));
  };
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
  throw new Error(usage());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
