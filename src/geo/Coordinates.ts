import { LatLon as gLatLon_OsGridRef, default as OsGridRef } from 'geodesy/osgridref'
//consider using Proj4 instead (in common with shpjs)?

export interface EastNorth {
    east: number;
    north: number;
}

/** assume WGS84 */
export interface LatLon {
    lat: number;
    lon: number;
}


export function convertWgsToOSGB(merc: LatLon) {
    //const ostn = await OSTN;
    //cf "convert_osgb36" from Rust lib...
    
    //not actually bothering with all this shifts stuff for now, really just need to get some data converted!
    //so using "geodesy" lib for now, pending finding any real problem with it.
    //I would like my conversions to be accurate, without needing big data files.
    //I still think my jpx encoded shifts might make some sense, but 'patience' to implement that 
    //is actually 'imprudence' with limited time & attention resources.

    const ll = new gLatLon_OsGridRef(merc.lat, merc.lon);
    const grid = ll.toOsGrid();
    return {east: grid.easting, north: grid.northing}
}
/**
 * Given an array of WGS coordinates, return array of OSGB.
 * @param points an array of points, each of which is [lat, long]
 */
export function convertWgsArray(points: number[][]) {
    return points.map(p => {
        const en = convertWgsToOSGB({lon: p[0], lat: p[1]});
        return [en.east, en.north];
    });
}
export function convertWgsPointToOSGB(p: number[]){ //[number, number] | [number, number, number]) {
    if (p.length < 2) throw new Error("input too short");
    const en = convertWgsToOSGB({lon: p[0], lat: p[1]});
    if (p[2] !== undefined) return [en.east, en.north, p[2]];
    return [en.east, en.north];
}
export function gridRefString(coord: EastNorth, digits?: number) {
    const g = new OsGridRef(coord.east, coord.north);
    return g.toString(digits).replace(/ /g, '');
}