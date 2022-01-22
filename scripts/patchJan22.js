const fs = require('fs');
const jph = require('../public/openjphjs.js');
const jpx = require('../public/openjpegwasm.js');

const jpxSourceFolder = '/Users/peter/Dropbox/BlenderGIS/pyUtil/images/web/';
const testFolder = '/Volumes/BlackSea/GIS/j2k/temp/';
const list = [
  'su4031_DSM_2M',
  'su4132_DSM_50CM',
  'su5625_DSM_2M',
  'su5525_DSM_2M',
  'su5124_DSM_2M',
  'sy2286_DSM_1M',
  'sy3188_DSM_1M',
  'sy3495_DSM_1M',
  'sy3496_DSM_1M',
  'sy3396_DSM_1M',
  'sy2186_DSM_1M',
  'sy1986_DSM_1M',
  'sy1589_DSM_1M',
  'sy2096_DSM_1M',
  'sy2090_DSM_1M'
].map(f => `${f}.asc_normalised_rate0`);

setTimeout(async () => {
  const jphEncoder = new jph.HTJ2KEncoder();
  const jphDecoder = new jph.HTJ2KDecoder();
  const jpxDecoder = new (await jpx()).J2KDecoder();

  const lossless = true;
  jphEncoder.setQuality(lossless, 0);
  
  list.forEach(f => {
    try {
      const testData = fs.readFileSync(`${jpxSourceFolder}${f}.jpx`);
      const encodedBuffer = jpxDecoder.getEncodedBuffer(testData.length);
      encodedBuffer.set(testData);
      jpxDecoder.decode();
      console.log('successfully decoded', f);
      const frameInfo = jpxDecoder.getFrameInfo();
      const decodedBuffer = jpxDecoder.getDecodedBuffer();
      const uncompressedBuffer = jphEncoder.getDecodedBuffer(frameInfo);
      uncompressedBuffer.set(decodedBuffer);
      jphEncoder.encode();
      const recodedBuffer = jphEncoder.getEncodedBuffer();
      fs.writeFileSync(`${testFolder}${f}.j2c`, recodedBuffer);
      console.log('transcoded and saved', f);
    } catch (e) {
      console.log('failed to recode', f, e.message);
    }
  });
}, 200);