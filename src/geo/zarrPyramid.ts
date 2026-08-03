import * as THREE from 'three';
import type { ChunkFetchDescriptor, EncodingScalars, TerrainManifestV2 } from './pyramidTypes';

type TileExtent = {
  readonly eastMin: number;
  readonly eastMax: number;
  readonly northMin: number;
  readonly northMax: number;
};

/**
 * Reader for the renormalised zarr store (see docs/planning/zarr-transcode.md).
 *
 * Deliberately shaped like `PyramidCatalogResolver` so `PyramidTileTree` does
 * not have to know which kind of dataset it is drawing — the tree only uses
 * `catalogRef.meta`, `clearCache()` and `resolveChunksInBoundsAdaptive()`.
 *
 * Two things differ from the v2 manifest tree, and both simplify:
 * every chunk shares one scale/offset from the array attributes, and the chunk
 * that covers a point is arithmetic rather than a manifest descent.
 */

const NORTH_ORIGIN = 1_300_000;
const EAST_ORIGIN = 0;
const SHARD_INDEX_ENTRY_BYTES = 16;
const CRC32C_BYTES = 4;
const EMPTY_SLOT = 0xffffffffffffffffn;
/** Refine while the chunk is nearer than this many chunk-widths (see shouldRefine). */
const REFINE_DISTANCE_FACTOR = 2;

type ZarrArrayMeta = {
  readonly shape: readonly number[];
  readonly chunkShape: readonly number[];
  readonly innerChunkShape: readonly number[] | null;
  readonly attributes: Record<string, unknown>;
};

export type ZarrLevel = {
  readonly level: number;
  readonly resolutionMetres: number;
  readonly chunkMetres: number;
  readonly chunkPixels: number;
  /** [y, x] chunk counts. */
  readonly chunkGrid: readonly [number, number];
  /** Inner chunks per shard, [y, x]; null when the level is not sharded. */
  readonly shardChunks: readonly [number, number] | null;
  readonly baseUrl: string;
};

type ShardIndex = Array<{ offset: number; length: number } | null>;

function joinUrl(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/, ''), ...parts].join('/');
}

/**
 * Byte range as a URL fragment.
 *
 * A fragment never reaches the server, so this rides along every URL-keyed
 * path already in the app — the texture cache, the tree's per-URL dedup, the
 * inspector labels — and gives each chunk a distinct key even though many of
 * them live in one shard. The loader turns it into a `Range` header.
 */
export function withByteRange(url: string, offset: number, length: number): string {
  return `${url}#bytes=${offset}-${offset + length - 1}`;
}

export function parseByteRange(url: string): { url: string; range?: { start: number; end: number } } {
  const hash = url.indexOf('#bytes=');
  if (hash < 0) return { url };
  const [start, end] = url.slice(hash + 7).split('-').map(Number);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { url: url.slice(0, hash) };
  return { url: url.slice(0, hash), range: { start, end } };
}

async function fetchJson(url: string): Promise<unknown | undefined> {
  const response = await fetch(url);
  if (!response.ok) return undefined;
  return response.json();
}

function parseArrayMeta(raw: unknown): ZarrArrayMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const node = raw as Record<string, unknown>;
  if (node.node_type !== 'array') return undefined;
  const shape = node.shape as number[] | undefined;
  const grid = node.chunk_grid as { configuration?: { chunk_shape?: number[] } } | undefined;
  const chunkShape = grid?.configuration?.chunk_shape;
  if (!shape || !chunkShape) return undefined;
  const codecs = (node.codecs ?? []) as Array<{ name?: string; configuration?: { chunk_shape?: number[] } }>;
  const sharding = codecs.find((codec) => codec.name === 'sharding_indexed');
  return {
    shape,
    chunkShape,
    innerChunkShape: sharding?.configuration?.chunk_shape ?? null,
    attributes: (node.attributes ?? {}) as Record<string, unknown>,
  };
}

export class ZarrPyramidResolver {
  private readonly shardIndices = new Map<string, Promise<ShardIndex | undefined>>();
  private readonly presence = new Map<string, Promise<boolean>>();
  private readonly meta: TerrainManifestV2;

