
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
    
    const splitData = new Uint8Array(pixelData.length*3);
    pixelData.forEach((v, i) => {
        const r = v >> 8;
        const g = v - (r << 8);
        splitData[3*i] = r;
        splitData[3*i + 1] = g;
        splitData[3*i + 2] = 0;
    });
  
    
    return { texData: splitData, frameInfo: frameInfo };
}

onmessage = m => {
    decode(m.data).then(postMessage);
}
