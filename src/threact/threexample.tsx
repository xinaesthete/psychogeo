import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls";
import { jp2Texture } from "../openjpegjs/jp2kloader";
import { IThree } from "./threact";

//only used for literal highlighting e.g. with glsl-literal extension
export const glsl = (a: any,...bb: any) => a.map((x:any,i:any) => [x, bb[i]]).flat().join('');

export abstract class ThreactTrackballBase implements IThree {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();
    ortho = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 1);
    trackCtrl?: TrackballControls;
    overlay = new THREE.Scene(); //for debug graphics
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
        this.ortho.right = a;
        this.camera.updateProjectionMatrix();
    }
    render(renderer: THREE.WebGLRenderer) {
        renderer.render(this.scene, this.camera);
        renderer.clearDepth();
        if (this.overlay.children.length) renderer.render(this.overlay, this.ortho);
    }
    debugTexture(texture: THREE.Texture) {
        const mat = new THREE.MeshBasicMaterial({map: texture});
        const geo = new THREE.PlaneBufferGeometry(0.2, 0.2, 1, 1);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.x = 0.15;
        mesh.position.y = 0.15;
        this.overlay.add(mesh);
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
        jp2Texture(this.url, false).then(result => {
            const uniforms = {'map': {value: result.texture}};
            const mat = new THREE.ShaderMaterial({vertexShader: vert, fragmentShader: frag, uniforms: uniforms});
            const mesh = new THREE.Mesh(JP2TextureView.geo, mat);
            this.scene.add(mesh);
        });
    }
}

export function computeTriangleGridIndices(gridSizeX: number, gridSizeY: number) {
    //TODO: order triangle so that they can be used for better LOD?
    const n = gridSizeX * gridSizeY * 6;
    const t = n > 1<<16 ? Uint32Array : Uint16Array;
    const data = new t(n);
    let p = 0;
    const index = (x: number, y: number) => gridSizeY * x + y;
    for (let i=0; i<gridSizeX - 1; i++) {
        for (let j=0; j<gridSizeY - 1; j++) {
            const cell = [
                index(i,   j),
                index(i+1, j),
                index(i+1, j+1),
                index(i,   j),
                index(i+1, j+1),
                index(i,   j+1),
            ];
            data.set(cell,   p);
            p+=6;
        }
    }
    return new THREE.BufferAttribute(data, 1);
}

function computeTriangleGridIndicesX(gridSizeX: number, gridSizeY: number) {
    //TODO: order triangle so that they can be used for better LOD
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