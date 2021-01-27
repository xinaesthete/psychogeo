import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices, ThreactTrackballBase } from '../threact/threexample';
import { EastNorth } from './Coordinates';
import * as dsm_cat from './dsm_catalog.json' //pending rethink of API...
import { threeGeometryFromShpZip } from './ShpProcessor';
import { applyCustomDepth, applyCustomDepthForViewshed, getTileMaterial, tileLoadingMat } from './TileShader';
import { loadGpxGeometry } from './TrackVis';


const cat = (dsm_cat as any).default;
type DsmSources = Partial<Record<"500" | "1000" | "2000", string>>;
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



const tileBSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.8);
const tileBBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));

//make this false to use PlaneBufferGeometry
//should allow us to use more standard shaders, with displacement map for terrain
//but not working.
const attributeless = true, onlyDebugGeometry = false;

function makeTileGeometry(s: number) {
    let geo : THREE.BufferGeometry;
    if (attributeless) {
        geo = new THREE.BufferGeometry();
        geo.drawRange.count = (s-1) * (s-1) * 6;
        geo.setIndex(computeTriangleGridIndices(s, s));
    } else {
        geo = new THREE.PlaneBufferGeometry(1, 1, s, s);
        geo.translate(0.5, 0.5, 0.5);
        geo.computeVertexNormals();
    }
    //would these be able to account for displacement if computed automatically?
    geo.boundingSphere = tileBSphere;
    geo.boundingBox = tileBBox;
    return geo;
}

const LOD_LEVELS = 8;
/** by LOD, 0 is 2k, 1 is 1k, 2 is 500... powers of 2 might've been nice if the original data was like that */
const tileGeom: THREE.BufferGeometry[] = [];
for (let i=0; i<LOD_LEVELS; i++) {
    tileGeom.push(makeTileGeometry(Math.floor(2000 / Math.pow(2, i))));
}
let lodFalloffFactor = 700; //TODO control this depending on hardware etc.
function getTileLOD(dist: number) {
    return Math.pow(2, Math.min(LOD_LEVELS-1, Math.round(Math.sqrt(dist/lodFalloffFactor))));
}


const nullInfo: DsmCatItem = {
    xllcorner:0, yllcorner: 0, min_ele:0, max_ele:0, ncols:0, nrows:0, 
    source_filename: "no", sources: {"500": "no"}, valid_percent: 0, mesh: new THREE.Object3D()
};
nullInfo.mesh!.userData.isNull = true;


async function getTileMesh(coord: EastNorth) {
    let info = getTileProperties(coord) || nullInfo;
    // if (info.mesh) return info; //!!! this breaks when more than one scene uses the same tile.
    //// but we'll still be using a cached texture.

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
    const geo = tileGeom[0]; //regardless of image geom, for now
    
    const mat = attributeless ? getTileMaterial(uniforms) : new THREE.MeshStandardMaterial();
    if (!attributeless) {
        let material = mat as THREE.MeshStandardMaterial;
        material.displacementMap = texture;
        material.displacementScale = 1;//info.max_ele - info.min_ele; //handled by matrix (for now)
    }
    const mesh = new THREE.Mesh(geo, mat);
    applyCustomDepth(mesh, uniforms);
    mesh.castShadow = true;
    mesh.receiveShadow = true; //unfortunately, I don't see them...
    mesh.scale.set(1000, 1000, info.max_ele-info.min_ele);
    mesh.position.z = info.min_ele;

    mesh.onBeforeRender = (r, s, cam, g, mat, group) => {
        mesh.userData.lastRender = Date.now();
    }
    const dCam = new THREE.Vector3(), offset = new THREE.Vector3(500, 500, info.min_ele), pos = new THREE.Vector3();
    mesh.userData.updateLOD = (otherPos: THREE.Vector3) => {
        //TODO: different LOD for shadow vs view (I think this is only called once per frame, how do I intercept shadow pass?)
        //-- could have seperate LOD in MeshDepthMaterial / MeshDistanceMaterial I guess.
        pos.addVectors(mesh.position, offset);
        //const otherPos = cam.position;
        const dist = dCam.subVectors(pos, otherPos).length();
        //could still be something to be said for changing drawRange vs switching geometry,
        //but this was half-baked, and switching geometry seems ok (as long as not done in onBeforeRender)
        // geo.drawRange.count = fullLODCount/lod; //this version would *have* to be onBeforeRender

        const lod = getTileLOD(dist);
        const lodIndex = Math.log2(lod);
        const geo = tileGeom[lodIndex];
        if (!geo) debugger;
        mesh.geometry = geo;
        const v = Math.floor(2000 / lod);
        //-- it should be that with current calculation, LOD may choose geometry with a higher resolution than tile data
        //but that shouldn't matter for EPS values, or anything else(?) aside from redundant computation.
        uniforms.EPS.value.x = 1/(v-1);
        uniforms.EPS.value.y = 1/(v-1);
        uniforms.gridSizeX.value = v;
        uniforms.gridSizeY.value = v;
        

        mesh.userData.lastLOD = lod;
    }
    mesh.userData.updateLOD(mesh.position);//prevent glitching when first loaded.
    // --------------------
    info.mesh = mesh;
    return info;
}

