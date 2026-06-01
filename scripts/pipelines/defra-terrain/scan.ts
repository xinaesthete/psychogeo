import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DefraReturnKind, SourceProvenance } from './types.ts';

export interface DefraZipSource extends SourceProvenance {
  readonly zipBasename: string;
}

export interface DefraTileGroup {
  readonly tileRef: string;
  readonly year: number;
  readonly sources: Partial<Record<DefraReturnKind, DefraZipSource>>;
}

const ZIP_PATTERN =
  /^LIDAR-(?:(FZ|LZ)_DSM|DTM)-1m-(\d{4})-([A-Z]{2}\d{2}(?:ne|nw|se|sw))\.zip$/i;

export function parseDefraZipName(zipPath: string): DefraZipSource | null {
  const zipBasename = path.basename(zipPath);
  const match = ZIP_PATTERN.exec(zipBasename);
  if (!match) return null;

  const rawReturnKind = match[1];
  const returnKind: DefraReturnKind =
    rawReturnKind === undefined ? 'DTM' : rawReturnKind.toUpperCase() === 'FZ' ? 'FZ' : 'LZ';
  const year = Number.parseInt(match[2], 10);
  const tileRef = match[3];
  const product = returnKind === 'DTM' ? 'DTM' : `${returnKind}_DSM`;

  return {
    product,
    returnKind,
    year,
    tileRef,
    zipPath,
    zipBasename,
  };
}

export async function scanDefraZips(inputDir: string): Promise<DefraTileGroup[]> {
  const dirEntries = await readdir(inputDir, { withFileTypes: true });
  const groups = new Map<string, DefraTileGroup>();

  for (const entry of dirEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    const source = parseDefraZipName(path.join(inputDir, entry.name));
    if (!source) continue;
    const key = `${source.year}:${source.tileRef}`;
    const existing = groups.get(key);
    const sources: Partial<Record<DefraReturnKind, DefraZipSource>> = {
      ...(existing?.sources ?? {}),
      [source.returnKind]: source,
    };
    groups.set(key, {
      tileRef: source.tileRef,
      year: source.year,
      sources,
    });
  }

  return Array.from(groups.values()).sort((a, b) => {
    const tileOrder = a.tileRef.localeCompare(b.tileRef);
    return tileOrder !== 0 ? tileOrder : a.year - b.year;
  });
}

export function summarizeScan(groups: DefraTileGroup[]): string {
  const kinds: DefraReturnKind[] = ['FZ', 'LZ', 'DTM'];
  const rows = groups.map((group) => {
    const present = kinds
      .filter((kind) => group.sources[kind] !== undefined)
      .join(',');
    return `${group.tileRef} ${group.year}: ${present || 'no recognised products'}`;
  });
  return rows.join('\n');
}