  private constructor(
    readonly storeUrl: string,
    readonly channelId: string,
    /** Every channel the store declares, so a caller can offer the others. */
    readonly availableChannels: readonly string[],
    readonly levels: readonly ZarrLevel[],
    readonly encoding: EncodingScalars,
  ) {
    this.meta = {
      // Enough of the v2 shape for the parts of the tree that read it — the
      // level ladder. Everything else it used to need is now arithmetic.
      schemaVersion: 'psychogeo.terrain.v2',
      format: 'tc-dsm-pyramid',
      datasetId: `${channelId}@zarr`,
      channelId,
      ingestCell: 'zarr',
      crs: { horizontal: 'EPSG:27700', verticalDatum: 'ODN' },
      spatialIndex: { scheme: 'osgb-national-grid', tiers: [] },
      naming: {
        nodeDir: '', nodeManifest: '', mergedChunk: '', leafChunk: '', leafChunkId: '',
      },
      tileMatrixSet: {
        levels: levels.map((entry) => ({
          level: entry.level,
          resolutionMetres: entry.resolutionMetres,
          tierMetres: entry.chunkMetres,
        })),
      },
      encoding: { codec: 'htj2k', sampleType: 'uint16', normalisation: 'globalScaleOffset', nodata: 0 },
      indexRoot: '',
    } as unknown as TerrainManifestV2;
  }

  /**
   * Open a store, or one channel of it.
   *
   * `storeUrl` may address the store root or a channel group directly, which
   * is what lets the dataset URL control select a channel with no new syntax:
   * a group carrying `multiscales` *is* a channel, and anything else is a root
   * that names its channels. Nothing here guesses a channel name — a guess
   * looks exactly like working code until a second channel exists.
   */
  static async load(
    storeUrl: string,
    requestedChannel?: string,
  ): Promise<ZarrPyramidResolver | undefined> {
    const root = await fetchJson(joinUrl(storeUrl, 'zarr.json'));
    if (!root || typeof root !== 'object') return undefined;
    const rootNode = root as Record<string, unknown>;
    if (rootNode.node_type !== 'group') return undefined;
    const rootAttrs = (rootNode.attributes ?? {}) as Record<string, unknown>;
    const rootPsychogeo = (rootAttrs.psychogeo ?? {}) as Record<string, unknown>;

    let channelUrl: string;
    let channelRaw: Record<string, unknown>;
    let channels: string[];
    if (rootAttrs.multiscales !== undefined) {
      // Already a channel group. Its own name is the last path segment unless
      // it records one.
      channelUrl = storeUrl;
      channelRaw = rootNode;
      channels = [
        (rootPsychogeo.channelId as string | undefined) ??
          storeUrl.replace(/\/+$/, '').split('/').pop() ??
          '',
      ];
      if (requestedChannel !== undefined && requestedChannel !== channels[0]) return undefined;
    } else {
      const declared = rootPsychogeo.channels;
      channels = Array.isArray(declared)
        ? declared.filter((entry): entry is string => typeof entry === 'string')
        : [];
      if (channels.length === 0) return undefined;
      const wanted = requestedChannel ?? channels[0];
      if (!channels.includes(wanted)) return undefined;
      channelUrl = joinUrl(storeUrl, wanted);
      const raw = (await fetchJson(joinUrl(channelUrl, 'zarr.json'))) as
        | Record<string, unknown>
        | undefined;
      if (!raw) return undefined;
      channelRaw = raw;
    }
    const channelAttrs = (channelRaw.attributes ?? {}) as Record<string, unknown>;
    const psychogeo = (channelAttrs.psychogeo ?? {}) as Record<string, unknown>;
    const channelId =
      (psychogeo.channelId as string | undefined) ?? requestedChannel ?? channels[0];
    const channelEncoding = (psychogeo.encoding ?? {}) as Record<string, unknown>;
    if (
      channelEncoding.normalisation !== undefined &&
      channelEncoding.normalisation !== 'globalScaleOffset'
    ) {
      // The repacked store keeps per-chunk scalars in companion arrays; this
      // reader only understands the renormalised one.
      return undefined;
    }

    const multiscales = channelAttrs.multiscales as Array<{ datasets?: Array<{ path?: string }> }> | undefined;
    const paths = multiscales?.[0]?.datasets?.map((entry) => entry.path).filter(Boolean) as string[] | undefined;
    if (!paths || paths.length === 0) return undefined;

    // One round trip for the whole ladder, not one per level. The levels are
    // independent and the store is remote: awaiting them in sequence made
    // opening a store cost a round trip per level before any chunk was asked
    // for, which is most of the wait on a high-latency origin.
    const fetched = await Promise.all(
      paths.map(async (levelPath) => {
        const baseUrl = joinUrl(channelUrl, levelPath);
        return {
          levelPath,
          baseUrl,
          arrayMeta: parseArrayMeta(await fetchJson(joinUrl(baseUrl, 'zarr.json'))),
        };
      }),
    );

    const levels: ZarrLevel[] = [];
    for (const { levelPath, baseUrl, arrayMeta } of fetched) {
      if (!arrayMeta) continue;
      const attrs = (arrayMeta.attributes.psychogeo ?? {}) as Record<string, number>;
      const chunkPixels = (arrayMeta.innerChunkShape ?? arrayMeta.chunkShape)[0];
      const shardChunks = arrayMeta.innerChunkShape
        ? ([
            arrayMeta.chunkShape[0] / arrayMeta.innerChunkShape[0],
            arrayMeta.chunkShape[1] / arrayMeta.innerChunkShape[1],
          ] as [number, number])
        : null;
      levels.push({
        level: attrs.level ?? Number(levelPath),
        resolutionMetres: attrs.resolutionMetres,
        chunkMetres: attrs.chunkMetres,
        chunkPixels,
        chunkGrid: [
          Math.round(arrayMeta.shape[0] / chunkPixels),
          Math.round(arrayMeta.shape[1] / chunkPixels),
        ],
        shardChunks,
        baseUrl,
      });
    }
    if (levels.length === 0) return undefined;

    const scale = channelEncoding.scale as number;
    const offset = channelEncoding.offset as number;
    if (!Number.isFinite(scale) || !Number.isFinite(offset)) return undefined;

    return new ZarrPyramidResolver(storeUrl, channelId, channels, levels, {
      scale,
      offset,
      min: offset + scale,
      max: offset + scale * 65535,
    } as EncodingScalars);
  }