//may consider throttling how many tiles load at a time & having a status to indicate that.
enum TileStatus { UnTouched, Loading, Loaded, Error } 
class LazyTile {
    static loaderGeometry = new THREE.BoxBufferGeometry();
    static loaderMat = new THREE.MeshBasicMaterial({transparent: true, color: 0x800000, opacity: 0.5, blending: THREE.AdditiveBlending});
    object3D: THREE.Object3D;
    status = TileStatus.UnTouched;
    get lastRender(): number {
        return this.object3D.userData.lastRender as number;
    }
    get lastLOD(): number {
        return this.object3D.userData.lastLOD as number;
    }
    updateLOD(otherPos: THREE.Vector3) {
        const mesh = this.object3D as THREE.Mesh;
        if (!mesh.userData.updateLOD) return;
        mesh.userData.updateLOD(otherPos);
    }
    constructor(info: DsmCatItem, origin: EastNorth, parent: THREE.Object3D) {
        let obj = this.object3D = new THREE.Mesh(LazyTile.loaderGeometry, LazyTile.loaderMat);
        const coord = {east: info.xllcorner, north: info.yllcorner};
        const dx = info.xllcorner - origin.east;
        const dy = info.yllcorner - origin.north;
        obj.position.x = dx + 500;
        obj.position.y = dy + 500;
        obj.position.z = info.min_ele;
        obj.scale.set(1000, 1000, info.max_ele-info.min_ele);
        parent.add(obj);
        obj.onBeforeRender = () => {
            this.status = TileStatus.Loading;
            parent.remove(obj);
            const loadingMesh = new THREE.Mesh(obj.geometry, tileLoadingMat);
            loadingMesh.position.x = dx + 500;
            loadingMesh.position.y = dy + 500;
            loadingMesh.position.z = info.min_ele;
            loadingMesh.scale.set(1000, 1000, info.max_ele-info.min_ele);
            parent.add(loadingMesh);
    
            //TODO: add intermediate 'loading' graphic & 'error' debug info.
            getTileMesh(coord).then(m => {
                this.status = TileStatus.Loaded;
                parent.remove(loadingMesh);
                m.mesh!.position.x = dx;
                m.mesh!.position.y = dy;
                this.object3D = m.mesh!;
                parent.add(this.object3D);
            });
        }
    }
}
const osTerrainMat = new THREE.MeshStandardMaterial({
    wireframe: false, color: 0x60e580, flatShading: true
});
// osTerrainMat.side = THREE.DoubleSide;
osTerrainMat.shadowSide = THREE.DoubleSide;

