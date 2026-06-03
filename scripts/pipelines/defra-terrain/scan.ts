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

const LEGACY_ZIP_PATTERN = /^LIDAR-(?:(FZ|LZ)_DSM|DTM)-1m-(\d{4})-([A-Z]{2}\d{2}(?:ne|nw|se|sw))\.zip$/i;
const NLP_ZIP_PATTERN =
  /^National-LIDAR-Programme-(DSM|DTM)-(\d{4})-([A-Z]{2}\d{2}(?:ne|nw|se|sw))\.zip$/i;

export function parseDefraZipName(zipPath: string): DefraZipSource | null {
  const zipBasename = path.basename(zipPath);
  const legacyMatch = LEGACY_ZIP_PATTERN.exec(zipBasename);
  const nlpMatch = NLP_ZIP_PATTERN.exec(zipBasename);
  if (!legacyMatch && !nlpMatch) return null;

  let returnKind: DefraReturnKind;
  let year: number;
  let tileRef: string;
  let product: string;

  if (legacyMatch) {
    const rawReturnKind = legacyMatch[1];
    returnKind = rawReturnKind === undefined ? 'DTM' : rawReturnKind.toUpperCase() === 'FZ' ? 'FZ' : 'LZ';
    year = Number.parseInt(legacyMatch[2], 10);
    tileRef = legacyMatch[3];
    product = returnKind === 'DTM' ? 'DTM' : `${returnKind}_DSM`;
  } else if (nlpMatch) {
    const rawProduct = nlpMatch[1].toUpperCase();
    // National LIDAR Programme files expose a single DSM channel; ingest it as the main DSM input.
    // actually this is very much subject to review and there will be different shapes
    // we shouldn't really be referring to DSM as "FZ" and the regex pattern logic is not what we'll want later
    // also todo zod schema
    returnKind = rawProduct === 'DTM' ? 'DTM' : 'FZ';
    year = Number.parseInt(nlpMatch[2], 10);
    tileRef = nlpMatch[3];
    product = rawProduct;
  } else {
    return null;
  }

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
    if (entry.name.startsWith('._')) continue;
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
