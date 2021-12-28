/**
 * Utilities for loading Jpeg2000 using OpenJPEGJS WASM decoder.
 *
 * Not intended (at time of writing) to robustly cover a wide range of inputs, but to handle data specific
 * to current application (single channel 16bit unsigned int, likely to change).  Should not be hard to generalise.
 *
 * This should hopefully be usable as a reasonably clean TS module, although it hides some less clean implementation detail.
 * Well a little unit testing wouldn't do us any harm... (no a little unit testing wouldn't do us any harm)
 */

import * as THREE from 'three'
import { WorkerPool } from './workerPool';


export interface FrameInfo {
    width: number; height: number; isSigned: boolean; bitsPerSample: number, componentCount: number;
}

export interface TextureTile {
  texture: THREE.Texture;
  frameInfo: FrameInfo;
}
export interface PixFrame {
  frameInfo: FrameInfo;
  pixData: Uint16Array;
}
export interface TexFrame {
  frameInfo: FrameInfo;
  texData: Uint16Array;
  //not all code here is very clean wrt naming etc. at the moment.
}

const workers = new WorkerPool(8);
workers.maxAge = 9e9;
//^^^ long life because I have a slight bug when new workers init.
//not much point in retiring, I think I had a memory leak before because I kept making new decoders
const times: number[] = [];
async function getTexData(url: string, fullFloat: boolean, compressionRatio = 1) : Promise<TexFrame> {
  if (url.startsWith('/ttile')) {
    const r = await fetch(url);
    const frameInfo:FrameInfo = {width: 4096, height: 4096, isSigned: true, bitsPerSample: 32, componentCount: 1};
    const buf = await r.arrayBuffer();
    
    //const texData = new Uint16Array(new Float32Array(buf).map(toHalf));//.map(v => Number.isNaN(v) ? -200 : v);
    const texData = new Uint16Array(buf);//.map(v => Number.isNaN(v) ? -200 : v);
    if (texData.length !== frameInfo.width * frameInfo.height) {
      console.error(`that ain't gonna work - ${texData.length} isn't expected length (${frameInfo.width*frameInfo.height})`);
    }
    // const min = texData.reduce((a,b) => Math.min(a, b), Number.MAX_VALUE);
    // const max = texData.reduce((a,b) => Math.max(a, b), Number.MIN_VALUE);
    // const mean = texData.reduce((a, b) => a+b, 0) / texData.length;
    // console.log('got stats in', Date.now()-t);
    
    // console.log('min', min);
    // console.log('max', max);
    // console.log('mean', mean);
    
    return {frameInfo, texData};
  }
  const worker = await workers.getWorker();
  const t = Date.now();
  const promise = new Promise<TexFrame>(async (resolve, reject) => {
    worker.onmessage = m => {
      workers.releaseWorker(worker);
      const dt = Date.now() - t;
      times.push(dt);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;;
      console.log(`t: ${dt}, min: ${Math.min(...times)}, max: ${Math.max(...times)} avg: ${avg}`);
      if (typeof m.data === "string") reject(m.data);
      resolve(m.data as TexFrame);
    }
    if (compressionRatio === 1) worker.postMessage({cmd: "tex", url, fullFloat});
    else worker.postMessage({cmd: "recode", url, compressionRatio: compressionRatio, fullFloat});
  });
  return promise;
}
const textureCache = new Map<string, TextureTile>();

export async function jp2Texture(url: string, simplerDecodeHack: boolean) {
  //what if someone else is already waiting for it but it's not in the cache yet?
  if (textureCache.has(url)) return textureCache.get(url) as TextureTile;
  const result = await getTexData(url, simplerDecodeHack);
  const frameInfo = result.frameInfo;
  // console.log(JSON.stringify(frameInfo, null, 2));

  //https://jsfiddle.net/f2Lommf5/1856/ - doesn't give errors but doesn't seem to load any meaningful data.
  //const texture = new THREE.DataTexture(data, frameInfo.width, frameInfo.height, THREE.LuminanceFormat, THREE.UnsignedShortType,
      //THREE.UVMapping, THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping, THREE.NearestFilter, THREE.NearestFilter, 1
  //);
  //there is evidence the following work in WebGL2, need to translate to THREE.DataTexture:
  //internalFormat = gl.DEPTH_COMPONENT16; format = gl.DEPTH_COMPONENT; type = gl.UNSIGNED_SHORT; // OK, red
  // const texture = new THREE.DataTexture(result.texData, frameInfo.width, frameInfo.height, THREE.RGBFormat, THREE.UnsignedByteType);
  const format = THREE.RedFormat;
  const type = THREE.HalfFloatType;
  const d = result.texData; //fullFloat ? new Float32Array(result.texData) : result.texData;
  const texture = new THREE.DataTexture(d, frameInfo.width, frameInfo.height, format, type);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 16;
  // texture.generateMipmaps = true; //TODO: test & make sure full use being made...
  const t = {texture, frameInfo};
  textureCache.set(url, t);
  return t;
}

export function newGLContext() {
  //TODO: formalise GL resource management with threact.
  textureCache.clear();
}


//https://discourse.threejs.org/t/three-datatexture-works-on-mobile-only-when-i-keep-the-type-three-floattype-but-not-as-three-halffloattype/1864/4
const floatView = new Float32Array(1);
const int32View = new Int32Array(floatView.buffer);
function toHalf(val: number) {
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
