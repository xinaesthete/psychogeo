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

function isDtmTileUrl(url) {
    return url.includes('/ltile/');
}

/** Normalised codebook sample (0…65535) from HTJ2K decode, signed or unsigned. */
function normSampleU16(samples, i) {
    const v = samples[i];
    if (samples instanceof Int16Array) {
        return (v + 32768) & 0xffff;
    }
    return v;
}

/** Denormalise per-tile uint16 codebook to half-float metres (domain from /ttile/). */
function samplesToMetresHalfTexture(samples, heightRangeMetres) {
    const min = heightRangeMetres.min;
    const span = heightRangeMetres.max - min || 1;
    const texData = new Uint16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const metres = min + (normSampleU16(samples, i) / 65536) * span;
        texData[i] = toHalf(metres);
    }
    return texData;
}

function samplesToMetresArray(samples, heightRangeMetres) {
    const min = heightRangeMetres.min;
    const span = heightRangeMetres.max - min || 1;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        out[i] = min + (normSampleU16(samples, i) / 65536) * span;
    }
    return out;
}

function halfToFloat(bits) {
    const sign = (bits & 0x8000) >> 15;
    const exponent = (bits & 0x7c00) >> 10;
    const mantissa = bits & 0x03ff;
    if (exponent === 0) {
        if (mantissa === 0) return sign ? -0 : 0;
        const m = mantissa / 1024;
        const v = m * Math.pow(2, -14);
        return sign ? -v : v;
    }
    if (exponent === 0x1f) return mantissa ? NaN : sign ? -Infinity : Infinity;
    const e = exponent - 15;
    const m = 1 + mantissa / 1024;
    const v = m * Math.pow(2, e);
    return sign ? -v : v;
}

function upsampleHalfTexNearest(src, srcW, srcH, dstW, dstH) {
    const out = new Uint16Array(dstW * dstH);
    for (let y = 0; y < dstH; y++) {
        const sy = Math.min(srcH - 1, Math.round((y * (srcH - 1)) / Math.max(1, dstH - 1)));
        for (let x = 0; x < dstW; x++) {
            const sx = Math.min(srcW - 1, Math.round((x * (srcW - 1)) / Math.max(1, dstW - 1)));
            out[y * dstW + x] = src[sy * srcW + sx];
        }
    }
    return out;
}

function upsampleHalfTexBilinear(src, srcW, srcH, dstW, dstH) {
    const out = new Uint16Array(dstW * dstH);
    for (let y = 0; y < dstH; y++) {
        const sy = (y * (srcH - 1)) / Math.max(1, dstH - 1);
        const y0 = Math.floor(sy);
        const y1 = Math.min(srcH - 1, y0 + 1);
        const fy = sy - y0;
        for (let x = 0; x < dstW; x++) {
            const sx = (x * (srcW - 1)) / Math.max(1, dstW - 1);
            const x0 = Math.floor(sx);
            const x1 = Math.min(srcW - 1, x0 + 1);
            const fx = sx - x0;
            const m00 = halfToFloat(src[y0 * srcW + x0]);
            const m10 = halfToFloat(src[y0 * srcW + x1]);
            const m01 = halfToFloat(src[y1 * srcW + x0]);
            const m11 = halfToFloat(src[y1 * srcW + x1]);
            const m0 = m00 * (1 - fx) + m10 * fx;
            const m1 = m01 * (1 - fx) + m11 * fx;
            out[y * dstW + x] = toHalf(m0 * (1 - fy) + m1 * fy);
        }
    }
    return out;
}

/** Top row vs bottom row equality at the same x (vertical half-res / duplicate). */
function verticalMirrorScore(texData, width, height) {
    const h2 = height >> 1;
    let eq = 0;
    let n = 0;
    const step = Math.max(1, Math.floor(width / 24));
    for (let y = 0; y < h2; y += step) {
        for (let x = 0; x < width; x += step) {
            if (texData[y * width + x] === texData[(y + h2) * width + x]) eq++;
            n++;
        }
    }
    return n > 0 ? eq / n : 0;
}

function expandTopLeftQuadrant(texData, width, height) {
    const w2 = width >> 1;
    const h2 = height >> 1;
    const q = new Uint16Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
        for (let x = 0; x < w2; x++) q[y * w2 + x] = texData[y * width + x];
    }
    return upsampleHalfTexBilinear(q, w2, h2, width, height);
}

