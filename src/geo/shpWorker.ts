/// <reference lib="webworker" />

import initShpProcessor, { triangulate_shp_zip } from '../../rust/shp_processor_wasm/pkg/shp_processor_wasm.js';
import type { ShpWorkerRequest, ShpWorkerResponse } from './shpWorkerProtocol';

interface RustTriangulationResult {
    coordinates: Float32Array;
    triangles: Uint32Array;
}

let rustBackendPromise: Promise<void> | undefined;

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
            .then(() => undefined);
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

function readRustTriangulationResult(result: object): RustTriangulationResult {
    const coordinates = Reflect.get(result, 'coordinates');
    const triangles = Reflect.get(result, 'triangles');
    if (!(coordinates instanceof Float32Array) || !(triangles instanceof Uint32Array)) {
        throw new Error('Rust SHP triangulation returned invalid buffers');
    }
    return {coordinates, triangles};
}

async function triangulate(url: string): Promise<ShpWorkerResponse> {
    const startedAt = Date.now();
    try {
        const [_, shpZip] = await Promise.all([ensureRustBackend(), fetchShpZip(url)]);
        const result = readRustTriangulationResult(triangulate_shp_zip(new Uint8Array(shpZip)));
        return {
            kind: 'success',
            backend: 'rust-wasm',
            coordinates: result.coordinates,
            triangles: result.triangles,
            computeTime: Date.now() - startedAt,
        };
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
