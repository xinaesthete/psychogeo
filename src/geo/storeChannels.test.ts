import { describe, expect, it, vi } from 'vitest';
import { resolveStoreChannels } from './storeChannels';

const STORE = 'https://example.test/terra.zarr';
const CHANNELS = ['height.dsm.fz', 'height.dsm.lz'];

function serve(map: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const body = map[String(input)];
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

const root = { attributes: { psychogeo: { channels: CHANNELS } } };
const channelGroup = { attributes: { multiscales: [{ datasets: [{ path: '0' }] }] } };

describe('resolveStoreChannels', () => {
  it('lists the channels a store root declares', async () => {
    const fetchImpl = serve({ [`${STORE}/zarr.json`]: root });
    expect(await resolveStoreChannels(`${STORE}/zarr.json`, fetchImpl)).toEqual({ channels: CHANNELS });
  });

  it('walks up from a channel group and reports which one the URL names', async () => {
    // So the picker opens showing the channel already being viewed rather than
    // silently disagreeing with the URL.
    const fetchImpl = serve({
      [`${STORE}/zarr.json`]: root,
      [`${STORE}/height.dsm.lz/zarr.json`]: channelGroup,
    });
    expect(await resolveStoreChannels(`${STORE}/height.dsm.lz/zarr.json`, fetchImpl)).toEqual({
      channels: CHANNELS,
      addressed: 'height.dsm.lz',
    });
  });

  it('lists the channels but names none when the segment is not one', async () => {
    const fetchImpl = serve({
      [`${STORE}/zarr.json`]: root,
      [`${STORE}/nonsense/zarr.json`]: channelGroup,
    });
    expect(await resolveStoreChannels(`${STORE}/nonsense/zarr.json`, fetchImpl)).toEqual({
      channels: CHANNELS,
    });
  });

  it('reports none for a v2 manifest tree, so the picker stays out of the way', async () => {
    const fetchImpl = serve({});
    expect(await resolveStoreChannels('https://example.test/dataset/metadata.json', fetchImpl))
      .toEqual({ channels: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports none rather than throwing when the store cannot be read', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await resolveStoreChannels(`${STORE}/zarr.json`, fetchImpl)).toEqual({ channels: [] });
  });
});
