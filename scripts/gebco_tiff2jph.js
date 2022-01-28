const GeoTIFF = require('geotiff');
const jph = require('../public/openjphjs.js');
const fs = require('fs');

const path = '/Volumes/BlackSea/GIS/bathymetry/';
const outPath = '/Volumes/BlackSea/GIS/bathymetry/htj2k_lossy/';

const tileSize = 2048;

const inputFiles = fs.readdirSync(path).filter(f=> f.endsWith('.tif'));
const existingFiles = fs.readdirSync(outPath);
function stats(vals) {
  const t = Date.now();
  let min = Number.MAX_VALUE;
  let max = Number.NEGATIVE_INFINITY;
  let mean = 0;
  for (let i=0; i<vals.length; i++) {
    let v = vals[i];
    min = Math.min(min, v);
    max = Math.max(max, v);
    mean += v;
  };
  mean = mean / vals.length;
  console.log('got stats via loop in', Date.now()-t);
  console.log('min', min);
  console.log('max', max);
  console.log('mean', mean);
  return {min, max, mean};
}

function normaliseUint16(vals) {
  const {min, max, mean} = stats(vals);
  const range = max - min;
  const normalised = new Uint16Array(vals.length);
  for (let i=0; i<vals.length; i++) {
    let v = vals[i];
    normalised[i] = toHalf((v-min)/range);
  }
  return {normalised, min, max, mean};
}

let encoder;

function initHTJ2K() {
  encoder = new jph.HTJ2KEncoder();
  encoder.setQuality(false, 0.001); //not sure I understand the quantization; if I'm using int, then a value of '1' is clearly not meaining '1'
  encoder.setDecompositions(10); //higher value seems to be smaller file (up to a point)
}
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

setTimeout(async () => {
  try {
    await main();
  } catch (e) {
    console.error(e);
  }
}, 200);
function exists(f, x, y) {
  let file = f.replace('.tif', `_x${x}_y${y}`);
  return existingFiles.some(f=> f.startsWith(file));
}
async function main() {
  initHTJ2K();
  for (let i=0; i<inputFiles.length; i++) {
    let inF = inputFiles[i];
    const tiff = await GeoTIFF.fromFile(path + inF);
    const image = await tiff.getImage();
    const width = 2048, height = 2048
    const t = Date.now();
    const [data] = await image.readRasters({width, height, resampleMethod: 'linear'});
    console.log('read raster in', Date.now()-t);
    stats(data);
    const frameInfo = {width, height, isSigned: true, componentCount: 1, bitsPerSample: 16};
    const uncompressedBuffer = encoder.getDecodedBuffer(frameInfo);
    uncompressedBuffer.set(data);
    encoder.encode();
    const encoded = encoder.getEncodedBuffer();
    console.log(`recompressed size ${Math.floor(encoded.byteLength / 1024)}kb (${data.byteLength / encoded.byteLength}x compression)`);
    const outF = outPath + inF.replace('.tif', '_2048x2048.j2c');
    fs.writeFile(outF, new Uint8Array(encoded), (err) => {
      if (err) console.error(err);
      console.log(`Wrote ${outF}`);
    });
  }
}

async function mainNormalise(){
initHTJ2K();
let skipped = 0, i=0;
// inputFiles.forEach(async (inF) => {
for (let i=0; i<inputFiles.length; i++) {
  let inF = inputFiles[i];
  if (i++ >= 1) return;
  console.log('skipped', skipped);
  const tiff = await GeoTIFF.fromFile(path + inF);
  const image = await tiff.getImage();
  console.log(inF, image.getWidth(), image.getHeight());
  const w = image.getWidth();
  // I think I want to have a tileSize of 2048, resampled from chunks of 1800
  // which means n = 12 (21600/1800)
  const s = 1800;
  const n = w/s;
  console.assert(n === 12);

  for (let x=0; x<n; x++) {
    for (let y=0; y<n; y++) {
      if (exists(inF, x, y)) {
        skipped++;
        continue;
      }
      const window = [x*s, y*s, (x+1)*s, (y+1)*s];
      const width = tileSize;
      const height = tileSize;
      const resampleMethod = 'linear';
      const [data] = await image.readRasters({window, resampleMethod, width, height});
      const {normalised, min, max} = normaliseUint16(data);
      const outF = outPath + inF.replace('.tif', `_x${x}_y${y}_min${min}_max${max}.j2c`);
      const frameInfo = {width, height, bitsPerSample: 16, isSigned: false, componentCount: 1};
      const uncompressedBuffer = encoder.getDecodedBuffer(frameInfo);
      uncompressedBuffer.set(normalised);
      encoder.encode();
      const encoded = encoder.getEncodedBuffer();
      console.log(`recompressed size ${Math.floor(encoded.byteLength / 1024)}kb (${data.byteLength / encoded.byteLength}x compression)`);
      fs.writeFile(outF, new Uint8Array(encoded), (err) => {
        if (err) console.error(err);
        console.log(`Wrote ${outF}`);
      });
    }
  }
}}