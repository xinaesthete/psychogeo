/**
 * Receives message requesting an image to be loaded (or recoded), responding with the resulting data when done.
 * Assumes that the calling code will not attempt to make a new request on a given instance until a result has been returned:
 * response messages have no extra information about which request their response relates to.
 * May change so that progress messages are sent.
 * Used in conjunction with WorkerPool / jp2kloader
 */

importScripts('openjpegwasm.js');

let j;

function getPixelData(frameInfo, decodedBuffer) {
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

async function decodeData(encodedBitstream) {
    const decoder = new j.J2KDecoder();
    const encodedBuffer = decoder.getEncodedBuffer(encodedBitstream.length);
    encodedBuffer.set(encodedBitstream);
    decoder.decode();
    const frameInfo = decoder.getFrameInfo();
    const decodedBuffer = decoder.getDecodedBuffer();
    const pixelData = getPixelData(frameInfo, decodedBuffer);
    return {pixelData, frameInfo}
}

async function decodeFromURL(url) {
    if (!j) j = await OpenJPEGWASM();
    const response = await fetch(url);
    const encodedBitstream = new Uint8Array(await response.arrayBuffer());
    return decodeData(encodedBitstream);
}

//takes unsigned 16bit int & splits for use in RGB texture (a bit wasteful)
function splitBytes(pixelData) {
    const splitData = new Uint8Array(pixelData.length*3);
    pixelData.forEach((v, i) => {
        const r = v >> 8;
        const g = v - (r << 8);
        splitData[3*i] = r;
        splitData[3*i + 1] = g;
        splitData[3*i + 2] = 0;
    });
    return splitData;
}

async function decodeTex(url) {
    const {pixelData, frameInfo} = await decodeFromURL(url);
    const splitData = splitBytes(pixelData);

    return { texData: splitData, frameInfo: frameInfo };
}

async function recode(url, q) {
    const {pixelData, frameInfo} = await decodeFromURL(url);
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

onmessage = m => {
    switch (m.data.cmd) {
        case "tex":
            decodeTex(m.data.url).then(postMessage);
            break;
        case "recode":
            recode(m.data.url, m.data.compressionRatio).then(postMessage);
            break;
        default:
            throw new Error(`texture_worker expects {cmd: "tex"|"pix", url: string }, got ${JSON.stringift(m.data)}`);
    }
}
