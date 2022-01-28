/**
 * Would be nice to have something a bit more like an actual formal test for some of this stuff...
 * this is a script where I'm trying to establish ability to encode & decode some data without losing information.
 */
const GeoTIFF = require('geotiff');
//maybe use different library... would be nice if it was in npm
const jph = require('../public/openjphjs.js');
const fs = require('fs');
const path = '/Volumes/BlackSea/GIS/DEFRA/LIDAR_10m_DTM_Composite_2019/LIDAR_10m_DTM_Composite.tif';
const outPath = '/Volumes/BlackSea/GIS/DEFRA/LIDAR_10m_DTM_Composite_2019/htj2k/';

let encoder, decoder;
function initHTJ2K() {
  encoder = new jph.HTJ2KEncoder(); //probably ready now...
  decoder = new jph.HTJ2KDecoder();
  const lossless = true;
  const quantizationStep = 1e-2;
  encoder.setQuality(lossless, quantizationStep);
  // encoder.setIsUsingColorTransform(false);
  // encoder.setCompressionRatio(0, 0); //not a function??
  // encoder.setDecompositions(8);
}
function printStats(vals) {
  let t = Date.now();
  const min = vals.reduce((a,b) => Math.min(a, b), Number.MAX_VALUE);
  const max = vals.reduce((a,b) => Math.max(a, b), Number.MIN_VALUE);
  const mean = vals.reduce((a, b) => a+b, 0) / vals.length;
  // console.log('got stats in', Date.now()-t);
  
  console.log('min', min);
  console.log('max', max);
  console.log('mean', mean);
  return [min, max, mean];
}


GeoTIFF.fromFile(path).then(async (tiff) => {
  const image = await tiff.getImage();
  // extract a region known to have some information.
  // actually, at the moment what I'm seeking to establish is image encoding / decoding
  // would make sense to just generate some random noise, but we have data to hand.
  initHTJ2K();
  const w = image.getWidth();
  const h = image.getHeight();
  const [L, T, R, B] = box = image.getBoundingBox();
  //*10 is because these are 10m pixels. no fancy projection required for now.
  if ((R - L) !== w*10) console.error(`!!! width of bounding box (${R-L}) not equal to 10*width of image (${w*10}) !!!`);
  if ((B - T) !== h*10) console.error(`!!! height of bounding box (${B-T}) not equal to 10*height of image (${h*10}) !!!`);
  console.log('samples per pixel:', image.getSamplesPerPixel());
  const s = outTileSize = image.getTileWidth(); //somewhat magic numbers here
  console.log('tile size: ', s);
  const nx = Math.floor(w/outTileSize), ny = Math.floor(h/outTileSize);
  function geoLLCoordFromWindowOrName(win) {
    if (typeof win === 'string') win = windowFromImgName(win);
    const [l, t, r, b] = win.map(v=>v*10);
    const xll = l+L;
    const yll = B-b; //b-T;
    return [xll, yll];
  }
  function windowFromImgName(f) {
    //based on tile indexing of 4096**2 tiles, but with s2 such that we get a 256**2 region
    const s = 4096, s2 = 1/16;
    const x = Number.parseInt(f.substring(0, 3));
    const y = Number.parseInt(f.substring(4, 7));
    const left = x*s, right = (x+s2)*s, top = y*s, bottom = (y+s2)*s;
    return [left, top, right, bottom];
  }

  const window = windowFromImgName('007_012');
  let [originalData] = await image.readRasters({window});
  // const mockData = [];
  // for (let i=0; i<256**2; i++) mockData.push(42);
  // data = new Uint16Array(mockData);
  const [min, max, mean] = printStats(originalData);
  const frameInfo = { bitsPerSample: 16, isSigned: false, width: 256, height: 256, componentCount: 1 };
  const normalise = v => 65536*((v-min) / (max-min));
  const unNormalise = v => min + ((v/65536) * (max-min));
  const data = new Uint16Array(originalData.map(v => normalise(v)));
  // printStats(data);
  const uncompressedBuffer = encoder.getDecodedBuffer(frameInfo);
  uncompressedBuffer.set(data);
  encoder.encode();
  const encoded = encoder.getEncodedBuffer();
  console.log('compression factor', data.length / encoded.length);
  
  const encodedBuffer = decoder.getEncodedBuffer(encoded.length);
  encodedBuffer.set(encoded);
  decoder.decode();
  const decodedBufferRaw = decoder.getDecodedBuffer();
  let t = Date.now();
  const decodedBuffer = new Uint16Array(decodedBufferRaw.map(v=>v).buffer);
  // const dv = new DataView(decodedBufferRaw.buffer);
  // const a = data[0], b = dv.getFloat32(0, true);
  // const a = data[0], b = decodedBufferRaw[0];
  // console.log(a, b, a-b);
  const info = decoder.getFrameInfo();
  console.log('decoded data', JSON.stringify(info));
  // printStats(decodedBuffer);
  t = Date.now();
  const err = decodedBuffer.map((v, i) => v-data[i]);
  const dt = Date.now() - t;
  console.log('error stats:');
  // printStats(err);
  const reconstituted = new Float32Array(decodedBuffer).map(unNormalise);
  printStats(reconstituted);
  console.log(originalData[0], reconstituted[0]);
  const err2 = reconstituted.map((v, i) => v-originalData[i]);
  // printStats(err2);
  const rmse = Math.sqrt(err2.map(e=>e**2).reduce((a,b)=>a+b, 0) / err2.length);
  console.log('rmse', rmse);
  //const decodedFloats = new Float32Array(decodedBufferRaw.buffer);
  //printStats(decodedFloats);
});