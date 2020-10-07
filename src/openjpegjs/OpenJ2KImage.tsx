import React from 'react';
import {FrameInfo, getPixelDataU16} from "./jp2kloader";

export interface OpenJ2KImageP { src: string }

interface OpenJ2KImageS {
    pixData?: Uint16Array;
    frameInfo?: FrameInfo;
    imageData?: any;
}


/** React component that displays JP2K image at given src. */
export class OpenJ2KImage extends React.Component<OpenJ2KImageP, OpenJ2KImageS> {
    mount?: HTMLCanvasElement;
    constructor(props: OpenJ2KImageP) {
        super(props);
        this.state = {};
    }
    async init() {
        const {pixData, frameInfo} = await getPixelDataU16(this.props.src);
        this.state = {
            pixData: pixData, frameInfo: frameInfo
        }
    }
    componentDidMount() {
        this.init().then(() => {
            //pretty much copied directly from https://github.com/chafey/openjpegjs
            const frameInfo = this.state.frameInfo!;
            const pixelData = this.state.pixData!;
            const c = this.mount as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx) throw new Error("Failed to create 2d canvas context");
            c.width = frameInfo.width;
            c.height = frameInfo.height;
            const imageData = ctx.createImageData(frameInfo.width, frameInfo.height);
            function getMinMax() {
                const numPixels = frameInfo.width * frameInfo.height * frameInfo.componentCount;
                let min = pixelData[0];
                let max = pixelData[0];
                for(let i=0; i < numPixels; i++) {
                    if(pixelData[i] < min) {
                        min = pixelData[i];
                    }
                    if(pixelData[i] > max) {
                        max = pixelData[i];
                    }
                }
                return {min, max};
            }
            let outOffset = 0, inOffset = 0;
            const minMax = getMinMax();
            console.log(`min: ${minMax.min}, max: ${minMax.max}`);
            let dynamicRange = minMax.max - minMax.min;
            let bitsOfData = 1;

            while (dynamicRange > 1) {
                dynamicRange = dynamicRange >> 1;
                bitsOfData++;
            }
            let bitShift = bitsOfData - 8;
            const offset = -minMax.min;
            //debugger;
            for (let y=0; y < frameInfo.height; y++) {
                for (let x = 0; x < frameInfo.width; x++) {
                    if(frameInfo.bitsPerSample <= 8) {
                        const value = pixelData[inOffset++];
                        imageData.data[outOffset] = value;
                        imageData.data[outOffset + 1] = value;
                        imageData.data[outOffset + 2] = value;
                        imageData.data[outOffset + 3] = 255;
                        outOffset += 4;
                    }
                    else // bitsPerSample > 8
                    {
                        // Do a simple transformation to display 16 bit data:
                        //  * Offset the pixels so the smallest value is 0
                        //  * Shift the pixels to display the most significant 8 bits
                        const fullPixel = pixelData[inOffset++] + offset;
                        let value = (fullPixel >> bitShift);
                        imageData.data[outOffset] = value;
                        imageData.data[outOffset + 1] = value;
                        imageData.data[outOffset + 2] = value;
                        imageData.data[outOffset + 3] = 255;
                        outOffset += 4;
                    }
                }
            }
            ctx.putImageData(imageData, 0, 0);
        });
    }

    render() {
        return (
            <canvas ref={(mount) => this.mount = mount as HTMLCanvasElement} />
        )
    }
}
