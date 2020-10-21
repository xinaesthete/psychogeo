import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices, ThreactTrackballBase, glsl } from '../threact/threexample';
import { EastNorth } from './Coordinates';
import * as dsm_cat from './dsm_catalog.json' //pending rethink of API...
import { loadGpxGeometry } from './TrackVis';


const cat = (dsm_cat as any).default;
type DsmSources = Partial<Record<"2000" | "1000" | "500", string>>;
interface DsmCatItem {
    min_ele: number;
    max_ele: number;
    valid_percent: number,
    xllcorner: number,
    yllcorner: number,
    nrows: number,
    ncols: number,
    source_filename: string,
    sources: DsmSources,
    mesh?: THREE.Object3D //nb, one caveat is that having a given Object3D expects to appear once in one scenegraph
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
    return "/tile/" + source_filename; // /tile/ interpreted as url for fetch, tile: uses electron api
}



const indicesAttribute2kGrid = computeTriangleGridIndices(2000, 2000);
const indicesAttribute1kGrid = computeTriangleGridIndices(1000, 1000);
const indicesAttribute500Grid = computeTriangleGridIndices(500, 500);

const vert = glsl`
//uniform mat4 projectionMatrix, modelViewMatrix;
uniform float iTime;
uniform uint gridSizeX, gridSizeY;
uniform vec2 EPS;
uniform float heightMin, heightMax;
uniform float horizontalScale;
uniform sampler2D heightFeild;
varying vec2 vUv;
varying float normalisedHeight;
varying vec3 v_modelSpacePosition;
varying vec3 v_worldSpacePosition;
varying vec3 v_viewSpacePosition;
varying vec3 v_normal;
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
    return vec4((uv) * horizontalScale, getNormalisedHeight(uv), 1.0);
}
vec3 computeNormal(vec2 uv, vec4 pos) {
    //what about the edges?
    vec3 p = pos.xyz;
    vec3 dx = normalize(computePos(uv + vec2(EPS.x, 0.)).xyz - p);
    vec3 dy = normalize(computePos(uv + vec2(0., EPS.y)).xyz - p);
    return normalize(cross(dx, dy)).xyz;
}
void main() {
    vec2 uv = uvFromVertID();
    vUv = uv;
    // float h = getNormalisedHeight(vUv);
    // normalisedHeight = h;
    vec4 p = computePos(vUv);
    v_normal = computeNormal(uv, p);
    normalisedHeight = p.z;
    v_modelSpacePosition = p.xyz;
    p = modelMatrix * p;
    v_worldSpacePosition = p.xyz;
    p = viewMatrix * p;
    v_viewSpacePosition = p.xyz;
    gl_Position = projectionMatrix * p;
}
`;
const frag = glsl`//#version 300 es
precision highp float;
//out vec4 col;
uniform sampler2D heightFeild;
uniform float heightMin, heightMax;
uniform float iTime;
varying vec3 v_modelSpacePosition;
varying vec3 v_worldSpacePosition;
varying vec3 v_viewSpacePosition;
varying vec2 vUv;
varying float normalisedHeight;
varying vec3 v_normal;
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
float aastep(float threshold, float value) {
    float afwidth = length(vec2(dFdx(value), dFdy(value))) * 0.70710678118654757;
    return smoothstep(threshold-afwidth, threshold+afwidth, value);
}
vec3 computeNormal() {
    vec3 p = v_worldSpacePosition;
    vec3 dx = dFdx(p);
    vec3 dy = dFdy(p);
    return normalize(cross(dx, dy));
}
//this function seems quite good at showing up certain artefacts...
float computeSteepness() {
    // return pow(1.-abs(dot(vec3(0.,0.,1.), computeNormal())), 0.5);
    return pow(1.-abs(dot(vec3(0.,0.,1.), v_normal)), 0.5);
}
float computeContour() {
    float h = getHeight(vUv);// v_worldSpacePosition.z;
    h = mod(h-3.*iTime, 5.)/5.;
    h = max(smoothstep(0.98, 1.0, h), smoothstep(0.02, 0., h));
    //h = aastep(0.5, h);
    return h;
}
void main() {
    float h = computeContour();
    float s = computeSteepness();
    // float v = normalisedHeight;
    float v = abs(getHeight(vUv) - v_worldSpacePosition.z);
    vec4 col = vec4(vec3(0.2, s*0.7, v), 1.0);
    col.rg *= vec2(h);
    // col.rg = vUv;
    gl_FragColor = col;
}
`;

const tileBSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.8);
const tileGeometry1k = new THREE.BufferGeometry();
tileGeometry1k.setIndex(indicesAttribute1kGrid);
tileGeometry1k.boundingSphere = tileBSphere;
tileGeometry1k.drawRange.count = 999 * 999 * 6;
const tileGeometry500 = new THREE.BufferGeometry();
tileGeometry500.setIndex(indicesAttribute500Grid);
tileGeometry500.boundingSphere = tileBSphere;
tileGeometry500.drawRange.count = 499 * 499 * 6;
const tileGeometry2k = new THREE.BufferGeometry();
tileGeometry2k.setIndex(indicesAttribute2kGrid);
tileGeometry2k.boundingSphere = tileBSphere;
tileGeometry2k.drawRange.count = 1999 * 1999 * 6;

const nullInfo: DsmCatItem = {
    xllcorner:0, yllcorner: 0, min_ele:0, max_ele:0, ncols:0, nrows:0, 
    source_filename: "no", sources: {"500": "no"}, valid_percent: 0, mesh: new THREE.Object3D()
};
nullInfo.mesh!.userData.isNull = true;

function getTileLOD(dist: number) {
    //TODO: work out a proper formula, change effect...
    if (dist < 2000) return 1;
    if (dist > 20000) return 64;
    if (dist > 10000) return 32;
    if (dist > 5000) return 16;
    return 8;
}

