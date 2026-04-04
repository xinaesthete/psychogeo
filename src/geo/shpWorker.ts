/// <reference lib="webworker" />

import Delaunator from 'delaunator';
import shp from 'shpjs';
import initShpProcessor, { triangulate_shp_zip } from '../../rust/shp_processor_wasm/pkg/shp_processor_wasm.js';
import { convertWgsToOSGB } from './Coordinates';
import { collectShpPoints } from './shpPoints';
import type { ShpWorkerRequest, ShpWorkerResponse, ShpWorkerSuccess } from './shpWorkerProtocol';

interface RustTriangulationResult {
    coordinates: Float32Array;
    triangles: Uint32Array;
}

let rustBackendPromise: Promise<boolean> | undefined;

function describeError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return 'Unknown SHP worker error';
}

async function ensureRustBackend() {
    if (!rustBackendPromise) {
        rustBackendPromise = initShpProcessor()
            .then(() => true)
            .catch(error => {
                console.warn('Falling back to JavaScript SHP triangulation:', error);
                return false;
            });
    }
    return rustBackendPromise;
}

async function fetchShpZip(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`failed to fetch '${url}': ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

async function parseShpPointsWithJavascript(shpBuffer: ArrayBuffer) {
    const source = await shp(shpBuffer);
    const points = collectShpPoints(source);
    if (points.length === 0) {
        throw new Error('no geometry found in shapefile archive');
    }
    return points;
}

function projectJavascriptPointsToOSGB(pointsWgs: Float64Array) {
    const pointsOsgb = new Float64Array(pointsWgs.length);
    for (let pointIndex = 0; pointIndex < pointsWgs.length; pointIndex += 3) {
        const osgb = convertWgsToOSGB({
            lon: pointsWgs[pointIndex],
            lat: pointsWgs[pointIndex + 1],
        });
        pointsOsgb[pointIndex] = osgb.east;
        pointsOsgb[pointIndex + 1] = osgb.north;
        pointsOsgb[pointIndex + 2] = pointsWgs[pointIndex + 2];
    }
    return pointsOsgb;
}

function readRustTriangulationResult(result: object): RustTriangulationResult {
    const coordinates = Reflect.get(result, 'coordinates');
    const triangles = Reflect.get(result, 'triangles');
    if (!(coordinates instanceof Float32Array) || !(triangles instanceof Uint32Array)) {
        throw new Error('Rust SHP triangulation returned invalid buffers');
    }
    return {coordinates, triangles};
}

function triangulateWithJavascript(pointsXYZ: Float64Array, startedAt: number): ShpWorkerSuccess {
    const pointCount = pointsXYZ.length / 3;
    const coordinates = new Float32Array(pointsXYZ.length);
    const coordinates2d = new Float64Array(pointCount * 2);
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const sourceOffset = pointIndex * 3;
        const targetOffset = pointIndex * 2;
        coordinates[sourceOffset] = pointsXYZ[sourceOffset];
        coordinates[sourceOffset + 1] = pointsXYZ[sourceOffset + 1];
        coordinates[sourceOffset + 2] = pointsXYZ[sourceOffset + 2];
        coordinates2d[targetOffset] = pointsXYZ[sourceOffset];
        coordinates2d[targetOffset + 1] = pointsXYZ[sourceOffset + 1];
    }
    const delaunay = new Delaunator(coordinates2d);
    return {
        kind: 'success',
        backend: 'javascript',
        coordinates,
        triangles: delaunay.triangles,
        computeTime: Date.now() - startedAt,
    };
}

async function triangulate(url: string): Promise<ShpWorkerResponse> {
    const startedAt = Date.now();
    try {
        const shpZip = await fetchShpZip(url);
        if (await ensureRustBackend()) {
            try {
                const result = readRustTriangulationResult(triangulate_shp_zip(new Uint8Array(shpZip)));
                return {
                    kind: 'success',
                    backend: 'rust-wasm',
                    coordinates: result.coordinates,
                    triangles: result.triangles,
                    computeTime: Date.now() - startedAt,
                };
            } catch (error) {
                console.warn('Rust SHP triangulation failed; retrying in JavaScript:', error);
            }
        }
        const points = projectJavascriptPointsToOSGB(await parseShpPointsWithJavascript(shpZip));
        return triangulateWithJavascript(points, startedAt);
    } catch (error) {
        return {
            kind: 'error',
            error: describeError(error),
            computeTime: Date.now() - startedAt,
        };
    }
}

self.onmessage = async (message: MessageEvent<ShpWorkerRequest>) => {
    const response = await triangulate(message.data.url);
    if (response.kind === 'success') {
        self.postMessage(response, [response.coordinates.buffer, response.triangles.buffer]);
        return;
    }
    self.postMessage(response);
};
