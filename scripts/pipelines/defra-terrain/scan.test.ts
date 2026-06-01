import { describe, expect, it } from 'vitest';
import { parseDefraZipName, summarizeScan } from './scan.ts';

describe('DEFRA ZIP scan parsing', () => {
  it('parses FZ, LZ and DTM source filenames', () => {
    expect(parseDefraZipName('/data/LIDAR-FZ_DSM-1m-2022-SP50ne.zip')).toMatchObject({
      returnKind: 'FZ',
      product: 'FZ_DSM',
      year: 2022,
      tileRef: 'SP50ne',
    });
    expect(parseDefraZipName('/data/LIDAR-LZ_DSM-1m-2022-SP50nw.zip')).toMatchObject({
      returnKind: 'LZ',
      product: 'LZ_DSM',
      tileRef: 'SP50nw',
    });
    expect(parseDefraZipName('/data/LIDAR-DTM-1m-2022-SP50sw.zip')).toMatchObject({
      returnKind: 'DTM',
      product: 'DTM',
      tileRef: 'SP50sw',
    });
  });

  it('summarises grouped sources deterministically', () => {
    expect(
      summarizeScan([
        {
          tileRef: 'SP50ne',
          year: 2022,
          sources: {
            FZ: {
              product: 'FZ_DSM',
              returnKind: 'FZ',
              year: 2022,
              tileRef: 'SP50ne',
              zipPath: '/x/fz.zip',
              zipBasename: 'fz.zip',
            },
            LZ: {
              product: 'LZ_DSM',
              returnKind: 'LZ',
              year: 2022,
              tileRef: 'SP50ne',
              zipPath: '/x/lz.zip',
              zipBasename: 'lz.zip',
            },
          },
        },
      ]),
    ).toBe('SP50ne 2022: FZ,LZ');
  });
});
