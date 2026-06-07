import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DefraTileGroup } from '../scan.ts';
import {
  cellAllGroupsComplete,
  cellFullyComplete,
  countRemainingGroups,
  groupKey,
  readCompletedCells,
  readCompletedGroups,
  resumeStateForRegion,
  writeCompletedCells,
  writeCompletedGroups,
} from './resume.ts';

function group(tileRef: string, year = 2022): DefraTileGroup {
  return { tileRef, year, sources: {} };
}

describe('resume', () => {
  it('counts remaining groups and detects complete cells', () => {
    const groups = [group('SP51ne'), group('SP51nw'), group('SP51se'), group('SP51sw')];
    const completedKeys = new Set([groupKey('SP51ne', 2022), groupKey('SP51nw', 2022)]);

    expect(countRemainingGroups(groups, completedKeys)).toBe(2);
    expect(cellAllGroupsComplete(groups, completedKeys)).toBe(false);
    expect(cellFullyComplete('SP51', groups, completedKeys, new Set(), true)).toBe(false);
    expect(cellFullyComplete('SP51', groups, completedKeys, new Set(['SP51']), true)).toBe(false);

    const allKeys = new Set(groups.map((entry) => groupKey(entry.tileRef, entry.year)));
    expect(cellAllGroupsComplete(groups, allKeys)).toBe(true);
    expect(cellFullyComplete('SP51', groups, allKeys, new Set(['SP51']), true)).toBe(true);
    expect(cellFullyComplete('SP51', groups, allKeys, new Set(), false)).toBe(true);
    expect(cellFullyComplete('SP51', groups, allKeys, new Set(), true)).toBe(false);
  });

  it('summarises region resume state', () => {
    const regionGroups = [
      ...['SP51ne', 'SP51nw', 'SP51se', 'SP51sw'].map((tileRef) => group(tileRef)),
      ...['SP52ne', 'SP52nw', 'SP52se', 'SP52sw'].map((tileRef) => group(tileRef)),
    ];
    const groupsByCell = new Map<string, DefraTileGroup[]>([
      ['SP51', regionGroups.slice(0, 4)],
      ['SP52', regionGroups.slice(4, 8)],
    ]);
    const completedGroups = [
      { tileRef: 'SP51ne', year: 2022 },
      { tileRef: 'SP51nw', year: 2022 },
      { tileRef: 'SP51se', year: 2022 },
      { tileRef: 'SP51sw', year: 2022 },
    ];

    expect(
      resumeStateForRegion(
        regionGroups,
        ['SP51', 'SP52'],
        completedGroups,
        new Set(['SP51']),
        groupsByCell,
        true,
      ),
    ).toEqual({
      completedGroups: 4,
      completedCells: 1,
      remainingGroups: 4,
      remainingCells: 1,
    });
  });

  it('persists and reloads completed groups and cells from disk', async () => {
    const outDir = path.join('/tmp', `terracognita-resume-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    try {
      await writeCompletedGroups(outDir, [
        { tileRef: 'SU00ne', year: 2022 },
        { tileRef: 'SU00nw', year: 2022 },
      ]);
      await writeCompletedCells(outDir, ['SU00']);

      expect(await readCompletedGroups(outDir)).toEqual([
        { tileRef: 'SU00ne', year: 2022 },
        { tileRef: 'SU00nw', year: 2022 },
      ]);
      expect([...(await readCompletedCells(outDir))]).toEqual(['SU00']);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
