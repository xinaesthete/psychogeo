import { default as OsGridRef } from "geodesy/osgridref";
import type { LatLon } from "../geo/Coordinates";
import { convertWgsToOSGB } from "../geo/Coordinates";
import type { TerrainViewState } from "./viewState";

/**
 * View state shape consumed by react-map-gl / deck.gl MapController.
 * Wire sync in a future hybrid UI — no map dependencies required here.
 */
export type WgsViewState = {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch: number;
    bearing: number;
};

const EARTH_RADIUS_M = 6_378_137;
const DEFAULT_BASE_ZOOM = 14;

export function convertOsgbToWgs(coord: { east: number; north: number }): LatLon {
    const grid = new OsGridRef(coord.east, coord.north);
    const ll = grid.toLatLon();
    return { lat: ll.lat, lon: ll.lon };
}

/** Approximate map zoom from camera distance (meters). Tune when syncing with Mapbox. */
export function distanceToZoom(distance: number, latitude: number): number {
    const metersPerPixel = distance * 0.001;
    const latRad = (latitude * Math.PI) / 180;
    const zoom = Math.log2(
        (EARTH_RADIUS_M * Math.cos(latRad) * Math.PI) / (256 * metersPerPixel),
    );
    return Math.max(0, Math.min(22, zoom));
}

export function terrainViewStateToWgs(
    state: TerrainViewState,
    baseZoom = DEFAULT_BASE_ZOOM,
): WgsViewState {
    const { lat, lon } = convertOsgbToWgs(state.target);
    return {
        longitude: lon,
        latitude: lat,
        zoom: distanceToZoom(state.distance, lat) || baseZoom,
        pitch: (state.pitch * 180) / Math.PI,
        bearing: (state.bearing * 180) / Math.PI,
    };
}

/** Inverse of terrainViewStateToWgs for syncing map → Three (approximate distance). */
export function wgsViewStateToTerrain(
    wgs: WgsViewState,
    distanceOverride?: number,
): TerrainViewState {
    const en = convertWgsToOSGB({ lat: wgs.latitude, lon: wgs.longitude });
    const latRad = (wgs.latitude * Math.PI) / 180;
    const metersPerPixel =
        (EARTH_RADIUS_M * Math.cos(latRad) * Math.PI) / (256 * Math.pow(2, wgs.zoom));
    const distance = distanceOverride ?? metersPerPixel / 0.001;
    return {
        target: en,
        distance,
        bearing: (wgs.bearing * Math.PI) / 180,
        pitch: (wgs.pitch * Math.PI) / 180,
    };
}
