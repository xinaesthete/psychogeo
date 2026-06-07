import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readMetadata, readNodeManifest } from './layout.ts';
import { parseMetadataJson } from './schema.ts';

const METADATA_FILE = 'metadata.json';
const METRICS_FILE = 'index/ingest-metrics.json';

interface RegionSummaryCell {
  readonly cell: string;
  readonly indexRoot: string;
}

interface RegionSummaryFile {
  readonly regionLabel: string;
  readonly cells: readonly RegionSummaryCell[];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRegionSummary(outDir: string, relPath: string): Promise<RegionSummaryFile> {
  const content = await readFile(path.join(outDir, relPath), 'utf8');
  const parsed = JSON.parse(content) as RegionSummaryFile;
  if (!Array.isArray(parsed.cells)) {
    throw new Error('region summary cells must be an array');
  }
  return parsed;
}

export async function validateDatasetV2(outDir: string): Promise<string[]> {
  const errors: string[] = [];
  const metadataPath = path.join(outDir, METADATA_FILE);

  if (!(await pathExists(metadataPath))) {
    return ['missing metadata.json'];
  }

  let meta;
  try {
    meta = await readMetadata(outDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [`invalid metadata.json: ${message}`];
  }

  try {
    parseMetadataJson(meta);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`metadata.json failed schema validation: ${message}`);
  }

  if (meta.regionSummary) {
    const summaryRel = meta.regionSummary;
    const summaryPath = path.join(outDir, summaryRel);
    if (!(await pathExists(summaryPath))) {
      errors.push(`missing region summary at ${summaryRel}`);
    } else {
      try {
        const summary = await readRegionSummary(outDir, summaryRel);
        if (summary.cells.length === 0) {
          errors.push('region summary lists no cells');
        }
        for (const cell of summary.cells) {
          const indexPath = path.join(outDir, cell.indexRoot);
          if (!(await pathExists(indexPath))) {
            errors.push(`missing cell index root ${cell.indexRoot} (${cell.cell})`);
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`invalid region summary: ${message}`);
      }
    }
  } else {
    const indexPath = path.join(outDir, meta.indexRoot);
    if (!(await pathExists(indexPath))) {
      errors.push(`missing index root manifest at ${meta.indexRoot}`);
    } else {
      try {
        await readNodeManifest(outDir, meta.indexRoot);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`invalid index root manifest: ${message}`);
      }
    }
  }

  const metricsPath = path.join(outDir, METRICS_FILE);
  if (!(await pathExists(metricsPath))) {
    errors.push(`missing ${METRICS_FILE}`);
  }

  return errors;
}

export function assertDatasetValid(errors: readonly string[]): void {
  if (errors.length === 0) return;
  throw new Error(`dataset validation failed:\n${errors.map((entry) => `- ${entry}`).join('\n')}`);
}

export async function validateAndAssertDatasetV2(outDir: string): Promise<void> {
  assertDatasetValid(await validateDatasetV2(outDir));
}
