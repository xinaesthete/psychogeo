import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { skipReasonForGroup, type DefraTileGroup } from '../scan.ts';
import { normalizeGridRef } from './osgb.ts';
import { groupKey } from './resume.ts';
import type { SkippedGroupEntry } from './types.ts';

export const SKIPPED_GROUPS_FILE = 'index/skipped-groups.json';

interface SkippedGroupsFile {
  readonly groups: SkippedGroupEntry[];
}

export async function readSkippedGroups(outDir: string): Promise<SkippedGroupEntry[]> {
  try {
    const content = await readFile(path.join(outDir, SKIPPED_GROUPS_FILE), 'utf8');
    const parsed = JSON.parse(content) as SkippedGroupsFile;
    return parsed.groups ?? [];
  } catch {
    return [];
  }
}

export async function writeSkippedGroups(outDir: string, groups: readonly SkippedGroupEntry[]): Promise<void> {
  const sorted = [...groups].sort((a, b) => {
    const tileOrder = a.tileRef.localeCompare(b.tileRef);
    return tileOrder !== 0 ? tileOrder : a.year - b.year;
  });
  await mkdir(path.join(outDir, 'index'), { recursive: true });
  await writeFile(
    path.join(outDir, SKIPPED_GROUPS_FILE),
    `${JSON.stringify({ groups: sorted }, null, 2)}\n`,
    'utf8',
  );
}

/** Record newly discovered uningestable groups; returns the full skip list. */
export async function syncSkippedGroups(
  outDir: string,
  candidates: readonly DefraTileGroup[],
  onSkip?: (entry: SkippedGroupEntry) => void,
): Promise<SkippedGroupEntry[]> {
  let skipped = await readSkippedGroups(outDir);
  const known = new Set(skipped.map((entry) => groupKey(entry.tileRef, entry.year)));
  let changed = false;

  for (const group of candidates) {
    const reason = skipReasonForGroup(group);
    if (!reason) continue;
    const tileRef = normalizeGridRef(group.tileRef);
    const key = groupKey(tileRef, group.year);
    if (known.has(key)) continue;
    const entry: SkippedGroupEntry = { tileRef, year: group.year, reason };
    skipped = [...skipped, entry];
    known.add(key);
    changed = true;
    onSkip?.(entry);
  }

  if (changed) await writeSkippedGroups(outDir, skipped);
  return skipped;
}
