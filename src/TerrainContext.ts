import { useThree } from "@react-three/fiber";
import { EastNorth } from "./geo/Coordinates";
import { TerrainOptions, TerrainRenderer } from "./geo/TileLoaderUK";

function terrainCacheKey(coord: EastNorth): string {
    return `${coord.east},${coord.north}`;
}

const terrains = new Map<string, TerrainRenderer>();

export function getTerrainRenderer(coord: EastNorth, options?: TerrainOptions): TerrainRenderer {
    const key = terrainCacheKey(coord);
    let t = terrains.get(key);
    if (!t) {
        t = new TerrainRenderer(coord, options);
        terrains.set(key, t);
    }
    return t;
}

export const useTerrain = (coord: EastNorth, options?: TerrainOptions) => {
    const { gl } = useThree();
    const t = getTerrainRenderer(coord, options);
    t.dom = gl.domElement;
    return t;
};
