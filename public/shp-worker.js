importScripts('delaunator.min.js', 'shp.js');

async function delaunayFromShpZip(url) {
    const t = Date.now();
    const file = await fetch(url);
    const shpBuff = await file.arrayBuffer();
    let s = await shp(shpBuff); //swallows errors in its "safelyResolveThenable"... what can we then do?
    if (!s) throw new Error(`failed to parse shp '${url}'`);
    let points; //[[x,y,z]*N]
    if (Array.isArray(s)) points = s.flatMap(getPoints);
    else points = getPoints(s);
    if (!points.length) throw new Error(`no geometry found from shp '${url}'`);
    //points = points.map(convertWgsPointToOSGB); //do this on the receiving end
    //--(except that at time of writing, I'm doing "PROJ-bypass surgery")--
    //TODO: look into SharedArrayBuffer / Atomics
    const pArr = new Float32Array(points.length * 3);
    for (let i=0; i<points.length; i++) {
        pArr.set(points[i], i*3);
    }
    const delaunay = Delaunator.from(points);
    // maybe it'd be quicker to use the constructor with an existing Float32Array, but any benefit negated here.
    // const delaunay = new Delaunator(pArr.filter((v, i) => i%3 !== 2));
    return {triangles: delaunay.triangles, coordinates: pArr, computeTime: Date.now()-t};
}

function getPoints(featureCol) {
    return featureCol.features.flatMap(f => {
        const height = f.properties['PROP_VALUE'];
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


function reverseWinding(indices, inPlace = true) {
    const newIndices = inPlace ? indices : new Uint32Array(indices.length);
    for (let i=0; i<indices.length/3; i++) {
        newIndices.set(indices.slice(i*3, 3+(i*3)).reverse(), i*3);
    }
    return newIndices;
}

onmessage = async m => {
    try {
         const result = await delaunayFromShpZip(m.data.url);
         postMessage(result, [result.coordinates.buffer, result.triangles.buffer]);
    } catch (e) {
        postMessage(e);
    }
}