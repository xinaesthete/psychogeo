const jph = require('../public/openjphjs.js');
const fs = require('fs');

const path = '/Volumes/BlackSea/GIS/j2k/jph2';
const out = '/Volumes/BlackSea/GIS/j2k/temp';

const files = fs.readdirSync(path).filter(f => f.startsWith('0') && f.endsWith('.j2c'));
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

function getPixelData(frameInfo, decodedBuffer) {
  if (frameInfo.bitsPerSample === 32) {
      return new Float32Array(decodedBuffer.buffer, decodedBuffer.byteOffset, decodedBuffer.byteLength / 4);
  }
  if (frameInfo.bitsPerSample > 8) {
      if (frameInfo.isSigned) {
          return new Int16Array(decodedBuffer.buffer, decodedBuffer.byteOffset, decodedBuffer.byteLength / 2);
      } else {
          return new Uint16Array(decodedBuffer.buffer, decodedBuffer.byteOffset, decodedBuffer.byteLength / 2);
      }
  } else {
      return decodedBuffer;
  }
}


const BAD_VALUE = -200;
function stats(data) {
  let min = Number.MAX_VALUE;
  let max = Number.NEGATIVE_INFINITY;
  let minI = -1, maxI = -1;
  let badSamples = 0;
  data.forEach((v, i) => {
    if (v !== BAD_VALUE) {
      if (v < min) minI = i;
      else if (v > max) maxI = i;
      min = Math.min(min, v);
      max = Math.max(max, v);
    } else badSamples++;
  });
  return {min, max, minI, maxI, badSamples};
}
function normalise(data) {
  const {min, max} = stats(data);
  const range = max - min;
  const normalised = new Uint16Array(data.length);
  data.forEach((v, i) => {
    if (v === BAD_VALUE) {
      normalised[i] = 0;
    } else {
      normalised[i] = toHalf((v-min)/range);
    }
  });
  return {normalised, min, max};
}

setTimeout(async () => {
  const decoder = new jph.HTJ2KDecoder();
  const encoder = new jph.HTJ2KEncoder();

  const lossless = true;
  encoder.setQuality(lossless, 0);
  let i = 0;
  files.forEach(async f => {
    if (i++ >= 1) return;
    try {
      const data = fs.readFileSync(`${path}/${f}`);
      console.log(f);
      const encodedBuffer = decoder.getEncodedBuffer(data.length);
      encodedBuffer.set(data);
      decoder.decode();
      const frameInfo = decoder.getFrameInfo();
      const decodedBuffer = decoder.getDecodedBuffer();
      
      const pixData = getPixelData(frameInfo, decodedBuffer);
      const {normalised, min, max} = normalise(pixData);
      console.log(`${f} min:${min} max:${max}`);
      console.log(JSON.stringify(frameInfo));
      frameInfo.bitsPerSample = 16;
      frameInfo.isSigned = false;
      const uncompressedBuffer = encoder.getDecodedBuffer(frameInfo);
      
      // normalised... but not 16bit...
      // so the uncompressedBuffer will be wrong size?
      const pixelData_8 = new Uint8Array(normalised.buffer, normalised.byteOffset, normalised.byteLength);
      uncompressedBuffer.set(pixelData_8); //offset is out of bounds.
      console.log(`encoding ${f}...`);
      encoder.encode();
      console.log('encoded');
      const recodedBuffer = encoder.getEncodedBuffer();
      const newF = f.replace('-32bit', '-normalised-16bit');
      fs.writeFileSync(`${out}/${newF}`, recodedBuffer);
      console.log('transcoded and saved', newF);
    } catch (e) {
      console.log('failed to recode', f, e.message);
    }
  });
}, 200);