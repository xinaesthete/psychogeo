import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeManifest, makeShard } from './manifest.ts';
import { resolveTerrainTile } from './reader.ts';
import type { TileRecord } from './types.ts';

describe('terrain manifest reader', () => {
  it('resolves a channel by OSGB coordinate', async () => {
    const root = path.join('/private/tmp', `psychogeo-reader-${Date.now()}`);
    await mkdir(path.join(root, 'index'), { recursive: true });
    const tile: TileRecord = {
      tileId: '455000_205000',
      sourceTileRef: 'SP50ne',
      extent: { eastMin: 455000, eastMax: 456000, northMin: 205000, northMax: 206000 },
      nominalExtent: { eastMin: 455000, eastMax: 456000, northMin: 205000, northMax: 206000 },
      provenance: [],
      channels: {
        'height.dsm.fz': {
          channelId: 'height.dsm.fz',
          href: 'tiles/455000_205000/height.dsm.fz.0.j2c',
          width: 1000,
          height: 1000,
          resolutionMetres: 1,
          apronMetres: 16,
          extent: { eastMin: 455000, eastMax: 456000, northMin: 205000, northMax: 206000 },
          nominalExtent: { eastMin: 455000, eastMax: 456000, northMin: 205000, northMax: 206000 },
          encoding: {
            kind: 'uint16-normalized',
            units: 'metre',
            nodataCode: 0,
            min: 1,
            max: 10,
            offset: 0,
            scale: 1,
          },
          bytes: 100,
          validPercent: 100,
          rmseMetres: 0,
          meanAbsMetres: 0,
          maxAbsMetres: 0,
          sourceReturnKind: 'FZ',
        },
      },
    };
    const shard = makeShard('test', '455000_205000', [tile]);
    await writeFile(path.join(root, 'index/455000_205000.json'), `${JSON.stringify(shard)}\n`);
    await writeFile(
      path.join(root, 'manifest.json'),
      `${JSON.stringify(makeManifest('test', shard.extent, ['index/455000_205000.json'], '2026-06-01T00:00:00.000Z'))}\n`,
    );

    const resolved = await resolveTerrainTile(root, 455500, 205500, 'height.dsm.fz');
    expect(resolved?.channel.href).toBe('tiles/455000_205000/height.dsm.fz.0.j2c');
  });
});
