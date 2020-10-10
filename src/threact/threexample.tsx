import * as THREE from "three";
import { WebGLRenderTarget } from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls";
import { getPixelDataU16 } from "../openjpegjs/jp2kloader";
import { renderer, IThree } from "./threact";

//only used for literal highlighting e.g. with glsl-literal extension
const glsl = (a: any,...bb: any) => a.map((x:any,i:any) => [x, bb[i]]).flat().join('');

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


async function jp2Texture(url: string) {
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
    const texture = new THREE.DataTexture(splitData, frameInfo.width, frameInfo.height, THREE.RGBFormat, THREE.UnsignedByteType);
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


function computeTriangleGridIndices(gridSizeX: number, gridSizeY: number) {
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

const indicesAttribute2kGrid = computeTriangleGridIndices(2000, 2000);

export class JP2HeightField extends ThreactTrackballBase {
    geo = new THREE.BufferGeometry();
    url: string;
    heightMin = 0;
    heightMax = 1;
    constructor(url: string) {
        super();
        this.url = url;
    }
    init() {
        this.camera.position.y = -100;
        this.camera.position.z = 50;
        const vert = glsl`#version 300 es
        precision highp float;
        uniform mat4 projectionMatrix, modelViewMatrix;
        uniform int gridSizeX, gridSizeY;
        uniform vec2 EPS;
        uniform float heightMin, heightMax;
        uniform float horizontalScale;
        uniform sampler2D heightFeild;
        out vec2 vUv;
        out float normalisedHeight;
        out vec3 v_modelSpacePosition;
        out vec3 v_viewSpacePosition;
        float mapHeight(float h) {
            return heightMin + h * (heightMax - heightMin);
        }
        float getNormalisedHeight(vec2 uv) {
            vec4 v = texture(heightFeild, uv);
            float h = v.r + (v.g / 256.);
            return h;
        }
        float getHeight(vec2 uv) {
            return mapHeight(getNormalisedHeight(uv));
        }
        vec2 uvFromVertID() {
            int x = gl_VertexID / gridSizeY;
            int y = gl_VertexID % gridSizeX;
            //NB: when I was doing this in OF, I didn't include the +0.5
            //I think this version is correct... see some odd artefacts otherwise.
            return vec2(float(x)+0.5, float(y)+0.5) * EPS;
        }
        vec4 computePos(in vec2 uv) {
            return vec4((uv-0.5) * horizontalScale, getHeight(uv), 1.0);
        }
        void main() {
            vec2 uv = uvFromVertID();
            float h = getNormalisedHeight(uv);
            normalisedHeight = h;
            vUv = uv;
            vec4 p = computePos(uv);
            v_modelSpacePosition = p.xyz;
            p = modelViewMatrix * p;
            v_viewSpacePosition = p.xyz;
            gl_Position = projectionMatrix * p;
        }
        `
        const frag = glsl`#version 300 es
        precision highp float;
        out vec4 col;
        in vec3 v_modelSpacePosition;
        in vec3 v_viewSpacePosition;
        in vec2 vUv;
        in float normalisedHeight;
        vec3 computeNormal() {
            vec3 p = v_modelSpacePosition;
            vec3 dx = dFdx(p);
            vec3 dy = dFdy(p);
            return normalize(cross(dx, dy));
        }
        //this function seems quite good at showing up certain artefacts...
        float computeSteepness() {
            return pow(1.-abs(dot(vec3(0.,0.,1.), computeNormal())), 0.1);
        }
        void main() {
            col = vec4(vec3(normalisedHeight), 1.0);
            col.rgb = vec3(computeSteepness());
        }
        `
        jp2Texture(this.url).then(result => {
            const w = result.frameInfo.width, h = result.frameInfo.height;
            const uniforms = {
                heightFeild: { value: result.texture },
                heightMin: { value: 0 }, heightMax: { value: 20 },
                EPS: { value: new THREE.Vector2(1/w, 1/h) },
                horizontalScale: { value: 1000 },
                gridSizeX: { value: w }, gridSizeY: { value: h }
            }
            const mat = new THREE.RawShaderMaterial({vertexShader: vert, fragmentShader: frag, uniforms: uniforms});
            mat.side = THREE.DoubleSide;
            this.geo.drawRange.count = (w-1)*(h-1)*6;
            if (w!==2000 || h !== 2000) alert('whoopsie, expected everything to always be 2k^2');
            this.geo.setIndex(indicesAttribute2kGrid);
            const mesh = new THREE.Mesh(this.geo, mat);
            mesh.frustumCulled = false; //TODO: appropriate bounding box
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