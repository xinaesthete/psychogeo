import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls";
import { getPixelDataU16 } from "../openjpegjs/jp2kloader";
import { renderer, IThree } from "./threact";

//only used for literal highlighting e.g. with glsl-literal extension
export const glsl = (a: any,...bb: any) => a.map((x:any,i:any) => [x, bb[i]]).flat().join('');

export abstract class ThreactTrackballBase implements IThree {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();
    trackCtrl?: TrackballControls;
    initThree(dom: HTMLElement) {
        this.camera.position.set(0, 1, -3);
        this.camera.lookAt(0, 0, 0);
        this.trackCtrl = new TrackballControls(this.camera, dom);
        this.init();
    }
    init(): void {}
    update() {
        this.trackCtrl!.update();
    }
    disposeThree() {
    }
    resize(rect: DOMRect): void {
        const w = rect.width, h = rect.height;
        const a = w / h;
        this.camera.aspect = a;
        this.camera.updateProjectionMatrix();
    }
}

export class DefaultCube extends ThreactTrackballBase {
    static geo = new THREE.BoxGeometry();
    static mat = new THREE.MeshNormalMaterial();
    init() {
        const mesh = new THREE.Mesh(DefaultCube.geo, DefaultCube.mat);
        this.scene.add(mesh);
    }
}


export async function jp2Texture(url: string) {
    const result = await getPixelDataU16(url);
    const frameInfo = result.frameInfo;
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
    return {texture, frameInfo};
}

export class JP2TextureView extends ThreactTrackballBase {
    url: string;
    static geo = new THREE.BoxGeometry();
    constructor(url: string) {
        super();
        this.url = url;
    }
    init() {
        const vert = glsl`
        varying vec2 vUv;
        void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            vUv = uv;
        }
        `;
        
        const frag = glsl`
        varying vec2 vUv;
        uniform sampler2D map;
        void main() {
            vec4 v = texture2D(map, vUv);
            float h = v.r + (v.g / 256.);
            gl_FragColor = vec4(h, h, h, 1.);
        }
        `;
        jp2Texture(this.url).then(result => {
            const uniforms = {'map': {value: result.texture}};
            const mat = new THREE.ShaderMaterial({vertexShader: vert, fragmentShader: frag, uniforms: uniforms});
            const mesh = new THREE.Mesh(JP2TextureView.geo, mat);
            this.scene.add(mesh);
        });
    }
}


export function computeTriangleGridIndices(gridSizeX: number, gridSizeY: number) {
    const d: number[] = [];
    const index = (x: number, y: number) => gridSizeY * x + y;
    for (let i=0; i<gridSizeX - 1; i++) {
        for (let j=0; j<gridSizeY - 1; j++) {
            d.push(index(i, j));
            d.push(index(i+1, j));
            d.push(index(i+1, j+1));
            d.push(index(i, j));
            d.push(index(i+1, j+1));
            d.push(index(i, j+1));
        }
    }
    return new THREE.BufferAttribute(new Uint32Array(d), 1);
}



// export class VidFeedbackTest extends ThreactTrackballBase {
//     rt: WebGLRenderTarget[];
//     constructor() {
//         super();
//         this.rt = [];
        
//     }
//     private makeRT() {
//         return new THREE.WebGLRenderTarget(256, 256);
//     }
//     init() {

//     }
//     update() {
//         super.update();
//         const rtBak = renderer.getRenderTarget();

//         renderer.setRenderTarget(rtBak);
//     }
// }