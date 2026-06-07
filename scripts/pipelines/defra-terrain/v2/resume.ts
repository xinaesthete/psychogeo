import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DefraTileGroup } from '../scan.ts';
import { indexRootForCell, nodeManifestPath } from './derive.ts';
import { readNodeManifest } from './layout.ts';

export const COMPLETED_GROUPS_FILE = 'index/completed-groups.json';
export const COMPLETED_CELLS_FILE = 'index/completed-cells.json';

export interface CompletedGroupEntry {
  readonly tileRef: string;
  readonly year: number;
}

interface CompletedGroupsFile {
  readonly groups: CompletedGroupEntry[];
}

interface CompletedCellsFile {
  readonly cells: string[];
}

export function groupKey(tileRef: string, year: number): string {
  return `${year}:${tileRef}`;
}

export async function readCompletedGroups(outDir: string): Promise<CompletedGroupEntry[]> {
  try {
    const content = await readFile(path.join(outDir, COMPLETED_GROUPS_FILE), 'utf8');
    const parsed = JSON.parse(content) as CompletedGroupsFile;
    return parsed.groups;
  } catch {
    return [];
  }
}

export async function writeCompletedGroups(outDir: string, groups: CompletedGroupEntry[]): Promise<void> {
  const sorted = [...groups].sort((a, b) => {
    const tileOrder = a.tileRef.localeCompare(b.tileRef);
    return tileOrder !== 0 ? tileOrder : a.year - b.year;
  });
  await mkdir(path.join(outDir, 'index'), { recursive: true });
  await writeFile(
    path.join(outDir, COMPLETED_GROUPS_FILE),
    `${JSON.stringify({ groups: sorted }, null, 2)}\n`,
    'utf8',
  );
}

export async function readCompletedCells(outDir: string): Promise<Set<string>> {
  try {
    const content = await readFile(path.join(outDir, COMPLETED_CELLS_FILE), 'utf8');
    const parsed = JSON.parse(content) as CompletedCellsFile;
    return new Set(parsed.cells);
  } catch {
    return new Set();
  }
}

export async function writeCompletedCells(outDir: string, cells: Iterable<string>): Promise<void> {
  const sorted = [...new Set(cells)].sort((a, b) => a.localeCompare(b));
  await mkdir(path.join(outDir, 'index'), { recursive: true });
  await writeFile(
    path.join(outDir, COMPLETED_CELLS_FILE),
    `${JSON.stringify({ cells: sorted }, null, 2)}\n`,
    'utf8',
  );
}

export async function markCellCompleted(outDir: string, cell: string): Promise<void> {
  const cells = await readCompletedCells(outDir);
  cells.add(cell);
  await writeCompletedCells(outDir, cells);
}

export function countRemainingGroups(
  groups: readonly DefraTileGroup[],
  completedKeys: ReadonlySet<string>,
): number {
  return groups.filter((group) => !completedKeys.has(groupKey(group.tileRef, group.year))).length;
}

export function cellAllGroupsComplete(
  groups: readonly DefraTileGroup[],
  completedKeys: ReadonlySet<string>,
): boolean {
  if (groups.length === 0) return false;
  return groups.every((group) => completedKeys.has(groupKey(group.tileRef, group.year)));
}

export function cellFullyComplete(
  cell: string,
  groups: readonly DefraTileGroup[],
  completedKeys: ReadonlySet<string>,
  completedCells: ReadonlySet<string>,
  runMerge: boolean,
): boolean {
  if (!cellAllGroupsComplete(groups, completedKeys)) return false;
  if (runMerge) return completedCells.has(cell);
  return true;
}

export async function readCellIngestStats(
  outDir: string,
  ingestCell: string,
): Promise<{ readonly groupCount: number; readonly leafChunks: number } | undefined> {
  try {
    const parent = await readNodeManifest(outDir, indexRootForCell(ingestCell));
    const children = parent.children ?? [];
    let leafChunks = 0;
    for (const childRef of children) {
      const child = await readNodeManifest(outDir, nodeManifestPath(ingestCell, childRef));
      if (!child.leaf) continue;
      const missing = new Set(child.leaf.missing ?? []);
      const slotCount = child.leaf.cols * child.leaf.rows;
      leafChunks += slotCount - missing.size;
    }
    return { groupCount: children.length, leafChunks };
  } catch {
    return undefined;
  }
}

export interface ResumeState {
  readonly completedGroups: number;
  readonly completedCells: number;
  readonly remainingGroups: number;
  readonly remainingCells: number;
}

export function resumeStateForRegion(
  regionGroups: readonly DefraTileGroup[],
  cells: readonly string[],
  completedGroups: readonly CompletedGroupEntry[],
  completedCells: ReadonlySet<string>,
  groupsByCell: ReadonlyMap<string, DefraTileGroup[]>,
  runMerge: boolean,
): ResumeState {
  const completedKeys = new Set(completedGroups.map((entry) => groupKey(entry.tileRef, entry.year)));
  const remainingGroups = countRemainingGroups(regionGroups, completedKeys);
  let remainingCells = 0;
  for (const cell of cells) {
    const cellGroups = groupsByCell.get(cell) ?? [];
    if (!cellFullyComplete(cell, cellGroups, completedKeys, completedCells, runMerge)) {
      remainingCells += 1;
    }
  }
  return {
    completedGroups: completedGroups.length,
    completedCells: completedCells.size,
    remainingGroups,
    remainingCells,
  };
}
