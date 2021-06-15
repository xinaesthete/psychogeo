import * as THREE from 'three'
import shp from 'shpjs'
import Delaunator from 'delaunator'
import { FeatureCollection } from 'geojson';
import { convertWgsPointToOSGB, EastNorth, gridRefString } from './Coordinates';
import { WorkerPool } from '../openjpegjs/workerPool';

export async function threeGeometryFromShpZipX(coord: EastNorth) {
    const os = gridRefString(coord, 2); //"su" + i + j
    const response = await fetch("/os/" + os);
    const file = await response.arrayBuffer();

    const s = await shp(file);
    
    let points: number[][];
    if (Array.isArray(s)) points = s.flatMap(fc => getPoints(fc));
    else points = getPoints(s);
    points = points.map(convertWgsPointToOSGB);
    const delaunay = Delaunator.from(points);
    
    const geo = new THREE.BufferGeometry();
    const pArr = new Float32Array(points.length * 3);
    for (let i=0; i<points.length; i++) {
        pArr.set(points[i], i*3);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pArr, 3));
    geo.setIndex(new THREE.BufferAttribute(reverseWinding(delaunay.triangles), 1));
    return geo;
}
type Delaun = {triangles: Uint32Array, coordinates: Float32Array, normals?: Float32Array, computeTime: number}; //maybe Delaunator<Float64Array>?
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
    let alreadyTimedOut = false;
    const promise = new Promise<Delaun>(async (resolve, reject) => {
        const t = setTimeout(()=>{
            alreadyTimedOut = true;
            console.log(`timeout ${os}\t${new Date()}`);
            //seems to fail the second time this happens
            ///--- I think my problem is to do with WASM not yet being loaded in newWorker ---///
            workers.releaseWorker(worker, false);
            reject("timeout");
        }, 30000);
        const slow = setTimeout(()=> {
            console.log(`slow ${os}`);
        }, 1000);
        worker.onmessage = m => {
            clearTimeout(t);
            clearTimeout(slow);
            console.log(`finished ${os} (${m.data.computeTime}ms)`);
            if (!m.data.triangles) {
                console.log(`error in ${os}: ${m.data}`);
                workers.releaseWorker(worker);
                reject(m.data);
            }
            workers.releaseWorker(worker, false); //testing kill functionality, don't want 2nd arg otherwise
            // *adding it seems to make the bug go away*, not quite sure what's happening...
            if (alreadyTimedOut) {
                //I would expect this to be nigh-on impossible given that the worker.terminate() is 'instantaneous'
                //but I guess there could be an issue with thread-safety.
                console.warn(`got a message from a worker that had already timed out`);
            }
            resolve(m.data as Delaun);
        }
        worker.postMessage({url: url});
    });

    const delaunay = await promise;
    const points = delaunay.coordinates;
    times.push(delaunay.computeTime);
    console.log(`took ${delaunay.computeTime}, average: ${times.reduce((a, b) => a+b, 0)/times.length}\t${delaunay.triangles.length/3} triangles`);
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(points, 3));
    if (delaunay.normals) geo.setAttribute("normal", new THREE.BufferAttribute(delaunay.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(delaunay.triangles, 1));
    return geo;
}

function reverseWinding(indices: Uint32Array, inPlace = true) {
    const newIndices = inPlace ? indices : new Uint32Array(indices.length);
    for (let i=0; i<indices.length/3; i++) {
        newIndices.set(indices.slice(i*3, 3+(i*3)).reverse(), i*3);
    }
    return newIndices;
}

function getPoints(featureCol: FeatureCollection) {
    return featureCol.features.flatMap(f => {
        const height = f.properties!['PROP_VALUE'] as number;
        switch(f.geometry.type) {
            case "Point":
                return [f.geometry.coordinates.concat(height)];
            case "MultiLineString":
                return f.geometry.coordinates.flatMap(cA=>cA.map(c=>c.concat(height)));
            case "MultiPoint":
            case "LineString":
                return f.geometry.coordinates.map(c => c.concat(height));
            default:
                return [];
        }
    });
}

const workers = new WorkerPool(8, "shp-worker.js");
// const workers = new WorkerPool(8, "rust_experiment/worker.js");
workers.maxAge = 9e9;
//may be a problem with first workers because module not loaded properly yet
//2021-06-15::: needs review: Rust version had been working, but not now on MBP
//perhaps it only worked on Windows desktop?