import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestDefraTerrain } from './ingest.ts';

const sampleDir = '/Users/ptodd/data/GIS/DEFRA/test-tiles';
const shouldRunGolden = process.env.PSYCHOGEO_RUN_DEFRA_GOLDEN === '1';

async function samplesExist(): Promise<boolean> {
  try {
    await access(path.join(sampleDir, 'LIDAR-FZ_DSM-1m-2022-SP50ne.zip'));
    await access(path.join(sampleDir, 'LIDAR-LZ_DSM-1m-2022-SP50ne.zip'));
    return true;
  } catch {
    return false;
  }
}

describe('DEFRA golden ingest', () => {
  const goldenIt = shouldRunGolden ? it : it.skip;
  goldenIt('ingests the downloaded SP50 sample set into /private/tmp', async () => {
    expect(await samplesExist()).toBe(true);
    const outDir = path.join('/private/tmp', `psychogeo-defra-golden-${Date.now()}`);
    const result = await ingestDefraTerrain({
      inputDir: sampleDir,
      outDir,
      datasetId: 'defra-golden-test',
    });
    expect(result.tileCount).toBeGreaterThan(0);
    expect(result.channelCount).toBeGreaterThan(result.tileCount);
  }, 120_000);
});