class LazyTileOS {
    static loaderGeometry = new THREE.BoxBufferGeometry(10000, 10000, 200);
    object3D: THREE.Object3D;
    status = TileStatus.UnTouched;
    constructor(coord: EastNorth, origin: EastNorth, parent: THREE.Object3D) {
        let obj = this.object3D = new THREE.Mesh(LazyTileOS.loaderGeometry, LazyTile.loaderMat);
        const xll = Math.floor(coord.east / 10000) * 10000;
        const yll = Math.floor(coord.north / 10000) * 10000;
        const dx = xll - origin.east;
        const dy = yll - origin.north;
        obj.position.x = dx + 5000;
        obj.position.y = dy + 5000;
        parent.add(obj);
        obj.onBeforeRender = () => {
            this.status = TileStatus.Loading;
            parent.remove(obj);
            const loadingMesh = new THREE.Mesh(obj.geometry, tileLoadingMat);
            loadingMesh.position.copy(obj.position);
            parent.add(loadingMesh);
            getOSDelaunayMesh(coord, origin).then(mesh => {
                this.status = TileStatus.Loaded;
                parent.remove(loadingMesh);
                this.object3D = mesh;
                parent.add(mesh);
            });
        }
    }
    async rasterize(destRT: THREE.WebGLRenderTarget) {
        //render normalised height into a buffer
        //read it back into memory
        //send the data to a worker to compress & save to disk, along with appropriate metadata.
    }
}
async function getOSDelaunayMesh(coord: EastNorth, origin: EastNorth) {
    try {
        const geo = await threeGeometryFromShpZip(coord);
        //would be better to do this in worker, but it currently doesn't have THREE...
        //I might figure how to make out WebPack config for workers, but...
        geo.computeVertexNormals(); 
        const mat = osTerrainMat;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
        mesh.position.x = -origin.east;
        mesh.position.y = -origin.north;
        applyCustomDepthForViewshed(mesh as THREE.Mesh);
        return mesh;
    } catch (e) {
        console.error(e);
    }
    return nullInfo.mesh!;
}
//TODO learn react, refactor, build gui.
export interface TerrainOptions {
    osTerr50Layer?: boolean;
    defraDSMLayer?: boolean;
    camZ: number;
}
export class TerrainRenderer extends ThreactTrackballBase {
    coord: EastNorth;
    tileProp: DsmCatItem;
    tiles: LazyTile[] = [];
    options: TerrainOptions;
    constructor(coord: EastNorth, options: TerrainOptions = {
        osTerr50Layer: true, defraDSMLayer: false, camZ: 15000
    }) {
        super();
        this.coord = {...coord};
        this.tileProp = getTileProperties(coord);
        this.addAxes();
        this.options = options; //AKA props
    }
    addMarker() {
        const info = this.tileProp;
        if (!info) return;
        const markerMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0.5, color: 0xffffff});
        const m = new THREE.Mesh(new THREE.SphereBufferGeometry(5, 30, 30), markerMat);
        // m.position.x = this.coord.east - info.xllcorner;
        // m.position.y = this.coord.north - info.yllcorner;
        m.position.z = info.min_ele;
        m.scale.z = (info.max_ele - info.min_ele) / 10;

        this.scene.add(m);
    }
    async addTrack(url: string, eleOffset = 2, color = 0xffffff) {
        this.scene.add(await loadGpxGeometry(url, this, eleOffset, color));
    }
    addAxes() {
        const ax = new THREE.AxesHelper(100);
        ax.position.set(0, 0, 0);//this.tileProp.min_ele);
        this.scene.add(ax);
    }
    init() {
        //const info = this.tileProp;
        this.camera.position.y = -100;
        this.camera.position.z = this.options.camZ; //info.max_ele + 50;
        this.camera.lookAt(0, 0, 0); //info.max_ele);
        this.camera.near = 1;
        this.camera.far = 2000000;

        this.sunLight();
        
        this.addMarker();
        if (onlyDebugGeometry) this.planeBaseTest();
        //this.shpTest();
        if (this.options.osTerr50Layer) this.bigShpTest();
        if (this.options.defraDSMLayer && !onlyDebugGeometry) this.makeTiles().then(v => {console.log('finished making tiles')});
    }
    sunLight() {
        //at some point I may want to have something more usefully resembling sun, just testing for now.
        const sun = new THREE.DirectionalLight(0xa09080, 0.9);
        sun.position.set(-10000, -3000, 400);
        sun.up = new THREE.Vector3(0, 0.5, 0.5).normalize();
        sun.castShadow = true;
        this.scene.add(sun);
    }
    planeBaseTest() {
        const geo = new THREE.PlaneBufferGeometry(10000, 10000, 2000, 2000);
        const mat = new THREE.MeshStandardMaterial();
        JP2.jp2Texture(getImageFilename(this.tileProp.source_filename)).then(({texture, frameInfo}) => {
            mat.displacementMap = texture;
            mat.displacementScale = (this.tileProp.max_ele - this.tileProp.min_ele) * 10;
            const m = new THREE.Mesh(geo, mat);
            m.frustumCulled = false;
            //this is interesting: shadows definitely not working with either / both DoubleSide
            // mat.side = THREE.DoubleSide;
            // mat.shadowSide = THREE.DoubleSide;
            m.receiveShadow = true;
            m.castShadow = true;
            m.position.z = -mat.displacementScale/2;
            applyCustomDepth(m, null);
            this.scene.add(m);
        });
    }
    //TODO: manage tiles differently, particularly LOD.
    async bigShpTest() {
        const o = this.coord;
        for (let i=-30; i<30; i++) {
            for (let j=-10; j<100; j++) {
                const coord = {east: o.east + 10000 * i, north: o.north + 10000 * j};
                new LazyTileOS(coord, o, this.scene);
            }
        }
    }
    async makeTiles() {
        Object.entries(cat).forEach((k) => {
            const info = k[1] as DsmCatItem;
            this.tiles.push(new LazyTile(info, this.coord, this.scene));
        });
    }
    update() {
        //this.updateTileStats(); // generates a bit much garbage?
        this.updateLOD(); //could use THREE.LOD instead of current system.
        super.update();
    }
    updateLOD() {
        this.tiles.forEach(t => t.updateLOD(this.camera.position));
    }
    updateTileStats() {
        const loaded = this.tiles.filter(t => t.status === TileStatus.Loaded);
        const now = Date.now();
        const recentlySeen = loaded.filter(t => (now - t.lastRender) < 1000);
        const lodStats = new Map<number, number>();
        recentlySeen.forEach(t => {
            const lod = t.lastLOD;
            const n = lodStats.get(lod) || 0;
            lodStats.set(lod, n+1);

            //premature optimisation?
            //don't want to do this to all tiles, this isn't probably most correct way, 
            //but should get it done for approximately correct set of tiles before (not during) next render
            t.updateLOD(this.camera.position);
        });
        // this.tiles.forEach(t => t.updateLOD(this.camera.position));
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