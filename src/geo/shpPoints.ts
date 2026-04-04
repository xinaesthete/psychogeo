import type { FeatureCollection, GeoJsonProperties, Geometry, Position } from './geoJsonTypes';

type ShpSource = FeatureCollection | FeatureCollection[];

function readNumericHeight(properties: GeoJsonProperties | null | undefined) {
    const rawHeight = properties?.['PROP_VALUE'];
    if (typeof rawHeight === 'number' && Number.isFinite(rawHeight)) {
        return rawHeight;
    }
    if (typeof rawHeight === 'string') {
        const parsed = Number(rawHeight);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

function pushPosition(position: Position, properties: GeoJsonProperties | null | undefined, sink: number[]) {
    const [x, y, z] = position;
    if (x === undefined || y === undefined) {
        return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
    }
    const height = readNumericHeight(properties) ?? z;
    if (typeof height !== 'number' || !Number.isFinite(height)) {
        return;
    }
    sink.push(x, y, height);
}

function pushGeometryPoints(
    geometry: Geometry | null,
    properties: GeoJsonProperties | null | undefined,
    sink: number[],
) {
    if (!geometry) {
        return;
    }
    switch (geometry.type) {
        case 'Point':
            pushPosition(geometry.coordinates, properties, sink);
            return;
        case 'MultiPoint':
        case 'LineString':
            geometry.coordinates.forEach(position => pushPosition(position, properties, sink));
            return;
        case 'MultiLineString':
        case 'Polygon':
            geometry.coordinates.forEach(line => {
                line.forEach(position => pushPosition(position, properties, sink));
            });
            return;
        case 'MultiPolygon':
            geometry.coordinates.forEach(polygon => {
                polygon.forEach(line => {
                    line.forEach(position => pushPosition(position, properties, sink));
                });
            });
            return;
        case 'GeometryCollection':
            geometry.geometries.forEach(childGeometry => {
                pushGeometryPoints(childGeometry, properties, sink);
            });
            return;
        default:
            return;
    }
}

function appendFeatureCollectionPoints(collection: FeatureCollection, sink: number[]) {
    collection.features.forEach(feature => {
        pushGeometryPoints(feature.geometry, feature.properties, sink);
    });
}

export function collectShpPoints(source: ShpSource) {
    const points: number[] = [];
    if (Array.isArray(source)) {
        source.forEach(collection => appendFeatureCollectionPoints(collection, points));
    } else {
        appendFeatureCollectionPoints(source, points);
    }
    return new Float64Array(points);
}
