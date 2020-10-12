import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls";
import { jp2Texture } from "../openjpegjs/jp2kloader";
import { IThree } from "./threact";

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