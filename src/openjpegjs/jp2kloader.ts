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

/* // for ref:
EMSCRIPTEN_BINDINGS(FrameInfo) {
  value_object<FrameInfo>("FrameInfo")
    .field("width", &FrameInfo::width)
    .field("height", &FrameInfo::height)
    .field("bitsPerSample", &FrameInfo::bitsPerSample)
    .field("componentCount", &FrameInfo::componentCount)
    .field("isSigned", &FrameInfo::isSigned)
       ;
}

EMSCRIPTEN_BINDINGS(Point) {
  value_object<Point>("Point")
    .field("x", &Point::x)
    .field("y", &Point::y)
       ;
}

EMSCRIPTEN_BINDINGS(Size) {
  value_object<Size>("Size")
    .field("width", &Size::width)
    .field("height", &Size::height)
       ;
}

EMSCRIPTEN_BINDINGS(J2KDecoder) {
  class_<J2KDecoder>("J2KDecoder")
    .constructor<>()
    .function("getEncodedBuffer", &J2KDecoder::getEncodedBuffer)
    .function("getDecodedBuffer", &J2KDecoder::getDecodedBuffer)
    .function("readHeader", &J2KDecoder::readHeader)
    .function("calculateSizeAtDecompositionLevel", &J2KDecoder::calculateSizeAtDecompositionLevel)
    .function("decode", &J2KDecoder::decode)
    .function("decodeSubResolution", &J2KDecoder::decodeSubResolution)
    .function("getFrameInfo", &J2KDecoder::getFrameInfo)
    .function("getNumDecompositions", &J2KDecoder::getNumDecompositions)
    .function("getIsReversible", &J2KDecoder::getIsReversible)
    .function("getProgressionOrder", &J2KDecoder::getProgressionOrder)
    .function("getImageOffset", &J2KDecoder::getImageOffset)
    .function("getTileSize", &J2KDecoder::getTileSize)
    .function("getTileOffset", &J2KDecoder::getTileOffset)
    .function("getBlockDimensions", &J2KDecoder::getBlockDimensions)
    .function("getNumLayers", &J2KDecoder::getNumLayers)
    .function("getColorSpace", &J2KDecoder::getColorSpace)
   ;
}


EMSCRIPTEN_BINDINGS(J2KEncoder) {
  class_<J2KEncoder>("J2KEncoder")
    .constructor<>()
    .function("getDecodedBuffer", &J2KEncoder::getDecodedBuffer)
    .function("getEncodedBuffer", &J2KEncoder::getEncodedBuffer)
    .function("encode", &J2KEncoder::encode)
    .function("setDecompositions", &J2KEncoder::setDecompositions)
    .function("setQuality", &J2KEncoder::setQuality)
    .function("setProgressionOrder", &J2KEncoder::setProgressionOrder)
    .function("setDownSample", &J2KEncoder::setDownSample)
    .function("setImageOffset", &J2KEncoder::setImageOffset)
    .function("setTileSize", &J2KEncoder::setTileSize)
    .function("setTileOffset", &J2KEncoder::setTileOffset)
    .function("setBlockDimensions", &J2KEncoder::setBlockDimensions)
    .function("setNumPrecincts", &J2KEncoder::setNumPrecincts)
    .function("setPrecinct", &J2KEncoder::setPrecinct)
    .function("setCompressionRatio", &J2KEncoder::setCompressionRatio)

   ;
}

 */

export interface FrameInfo {
    width: number; height: number; isSigned: boolean; bitsPerSample: number, componentCount: number;
}


// load OpenJPEGWASM decoder into this module, assuming that there is a global OpenJPEGWASM from a <script> tag...
async function getDecoder() {
    //>>>>>>>>> OpenJPEGWASM().then(j => decoder = new j.J2KDecoder()) <<<<<<<<<<<
    let decoder: any;

    //for some reason I was having trouble with await version.
    //const j = await (window as any).OpenJPEGWASM();
    //decoder = new j.J2kDecoder();
    (window as any).OpenJPEGWASM().then((j: any) => decoder = new j.J2KDecoder());

    //so, this is obviously not great, but...
    function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }
    while (!decoder) {
        await sleep(10);
    }
    return decoder;
}

function getPixelData(frameInfo: FrameInfo, decodedBuffer: Uint8Array) {
    if(frameInfo.bitsPerSample > 8) {
        if(frameInfo.isSigned) {
            return new Int16Array(decodedBuffer.buffer, decodedBuffer.byteOffset, decodedBuffer.byteLength / 2);
        } else {
            return new Uint16Array(decodedBuffer.buffer, decodedBuffer.byteOffset, decodedBuffer.byteLength / 2);
        }
    } else {
        return decodedBuffer;
    }
}


export async function getPixelDataU16(url: string) {
    const decoder = await getDecoder();
    let encodedBitstream: Uint8Array;
    if (url.startsWith("tile:")) {
      encodedBitstream = await (window as any).electron.readTile(url);
    } else {
      const response = await fetch(url);
      encodedBitstream = new Uint8Array(await response.arrayBuffer());
    }
    //--decode();--
    const encodedBuffer = decoder.getEncodedBuffer(encodedBitstream.length);
    encodedBuffer.set(encodedBitstream);
    decoder.decode(); //nb, original code calls decodeSubResolution
    const frameInfo: FrameInfo = decoder.getFrameInfo();
    //console.log(JSON.stringify(frameInfo, null, 2));

    const decodedBuffer = decoder.getDecodedBuffer();
    const pixelData = getPixelData(frameInfo, decodedBuffer);
    return { pixData: pixelData as Uint16Array, frameInfo };
}

interface TextureTile {
  texture: THREE.Texture;
  frameInfo: FrameInfo;
}
const textureCache = new Map<string, TextureTile>();

export async function jp2Texture(url: string) {
  if (textureCache.has(url)) return textureCache.get(url) as TextureTile;
  const result = await getPixelDataU16(url);
  const frameInfo = result.frameInfo;
  // console.log(JSON.stringify(frameInfo, null, 2));
  const data = result.pixData;

  const splitData = new Uint8Array(data.length*3);
  data.forEach((v, i) => {
      const r = v >> 8;
      const g = v - (r << 8);
      splitData[3*i] = r;
      splitData[3*i + 1] = g;
      splitData[3*i + 2] = 0;
  });

  //https://jsfiddle.net/f2Lommf5/1856/ - doesn't give errors but doesn't seem to load any meaningful data.
  //const texture = new THREE.DataTexture(data, frameInfo.width, frameInfo.height, THREE.LuminanceFormat, THREE.UnsignedShortType,
      //THREE.UVMapping, THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping, THREE.NearestFilter, THREE.NearestFilter, 1
  //);
  //there is evidence the following work in WebGL2, need to translate to THREE.DataTexture:
  //internalFormat = gl.DEPTH_COMPONENT16; format = gl.DEPTH_COMPONENT; type = gl.UNSIGNED_SHORT; // OK, red    
  const texture = new THREE.DataTexture(splitData, frameInfo.width, frameInfo.height, THREE.RGBFormat, THREE.UnsignedByteType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  const t = {texture, frameInfo};
  textureCache.set(url, t);
  return t;
}

export function newGLContext() {
  //TODO: formalise GL resource management with threact.
  textureCache.clear();
}