import { describe, expect, it } from 'vitest';
import { makeManifest, makeShard, summarizeStorage } from './manifest.ts';
import type { ChannelTileRecord, TileRecord } from './types.ts';

function channel(channelId: ChannelTileRecord['channelId'], bytes: number): ChannelTileRecord {
  return {
    channelId,
    href: `tiles/example/${channelId}.j2c`,
    width: 10,
    height: 10,
    resolutionMetres: 1,
    apronMetres: 0,
    extent: { eastMin: 0, eastMax: 10, northMin: 0, northMax: 10 },
    nominalExtent: { eastMin: 0, eastMax: 10, northMin: 0, northMax: 10 },
    encoding: {
      kind: 'uint16-normalized',
      units: 'metre',
      nodataCode: 0,
      min: 1,
      max: 2,
      offset: 1,
      scale: 1 / 65534,
    },
    bytes,
    validPercent: 100,
    rmseMetres: 0,
    meanAbsMetres: 0,
    maxAbsMetres: 0,
  };
}

describe('terrain manifest storage stats', () => {
  it('summarises payload sizes by channel and embeds them in the manifest', () => {
    const tile: TileRecord = {
      tileId: '0_0',
      sourceTileRef: 'AA00ne',
      extent: { eastMin: 0, eastMax: 10, northMin: 0, northMax: 10 },
      nominalExtent: { eastMin: 0, eastMax: 10, northMin: 0, northMax: 10 },
      provenance: [],
      channels: {
        'height.dsm.fz': channel('height.dsm.fz', 100),
        'height.dsm.lz': channel('height.dsm.lz', 200),
      },
    };
    const shard = makeShard('dataset', '0_0', [tile]);
    const storage = summarizeStorage([shard]);
    const manifest = makeManifest(
      'dataset',
      shard.extent,
      ['index/0_0.json'],
      storage,
      '2026-06-01T00:00:00.000Z',
    );

    expect(manifest.storage.totalPayloadBytes).toBe(300);
    expect(manifest.storage.channelPayloadCount).toBe(2);
    expect(manifest.storage.channels.find((entry) => entry.channelId === 'height.dsm.fz')).toMatchObject({
      payloadCount: 1,
      totalBytes: 100,
      minBytes: 100,
      maxBytes: 100,
      meanBytes: 100,
    });
    expect(manifest.storage.channels.find((entry) => entry.channelId === 'height.dtm')).toMatchObject({
      payloadCount: 0,
      totalBytes: 0,
    });
  });
});
