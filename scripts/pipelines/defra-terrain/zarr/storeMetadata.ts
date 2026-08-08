import type { TerrainManifestV2 } from '../v2/types.ts';
import type { ScaleOffset } from './globalScale.ts';
import { NATIONAL_EXTENT, type LevelGrid } from './grid.ts';
import type { RenormLevel } from './levels.ts';

/**
 * Codec id registered by `zarrextra`'s `registerExperimentalHtj2kCodec()`,
 * backed by openjph-wasm. Experimental until there is registry alignment —
 * datasets written with it are explicitly labelled in the group attributes.
 */
export const HTJ2K_CODEC_NAME = 'experimental.openjph_htj2k';

export const ZARR_FORMAT = 3;

type Json = Record<string, unknown>;

function htj2kCodec(): Json {
  return { name: HTJ2K_CODEC_NAME };
}

function shardingCodec(grid: LevelGrid): Json {
  return {
    name: 'sharding_indexed',
    configuration: {
      chunk_shape: grid.chunkShape,
      codecs: [htj2kCodec()],
      index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }, { name: 'crc32c' }],
      index_location: 'end',
    },
  };
}

export function buildGroupMetadata(attributes: Json = {}): Json {
  return { zarr_format: ZARR_FORMAT, node_type: 'group', attributes };
}

/**
 * The store root, which names the channel groups under it.
 *
 * A Zarr group does not record its children, and a store served as plain
 * static files has nothing to enumerate — there is no listing to ask for. So a
 * reader either finds the channels named here or guesses, and a guess is
 * indistinguishable from working code until a second channel exists. Which is
 * precisely when this layout is supposed to start paying: DTM, the FZ−LZ
 * foliage measure and the survey years are all meant to arrive as siblings.
 */
export function buildStoreRootMetadata(
  channels: readonly string[],
  psychogeo: Json = {},
): Json {
  return buildGroupMetadata({ psychogeo: { ...psychogeo, channels: [...channels] } });
}

/**
 * One level of the height pyramid.
 *
 * When the level is sharded the array's own chunk grid is the *shard* grid and
 * the sharding codec carries the inner chunk shape — that indirection is what
 * turns 150k files into a few thousand while each codestream stays
 * individually range-readable.
 */
export function buildLevelArrayMetadata(grid: LevelGrid, source: TerrainManifestV2): Json {
  const sharded = grid.shardChunks !== null && grid.shardShape !== null;
  return {
    zarr_format: ZARR_FORMAT,
    node_type: 'array',
    shape: grid.shape,
    data_type: source.encoding.sampleType,
    chunk_grid: {
      name: 'regular',
      configuration: { chunk_shape: sharded ? grid.shardShape : grid.chunkShape },
    },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: source.encoding.nodata,
    codecs: sharded ? [shardingCodec(grid)] : [htj2kCodec()],
    dimension_names: ['y', 'x'],
    attributes: {
      psychogeo: {
        level: grid.level,
        chunkMetres: grid.chunkMetres,
        chunkPixels: grid.chunkPixels,
        resolutionMetres: grid.resolutionMetres,
        nominalResolutionMetres: grid.nominalResolutionMetres,
        shardMetres: grid.shardMetres,
      },
    },
  };
}

/**
 * A level of the renormalised pyramid.
 *
 * The whole point of the global scale is that there is no companion array: the
 * transform is a pair of numbers in the array's own attributes, which is what a
 * reader outside this project can act on without knowing anything bespoke.
 */
export function buildRenormLevelMetadata(level: RenormLevel, encoding: ScaleOffset): Json {
  const sharded = level.shardChunks !== null && level.shardShape !== null;
  return {
    zarr_format: ZARR_FORMAT,
    node_type: 'array',
    shape: level.shape,
    data_type: 'uint16',
    chunk_grid: {
      name: 'regular',
      configuration: { chunk_shape: sharded ? level.shardShape : level.chunkShape },
    },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: sharded
      ? [
          {
            name: 'sharding_indexed',
            configuration: {
              chunk_shape: level.chunkShape,
              codecs: [htj2kCodec()],
              index_codecs: [
                { name: 'bytes', configuration: { endian: 'little' } },
                { name: 'crc32c' },
              ],
              index_location: 'end',
            },
          },
        ]
      : [htj2kCodec()],
    dimension_names: ['y', 'x'],
    attributes: {
      psychogeo: {
        level: level.level,
        resolutionMetres: level.resolutionMetres,
        chunkMetres: level.chunkMetres,
        // height = raw * scale + offset; raw 0 is nodata.
        scale: encoding.scale,
        offset: encoding.offset,
        nodata: 0,
      },
    },
  };
}

export type ChannelMetadataOptions = {
  readonly channelId: string;
  readonly sourceDatasetId: string;
  readonly crs: TerrainManifestV2['crs'];
  readonly levels: readonly RenormLevel[];
  readonly encoding: ScaleOffset;
  readonly dithered: boolean;
  /** What the samples mean, when it is not simply height above datum. */
  readonly measure?: string;
  readonly description?: string;
};

