import { hasDsmSource, type DefraTileGroup } from '../scan.ts';
import {
  extentsIntersect,
  normalizeGridRef,
  safeGridRefToBounds,
  type TileExtent,
} from './osgb.ts';

/** Configurable ingest extent — grid ref at any OSGB tier, or explicit easting/northing bounds. */
export type RegionSpec =
  | { readonly kind: 'grid-ref'; readonly gridRef: string }
  | { readonly kind: 'bounds'; readonly bounds: TileExtent };

const GRID_REF_5KM = /^([A-Z]{2})(\d{2})(ne|nw|se|sw)$/i;
const GRID_REF_10KM = /^([A-Z]{2})(\d{2})$/;
const GRID_REF_100KM = /^([A-Z]{2})$/;
const GRID_REF_500KM = /^([A-Z])$/;

export function tenKmCellFromTileRef(tileRef: string): string {
  const normalized = normalizeGridRef(tileRef);
  const match = GRID_REF_5KM.exec(normalized);
  if (!match) throw new Error(`expected 5 km DEFRA tile reference: ${tileRef}`);
  return `${match[1]}${match[2]}`;
}

export function parseRegionGridRef(gridRef: string): RegionSpec {
  const trimmed = gridRef.trim();
  if (trimmed.length === 0) throw new Error('region grid reference must not be empty');
  const upper = trimmed.toUpperCase();
  if (upper.length === 1 && GRID_REF_500KM.test(upper)) {
    return { kind: 'grid-ref', gridRef: upper };
  }
  if (upper.length === 2 && GRID_REF_100KM.test(upper)) {
    return { kind: 'grid-ref', gridRef: upper };
  }
  if (upper.length === 4 && GRID_REF_10KM.test(upper)) {
    normalizeGridRef(upper);
    return { kind: 'grid-ref', gridRef: upper };
  }
  if (/^[A-Z]{2}\d{1,3}$/.test(upper)) {
    return { kind: 'grid-ref', gridRef: upper };
  }
  throw new Error(
    `invalid region grid reference: ${gridRef} (expected 500 km letter, 100 km pair, 10 km cell, or prefix like SP5)`,
  );
}

export function parseRegionBounds(
  eastMin: number,
  northMin: number,
  eastMax: number,
  northMax: number,
): RegionSpec {
  if (!Number.isFinite(eastMin) || !Number.isFinite(northMin) || !Number.isFinite(eastMax) || !Number.isFinite(northMax)) {
    throw new Error('bounds values must be finite numbers');
  }
  if (eastMin >= eastMax) throw new Error('bounds eastMin must be less than eastMax');
  if (northMin >= northMax) throw new Error('bounds northMin must be less than northMax');
  return {
    kind: 'bounds',
    bounds: { eastMin, northMin, eastMax, northMax },
  };
}

export function parseRegionBoundsCsv(value: string): RegionSpec {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 4) {
    throw new Error('--bounds expects four comma-separated numbers: eastMin,northMin,eastMax,northMax');
  }
  const numbers = parts.map((part) => Number.parseFloat(part));
  if (numbers.some((n) => Number.isNaN(n))) {
    throw new Error('--bounds values must be numbers');
  }
  const [eastMin, northMin, eastMax, northMax] = numbers;
  return parseRegionBounds(eastMin, northMin, eastMax, northMax);
}

export function parseRegionArg(options: {
  readonly region?: string;
  readonly cell?: string;
  readonly bounds?: string;
}): RegionSpec {
  if (options.bounds) return parseRegionBoundsCsv(options.bounds);
  const gridRef = options.region ?? options.cell;
  if (!gridRef) {
    throw new Error('--region (or --cell) is required; alternatively use --bounds eastMin,northMin,eastMax,northMax');
  }
  return parseRegionGridRef(gridRef);
}

export function regionLabel(region: RegionSpec): string {
  if (region.kind === 'bounds') {
    const { eastMin, northMin, eastMax, northMax } = region.bounds;
    return `${eastMin},${northMin},${eastMax},${northMax}`;
  }
  return region.gridRef;
}

function matchesGridRefPrefix(tenKmCell: string, prefix: string): boolean {
  const cell = tenKmCell.toUpperCase();
  const prefixUpper = prefix.toUpperCase();
  if (prefixUpper.length === 1) {
    return cell.charAt(0) === prefixUpper;
  }
  return cell.startsWith(prefixUpper);
}

export function tileRefMatchesRegion(tileRef: string, region: RegionSpec): boolean {
  let normalized: string;
  try {
    normalized = normalizeGridRef(tileRef);
  } catch {
    return false;
  }
  if (!GRID_REF_5KM.test(normalized)) return false;

  const tileBounds = safeGridRefToBounds(tileRef);
  if (!tileBounds) return false;

  if (region.kind === 'bounds') {
    return extentsIntersect(tileBounds, region.bounds);
  }

  const prefix = region.gridRef.toUpperCase();
  const tenKm = tenKmCellFromTileRef(tileRef);

  if (GRID_REF_100KM.test(prefix) || GRID_REF_10KM.test(prefix)) {
    const bounds = safeGridRefToBounds(prefix);
    if (!bounds || !extentsIntersect(tileBounds, bounds)) return false;
  }

  return matchesGridRefPrefix(tenKm, prefix);
}

export function filterGroupsByRegion(groups: readonly DefraTileGroup[], region: RegionSpec): DefraTileGroup[] {
  return groups.filter((group) => tileRefMatchesRegion(group.tileRef, region));
}

export function discoverTenKmCells(groups: readonly DefraTileGroup[], region: RegionSpec): string[] {
  const cells = new Set<string>();
  for (const group of filterGroupsByRegion(groups, region)) {
    if (!hasDsmSource(group)) continue;
    cells.add(tenKmCellFromTileRef(group.tileRef));
  }
  return [...cells].sort((a, b) => a.localeCompare(b));
}

export function regionIngestRoot(region: RegionSpec): string {
  if (region.kind === 'bounds') {
    const { eastMin, northMin, eastMax, northMax } = region.bounds;
    return `bounds_${eastMin}_${northMin}_${eastMax}_${northMax}`;
  }
  return region.gridRef;
}

export function isSingleTenKmCell(region: RegionSpec): boolean {
  if (region.kind !== 'grid-ref') return false;
  return GRID_REF_10KM.test(region.gridRef.toUpperCase());
}

export function singleTenKmCell(region: RegionSpec): string | undefined {
  if (!isSingleTenKmCell(region)) return undefined;
  return normalizeGridRef(region.gridRef);
}
