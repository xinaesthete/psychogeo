import * as THREE from 'three'
import shp from 'shpjs'
import Delaunator from 'delaunator'
import { FeatureCollection } from 'geojson';
import { convertWgsPointToOSGB } from './Coordinates';

export async function threeGeometryFromShpZip(file: string | Buffer | ArrayBuffer) {
    //it would be nice to run this in a worker, but that means importing libraries differently / changing webpack config...
    //need to think about how I call this anyway...
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
