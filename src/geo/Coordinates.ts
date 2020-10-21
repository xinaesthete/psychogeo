import { getPixDataU16, PixFrame } from '../openjpegjs/jp2kloader'
// import * as mtLatLon from 'mt-latlon'
// import * as mtCoordTransform from 'mt-coordtransform'
// import * as mtOSGridRef from 'mt-osgridref'
import gOsGridRef, { LatLon as gLatLon_OsGridRef } from 'geodesy/osgridref'


export interface EastNorth {
    east: number;
    north: number;
}

/** assume WGS84 */
export interface LatLon {
    lat: number;
    lon: number;
}

/** numbers used to re-normalise OSTN shift data range */
const minEShift = 82.182,
    maxEShift = 111.046,
    minNShift = -84.153,
    maxNShift = -43.869,
    minHShift = 41.35,
    maxHShift = 57.998;

/** legal ranges, other magic numbers, and general ref for algorithms https://github.com/urschrei/lonlat_bng/blob/master/src/conversions.rs */
const MIN_LONGITUDE = -8.5790;
const MAX_LONGITUDE = 1.7800;
const MIN_LATITUDE = 49.922;
const MAX_LATITUDE = 60.8400;
const RAD = Math.PI / 180;
//"lon & lat of true origin"
const LAM0 = RAD * -2;
const PHI0 = RAD * 49;

class PixFrameRange {
    data: PixFrame;
    min: number; 
    max: number;
    constructor(data: PixFrame, min: number, max: number) {
        this.data = data;
        this.min = min;
        this.max = max;
    }
    read(x: number, y: number) : number {
        const h = this.data.frameInfo.height;
        const i = x + y * h;
        const v = this.data.pixData[i] / 1<<16;
        return this.min + v * (this.max - this.min);
    }
}
class OSTNShifts {
    eShiftRaw: PixFrameRange;
    nShiftRaw: PixFrameRange;
    hShiftRaw: PixFrameRange;
    constructor(e: PixFrame, n: PixFrame, h: PixFrame) {
        this.eShiftRaw = new PixFrameRange(e, minEShift, maxEShift);
        this.nShiftRaw = new PixFrameRange(n, minNShift, maxNShift);
        this.hShiftRaw = new PixFrameRange(h, minHShift, maxHShift);
    }
    getShift(coord: EastNorth) {
        const x = Math.round(coord.east);
        const y = Math.round(coord.north);
        const eShift = this.eShiftRaw.read(x, y);
        const nShift = this.nShiftRaw.read(x, y);
        return {east: eShift, north: nShift};
    }
}
const OSTN: Promise<OSTNShifts> = loadOSTN();

async function loadOSTN() {
    let e, n, h;
    Promise.all([
        e = await getPixDataU16('/data/OSTN/ostnEShift-90.jpz'),
        n = await getPixDataU16('/data/OSTN/ostnNShift-90.jpz'),
        h = await getPixDataU16('/data/OSTN/ostnHShift-90.jpz'),
    ]);
    return new OSTNShifts(e, n, h);
}


function check(v: number, min: number, max: number) {
    console.assert(v >= min && v <= max, 'coordinate out of range');
    return v;
}
function checkLon(lon: number) {
    return check(lon, MIN_LONGITUDE, MAX_LONGITUDE);
}
function checkLat(lon: number) {
    return check(lon, MIN_LATITUDE, MAX_LATITUDE);
}


function convertETRS89(merc: LatLon) {
    //assert within UK bounding box, convert to degrees
    //?????? surely we expect them to already be in degrees and might want rad?
    const lon1 = checkLon(merc.lon) / RAD;
    const lat1 = checkLat(merc.lat) / RAD;
}

export function convertWgsToOSGB(merc: LatLon) {
    //const ostn = await OSTN;
    //cf "convert_osgb36" from Rust lib...
    
    //not actually bothering with all this shifts stuff for now, really just need to get some data converted!
    //so using "mt" libs for now, pending finding any real problem with it.
    //I would like my conversions to be accurate, without needing big data files.
    //I still think my jpx encoded shifts might make some sense, but 'patience' to implement that 
    //is actually 'imprudence' with limited time & attention resources.

    //the 'mt' versions had trouble with webpack, and I realised also appear to be abandoned versions of what can now be foung in 'geodesy'
    // const ll = mtCoordTransform.convertWgsToOSGB(new mtLatLon(merc.lat, merc.lon));
    // const point = mtOSGridRef.latLongToOsGrid(ll);
    //return {east: point.easting, north: point.northing};
    const ll = new gLatLon_OsGridRef(merc.lat, merc.lon);
    const grid = ll.toOsGrid();
    return {east: grid.easting, north: grid.northing}
}
