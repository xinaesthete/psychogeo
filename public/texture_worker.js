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
    encoder = new Module.HTJ2KEncoder();
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

function computeHeightError(full, lossy) {
    const n = Math.min(full.length, lossy.length);
    if (n === 0) {
        return {
            pixelCount: 0,
            identicalPixels: 0,
            rmseRaw: 0,
            meanAbsRaw: 0,
            maxAbsRaw: 0,
            rmseNorm: 0,
            meanAbsNorm: 0,
            maxAbsNorm: 0,
        };
    }
    let sumSq = 0;
    let sumAbs = 0;
    let maxAbs = 0;
    let identicalPixels = 0;
    const scale = 1 << 16;
    for (let i = 0; i < n; i++) {
        const d = full[i] - lossy[i];
        const a = Math.abs(d);
        if (a === 0) identicalPixels += 1;
        sumSq += d * d;
        sumAbs += a;
        if (a > maxAbs) maxAbs = a;
    }
    const rmseRaw = Math.sqrt(sumSq / n);
    const meanAbsRaw = sumAbs / n;
    return {
        pixelCount: n,
        identicalPixels,
        rmseRaw,
        meanAbsRaw,
        maxAbsRaw: maxAbs,
        rmseNorm: rmseRaw / scale,
        meanAbsNorm: meanAbsRaw / scale,
        maxAbsNorm: maxAbs / scale,
    };
}

async function recode(url, q) {
    const response = await fetch(url);
    if (!response.ok) throw 'failed to fetch ' + url;
    const encodedBitstream = new Uint8Array(await response.arrayBuffer());
    const sourceBytes = encodedBitstream.byteLength;
    const { pixelData, frameInfo } = await decodeData(encodedBitstream);
    const encoded = await encode(pixelData, frameInfo, q);
    const encodedBytes = encoded.byteLength;
    const recoded = (await decodeData(encoded)).pixelData;
    const heightError = computeHeightError(pixelData, recoded);
    const texData = recoded.map(v => toHalf(v / (1 << 16)));
    return {
        texData,
        frameInfo,
        recodeStats: {
            quality: q,
            sourceBytes,
            encodedBytes,
            bytesPerPixel: encodedBytes / heightError.pixelCount,
            sourceBytesPerPixel: sourceBytes / heightError.pixelCount,
            compressionVsSource: sourceBytes > 0 ? encodedBytes / sourceBytes : 0,
            width: frameInfo.width,
            height: frameInfo.height,
            ...heightError,
        },
    };
}

async function encode(pixelData, frameInfo, q) {
    const uncompressedBuffer = encoder.getDecodedBuffer(frameInfo);
    const pixelData_8 = new Uint8Array(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength);
    uncompressedBuffer.set(pixelData_8);

    encoder.setQuality(false, q);
    encoder.setDecompositions(8);

    try {
        encoder.encode();
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`HTJ2K encode failed at q=${q}: ${detail}`);
    }
    const encoded = encoder.getEncodedBuffer();
    if (!encoded || encoded.byteLength === 0) {
        throw new Error(`HTJ2K encode produced empty bitstream at q=${q}`);
    }
    return encoded;
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
                throw new Error(`texture_worker expects {cmd: "tex"|"recode", url: string, fullFloat: boolean}`);
        }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        postMessage(`error ${detail} (message ${JSON.stringify(m.data)})`);
    }
}
