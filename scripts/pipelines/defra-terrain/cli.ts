#!/usr/bin/env node
import { inspectDataset } from './inspect.ts';
import { ingestDefraTerrain, type IngestProgressEvent } from './ingest.ts';
import { scanDefraZips, summarizeScan } from './scan.ts';

interface CliArgs {
  readonly command: string;
  readonly input?: string;
  readonly out?: string;
  readonly dataset?: string;
  readonly datasetId?: string;
  readonly progress: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm pipeline:defra -- scan --input <dir>',
    '  pnpm pipeline:defra -- ingest --input <dir> --out <dataset-dir> [--dataset-id <id>] [--progress]',
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
  switch (event.phase) {
    case 'scan':
      return `[defra] scanned ${event.groups} source groups`;
    case 'group-start':
      return `[defra] group ${event.groupIndex}/${event.groupCount}: ${event.tileRef} ${event.year}`;
    case 'tile':
      return `[defra] tile ${event.tileIndex}/${event.tileCount}: ${event.tileId}, ${event.channels} channels, ${formatBytes(event.bytes)}`;
    case 'group-complete':
      return `[defra] complete ${event.tileRef}: ${event.tiles} tiles, ${event.channels} channels, ${formatBytes(event.bytes)}`;
    case 'complete':
      return `[defra] wrote ${event.tileCount} tiles, ${event.channelCount} channel payloads, ${event.shardCount} shards, ${formatBytes(event.totalPayloadBytes)} payload`;
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
    const result = await ingestDefraTerrain({
      inputDir: args.input,
      outDir: args.out,
      datasetId: args.datasetId,
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
