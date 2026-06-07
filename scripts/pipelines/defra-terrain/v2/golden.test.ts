import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestDefraTerrainV2 } from './ingest.ts';
import { verifyDerivedPaths } from './inspect.ts';
import { resolveChunksInBounds } from './reader.ts';

const sampleDir = '/Users/ptodd/data/GIS/DEFRA/test-tiles';
const shouldRunGolden =
  process.env.TERRACOGNITA_RUN_DEFRA_GOLDEN === '1' ||
  process.env.PSYCHOGEO_RUN_DEFRA_GOLDEN === '1';

async function samplesExist(): Promise<boolean> {
  try {
    await access(path.join(sampleDir, 'LIDAR-FZ_DSM-1m-2022-SP50ne.zip'));
    return true;
  } catch {
    return false;
  }
}

describe('DEFRA v2 golden ingest', () => {
  const goldenIt = shouldRunGolden ? it : it.skip;
  goldenIt('ingests SP50 into tc-dsm-pyramid layout', async () => {
    expect(await samplesExist()).toBe(true);
    const outDir = path.join('/private/tmp', `terracognita-v2-golden-${Date.now()}`);
    const result = await ingestDefraTerrainV2({
      inputDir: sampleDir,
      outDir,
      region: { kind: 'grid-ref', gridRef: 'SP50' },
      datasetId: 'defra-v2-golden-test',
    });
    expect(result.leafChunkCount).toBe(100);
    expect(result.groupCount).toBe(4);
    expect(await verifyDerivedPaths(outDir)).toEqual([]);
    const chunks = await resolveChunksInBounds(
      outDir,
      { eastMin: 455100, eastMax: 455900, northMin: 205100, northMax: 205900 },
      0,
    );
    expect(chunks.length).toBeGreaterThan(0);
  }, 180_000);
});