  get catalogRef(): { meta: TerrainManifestV2 } {
    return { meta: this.meta };
  }

  clearCache(): void {
    this.shardIndices.clear();
    this.presence.clear();
  }

  private levelFor(viewportMetres: number): ZarrLevel {
    // Coarsest level whose chunk still spans less ground than the viewport;
    // one chunk is 1000 px, so this keeps roughly a pixel per screen pixel.
    const ordered = [...this.levels].sort((a, b) => b.level - a.level);
    for (const level of ordered) {
      if (level.level > 0 && viewportMetres >= level.chunkMetres) return level;
    }
    return this.levels[0];
  }

  /**
   * Refine while a chunk would cover more than roughly the whole viewport.
   *
   * A chunk is 1000 px however coarse it is, so the useful test is angular:
   * at distance d a chunk of side S subtends about S/d, and the projection
   * turns that into ~S/d * focalPx pixels. Refining at S/d > 1 keeps chunks
   * near their native resolution and lets distant ground stay coarse, which is
   * what a viewport-wide level choice cannot do on an oblique view — there the
   * ground footprint runs to the horizon and drags everything to the coarsest
   * level.
   */
  private shouldRefine(level: ZarrLevel, coord: readonly [number, number], camera: THREE.Vector3): boolean {
    const eastMin = EAST_ORIGIN + coord[1] * level.chunkMetres;
    const northMin = NORTH_ORIGIN - (coord[0] + 1) * level.chunkMetres;
    // Distance to the nearest point of the chunk, not its centre: a chunk the
    // camera sits on top of must refine however far its centre is.
    const dx = Math.max(eastMin - camera.x, 0, camera.x - (eastMin + level.chunkMetres));
    const dy = Math.max(northMin - camera.y, 0, camera.y - (northMin + level.chunkMetres));
    const distance = Math.sqrt(dx * dx + dy * dy + camera.z * camera.z);
    return distance < level.chunkMetres * REFINE_DISTANCE_FACTOR;
  }

