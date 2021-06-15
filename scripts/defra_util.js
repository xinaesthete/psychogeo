const GeoTIFF = require('geotiff');
const jph = require('../public/openjphjs.js');
const fs = require('fs');
const readline = require('readline');

const path = '/Volumes/BlackSea/GIS/DEFRA/LIDAR_10m_DTM_Composite_2019/LIDAR_10m_DTM_Composite.tif';
const outPath = '/Volumes/BlackSea/GIS/DEFRA/LIDAR_10m_DTM_Composite_2019/htj2k/';
const catPath = '../src/geo';
let encoder; //hacky async init this later when 'probably' done.
//const encoder = new jph.HTJ2KEncoder();
let decoder;
const compressedFiles = fs.readdirSync(outPath).filter(f=>
  !f.startsWith('.') && f.endsWith('j2c') && f.includes('32bit'));
const BAD_VALUE = 3.402823466e38; //not in a form useful for direct comparison.
const BAD_THRESH = 3e8;
const NEW_BAD_VALUE = -200;

//https://discourse.threejs.org/t/three-datatexture-works-on-mobile-only-when-i-keep-the-type-three-floattype-but-not-as-three-halffloattype/1864/4
const floatView = new Float32Array(1);
const int32View = new Int32Array(floatView.buffer);
function toHalf(val) {
    floatView[0] = val;
    var x = int32View[0];

    var bits = (x >> 16) & 0x8000; /* Get the sign */
    var m = (x >> 12) & 0x07ff; /* Keep one extra bit for rounding */
    var e = (x >> 23) & 0xff; /* Using int is faster here */

    /* If zero, or denormal, or exponent underflows too much for a denormal
                   * half, return signed zero. */
    if (e < 103) return bits;

    /* If NaN, return NaN. If Inf or exponent overflow, return Inf. */
    if (e > 142) {

        bits |= 0x7c00;
        /* If exponent was 0xff and one mantissa bit was set, it means NaN,
                                 * not Inf, so make sure we set one mantissa bit too. */
        bits |= ((e == 255) ? 0 : 1) && (x & 0x007fffff);
        return bits;
    }

    /* If exponent underflows but not too much, return a denormal */
    if (e < 113) {
        m |= 0x0800;
        /* Extra rounding may overflow and set mantissa to 0 and exponent
                         * to 1, which is OK. */
        bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
        return bits;
    }

    bits |= ((e - 112) << 10) | (m >> 1);
    /* Extra rounding. An overflow will set mantissa to 0 and increment
                   * the exponent, which is OK. */
    bits += m & 1;
    return bits;
}

