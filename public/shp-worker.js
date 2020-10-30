importScripts('delaunator.min.js', 'shp.js');

async function delaunayFromShpZip(url) {
    const file = await fetch(url);
    const shpBuff = await file.arrayBuffer();
    const s = await shp(shpBuff);
    let points;
    if (Array.isArray(s)) points = s.flatMap(getPoints);
    else points = getPoints(s);
    //points = points.map(convertWgsPointToOSGB); //do this on the receiving end
    //(except that at time of writing, I'm doing "PROJ-bypass surgery")
    const delaunay = Delaunator.from(points);
    const pArr = new Float32Array(points.length * 3);
    for (let i=0; i<points.length; i++) {
        pArr.set(points[i], i*3);
    }
    return {triangles: delaunay.triangles, pArr: pArr};
}

function getPoints(featureCol) {
    return featureCol.features.flatMap(f => {
        const height = f.properties['PROP_VALUE'];
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

onmessage = async m => {
    try {
        delaunayFromShpZip(m.data.url).then(postMessage);
    } catch (e) {
        postMessage(e);
    }
}