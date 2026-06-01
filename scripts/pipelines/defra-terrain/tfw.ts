import type { TileExtent } from './types.ts';

export interface WorldFile {
  readonly pixelSizeX: number;
  readonly rotationY: number;
  readonly rotationX: number;
  readonly pixelSizeY: number;
  readonly upperLeftCentreX: number;
  readonly upperLeftCentreY: number;
}

export function parseWorldFile(text: string): WorldFile {
  const values = text
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseFloat(part));
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Expected a six-line numeric TFW world file.');
  }
  return {
    pixelSizeX: values[0],
    rotationY: values[1],
    rotationX: values[2],
    pixelSizeY: values[3],
    upperLeftCentreX: values[4],
    upperLeftCentreY: values[5],
  };
}

export function extentFromWorldFile(world: WorldFile, width: number, height: number): TileExtent {
  if (world.rotationX !== 0 || world.rotationY !== 0) {
    throw new Error('Rotated DEFRA rasters are not supported by this pipeline.');
  }
  const west = world.upperLeftCentreX - world.pixelSizeX / 2;
  const north = world.upperLeftCentreY - world.pixelSizeY / 2;
  const east = west + width * world.pixelSizeX;
  const south = north + height * world.pixelSizeY;
  return {
    eastMin: Math.min(west, east),
    eastMax: Math.max(west, east),
    northMin: Math.min(south, north),
    northMax: Math.max(south, north),
  };
}

function firstNumber(pattern: RegExp, text: string): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function extentFromEsriXml(text: string): TileExtent | null {
  const west = firstNumber(/<westBL[^>]*>([-+\d.]+)<\/westBL>/, text);
  const east = firstNumber(/<eastBL[^>]*>([-+\d.]+)<\/eastBL>/, text);
  const south = firstNumber(/<southBL[^>]*>([-+\d.]+)<\/southBL>/, text);
  const north = firstNumber(/<northBL[^>]*>([-+\d.]+)<\/northBL>/, text);
  if (west === null || east === null || south === null || north === null) return null;
  return {
    eastMin: Math.min(west, east),
    eastMax: Math.max(west, east),
    northMin: Math.min(south, north),
    northMax: Math.max(south, north),
  };
}

export function resolutionFromEsriXml(text: string): number | null {
  return firstNumber(/<dimResol><value[^>]*uom="m"[^>]*>([-+\d.]+)<\/value><\/dimResol>/, text);
}
