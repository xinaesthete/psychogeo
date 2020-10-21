import { LatLon as gLatLon_OsGridRef } from 'geodesy/osgridref'


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

