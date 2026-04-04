import * as THREE from 'three'
import { EastNorth, gridRefString } from './Coordinates';
import { WorkerPool } from '../openjpegjs/workerPool';
import type { DelaunayBuffers, ShpWorkerRequest, ShpWorkerResponse } from './shpWorkerProtocol';
import ShpTriangulationWorker from './shpWorker?worker';

type Delaun = DelaunayBuffers; //maybe Delaunator<Float64Array>?
const times: number[] = [];
const workerRegister: Map<EastNorth, Worker> = new Map();
/** returns THREE.BufferGeometry based on shapefile at the given OS coordinate */
export async function threeGeometryFromShpZip(coord: EastNorth) {
    if (workerRegister.has(coord)) {
        throw new Error("duplicate request");
        //remember we could have more than one renderer
        //(we should have a cache, multiple calls should not be an error)
        //as of this writing, we don't - so this would be an error.
        //doesn't seem to be occurring,
        //so not sure why sometimes 'loading' geometry overlaps with loaded.
    }
    //there's a hole in everything, that's how the light gets in.
    const os = gridRefString(coord, 2); //"su" + i + j
    console.log(`request for ${os}`);
    const url = "/os/" + os;
    const worker = await workers.getWorker();
    ///////XXX: this was just some half-done temp debug thing I think
    // workerRegister.set(coord, worker);
    
    //we could consider checking if this job is still a priority at this point to save swamping the system
    //e.g. user sweeps camera across a wide area and queues thousands of tiles, but by the time a worker is available
    //this tile is no longer visible.
    console.log(`ready to start ${os}`);
    const promise = new Promise<Delaun>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(t);
            clearTimeout(slow);
            worker.onmessage = null;
            worker.onerror = null;
            callback();
        };
        const t = setTimeout(() => {
            finish(() => {
                console.log(`timeout ${os}\t${new Date()}`);
                workers.releaseWorker(worker, true);
                reject(new Error(`timeout while processing ${os}`));
            });
        }, 30000);
        const slow = setTimeout(()=> {
            console.log(`slow ${os}`);
        }, 1000);
        worker.onmessage = (message: MessageEvent<ShpWorkerResponse>) => {
            finish(() => {
                const payload = message.data;
                if (payload.kind === 'error') {
                    console.log(`error in ${os}: ${payload.error}`);
                    workers.releaseWorker(worker, true);
                    reject(new Error(payload.error));
                    return;
                }
                console.log(`finished ${os} via ${payload.backend} (${payload.computeTime}ms)`);
                workers.releaseWorker(worker);
                resolve(payload);
            });
        };
        worker.onerror = event => {
            finish(() => {
                workers.releaseWorker(worker, true);
                reject(event.error instanceof Error ? event.error : new Error(event.message));
            });
        };
        const request: ShpWorkerRequest = {url};
        worker.postMessage(request);
    });

    const delaunay = await promise;
    const points = delaunay.coordinates;
    times.push(delaunay.computeTime);
    console.log(`took ${delaunay.computeTime} via ${delaunay.backend}, average: ${times.reduce((a, b) => a+b, 0)/times.length}\t${delaunay.triangles.length/3} triangles`);
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(points, 3));
    if (delaunay.normals) geo.setAttribute("normal", new THREE.BufferAttribute(delaunay.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(delaunay.triangles, 1));
    return geo;
}

const workers = new WorkerPool(8, () => new ShpTriangulationWorker());
workers.maxAge = 9e9;
//may be a problem with first workers because module not loaded properly yet
//2021-06-15::: needs review: Rust version had been working, but not now on MBP
//perhaps it only worked on Windows desktop?
