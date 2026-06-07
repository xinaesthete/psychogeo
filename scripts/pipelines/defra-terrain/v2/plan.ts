import { stat } from 'node:fs/promises';
import type { DefraTileGroup } from '../scan.ts';
import { scanDefraZips } from '../scan.ts';
import {
  formatBytes,
  formatDuration,
  ingestMetricsRates,
  readIngestMetrics,
  type IngestMetricsRates,
} from './metrics.ts';
import {
  discoverTenKmCells,
  filterGroupsByRegion,
  parseRegionArg,
  regionLabel,
  tenKmCellFromTileRef,
  type RegionSpec,
} from './region.ts';

export interface RegionCellPlan {
  readonly cell: string;
  readonly groupCount: number;
  readonly sourceZipBytes: number;
}

export interface RegionPlanEstimate {
  readonly elapsedMs: number;
  readonly outputBytes: number;
}

export interface RegionPlan {
  readonly region: RegionSpec;
  readonly regionLabel: string;
  readonly cellCount: number;
  readonly groupCount: number;
  readonly sourceZipBytes: number;
  readonly cells: readonly RegionCellPlan[];
  readonly estimate?: RegionPlanEstimate;
  readonly rates?: IngestMetricsRates;
}

async function sourceZipBytesForGroup(group: DefraTileGroup): Promise<number> {
  let total = 0;
  for (const source of Object.values(group.sources)) {
    if (!source) continue;
    const fileStat = await stat(source.zipPath);
    total += fileStat.size;
  }
  return total;
}

export async function planRegionIngest(options: {
  readonly inputDir: string;
  readonly region: RegionSpec;
  readonly baselineMetricsDir?: string;
}): Promise<RegionPlan> {
  const allGroups = await scanDefraZips(options.inputDir);
  const groups = filterGroupsByRegion(allGroups, options.region);
  const cells = discoverTenKmCells(allGroups, options.region);

  const byCell = new Map<string, DefraTileGroup[]>();
  for (const group of groups) {
    const cell = tenKmCellFromTileRef(group.tileRef);
    const existing = byCell.get(cell) ?? [];
    existing.push(group);
    byCell.set(cell, existing);
  }

  const cellPlans: RegionCellPlan[] = [];
  let sourceZipBytes = 0;
  for (const cell of cells) {
    const cellGroups = byCell.get(cell) ?? [];
    let cellSourceBytes = 0;
    for (const group of cellGroups) {
      cellSourceBytes += await sourceZipBytesForGroup(group);
    }
    sourceZipBytes += cellSourceBytes;
    cellPlans.push({
      cell,
      groupCount: cellGroups.length,
      sourceZipBytes: cellSourceBytes,
    });
  }

  const baseline = options.baselineMetricsDir
    ? await readIngestMetrics(options.baselineMetricsDir)
    : undefined;
  const rates = baseline ? ingestMetricsRates(baseline) : undefined;

  let estimate: RegionPlanEstimate | undefined;
  if (rates) {
    estimate = {
      elapsedMs: rates.msPerGroup * groups.length,
      outputBytes: rates.outputBytesPerGroup * groups.length,
    };
  }

  return {
    region: options.region,
    regionLabel: regionLabel(options.region),
    cellCount: cells.length,
    groupCount: groups.length,
    sourceZipBytes,
    cells: cellPlans,
    estimate,
    rates,
  };
}

export function formatRegionPlan(plan: RegionPlan): string {
  const lines = [
    `region: ${plan.regionLabel}`,
    `cells: ${plan.cellCount}, groups: ${plan.groupCount}`,
    `source zips: ${formatBytes(plan.sourceZipBytes)}`,
  ];
  if (plan.estimate && plan.rates) {
    lines.push(
      `estimate (from baseline rates): ${formatDuration(plan.estimate.elapsedMs)}, output ${formatBytes(plan.estimate.outputBytes)}`,
      `baseline rates: ${formatDuration(plan.rates.msPerGroup)}/group, ${formatBytes(plan.rates.outputBytesPerGroup)}/group output`,
    );
  }
  lines.push('', 'cells:');
  for (const cell of plan.cells) {
    lines.push(`  ${cell.cell}: ${cell.groupCount} groups, ${formatBytes(cell.sourceZipBytes)} source`);
  }
  return lines.join('\n');
}

export function parsePlanRegionArg(options: {
  readonly region?: string;
  readonly cell?: string;
  readonly bounds?: string;
}): RegionSpec {
  return parseRegionArg(options);
}
