export type GeoJsonProperties = Record<string, unknown>;
export type Position = number[];

export interface PointGeometry {
    type: 'Point';
    coordinates: Position;
}

export interface MultiPointGeometry {
    type: 'MultiPoint';
    coordinates: Position[];
}

export interface LineStringGeometry {
    type: 'LineString';
    coordinates: Position[];
}

export interface MultiLineStringGeometry {
    type: 'MultiLineString';
    coordinates: Position[][];
}

export interface PolygonGeometry {
    type: 'Polygon';
    coordinates: Position[][];
}

export interface MultiPolygonGeometry {
    type: 'MultiPolygon';
    coordinates: Position[][][];
}

export interface GeometryCollectionGeometry {
    type: 'GeometryCollection';
    geometries: Geometry[];
}

export type Geometry =
    | PointGeometry
    | MultiPointGeometry
    | LineStringGeometry
    | MultiLineStringGeometry
    | PolygonGeometry
    | MultiPolygonGeometry
    | GeometryCollectionGeometry;

export interface Feature {
    geometry: Geometry | null;
    properties?: GeoJsonProperties | null;
}

export interface FeatureCollection {
    features: Feature[];
}
