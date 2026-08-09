/**
 * What channels a dataset URL offers, for the channel picker.
 *
 * A Zarr group does not list its children and a store served as static files
 * has no listing to ask for, so the channels come from the root group's
 * `psychogeo.channels`. The URL may address either the root or one channel
 * group inside it, and the picker wants to know both which channels exist and
 * which one the URL already names.
 */

export type StoreChannels = {
  readonly channels: readonly string[];
  /** Set when the URL addresses a channel group rather than the store root. */
  readonly addressed?: string;
};

const EMPTY: StoreChannels = { channels: [] };

function channelsOf(json: unknown): string[] | undefined {
  const attributes = (json as { attributes?: { psychogeo?: { channels?: unknown } } } | undefined)
    ?.attributes?.psychogeo?.channels;
  if (!Array.isArray(attributes)) return undefined;
  const names = attributes.filter((value): value is string => typeof value === 'string');
  return names.length > 0 ? names : undefined;
}

/**
 * Only meaningful for a zarr store; a v2 manifest tree has one channel and no
 * list, so this reports none and the picker stays out of the way.
 */
export async function resolveStoreChannels(
  datasetUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoreChannels> {
  if (!/\/zarr\.json$/.test(datasetUrl)) return EMPTY;
  const dir = datasetUrl.replace(/\/zarr\.json$/, '');

  const read = async (url: string): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${url}/zarr.json`);
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      return undefined;
    }
  };

  const here = channelsOf(await read(dir));
  if (here) return { channels: here };

  // Not the root, so try one level up and remember the segment walked past —
  // that is the channel this URL names.
  const parent = dir.replace(/\/[^/]+$/, '');
  if (!parent || parent === dir) return EMPTY;
  const above = channelsOf(await read(parent));
  if (!above) return EMPTY;
  const addressed = dir.slice(parent.length + 1);
  return above.includes(addressed) ? { channels: above, addressed } : { channels: above };
}
