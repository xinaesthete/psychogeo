import * as THREE from "three";
import { WebGLRenderTarget } from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls";
import { getPixelDataU16 } from "../openjpegjs/jp2kloader";
import { renderer, IThree } from "./threact";

export abstract class ThreactTrackballBase implements IThree {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();
    trackCtrl?: TrackballControls;
    initThree(dom: HTMLElement) {
        this.camera.position.set(0, 0, -3);
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
}

export class DefaultCube extends ThreactTrackballBase {
    static geo = new THREE.BoxGeometry();
    static mat = new THREE.MeshNormalMaterial();
    init() {
        const mesh = new THREE.Mesh(DefaultCube.geo, DefaultCube.mat);
        this.scene.add(mesh);
    }
}


const vert = `
varying vec2 vUv;
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vUv = uv;
}
`;

const frag = `
varying vec2 vUv;
uniform sampler2D map;
void main() {
    vec4 v = texture2D(map, vUv);
    float h = v.r + (v.g / 256.);
    gl_FragColor = vec4(h, h, h, 1.);
}
`;

export class JP2TextureView extends ThreactTrackballBase {
    url: string;
    static geo = new THREE.BoxGeometry();
    constructor(url: string) {
        super();
        this.url = url;
    }
    init() {
        getPixelDataU16(this.url).then(result => {
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
            const texture = new THREE.DataTexture(splitData, frameInfo.width, frameInfo.height, THREE.RGBFormat, THREE.UnsignedByteType);
            //texture.unpackAlignment = 1; //this is done in DataTexture constructor anyway.
            //texture.internalFormat = "R16UI";
            //texture.needsUpdate = true;
            
            //const texture = new THREE.DataTexture(fData, frameInfo.width, frameInfo.height, THREE.LuminanceFormat, THREE.FloatType, undefined,
            //const mat = new THREE.MeshBasicMaterial({map: texture});
            const uniforms = {'map': {value: {texture}}};
            const mat = new THREE.ShaderMaterial({vertexShader: vert, fragmentShader: frag, uniforms: uniforms});
            mat.uniforms.map.value = texture;
            const mesh = new THREE.Mesh(JP2TextureView.geo, mat);
            this.scene.add(mesh);
        });
    }
}

export class VidFeedbackTest extends ThreactTrackballBase {
    rt: WebGLRenderTarget[];
    constructor() {
        super();
        this.rt = [];
        
    }
    private makeRT() {
        return new THREE.WebGLRenderTarget(256, 256);
    }
    init() {

    }
    update() {
        super.update();
        const rtBak = renderer.getRenderTarget();

        renderer.setRenderTarget(rtBak);
    }
}