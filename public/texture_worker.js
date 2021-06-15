/**
 * Receives message requesting an image to be loaded (or recoded), responding with the resulting data when done.
 * Assumes that the calling code will not attempt to make a new request on a given instance until a result has been returned:
 * response messages have no extra information about which request their response relates to.
 * May change so that progress messages are sent.
 * Used in conjunction with WorkerPool / jp2kloader
 */

// importScripts('openjpegwasm.js');
importScripts('openjphjs.js');

let j;
let decoder;
Module.onRuntimeInitialized = async _ => {
    decoder = new Module.HTJ2KDecoder();
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

function getPixelData(frameInfo, decodedBuffer) {
    if (frameInfo.bitsPerSample === 32) {
        return new Float32Array(decodedBuffer.buffer, decodedBuffer.byteLength, decodedBuffer.byteLength / 4);
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

async function decodeData(encodedBitstream) {
    // const decoder = new j.J2KDecoder();
    const encodedBuffer = decoder.getEncodedBuffer(encodedBitstream.length);
    encodedBuffer.set(encodedBitstream);
    decoder.decode();
    const frameInfo = decoder.getFrameInfo();
    const decodedBuffer = decoder.getDecodedBuffer();
    const pixelData = getPixelData(frameInfo, decodedBuffer);
    // decoder.delete();// should have been there before, or decoder reused
    return { pixelData, frameInfo }
}
async function decodeFromURL(url) {
    // if (!j) j = await OpenJPEGWASM();
    const response = await fetch(url);
    if (!response.ok) throw 'failed to fetch ' + url;
    const encodedBitstream = new Uint8Array(await response.arrayBuffer());
    return decodeData(encodedBitstream);
}

//takes unsigned 16bit int & splits for use in RGB texture (a bit wasteful)
function splitBytes(pixelData) {
    const splitData = new Uint8Array(pixelData.length * 3);
    pixelData.forEach((v, i) => {
        const r = v >> 8;
        const g = v - (r << 8);
        splitData[3 * i] = r;
        splitData[3 * i + 1] = g;
        splitData[3 * i + 2] = 0;
    });
    return splitData;
}

async function decodeTexToRGB(url) {
    const { pixelData, frameInfo } = await decodeFromURL(url);
    const splitData = splitBytes(pixelData);

    return { texData: splitData, frameInfo: frameInfo };
}

async function decodeTex(url, fullFloat) {
    const { pixelData, frameInfo } = await decodeFromURL(url);
    const texData = fullFloat && frameInfo.bitsPerSample === 32 ? pixelData.map(v=>v) : pixelData.map(v => toHalf(v / (1<<16)));
    
    return { texData, frameInfo };
}

async function recode(url, q) {
    const { pixelData, frameInfo } = await decodeFromURL(url);
    const encoder = new j.J2KEncoder();
    const uncompressedBuffer = encoder.getDecodedBuffer(frameInfo);
    //uncompressedBuffer.set(pixelData); // why twice as long? and 8bit? with 2nd half all 0s...
    const pixelData_8 = new Uint8Array(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength);
    uncompressedBuffer.set(pixelData_8); // why twice as long? and 8bit? with 2nd half all 0s...

    encoder.setQuality(1, 1);

    encoder.setCompressionRatio(0, q);
    encoder.setDecompositions(8);
    // encoder.setProgressionOrder(0);

    encoder.encode();
    const encoded = encoder.getEncodedBuffer();
    console.log(`recompressed size ${encoded.byteLength / (1024)}kb`);
    const recoded = await decodeData(encoded);
    const texData = splitBytes(recoded.pixelData);
    return { texData, frameInfo };
}

onmessage = async m => {
    try {
        switch (m.data.cmd) {
            case "tex":
                const r = await decodeTex(m.data.url, m.data.fullFloat);
                postMessage(r, [r.texData.buffer]);
                break;
            case "recode":
                const d = await recode(m.data.url, m.data.compressionRatio);
                postMessage(d, [d.texData.buffer]);
                break;
            default:
                throw new Error(`texture_worker expects {cmd: "tex"|"recode", url: string}`);
        }
    } catch (error) {
        postMessage(`error ${error} caught processing texture_worker message ${JSON.stringify(m.data)}`);
    }
}