/**
 * A channel group: the multiscale ladder plus everything a reader needs to turn
 * a raw sample into a number in metres.
 *
 * Channels differ in what they measure but not in how they are stored, so this
 * takes the few fields that vary rather than a source manifest — dz is derived
 * from a pair of source rasters and has no v2 manifest behind it.
 */
export function buildChannelMetadata(options: ChannelMetadataOptions): Json {
  return buildGroupMetadata({
    multiscales: [
      {
        name: options.channelId,
        axes: [
          { name: 'y', type: 'space', unit: 'metre' },
          { name: 'x', type: 'space', unit: 'metre' },
        ],
        datasets: options.levels.map((level) => ({
          path: String(level.level),
          coordinateTransformations: [
            { type: 'scale', scale: [level.resolutionMetres, level.resolutionMetres] },
          ],
        })),
      },
    ],
    psychogeo: {
      sourceDatasetId: options.sourceDatasetId,
      channelId: options.channelId,
      crs: options.crs,
      ...(options.measure ? { measure: options.measure } : {}),
      ...(options.description ? { description: options.description } : {}),
      encoding: {
        codecName: HTJ2K_CODEC_NAME,
        sampleType: 'uint16',
        normalisation: 'globalScaleOffset',
        scale: options.encoding.scale,
        offset: options.encoding.offset,
        nodata: 0,
        dithered: options.dithered,
      },
      grid: {
        crs: options.crs.horizontal,
        eastOrigin: NATIONAL_EXTENT.eastMin,
        northOrigin: NATIONAL_EXTENT.northMax,
        yAxis: 'south',
        levelFactor: 4,
      },
    },
  });
}

export function buildRenormChannelMetadata(
  source: TerrainManifestV2,
  levels: readonly RenormLevel[],
  encoding: ScaleOffset,
  dithered: boolean,
): Json {
  return buildChannelMetadata({
    channelId: source.channelId,
    sourceDatasetId: source.datasetId,
    crs: source.crs,
    levels,
    encoding,
    dithered,
  });
}

/**
 * Per-chunk `scale` / `offset`, one value per chunk of the matching level.
 *
 * The source normalises every chunk independently (uint16 1..65535 across that
 * chunk's own min..max), and Zarr has no array-level home for that — dtype
 * semantics are uniform across the array. So it travels alongside, at chunk
 * resolution. NaN marks a chunk with no data.
 */
export function buildEncodingArrayMetadata(grid: LevelGrid, name: 'scale' | 'offset'): Json {
  return {
    zarr_format: ZARR_FORMAT,
    node_type: 'array',
    shape: grid.chunkGrid,
    data_type: 'float64',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: grid.chunkGrid } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 'NaN',
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    dimension_names: ['y', 'x'],
    attributes: { psychogeo: { level: grid.level, quantity: name } },
  };
}

/**
 * Channel group attributes: an OME-style `multiscales` block for tooling that
 * looks for one, plus the exact OSGB affine, which `multiscales` has no
 * standard way to express.
 */
export function buildChannelGroupMetadata(
  source: TerrainManifestV2,
  grids: readonly LevelGrid[],
): Json {
  const ordered = [...grids].sort((a, b) => a.level - b.level);
  return buildGroupMetadata({
    multiscales: [
      {
        name: source.channelId,
        axes: [
          { name: 'y', type: 'space', unit: 'metre' },
          { name: 'x', type: 'space', unit: 'metre' },
        ],
        datasets: ordered.map((grid) => ({
          path: String(grid.level),
          coordinateTransformations: [
            { type: 'scale', scale: [grid.resolutionMetres, grid.resolutionMetres] },
          ],
        })),
      },
    ],
    psychogeo: {
      sourceSchemaVersion: source.schemaVersion,
      sourceFormat: source.format,
      sourceDatasetId: source.datasetId,
      channelId: source.channelId,
      crs: source.crs,
      encoding: {
        codec: source.encoding.codec,
        codecName: HTJ2K_CODEC_NAME,
        sampleType: source.encoding.sampleType,
        normalisation: source.encoding.normalisation,
        nodata: source.encoding.nodata,
        // value = raw * scale + offset, with raw 0 reserved for nodata; so
        // min = offset + scale and max = offset + 65535 * scale.
        rawMin: 1,
        rawMax: 65535,
      },
      // Array index (y, x) → OSGB: east = eastOrigin + x * res,
      // north = northOrigin - y * res. y runs south because the codestreams
      // are stored north-first.
      grid: {
        crs: source.crs.horizontal,
        eastOrigin: NATIONAL_EXTENT.eastMin,
        northOrigin: NATIONAL_EXTENT.northMax,
        yAxis: 'south',
        levels: ordered.map((grid) => ({
          level: grid.level,
          resolutionMetres: grid.resolutionMetres,
          chunkMetres: grid.chunkMetres,
          shape: grid.shape,
          chunkGrid: grid.chunkGrid,
        })),
      },
    },
  });
}