  private chunkRangeFor(level: ZarrLevel, bounds: TileExtent) {
    return {
      xStart: Math.max(0, Math.floor((bounds.eastMin - EAST_ORIGIN) / level.chunkMetres)),
      xEnd: Math.min(level.chunkGrid[1] - 1, Math.floor((bounds.eastMax - EAST_ORIGIN) / level.chunkMetres)),
      yStart: Math.max(0, Math.floor((NORTH_ORIGIN - bounds.northMax) / level.chunkMetres)),
      yEnd: Math.min(level.chunkGrid[0] - 1, Math.floor((NORTH_ORIGIN - bounds.northMin) / level.chunkMetres)),
    };
  }

  /**
   * Emit this chunk, or its four-by-four children if the camera is close
   * enough to want them. Refining replaces the coarse chunk outright rather
   * than drawing under it — children that hold no data leave a hole, which is
   * correct for a sparse pyramid and avoids two levels fighting for the same
   * ground.
   */
  private async descend(
    level: ZarrLevel,
    coord: readonly [number, number],
    bounds: TileExtent,
    camera: THREE.Vector3,
    out: ChunkFetchDescriptor[],
  ): Promise<void> {
    const finer = this.levels.find((entry) => entry.level === level.level - 1);
    if (finer && this.shouldRefine(level, coord, camera)) {
      const factor = Math.round(level.chunkMetres / finer.chunkMetres);
      const children: Array<readonly [number, number]> = [];
      const range = this.chunkRangeFor(finer, bounds);
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const child: readonly [number, number] = [coord[0] * factor + dy, coord[1] * factor + dx];
          if (child[0] < range.yStart || child[0] > range.yEnd) continue;
          if (child[1] < range.xStart || child[1] > range.xEnd) continue;
          children.push(child);
        }
      }
      await Promise.all(children.map((child) => this.descend(finer, child, bounds, camera, out)));
      return;
    }
    const descriptor = await this.descriptorFor(level, coord);
    if (descriptor) out.push(descriptor);
  }

  private async shardIndex(level: ZarrLevel, shard: readonly [number, number]): Promise<ShardIndex | undefined> {
    if (!level.shardChunks) return undefined;
    const url = joinUrl(level.baseUrl, 'c', String(shard[0]), String(shard[1]));
    const cached = this.shardIndices.get(url);
    if (cached) return cached;
    const slots = level.shardChunks[0] * level.shardChunks[1];
    const indexBytes = slots * SHARD_INDEX_ENTRY_BYTES + CRC32C_BYTES;
    const request = (async (): Promise<ShardIndex | undefined> => {
      // Suffix range: the index lives at the end of the shard, which is what
      // lets a cold reader find one chunk in two requests.
      const response = await fetch(url, { headers: { Range: `bytes=-${indexBytes}` } });
      if (!response.ok) return undefined;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < indexBytes) return undefined;
      const view = new DataView(buffer, buffer.byteLength - indexBytes);
      const entries: ShardIndex = [];
      for (let slot = 0; slot < slots; slot += 1) {
        const offset = view.getBigUint64(slot * SHARD_INDEX_ENTRY_BYTES, true);
        const length = view.getBigUint64(slot * SHARD_INDEX_ENTRY_BYTES + 8, true);
        entries.push(offset === EMPTY_SLOT ? null : { offset: Number(offset), length: Number(length) });
      }
      return entries;
    })();
    this.shardIndices.set(url, request);
    return request;
  }

  private chunkExists(url: string): Promise<boolean> {
    const cached = this.presence.get(url);
    if (cached) return cached;
    const probe = fetch(url, { method: 'HEAD' }).then(
      (response) => response.ok,
      () => false,
    );
    this.presence.set(url, probe);
    return probe;
  }

  private async descriptorFor(
    level: ZarrLevel,
    coord: readonly [number, number],
  ): Promise<ChunkFetchDescriptor | undefined> {
    const eastMin = EAST_ORIGIN + coord[1] * level.chunkMetres;
    const northMin = NORTH_ORIGIN - (coord[0] + 1) * level.chunkMetres;
    const common = {
      gridRef: `z${level.level}/${coord[0]}/${coord[1]}`,
      level: level.level,
      eastMin,
      northMin,
      encoding: this.encoding,
      width: level.chunkPixels,
      height: level.chunkPixels,
      extentMetres: level.chunkMetres,
    };

    if (!level.shardChunks) {
      // Unsharded levels have no index to consult, so absence has to be asked
      // about directly — otherwise every coordinate in the national grid looks
      // present and the tree queues a chunk per 404.
      const url = joinUrl(level.baseUrl, 'c', String(coord[0]), String(coord[1]));
      return (await this.chunkExists(url)) ? { ...common, url } : undefined;
    }
    const [perY, perX] = level.shardChunks;
    const shard: readonly [number, number] = [Math.floor(coord[0] / perY), Math.floor(coord[1] / perX)];
    const index = await this.shardIndex(level, shard);
    if (!index) return undefined;
    const entry = index[(coord[0] % perY) * perX + (coord[1] % perX)];
    if (!entry) return undefined;
    const shardUrl = joinUrl(level.baseUrl, 'c', String(shard[0]), String(shard[1]));
    return { ...common, url: withByteRange(shardUrl, entry.offset, entry.length) };
  }

  async resolveChunksInBounds(
    bounds: TileExtent,
    targetLevel?: number,
  ): Promise<ChunkFetchDescriptor[]> {
    const span = Math.max(bounds.eastMax - bounds.eastMin, bounds.northMax - bounds.northMin);
    const level =
      (targetLevel !== undefined ? this.levels.find((entry) => entry.level === targetLevel) : undefined) ??
      this.levelFor(span);

    const xStart = Math.max(0, Math.floor((bounds.eastMin - EAST_ORIGIN) / level.chunkMetres));
    const xEnd = Math.min(level.chunkGrid[1] - 1, Math.floor((bounds.eastMax - EAST_ORIGIN) / level.chunkMetres));
    const yStart = Math.max(0, Math.floor((NORTH_ORIGIN - bounds.northMax) / level.chunkMetres));
    const yEnd = Math.min(level.chunkGrid[0] - 1, Math.floor((NORTH_ORIGIN - bounds.northMin) / level.chunkMetres));
    if (xEnd < xStart || yEnd < yStart) return [];

    const pending: Array<Promise<ChunkFetchDescriptor | undefined>> = [];
    for (let y = yStart; y <= yEnd; y += 1) {
      for (let x = xStart; x <= xEnd; x += 1) {
        pending.push(this.descriptorFor(level, [y, x]));
      }
    }
    const resolved = await Promise.all(pending);
    return resolved.filter((entry): entry is ChunkFetchDescriptor => entry !== undefined);
  }

  /**
   * Chunks for a viewport, each at the level its distance warrants.
   *
   * Descends the pyramid from the coarsest level rather than picking one level
   * for the whole viewport: on an oblique view the ground footprint reaches the
   * horizon, so a single choice is either far too coarse underfoot or far too
   * fine at the skyline.
   */
  async resolveChunksInBoundsAdaptive(
    bounds: TileExtent,
    camera: THREE.Camera,
  ): Promise<ChunkFetchDescriptor[]> {
    const coarsest = this.levels.reduce((a, b) => (a.level > b.level ? a : b));
    const range = this.chunkRangeFor(coarsest, bounds);
    if (range.xEnd < range.xStart || range.yEnd < range.yStart) return [];

    const out: ChunkFetchDescriptor[] = [];
    const seeds: Array<readonly [number, number]> = [];
    for (let y = range.yStart; y <= range.yEnd; y += 1) {
      for (let x = range.xStart; x <= range.xEnd; x += 1) seeds.push([y, x]);
    }
    const position = camera.position;
    await Promise.all(seeds.map((coord) => this.descend(coarsest, coord, bounds, position, out)));
    return out;
  }
}
