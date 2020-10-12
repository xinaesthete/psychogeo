import * as THREE from 'three';
import { jp2Texture } from '../openjpegjs/jp2kloader';
import { computeTriangleGridIndices, ThreactTrackballBase, glsl } from '../threact/threexample';
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
    source_filename: string,
    mesh?: THREE.Mesh
}

export interface EastNorth {
    east: number;
    north: number;
}

/** 
 * return the lower-left corner of the grid cell containing coord
 * used to derive index for looking up in catalog / cache.
 */
function truncateEastNorth(coord: EastNorth) {
    const e = Math.floor(coord.east /1000) * 1000;
    const n = Math.floor(coord.north/1000) * 1000;
    return {east: e, north: n};
}
/**
 * Given coordinates (in the form found in dsm_cat...), see if we can find a corresponding tile and return some info about it.
 * @param x 
 * @param y 
 */
export function getTileProperties(coord: EastNorth) {
    const low = truncateEastNorth(coord);
    //almost robust enough for critical medical data...
    const k = low.east + ", " + low.north;

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
    uv.y = 1. - uv.y;
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
vec4 computePos(vec2 uv) {
    return vec4((uv) * horizontalScale, getHeight(uv), 1.0);
}
void main() {
    vec2 uv = uvFromVertID();
    vUv = uv;
    float h = getNormalisedHeight(vUv);
    normalisedHeight = h;
    vec4 p = computePos(vUv);
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
    return pow(1.-abs(dot(vec3(0.,0.,1.), computeNormal())), 0.5);
}
void main() {
    vec4 col = vec4(vec3(normalisedHeight), 1.0);
    col.rgb = vec3(computeSteepness());
    // col.rg = vUv;
    gl_FragColor = col;
}
`;

const tileBSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.8);
const tileGeometry1k = new THREE.BufferGeometry();
tileGeometry1k.setIndex(indicesAttribute1kGrid);
tileGeometry1k.boundingSphere = tileBSphere;
tileGeometry1k.drawRange.count = 999 * 999 * 6;
const tileGeometry2k = new THREE.BufferGeometry();
tileGeometry2k.setIndex(indicesAttribute2kGrid);
tileGeometry2k.boundingSphere = tileBSphere;
tileGeometry2k.drawRange.count = 1999 * 1999 * 6;


async function getTileMesh(coord: EastNorth) {
    const info = getTileProperties(coord);
    if (info.mesh) return info;
    const url = getImageFilename(info.source_filename);
    const {texture, frameInfo} = await jp2Texture(url);
    const w = frameInfo.width, h = frameInfo.height;
    const uniforms = {
        heightFeild: { value: texture },
        // heightMin: { value: info.min_ele }, heightMax: { value: info.max_ele },
        heightMin: { value: 0 }, heightMax: { value: 1 },
        EPS: { value: new THREE.Vector2(1/w, 1/h) },
        // horizontalScale: { value: 1000 },
        horizontalScale: { value: 1 },
        gridSizeX: { value: w }, gridSizeY: { value: h }
    }
    const mat = new THREE.ShaderMaterial({vertexShader: vert, fragmentShader: frag, uniforms: uniforms});
    mat.extensions.derivatives = true;
    mat.side = THREE.DoubleSide;
    let geo: THREE.BufferGeometry;
    if (w === 2000 &&  h === 2000) geo = tileGeometry2k;
    else if (w === 1000 &&  h === 1000) geo = tileGeometry1k;
    else {
        throw new Error('only working with 1k & 2k grid');
        //grid = computeTriangleGridIndices(w, h);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true; //tileBSphere hopefully correct...
    mesh.scale.set(1000, 1000, info.max_ele-info.min_ele);
    mesh.position.z = info.min_ele;
    
    info.mesh = mesh;
    return info;
}

export class JP2HeightField extends ThreactTrackballBase {
    coord: EastNorth;
    tileProp: DsmCatItem;
    url: string;
    constructor(coord: EastNorth) {
        super();
        this.coord = {...coord};
        this.tileProp = getTileProperties(coord);
        this.url = getImageFilename(this.tileProp.source_filename);
        this.addAxes();
    }
    addMarker() {
        const info = this.tileProp;
        const markerMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0.5, color: 0xff0000});
        const m = new THREE.Mesh(new THREE.SphereBufferGeometry(5, 30, 30), markerMat);
        m.position.x = this.coord.east - info.xllcorner;
        m.position.y = this.coord.north - info.yllcorner;
        m.position.z = info.max_ele;
        m.scale.z = (info.max_ele - info.min_ele) / 10;

        this.scene.add(m);
    }
    addAxes() {
        const ax = new THREE.AxesHelper(100);
        ax.position.set(0, 0, this.tileProp.min_ele);
        this.scene.add(ax);
    }
    init() {
        const info = this.tileProp;
        this.camera.position.y = -100;
        this.camera.position.z = info.max_ele + 50;
        this.camera.lookAt(0, 0, info.max_ele);
        this.camera.near = 1;
        this.camera.far = 200000;
        
        this.addMarker();

        getTileMesh(this.coord).then(info => this.scene.add(info.mesh!));
    }
}