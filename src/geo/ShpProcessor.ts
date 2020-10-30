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
    geo.setIndex(new THREE.BufferAttribute(delaunay.triangles, 1));
    return geo;
}
type Delaun = {triangles: Uint32Array, pArr: Float32Array}; //maybe Delaunator<Float64Array>?
/** returns THREE.BufferGeometry based on shapefile at the given OS coordinate */
export async function threeGeometryFromShpZip(coord: EastNorth) {
    //there's a hole in everything, that's how the light gets in.
    const os = gridRefString(coord, 2); //"su" + i + j
    const url = "/os/" + os;
    const worker = await workers.getWorker();
    const promise = new Promise<Delaun>(async (resolve, reject) => {
        worker.onmessage = m => {
            workers.releaseWorker(worker);
            const data = m.data as Delaun;
            if (!data) {
                reject(m.data);
            } else resolve(m.data as Delaun);
        }
        worker.postMessage({url: url});
    });

    const delaunay = await promise;
    const points = delaunay.pArr;
    const pArr = new Float32Array(points.length);
    for (let i=0; i<pArr.length/3; i++) {
        //we spend an awful lot of time on this, just projecting it *back* to how it was before
        //we need to figure out how to tell shp.js to use the right CRS
        //--- for now, I've done "PROJ-bypass surgery" in the version of shp.js used in the worker ---
        //pArr.set(convertWgsPointToOSGB([...points.slice(i*3,3+(i*3))]), i*3);
        pArr.set([...points.slice(i*3,3+(i*3))], i*3);
    }
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pArr, 3));
    geo.setIndex(new THREE.BufferAttribute(delaunay.triangles, 1));
    return geo;
}

//wrong?
function reverseWinding(indices: Uint32Array) {
    const newIndices = new Uint32Array(indices.length);
    for (let i=0; i<indices.length/3; i++) {
        newIndices.set(indices.slice(i*3, 2+(i*3)).reverse(), i*3);
    }
    return newIndices;
}

function getPoints(featureCol: FeatureCollection) {
    return featureCol.features.flatMap(f => {
        const height = f.properties!['PROP_VALUE'] as number;
        switch(f.geometry.type) {
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