async function getTileMesh(coord: EastNorth) {
    let info = getTileProperties(coord) || nullInfo;
    //XXX: NO! when hot-module-replacement happens, keeping hold of WebGL context related resources is a problem.
    //(actually not sure in what case HMR ever would't completely replace everything here)
    if (info.mesh) return info;
    const sources = info.sources;
    const source = sources[2000] || sources[1000] || sources[500]!;
    const url = getImageFilename(source);
    
    const {texture, frameInfo} = await JP2.jp2Texture(url);
    const w = frameInfo.width, h = frameInfo.height;
    const uniforms = {
        heightFeild: { value: texture },
        heightMin: { value: info.min_ele }, heightMax: { value: info.max_ele },
        // heightMin: { value: 0 }, heightMax: { value: 1 },
        EPS: { value: new THREE.Vector2(1/w, 1/h) },
        // horizontalScale: { value: 1000 },
        horizontalScale: { value: 1 },
        gridSizeX: { value: w }, gridSizeY: { value: h },
        iTime: globalUniforms.iTime
    }
    const mat = new THREE.ShaderMaterial({vertexShader: vert, fragmentShader: frag, uniforms: uniforms});
    mat.extensions.derivatives = true;
    mat.side = THREE.DoubleSide;
    let geo: THREE.BufferGeometry;
    if (w === 2000 &&  h === 2000) geo = tileGeometry2k;
    else if (w === 1000 &&  h === 1000) geo = tileGeometry1k;
    else if (w === 500 &&  h === 500) geo = tileGeometry500;
    else {
        throw new Error('Invalid tile: check proxy is running, dimensions 500/1000/2000... also beware out of date error messages (sorry).');
        //grid = computeTriangleGridIndices(w, h);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true; //tileBSphere hopefully correct...
    mesh.scale.set(1000, 1000, info.max_ele-info.min_ele);
    mesh.position.z = info.min_ele;

    // LOD hack-----------
    const dCam = new THREE.Vector3(), offset = new THREE.Vector3(500, 500, info.min_ele), pos = new THREE.Vector3();
    const fullLODCount = (w-1)*(h-1)*6;
    mesh.onBeforeRender = (r, s, cam, g, mat, group) => {
        pos.addVectors(mesh.position, offset);
        const dist = dCam.subVectors(pos, cam.position).length();
        const geo = g as THREE.BufferGeometry;
        const lod = getTileLOD(dist);
        geo.drawRange.count = fullLODCount/lod;
        uniforms.EPS.value.x = lod/w;

        mesh.userData.lastRender = Date.now();
        mesh.userData.lastLOD = lod;

        // geo.drawRange.count = 18*(h-1);// fullLODCount/lod;
        // const wa = window as any;
        // if (!wa.EPS) wa.EPS = 1/3;
        // uniforms.EPS.value.x = wa.EPS; //lod/w;
    }
    // --------------------
    info.mesh = mesh;
    return info;
}

async function* generateTileMeshes(coord: EastNorth, numX: number, numY: number) {
    for (let i=0; i<numX; i++) {
        const dx = -(numX*500) + i*1000;
        const e = coord.east + dx;
        for (let j=0; j<numY; j++) {
            const dy = -(numY*500) + j*1000;
            const n = coord.north + dy;
            const m = await getTileMesh({east: e, north: n});
            //TODO: more clarity about origin in scene etc.
            m.mesh!.position.x = dx;
            m.mesh!.position.y = dy;
            yield m;
        }
    }
    return;
}

class LazyTile {
    static loaderGeometry = new THREE.BoxBufferGeometry();
    static loaderMat = new THREE.MeshBasicMaterial({transparent: true, color: 0x800000, opacity: 0.5, blending: THREE.AdditiveBlending});
    object3D: THREE.Object3D;
    constructor(info: DsmCatItem, origin: EastNorth, parent: THREE.Object3D) {
        let obj = this.object3D = new THREE.Mesh(LazyTile.loaderGeometry, LazyTile.loaderMat);
        const coord = {east: info.xllcorner, north: info.yllcorner};
        const dx = info.xllcorner - origin.east;
        const dy = info.yllcorner - origin.north;
        obj.position.x = dx;
        obj.position.y = dy;
        obj.position.z = info.min_ele;
        obj.scale.set(1000, 1000, info.max_ele-info.min_ele);
        parent.add(obj);
        obj.onBeforeRender = () => {
            parent.remove(obj);
            //TODO: add intermediate 'loading' graphic & 'error' debug info.
            getTileMesh(coord).then(m => {
                m.mesh!.position.x = dx;
                m.mesh!.position.y = dy;
                this.object3D = m.mesh!;
                parent.add(this.object3D);
            });
        }
    }
}

type TileGenerator = AsyncGenerator<DsmCatItem, void, unknown>;
export class JP2HeightField extends ThreactTrackballBase {
    coord: EastNorth;
    tileProp: DsmCatItem;
    //tileGen: TileGenerator;
    constructor(coord: EastNorth) {
        super();
        this.coord = {...coord};
        this.tileProp = getTileProperties(coord);
        this.addAxes();
        //this.tileGen = generateTileMeshes(this.coord, 2, 2);
    }
    addMarker() {
        const info = this.tileProp;
        //const markerMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0.5, color: 0xff0000});
        const m = new THREE.PointLight();// THREE.Mesh(new THREE.SphereBufferGeometry(5, 30, 30), markerMat);
        m.castShadow = true;
        m.position.x = this.coord.east - info.xllcorner;
        m.position.y = this.coord.north - info.yllcorner;
        m.position.z = info.min_ele;
        m.scale.z = (info.max_ele - info.min_ele) / 10;

        this.scene.add(m);
    }
    async addTrack(url: string) {
        this.scene.add(await loadGpxGeometry(url, this.coord));
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
        this.makeTiles().then(v => {console.log('finished making tiles')});
    }
    async makeTiles() {
        Object.entries(cat).forEach((k) => {
            const info = k[1] as DsmCatItem;
            const t = new LazyTile(info, this.coord, this.scene);
        });
    }
    async makeTilesX() {
        const tileGen = generateTileMeshes(this.coord, 10000, 10000);
        const t = Date.now();
        let skipped = 0, tried = 0;
        for await (const tile of tileGen) {
            tried++;
            const m = tile.mesh!;
            if (m.userData.isNull) {
                skipped++;
                continue;
            }
            this.scene.add(tile.mesh!);
        }
        const dt = new Date(Date.now()-t).toLocaleTimeString();
        console.log(`finished loading tile data in ${dt}`);
        console.log(`skipped ${Math.floor(skipped*100/tried)}%`);
    }
    update() {
        super.update();
    }
}

/**
 * Pending better formalisation of GL resource management,
 * at the time of writing, this should be called from the main application, 
 * and is responsible for calling whatever methods are necessary to clear caches etc in other modules.
 */
export function newGLContext() {
    console.log('<< TileLoaderUK newGLContext() >>');
    JP2.newGLContext();
    Object.entries<DsmCatItem>(cat).forEach((v) => {
        v[1].mesh = undefined;
    });
}
//newGLCoxtent();