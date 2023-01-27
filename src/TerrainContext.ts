import { useThree } from "@react-three/fiber";
import { createContext } from "react";
import { EastNorth } from "./geo/Coordinates";
import { TerrainOptions, TerrainRenderer } from "./geo/TileLoaderUK";

const terrains = new Map<EastNorth, TerrainRenderer>();
export const useTerrain = (coord: EastNorth, options?: TerrainOptions) => {
    const { gl } = useThree();
    // coord should be id.
    // Why is this failing to build?
    if (!terrains.has(coord)) {
        terrains.set(coord, new TerrainRenderer(coord, options));
    }
    const t = terrains.get(coord)!;
    t.dom = gl.domElement;
    // update options if provided
    if (options) {
        t.options = options;
    }
    return t;
}