function expandTopHalf(texData, width, height) {
    const h2 = height >> 1;
    const top = new Uint16Array(width * h2);
    for (let y = 0; y < h2; y++) {
        for (let x = 0; x < width; x++) top[y * width + x] = texData[y * width + x];
    }
    return upsampleHalfTexBilinear(top, width, h2, width, height);
}

/** Lossy HTJ2K often decodes as a mirrored quarter/half tile; upscale from TL quadrant or top rows. */
function repairLossyDtmTex(texData, width, height, quadScore, q) {
    const vert = verticalMirrorScore(texData, width, height);
    const topMirror = quadScore.tlEqTr > 0.75;
    const bottomMirror = quadScore.blEqBr > 0.75;

    if (topMirror && bottomMirror) {
        return { texData: expandTopLeftQuadrant(texData, width, height) };
    }
    if (vert > 0.75) {
        return { texData: expandTopHalf(texData, width, height) };
    }
    if (q >= 0.5 && (topMirror || bottomMirror || vert > 0.55)) {
        return { texData: expandTopLeftQuadrant(texData, width, height) };
    }
    return { texData };
}

/** Detect 2×2 quadrant mirroring (lossy JP2 often decodes at half resolution). */
function quadrantMirrorScore(texData, width, height) {
    const w2 = width >> 1;
    const h2 = height >> 1;
    const idx = (x, y) => y * width + x;
    let tlEqTr = 0;
    let blEqBr = 0;
    let n = 0;
    const step = Math.max(1, Math.floor(w2 / 12));
    for (let y = step; y < h2 - step; y += step) {
        for (let x = step; x < w2 - step; x += step) {
            const tl = texData[idx(x, y)];
            const tr = texData[idx(x + w2, y)];
            const bl = texData[idx(x, y + h2)];
            const br = texData[idx(x + w2, y + h2)];
            if (tl === tr) tlEqTr++;
            if (bl === br) blEqBr++;
            n++;
        }
    }
    return { tlEqTr: n > 0 ? tlEqTr / n : 0, blEqBr: n > 0 ? blEqBr / n : 0, n };
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
    return { pixelData, frameInfo, decodedBuffer };
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
    const texData = pixelData.map(v => toHalf(v / (1 << 16)));
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

function computeHeightErrorMeters(full, lossy, range) {
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
    const scale = range > 0 ? range : 1;
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

async function recode(url, q, heightRangeMetres) {
    const response = await fetch(url);
    if (!response.ok) throw 'failed to fetch ' + url;
    const encodedBitstream = new Uint8Array(await response.arrayBuffer());
    const sourceBytes = encodedBitstream.byteLength;
    const { pixelData, frameInfo, decodedBuffer } = await decodeData(encodedBitstream);

    if (isDtmTileUrl(url) && heightRangeMetres) {
        const targetW = frameInfo.width;
        const targetH = frameInfo.height;
        const fullSamples = getPixelData(frameInfo, decodedBuffer);
        const fullMetres = samplesToMetresArray(fullSamples, heightRangeMetres);
        const rangeSpan = heightRangeMetres.max - heightRangeMetres.min || 1;

        const encoded = await encode(pixelData, frameInfo, q);
        const encodedBytes = encoded.byteLength;
        const recodedDecode = await decodeData(encoded);
        const lossyInfo = recodedDecode.frameInfo;
        const lossySamples = getPixelData(lossyInfo, recodedDecode.decodedBuffer);
        const lossyMetres = samplesToMetresArray(lossySamples, heightRangeMetres);
        const heightError = computeHeightErrorMeters(fullMetres, lossyMetres, rangeSpan);
        let texData = samplesToMetresHalfTexture(lossySamples, heightRangeMetres);
        let outFrameInfo = frameInfo;
        if (lossyInfo.width !== targetW || lossyInfo.height !== targetH) {
            texData = upsampleHalfTexNearest(texData, lossyInfo.width, lossyInfo.height, targetW, targetH);
            outFrameInfo = { ...frameInfo, width: targetW, height: targetH };
        }
        const quadScoreBefore = quadrantMirrorScore(texData, outFrameInfo.width, outFrameInfo.height);
        const repaired = repairLossyDtmTex(texData, outFrameInfo.width, outFrameInfo.height, quadScoreBefore, q);
        texData = repaired.texData;
        return {
            texData,
            frameInfo: outFrameInfo,
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
                const d = await recode(m.data.url, m.data.compressionRatio, m.data.heightRangeMetres);
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
