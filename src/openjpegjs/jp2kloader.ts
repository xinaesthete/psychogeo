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
  pixData: Uint16Array | Float32Array;
}
export interface TexFrame {
  frameInfo: FrameInfo;
  texData: Uint16Array | Float32Array;
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
    // for some reason, this doesn't appear to resemble the data that I'm expecting.
    // I get an error that the byteLength is not a multiple of 4.
    // If I try to slice a portion from the start & turn that into a Float32Array, it doesn't appear to contain relevant values.
    const texData = new Float32Array(buf);//.map(v => Number.isNaN(v) ? -200 : v);
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
    if (compressionRatio === 1) worker.postMessage({cmd: "tex", url: url, fullFloat: fullFloat});
    else worker.postMessage({cmd: "recode", url: url, compressionRatio: compressionRatio});
  });
  return promise;
}
const textureCache = new Map<string, TextureTile>();

export async function jp2Texture(url: string, fullFloat: boolean) {
  //what if someone else is already waiting for it but it's not in the cache yet?
  if (textureCache.has(url)) return textureCache.get(url) as TextureTile;
  const result = await getTexData(url, fullFloat);
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
  const type = fullFloat ? THREE.FloatType : THREE.HalfFloatType;
  const d = result.texData; //fullFloat ? new Float32Array(result.texData) : result.texData;
  const texture = new THREE.DataTexture(d, frameInfo.width, frameInfo.height, format, type);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true; //TODO: test & make sure full use being made...
  const t = {texture, frameInfo};
  textureCache.set(url, t);
  return t;
}

export function newGLContext() {
  //TODO: formalise GL resource management with threact.
  textureCache.clear();
}