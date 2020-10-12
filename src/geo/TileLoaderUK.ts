import * as THREE from 'three';
import { computeTriangleGridIndices, ThreactTrackballBase, jp2Texture, glsl } from '../threact/threexample';
import * as dsm_cat from './dsm_catalog.json'

//temporary... hopefully introduce config file & interface soon...
const sourceFolder = "C:/Users/peter/Dropbox/BlenderGIS/pyUtil/images/web/";

const cat = (dsm_cat as any).default;

interface DsmCatItem {
    min_ele: number;
    max_ele: number;
    valid_percent: number,
    xllcorner: number,
    yllcorner: number,
    nrows: number,
    ncols: number,
    source_filename: string
}

export interface EastNorth {
    east: number;
    north: number;
}

/**
 * Given coordinates (in the form found in dsm_cat...), see if we can find a corresponding tile and return some info about it.
 * @param x 
 * @param y 
 */
export function getTileProperties(x: number, y: number) {
    const xll = Math.floor(x/1000) * 1000;
    const yll = Math.floor(y/1000) * 1000;
    //almost robust enough for critical medical data...
    const k = xll + ", " + yll;

    return cat[k] as DsmCatItem;
}

export function getImageFilename(source_filename: string) {
    return sourceFolder + source_filename + "_normalised_60db.jpx";
}



const indicesAttribute2kGrid = computeTriangleGridIndices(2000, 2000);
const indicesAttribute1kGrid = computeTriangleGridIndices(1000, 1000);

const vert = glsl`
//uniform mat4 projectionMatrix, modelViewMatrix;
uniform uint gridSizeX, gridSizeY;
uniform vec2 EPS;
uniform float heightMin, heightMax;
uniform float horizontalScale;
uniform sampler2D heightFeild;
varying vec2 vUv;
varying float normalisedHeight;
varying vec3 v_modelSpacePosition;
varying vec3 v_viewSpacePosition;
float mapHeight(float h) {
    return heightMin + h * (heightMax - heightMin);
}
float getNormalisedHeight(vec2 uv) {
    vec4 v = texture2D(heightFeild, uv);
    float h = v.r + (v.g / 256.);
    return h;
}
float getHeight(vec2 uv) {
    return mapHeight(getNormalisedHeight(uv));
}
vec2 uvFromVertID() {
    uint id = uint(gl_VertexID);
    uint x = id / gridSizeY;
    uint y = id % gridSizeX;
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
`;
const frag = glsl`//#version 300 es
precision highp float;
//out vec4 col;
varying vec3 v_modelSpacePosition;
varying vec3 v_viewSpacePosition;
varying vec2 vUv;
varying float normalisedHeight;
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
    vec4 col = vec4(vec3(normalisedHeight), 1.0);
    col.rgb = vec3(computeSteepness());
    gl_FragColor = col;
}
`;

export class JP2HeightField extends ThreactTrackballBase {
    geo = new THREE.BufferGeometry();
    coord: EastNorth;
    tileProp: DsmCatItem;
    url: string;
    heightMin = 0;
    heightMax = 1;
    constructor(coord: EastNorth) {
        super();
        this.coord = coord;
        this.tileProp = getTileProperties(coord.east, coord.north);
        this.url = getImageFilename(this.tileProp.source_filename);
    }
    init() {
        this.camera.position.y = -100;
        this.camera.position.z = 50;
        this.camera.near = 1;
        this.camera.far = 200000;
        

        jp2Texture(this.url).then(result => {
            const w = result.frameInfo.width, h = result.frameInfo.height;
            const info = this.tileProp;
            const uniforms = {
                heightFeild: { value: result.texture },
                heightMin: { value: info.min_ele }, heightMax: { value: info.max_ele },
                EPS: { value: new THREE.Vector2(1/w, 1/h) },
                horizontalScale: { value: 1000 },
                gridSizeX: { value: w }, gridSizeY: { value: h }
            }
            const mat = new THREE.ShaderMaterial({vertexShader: vert, fragmentShader: frag, uniforms: uniforms});
            mat.extensions.derivatives = true;
            //mat.side = THREE.DoubleSide;
            this.geo.drawRange.count = (w-1)*(h-1)*6;
            let grid: THREE.BufferAttribute;
            if (w === 2000 &&  h === 2000) grid = indicesAttribute2kGrid;
            else if (w === 1000 &&  h === 1000) grid = indicesAttribute1kGrid;
            else grid = computeTriangleGridIndices(w, h);
            this.geo.setIndex(grid);
            const mesh = new THREE.Mesh(this.geo, mat);
            mesh.frustumCulled = false; //TODO: appropriate bounding box
            this.scene.add(mesh);
        });
    }
}