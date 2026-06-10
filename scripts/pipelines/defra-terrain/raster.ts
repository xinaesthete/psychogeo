import { fromArrayBuffer } from 'geotiff';
import type { DefraZipSource } from './scan.ts';
import type { SourceProvenance, TileExtent } from './types.ts';
import { extentFromEsriXml, extentFromWorldFile, parseWorldFile } from './tfw.ts';
import { extractZipEntry, findFirstEntry, listZipEntries } from './zip.ts';

export interface RasterSource {
  readonly width: number;
  readonly height: number;
  readonly extent: TileExtent;
  readonly resolutionMetres: number;
  readonly pixels: Float32Array;
  readonly provenance: SourceProvenance;
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function typedArrayToFloat32(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (value instanceof Float64Array || value instanceof Int16Array || value instanceof Uint16Array) {
    return Float32Array.from(value);
  }
  if (Array.isArray(value)) {
    return Float32Array.from(value);
  }
  throw new Error('GeoTIFF readRasters did not return a numeric raster.');
}

function firstRaster(value: unknown): Float32Array {
  if (Array.isArray(value)) return typedArrayToFloat32(value[0]);
  if (value !== null && typeof value === 'object' && '0' in value) {
    const record: { readonly [key: string]: unknown } = value;
    return typedArrayToFloat32(record['0']);
  }
  return typedArrayToFloat32(value);
}

function extentEquals(a: TileExtent, b: TileExtent): boolean {
  return (
    Math.abs(a.eastMin - b.eastMin) < 0.001 &&
    Math.abs(a.eastMax - b.eastMax) < 0.001 &&
    Math.abs(a.northMin - b.northMin) < 0.001 &&
    Math.abs(a.northMax - b.northMax) < 0.001
  );
}

export async function readRasterSource(source: DefraZipSource): Promise<RasterSource> {
  const entries = await listZipEntries(source.zipPath);
  const tifEntry = findFirstEntry(entries, /\.tif$/i);
  if (!tifEntry) throw new Error(`No GeoTIFF found in ${source.zipBasename}`);

  const tfwEntry = findFirstEntry(entries, /\.tfw$/i);
  const xmlEntry = findFirstEntry(entries, /\.tif\.xml$/i);
  const tiffBuffer = await extractZipEntry(source.zipPath, tifEntry);
  const tiff = await fromArrayBuffer(bufferToArrayBuffer(tiffBuffer));
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters();
  const pixels = firstRaster(rasters);

  let extent: TileExtent | null = null;
  if (tfwEntry) {
    const tfw = (await extractZipEntry(source.zipPath, tfwEntry)).toString('utf8');
    extent = extentFromWorldFile(parseWorldFile(tfw), width, height);
  }
  if (xmlEntry) {
    const xml = (await extractZipEntry(source.zipPath, xmlEntry)).toString('utf8');
    const xmlExtent = extentFromEsriXml(xml);
    if (extent === null) extent = xmlExtent;
    else if (xmlExtent !== null && !extentEquals(extent, xmlExtent)) {
      throw new Error(`TFW/XML extents disagree in ${source.zipBasename}`);
    }
  }
  if (extent === null) {
    const bbox = image.getBoundingBox();
    extent = {
      eastMin: Math.min(bbox[0], bbox[2]),
      eastMax: Math.max(bbox[0], bbox[2]),
      northMin: Math.min(bbox[1], bbox[3]),
      northMax: Math.max(bbox[1], bbox[3]),
    };
  }

  const resolutionMetres = (extent.eastMax - extent.eastMin) / width;
  return {
    width,
    height,
    extent,
    resolutionMetres,
    pixels,
    provenance: {
      product: source.product,
      returnKind: source.returnKind,
      year: source.year,
      tileRef: source.tileRef,
      zipPath: source.zipPath,
      rasterPath: tifEntry,
      metadataPath: xmlEntry ?? undefined,
    },
  };
}

export function windowRaster(
  source: RasterSource,
  nominalExtent: TileExtent,
  apronMetres: number,
): { readonly pixels: Float32Array; readonly width: number; readonly height: number; readonly extent: TileExtent } {
  const res = source.resolutionMetres;
  const west = Math.max(source.extent.eastMin, nominalExtent.eastMin - apronMetres);
  const east = Math.min(source.extent.eastMax, nominalExtent.eastMax + apronMetres);
  const south = Math.max(source.extent.northMin, nominalExtent.northMin - apronMetres);
  const north = Math.min(source.extent.northMax, nominalExtent.northMax + apronMetres);
  const x0 = Math.max(0, Math.floor((west - source.extent.eastMin) / res));
  const x1 = Math.min(source.width, Math.ceil((east - source.extent.eastMin) / res));
  const y0 = Math.max(0, Math.floor((source.extent.northMax - north) / res));
  const y1 = Math.min(source.height, Math.ceil((source.extent.northMax - south) / res));
  const width = x1 - x0;
  const height = y1 - y0;
  const pixels = new Float32Array(width * height);

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = (y0 + row) * source.width + x0;
    const targetOffset = row * width;
    pixels.set(source.pixels.subarray(sourceOffset, sourceOffset + width), targetOffset);
  }

  return {
    pixels,
    width,
    height,
    extent: {
      eastMin: source.extent.eastMin + x0 * res,
      eastMax: source.extent.eastMin + x1 * res,
      northMin: source.extent.northMax - y1 * res,
      northMax: source.extent.northMax - y0 * res,
    },
  };
}

export interface RasterWindow {
  readonly pixels: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly extent: TileExtent;
}

export function downsampleExtent(
  source: RasterSource,
  width: number,
  height: number,
  resolutionMetres: number,
): TileExtent {
  return {
    eastMin: source.extent.eastMin,
    eastMax: source.extent.eastMin + width * resolutionMetres,
    northMin: source.extent.northMax - height * resolutionMetres,
    northMax: source.extent.northMax,
  };
}

export function downsampleDimensions(
  source: RasterSource,
  resolutionMetres: number,
): { readonly factor: number; readonly width: number; readonly height: number } {
  const factor = Math.max(1, Math.round(resolutionMetres / source.resolutionMetres));
  return {
    factor,
    width: Math.floor(source.width / factor),
    height: Math.floor(source.height / factor),
  };
}

function sampleBilinear(
  pixels: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const v00 = pixels[y0 * width + x0];
  const v10 = pixels[y0 * width + x1];
  const v01 = pixels[y1 * width + x0];
  const v11 = pixels[y1 * width + x1];
  const top = v00 + tx * (v10 - v00);
  const bottom = v01 + tx * (v11 - v01);
  return top + ty * (bottom - top);
}

export function downsampleNearest(source: RasterSource, resolutionMetres: number): RasterWindow {
  const { factor, width, height } = downsampleDimensions(source, resolutionMetres);
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = y * factor;
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = source.pixels[sourceY * source.width + x * factor];
    }
  }
  return {
    pixels,
    width,
    height,
    extent: downsampleExtent(source, width, height, resolutionMetres),
  };
}

export function downsampleBilinear(source: RasterSource, resolutionMetres: number): RasterWindow {
  const { factor, width, height } = downsampleDimensions(source, resolutionMetres);
  const pixels = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const srcY = (y + 0.5) * factor - 0.5;
    for (let x = 0; x < width; x += 1) {
      const srcX = (x + 0.5) * factor - 0.5;
      pixels[y * width + x] = sampleBilinear(source.pixels, source.width, source.height, srcX, srcY);
    }
  }
  return {
    pixels,
    width,
    height,
    extent: downsampleExtent(source, width, height, resolutionMetres),
  };
}
