import { readTerrainManifest, readTileIndexShard } from './reader.ts';

export async function inspectDataset(datasetDir: string): Promise<string> {
  const manifest = await readTerrainManifest(datasetDir);
  const rows: string[] = [];
  rows.push(`${manifest.datasetId}`);
  rows.push(
    `bounds: E ${manifest.bounds.eastMin}..${manifest.bounds.eastMax}, N ${manifest.bounds.northMin}..${manifest.bounds.northMax}`,
  );
  rows.push(`channels: ${manifest.channels.map((channel) => channel.id).join(', ')}`);

  let tileCount = 0;
  const channelBytes = new Map<string, number>();
  const channelValid = new Map<string, { readonly sum: number; readonly count: number }>();

  for (const shardHref of manifest.index.shards) {
    const shard = await readTileIndexShard(datasetDir, shardHref);
    tileCount += shard.tiles.length;
    for (const tile of shard.tiles) {
      for (const channel of Object.values(tile.channels)) {
        channelBytes.set(channel.channelId, (channelBytes.get(channel.channelId) ?? 0) + channel.bytes);
        const prev = channelValid.get(channel.channelId) ?? { sum: 0, count: 0 };
        channelValid.set(channel.channelId, {
          sum: prev.sum + channel.validPercent,
          count: prev.count + 1,
        });
      }
    }
  }

  rows.push(`tiles: ${tileCount}`);
  rows.push(`payload bytes: ${manifest.storage.totalPayloadBytes}`);
  for (const channel of manifest.channels) {
    const storage = manifest.storage.channels.find((entry) => entry.channelId === channel.id);
    const bytes = storage?.totalBytes ?? channelBytes.get(channel.id) ?? 0;
    const valid = channelValid.get(channel.id);
    const avgValid = valid ? valid.sum / Math.max(1, valid.count) : 0;
    const payloadCount = storage?.payloadCount ?? 0;
    const meanBytes = storage?.meanBytes ?? 0;
    rows.push(`${channel.id}: ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${payloadCount} payloads, mean ${meanBytes.toFixed(1)} B, avg valid ${avgValid.toFixed(2)}%`);
  }
  return rows.join('\n');
}
