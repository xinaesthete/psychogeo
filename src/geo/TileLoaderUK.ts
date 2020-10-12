import * as dsm_cat from './dsm_catalog.json'

//temporary... hopefully introduce config file & interface soon...
const sourceFolder = "C:/Users/peter/Dropbox/BlenderGIS/pyUtil/images/web/";

const cat = (dsm_cat as any).default;

interface DsmCatItem {
    min_ele: number;
    max_ele: number;
    valid_percent: number,
    xllcorner: number,
    yllcorner: number,
    nrows: number,
    ncols: number,
    source_filename: string
}

/**
 * Given coordinates (in the form found in dsm_cat...), see if we can find a corresponding tile and return some info about it.
 * @param x 
 * @param y 
 */
export function getTileProperties(x: number, y: number) {
    const xll = Math.floor(x/1000) * 1000;
    const yll = Math.floor(y/1000) * 1000;
    //almost robust enough for critical medical data...
    const k = xll + ", " + yll;

    return cat[k] as DsmCatItem;
}

export function getImageFilename(source_filename: string) {
    return sourceFolder + source_filename + "_normalised_60db.jpx";
}