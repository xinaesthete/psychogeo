/**
 * Bridge for a future react-map-gl + deck.gl overlay alongside the Three.js terrain.
 *
 * Integration sketch (no runtime deps here):
 * 1. Mount `<Map>` from react-map-gl with `viewState` / `onMove`.
 * 2. On move: `wgsViewStateToTerrain(wgs)` → `applyTerrainViewState(camera, controls, terrain)`.
 * 3. On Three `controls` change: `terrainViewStateToWgs(state)` → update map `viewState`.
 * 4. Add deck.gl layers via `MapboxOverlay` or `<DeckGL>` for GPX, tile bounds, labels.
 *
 * Keep DSM mesh in Three; use deck for vector overlays until a TerrainLayer spike is justified.
 */
export type { WgsViewState } from "./wgsAdapter";
export {
    convertOsgbToWgs,
    distanceToZoom,
    terrainViewStateToWgs,
    wgsViewStateToTerrain,
} from "./wgsAdapter";
export type { TerrainViewState } from "./viewState";
export {
    applyTerrainViewState,
    onTerrainViewStateChange,
    terrainViewStateFromCamera,
} from "./viewState";
