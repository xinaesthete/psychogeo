export type ShpWorkerBackend = 'javascript' | 'rust-wasm';

export interface DelaunayBuffers {
    triangles: Uint32Array;
    coordinates: Float32Array;
    normals?: Float32Array;
    computeTime: number;
    backend: ShpWorkerBackend;
}

export interface ShpWorkerRequest {
    url: string;
}

export interface ShpWorkerSuccess extends DelaunayBuffers {
    kind: 'success';
}

export interface ShpWorkerFailure {
    kind: 'error';
    error: string;
    computeTime: number;
    backend?: ShpWorkerBackend;
}

export type ShpWorkerResponse = ShpWorkerSuccess | ShpWorkerFailure;
