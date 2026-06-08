import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DefraTileGroup } from '../scan.ts';
import { readSkippedGroups, syncSkippedGroups, writeSkippedGroups } from './skippedGroups.ts';

function group(tileRef: string, withDsm: boolean): DefraTileGroup {
  return {
    tileRef,
    year: 2022,
    sources: withDsm
      ? {
          FZ: {
            product: 'FZ_DSM',
            returnKind: 'FZ',
            year: 2022,
            tileRef,
            zipPath: `/tmp/${tileRef}.zip`,
            zipBasename: `${tileRef}.zip`,
          },
        }
      : {
          DTM: {
            product: 'DTM',
            returnKind: 'DTM',
            year: 2022,
            tileRef,
            zipPath: `/tmp/${tileRef}-dtm.zip`,
            zipBasename: `${tileRef}-dtm.zip`,
          },
        },
  };
}

describe('skippedGroups', () => {
  it('records uningestable groups with reasons', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'defra-v2-skip-'));
    try {
      const skipped = await syncSkippedGroups(outDir, [group('SZ69se', false)]);
      expect(skipped).toEqual([
        { tileRef: 'SZ69se', year: 2022, reason: 'no DSM source (found DTM only)' },
      ]);
      expect(await readSkippedGroups(outDir)).toEqual(skipped);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('dedupes on resume', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'defra-v2-skip-'));
    try {
      await writeSkippedGroups(outDir, [
        { tileRef: 'SZ69se', year: 2022, reason: 'no DSM source (found DTM only)' },
      ]);
      const skipped = await syncSkippedGroups(outDir, [group('SZ69se', false)]);
      expect(skipped).toHaveLength(1);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
