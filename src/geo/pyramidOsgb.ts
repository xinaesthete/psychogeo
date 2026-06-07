import OsGridRef from 'geodesy/osgridref.js';

export interface TileExtent {
  readonly eastMin: number;
  readonly eastMax: number;
  readonly northMin: number;
  readonly northMax: number;
}

const QUAD_SUFFIXES = ['ne', 'nw', 'se', 'sw'] as const;
export type QuadSuffix = (typeof QUAD_SUFFIXES)[number];

const GRID_REF_5KM = /^([A-Z]{2})(\d{2})(ne|nw|se|sw)$/i;
const GRID_REF_10KM = /^([A-Z]{2})(\d{2})$/;
const GRID_REF_100KM = /^([A-Z]{2})$/;

export function normalizeGridRef(gridRef: string): string {
  const match = GRID_REF_5KM.exec(gridRef);
  if (match) {
    const [, letters, digits, quad] = match;
    return `${letters}${digits}${quad.toLowerCase()}`;
  }
  const ten = GRID_REF_10KM.exec(gridRef);
  if (ten) return `${ten[1]}${ten[2]}`;
  const hundred = GRID_REF_100KM.exec(gridRef);
  if (hundred) return hundred[1];
  throw new Error(`invalid OSGB grid reference: ${gridRef}`);
}

export function tierMetresForGridRef(gridRef: string): number {
  const normalized = normalizeGridRef(gridRef);
  if (GRID_REF_5KM.test(normalized)) return 5000;
  if (GRID_REF_10KM.test(normalized)) return 10000;
  if (GRID_REF_100KM.test(normalized)) return 100000;
  throw new Error(`invalid OSGB grid reference: ${gridRef}`);
}

function parseTenKmSouthWest(gridRef: string): { east: number; north: number } {
  const normalized = normalizeGridRef(gridRef);
  const match = GRID_REF_10KM.exec(normalized);
  if (!match) throw new Error(`expected 10 km grid reference: ${gridRef}`);
  const parsed = OsGridRef.parse(`${match[1]}${match[2]}`);
  return { east: parsed.easting, north: parsed.northing };
}

function hundredKmSouthWest(letters: string): { east: number; north: number } {
  const parsed = OsGridRef.parse(`${letters}00`);
  return { east: parsed.easting, north: parsed.northing };
}

export function gridRefToBounds(gridRef: string): TileExtent {
  const normalized = normalizeGridRef(gridRef);
  const five = GRID_REF_5KM.exec(normalized);
  if (five) {
    const [, letters, digits, quad] = five;
    const sw = parseTenKmSouthWest(`${letters}${digits}`);
    const size = 5000;
    const eastHalf = quad.toLowerCase() === 'ne' || quad.toLowerCase() === 'se';
    const northHalf = quad.toLowerCase() === 'ne' || quad.toLowerCase() === 'nw';
    const eastMin = sw.east + (eastHalf ? size : 0);
    const northMin = sw.north + (northHalf ? size : 0);
    return {
      eastMin,
      eastMax: eastMin + size,
      northMin,
      northMax: northMin + size,
    };
  }
  const ten = GRID_REF_10KM.exec(normalized);
  if (ten) {
    const sw = parseTenKmSouthWest(normalized);
    return {
      eastMin: sw.east,
      eastMax: sw.east + 10000,
      northMin: sw.north,
      northMax: sw.north + 10000,
    };
  }
  const hundred = GRID_REF_100KM.exec(normalized);
  if (hundred) {
    const sw = hundredKmSouthWest(hundred[1]);
    return {
      eastMin: sw.east,
      eastMax: sw.east + 100000,
      northMin: sw.north,
      northMax: sw.north + 100000,
    };
  }
  throw new Error(`invalid OSGB grid reference: ${gridRef}`);
}

export function parentGridRef(gridRef: string): string | undefined {
  const normalized = normalizeGridRef(gridRef);
  const five = GRID_REF_5KM.exec(normalized);
  if (five) return `${five[1]}${five[2]}`;
  const ten = GRID_REF_10KM.exec(normalized);
  if (ten) return ten[1];
  return undefined;
}

export function childGridRefs(gridRef: string): string[] {
  const normalized = normalizeGridRef(gridRef);
  const hundred = GRID_REF_100KM.exec(normalized);
  if (hundred) {
    const letters = hundred[1];
    const children: string[] = [];
    for (let east = 0; east < 10; east += 1) {
      for (let north = 0; north < 10; north += 1) {
        children.push(`${letters}${east}${north}`);
      }
    }
    return children;
  }
  const ten = GRID_REF_10KM.exec(normalized);
  if (ten) {
    const prefix = `${ten[1]}${ten[2]}`;
    return QUAD_SUFFIXES.map((quad) => `${prefix}${quad}`);
  }
  return [];
}

export function extentsIntersect(a: TileExtent, b: TileExtent): boolean {
  return a.eastMin < b.eastMax && a.eastMax > b.eastMin && a.northMin < b.northMax && a.northMax > b.northMin;
}

export function gridRefsInBounds(bounds: TileExtent, tierMetres: number, candidates: string[]): string[] {
  return candidates.filter((gridRef) => {
    if (tierMetresForGridRef(gridRef) !== tierMetres) return false;
    return extentsIntersect(gridRefToBounds(gridRef), bounds);
  });
}

export function filterGroupsByCellPrefix(tileRef: string, cellPrefix: string): boolean {
  const normalized = normalizeGridRef(tileRef).toUpperCase();
  const prefix = cellPrefix.toUpperCase();
  if (!GRID_REF_5KM.test(normalized)) return false;
  const ten = GRID_REF_10KM.exec(normalized.slice(0, 4));
  if (!ten) return false;
  return `${ten[1]}${ten[2]}` === prefix;
}

export function isChildGridRef(parent: string, child: string): boolean {
  const normalizedParent = normalizeGridRef(parent);
  const normalizedChild = normalizeGridRef(child);
  if (normalizedChild === normalizedParent) return false;
  return normalizedChild.startsWith(normalizedParent);
}
