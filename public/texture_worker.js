
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


async function decode(url) {
    if (!j) j = await OpenJPEGWASM();
    const response = await fetch(url);
    const encodedBitstream = new Uint8Array(await response.arrayBuffer());
    const decoder = new j.J2KDecoder();
    const encodedBuffer = decoder.getEncodedBuffer(encodedBitstream.length);
    encodedBuffer.set(encodedBitstream);
    decoder.decode();
    const frameInfo = decoder.getFrameInfo();
    const decodedBuffer = decoder.getDecodedBuffer();
    const pixelData = getPixelData(frameInfo, decodedBuffer);
    return { pixData: pixelData, frameInfo: frameInfo };
}

onmessage = m => {
    decode(m.data).then(postMessage);
}