async function compressAndSave(data, frameInfo, name, test) {
  let [vals] = data;
  const anyGood = vals.find(v => v < BAD_THRESH);
  if (anyGood === undefined) {
    // console.log('no useful data...');
    return false;
  }
  vals = vals.map(v => v > BAD_THRESH ? NEW_BAD_VALUE : v);
  //encode the data to a file... keep it at 32bit float for now?
  const uncompressedBuffer = encoder.getDecodedBuffer(frameInfo);
  uncompressedBuffer.set(vals);
  encoder.encode();
  const encoded = encoder.getEncodedBuffer();
  console.log(`recompressed size ${encoded.byteLength / (1024)}kb`);
  fs.writeFile(outPath + name, new Uint8Array(encoded), ()=>console.log(`wrote "${name}"`));

  return true;
}
function printStats(vals) {
  const t = Date.now();
  const min = vals.reduce((a,b) => Math.min(a, b), Number.MAX_VALUE);
  const max = vals.reduce((a,b) => Math.max(a, b), Number.MIN_VALUE);
  const mean = vals.reduce((a, b) => a+b, 0) / vals.length;
  
  console.log('got stats in', Date.now()-t);
  console.log('min', min);
  console.log('max', max);
  console.log('mean', mean);
}
function initHTJ2K() {
  encoder = new jph.HTJ2KEncoder(); //probably ready now...
  decoder = new jph.HTJ2KDecoder();
  encoder.setQuality(true, 0);
  //encoder.setCompressionRatio(0, 0); //not a function??
  encoder.setDecompositions(8);
}
//const pool = new GeoTIFF.Pool(); //seems to take ~2x as long to readRasters with pool.
GeoTIFF.fromFile(path).then(async (tiff) => {
  const image = await tiff.getImage();
  console.log('file opened!', image.getWidth(), image.getHeight(), image.getTileWidth(), image.getTileHeight());
  
  initHTJ2K();

  const w = image.getWidth();
  const h = image.getHeight();
  const [L, T, R, B] = box = image.getBoundingBox();
  //*10 is because these are 10m pixels. no fancy projection required for now.
  if ((R - L) !== w*10) console.error(`!!! width of bounding box (${R-L}) not equal to 10*width of image (${w*10}) !!!`);
  if ((B - T) !== h*10) console.error(`!!! height of bounding box (${B-T}) not equal to 10*height of image (${h*10}) !!!`);
  console.log('samples per pixel:', image.getSamplesPerPixel());
  const s = outTileSize = image.getTileWidth() * 16; //somewhat magic numbers here
  console.log('tile size: ', s);
  const nx = Math.floor(w/outTileSize), ny = Math.floor(h/outTileSize);
  
  function geoLLCoordFromWindowOrName(win) {
    if (typeof win === 'string') win = windowFromImgName(win);
    const [l, t, r, b] = win.map(v=>v*10);
    const xll = l+L;
    const yll = B-b; //b-T;
    return [xll, yll];
  }
  /** assuming tile size 4096, images named 'xxx_yyy-32bit.j2c' where xxx & yyy are indices based on that tile size*/
  function windowFromImgName(f) {
    const x = Number.parseInt(f.substring(0, 3));
    const y = Number.parseInt(f.substring(4, 7));
    const left = x*s, right = (x+1)*s, top = y*s, bottom = (y+1)*s;
    return [left, top, right, bottom];
  }

  async function compareFile(f) {
    const win = windowFromImgName(f);
    const encodedBitstreamP = fs.promises.readFile(outPath + f);
    const referenceDataP = image.readRasters({window: win, fillValue: NEW_BAD_VALUE});
    const [encodedBitstream, referenceDataA] = await Promise.all([encodedBitstreamP, referenceDataP]);
    let [referenceData] = referenceDataA;
    referenceData = referenceData.map(v => v > BAD_THRESH ? NEW_BAD_VALUE : v);
    const encodedBuffer = decoder.getEncodedBuffer(encodedBitstream.length);
    encodedBuffer.set(encodedBitstream);
    decoder.decode();
    const decRaw = decoder.getDecodedBuffer(); //Uint8Array
    //stats still showing min=0 max=255 even though I'm trying to turn into Float32.
    //why am I getting NaN when I do `new Float32Array(decRaw.buffer)`?
    //perhaps need to clarify endianness & use DataView instead?
    const decodedBuffer = new Float32Array(decRaw.buffer, decRaw.byteOffset, decRaw.byteLength/4);
    const dv = new DataView(decRaw.buffer);

    console.log('reference data', f);
    //printStats(referenceData);
    const info = decoder.getFrameInfo();
    console.log('decoded data', JSON.stringify(info));
    // printStats(decodedBuffer);

    const a = referenceData[0], b = dv.getFloat32(0, true), c = dv.getFloat32(0, false);// decodedBuffer[0];
    console.log(a, b, Math.sqrt((a-b)**2));
    console.log(a, c, Math.sqrt((a-c)**2));
    const errSq = (v, i) => {
      const ref = referenceData[i];
      const r = ref > BAD_THRESH ? NEW_BAD_VALUE : ref;
      return (v-r)**2;
    }
    const mse = decodedBuffer.map(errSq).reduce((a,b)=>a+b, 0) / decodedBuffer.length;
    const rmse = Math.sqrt(mse);
    console.log('rmse:', rmse);
  }
  await compareFile('007_012-32bit.j2c');
  (async function compare() {
    for (let i=0; i<compressedFiles.length; i++) {
      const f = compressedFiles[i];
      await compareFile(f);
    }
  });
  (async function compress() {
    console.log(`making ${nx}x${ny} tiles...`);
    //https://github.com/chafey/openjphjs/blob/master/src/FrameInfo.hpp
    //bitsPerSample range [2, 16]?
    const frameInfo = { bitsPerSample: 32, isSigned: true, width: s, height: s, componentCount: 1 };
    for (let y=0; y<ny; y++) {
      console.log(`row ${y+1}/${ny}...`);
      //readline.cursorTo(process.stdout, 0, 0);
      //process.stdout.write(x + '/' + nx);
      // readline.cursorTo(process.stdout, 0, y);
      // process.stdout.write('\r' + " ".repeat(1000));
      for (let x=0; x<nx; x++) {
        // readline.cursorTo(process.stdout, x, y);
        // console.log(`col ${y+1}/${ny}...`);
        const left = x*s, right = (x+1)*s, top = y*s, bottom = (y+1)*s;
        const win = [left, top, right, bottom];
        // console.log(...win);
        //image window can go beyond bounds, in which case it might be useful to supply a fillValue
        const t = Date.now();
        const X = x.toLocaleString(undefined, {minimumIntegerDigits: 3});
        const Y = y.toLocaleString(undefined, {minimumIntegerDigits: 3});
        const name = `${X}_${Y}-32bit.j2c`;
        // if (compressedFiles.includes(name)) continue;
        const data = await image.readRasters({window: win, fillValue: NEW_BAD_VALUE});
        // console.log(`got data in`, Date.now()-t);
        const r = await compressAndSave(data, frameInfo, name, true);
        // process.stdout.write(r ? '.' : ' ');
      }
    }
  });
  (async function createAllMetadata() {
    const catalog = {};
    compressedFiles.forEach(async f => {
      const [xll, yll] = geoLLCoordFromWindowOrName(f);
      const entry = catalog[`${xll}, ${yll}`] = {xllcorner: xll, yllcorner: yll, nrows: s, ncols: s, source_filename: f};
      const json = JSON.stringify(entry);
      fs.writeFile(outPath+f+'.json', json, ()=>{console.log('wrote metadata for', f)});
    });

    fs.writeFile(catPath+'10m_dtm_catalog.json', JSON.stringify(catalog, null, 2), ()=>{console.log('wrote catalog')});
  });
}).catch(err => {
  console.error('ERROR!');
  console.error(err);
});

