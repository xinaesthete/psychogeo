import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import { globalUniforms } from '../threact/threact';
import { computeTriangleGridIndices, ThreactTrackballBase } from '../threact/threexample';
import { EastNorth } from './Coordinates';
import * as dsm_cat from './dsm_catalog.json' //pending rethink of API...
import * as dtm_10m from './10m_dtm_catalog.json' //similarly pending rethink of API...
import { threeGeometryFromShpZip } from './ShpProcessor';
import { applyCustomDepth, applyCustomDepthForViewshed, getTileMaterial, tileLoadingMat } from './TileShader';
import { loadGpxGeometry } from './TrackVis';
import { getLodUniforms, LOD_LEVELS, tileGeom } from './LodUtils';


const cat = (dsm_cat as any).default;
const cat10m = (dtm_10m as any).default;
type DsmSources = Partial<Record<"500" | "1000" | "2000", string>>;
interface DsmCatItem {
    min_ele?: number;
    max_ele?: number;
    valid_percent?: number,
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
    //XXX: tried passing 4096 instead of 1000, but WRONG.
    const e = Math.floor(coord.east /1000) * 1000;
    const n = Math.floor(coord.north/1000) * 1000;
    return {east: e, north: n};
}
/**
 * Given coordinates (in the form found in dsm_cat...), see if we can find a corresponding tile and return some info about it.
 * @param x 
 * @param y 
 */
export function getTileProperties(coord: EastNorth, lowRes = false) {
    const low = truncateEastNorth(coord);
    //almost robust enough for critical medical data...
    const k = low.east + ", " + low.north;

    return lowRes ? cat10m[k] : cat[k] as DsmCatItem;
}

export function getImageFilename(source_filename: string, lowRes = false) {
    if (lowRes) return "/ttile/" + source_filename;
    return "/tile/" + source_filename; // /tile/ interpreted as url for fetch, tile: uses electron api
}



//make this false to use PlaneBufferGeometry
//should allow us to use more standard shaders, with displacement map for terrain
//but not working.
export const attributeless = true, onlyDebugGeometry = false;


const nullInfo: DsmCatItem = {
    xllcorner:0, yllcorner: 0, min_ele:0, max_ele:0, ncols:0, nrows:0, 
    source_filename: "no", sources: {"500": "no"}, valid_percent: 0, mesh: new THREE.Object3D()
};
nullInfo.mesh!.userData.isNull = true;

// at the moment, this is only called from LazyLoader which already has it's info object
// we shouldn't really be making a whole grid of these things, but as of now, could be passing that
// rather than coord
async function getTileMesh(info: DsmCatItem, lowRes = false) {
    //let's call this differently for a low-res layer.
    // let info = getTileProperties(coord, lowRes) || nullInfo;
    // if (info.mesh) return info; //!!! this breaks when more than one scene uses the same tile.
    //// but we'll still be using a cached texture.

    const sources = info.sources;
    const source = !sources ? info.source_filename : sources[2000] || sources[1000] || sources[500]!;
    const url = getImageFilename(source, lowRes);
    
    const {texture, frameInfo} = await JP2.jp2Texture(url, lowRes); //lowRes also means 'fullFloat' at the moment
    const w = frameInfo.width, h = frameInfo.height;
    const lodObj = new THREE.LOD();
    const s = lowRes ? 40960 : 1000;
    // for now there's a weak convention that lowRes also means non-normalised data
    // and doesn't include stats. that might change, and we should more clearly flag.
    const eleScale = lowRes ? 1 : info.max_ele! - info.min_ele!;
    lodObj.scale.set(s, s, eleScale);
    lodObj.position.z = info.min_ele??0;
    for (let lod = 0; lod<LOD_LEVELS; lod++) {
        const uniforms = {
            heightFeild: { value: texture },
            heightMin: { value: info.min_ele?? 0 }, heightMax: { value: info.max_ele?? 1 },
            ...getLodUniforms(lod),
            horizontalScale: { value: 1 },
            iTime: globalUniforms.iTime,
        };
        const geo = tileGeom[lod]; //regardless of image geom, for now
        
        const mat = attributeless ? getTileMaterial(uniforms) : new THREE.MeshStandardMaterial();
        // mat.wireframe = true;
        if (!attributeless) {
            let material = mat as THREE.MeshStandardMaterial;
            material.displacementMap = texture;
            material.displacementScale = 1;//info.max_ele - info.min_ele; //handled by matrix (for now)
        }
        const mesh = new THREE.Mesh(geo, mat);
        applyCustomDepth(mesh, uniforms);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
        //this could be tweakable (integer only, higher values lower detail)
        const lodBias = 8;
        lodObj.addLevel(mesh, Math.pow(2,lod-lodBias) * s);
    }

    info.mesh = lodObj;
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
    constructor(info: DsmCatItem, parent: THREE.Object3D) {
        let obj = this.object3D = new THREE.Mesh(LazyTile.loaderGeometry, LazyTile.loaderMat);
        const dx = info.xllcorner;
        const dy = info.yllcorner;
        //info should really have grid size, hacking in on the basis of what is true right now
        //but future Pete / anyone else attempting to maintain code will not be happy if not fixed
        const lowRes = info.max_ele === undefined;
        const s = lowRes ? 40960 : 1000;
        obj.position.x = dx + s/2;
        obj.position.y = dy + s/2;
        obj.position.z = info.min_ele??0;
        const eleScale = lowRes? 1 : info.max_ele!-info.min_ele!;
        obj.scale.set(s, s, eleScale);
        parent.add(obj);
        obj.onBeforeRender = () => {
            this.status = TileStatus.Loading;
            parent.remove(obj);
            const loadingMesh = new THREE.Mesh(obj.geometry, tileLoadingMat);
            loadingMesh.position.x = dx + s/2;
            loadingMesh.position.y = dy + s/2;
            loadingMesh.position.z = info.min_ele??0;
            loadingMesh.scale.set(s, s, eleScale);
            parent.add(loadingMesh);
    
            //TODO: add intermediate 'loading' graphic & 'error' debug info.
            getTileMesh(info, lowRes).then(m => {
                this.status = TileStatus.Loaded;
                parent.remove(loadingMesh);
                m.mesh!.position.x = dx;
                m.mesh!.position.y = dy;
                this.object3D = m.mesh!;
                if (lowRes) this.object3D.position.z = -100;
                parent.add(this.object3D);
            });
        }
    }
}
const osTerrainMat = new THREE.MeshStandardMaterial({
    wireframe: false, color: 0x60e580, flatShading: true,
    side: THREE.BackSide, shadowSide: THREE.BackSide
});
// osTerrainMat.side = THREE.DoubleSide;
osTerrainMat.shadowSide = THREE.DoubleSide;

class LazyTileOS {
    static loaderGeometry = new THREE.BoxBufferGeometry(10000, 10000, 200);
    object3D: THREE.Object3D;
    status = TileStatus.UnTouched;
    constructor(coord: EastNorth, parent: THREE.Object3D) {
        const tileSize = 10000;
        let obj = this.object3D = new THREE.Mesh(LazyTileOS.loaderGeometry, LazyTile.loaderMat);
        const xll = Math.floor(coord.east / tileSize) * tileSize;
        const yll = Math.floor(coord.north / tileSize) * tileSize;
        obj.position.x = xll + tileSize/2;
        obj.position.y = yll + tileSize/2;
        parent.add(obj);
        obj.onBeforeRender = () => {
            this.status = TileStatus.Loading;
            parent.remove(obj);
            const loadingMesh = new THREE.Mesh(obj.geometry, tileLoadingMat);
            loadingMesh.position.copy(obj.position);
            parent.add(loadingMesh);
            getOSDelaunayMesh(coord).then(mesh => {
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
async function getOSDelaunayMesh(coord: EastNorth) {
    try {
        const geo = await threeGeometryFromShpZip(coord);
        //would be better to do this in worker, but it currently doesn't have THREE...
        /// -- I'm now doing this in Rust, but it may still have problems so might want to uncomment:
        if (!geo.attributes["normal"]) geo.computeVertexNormals();
        const mat = osTerrainMat;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
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
    defra10mDTMLayer?: boolean;
    tracks?: Track[];
    camZ: number;
}
export interface Track {
    url: string;
    heightOffset?: number;
    colour?: number;
}
export class TerrainRenderer extends ThreactTrackballBase {
    coord: EastNorth;
    tileProp: DsmCatItem;
    tiles: LazyTile[] = [];
    options: TerrainOptions;
    constructor(coord: EastNorth, options: TerrainOptions = {
        osTerr50Layer: false, defraDSMLayer: false, camZ: 15000, defra10mDTMLayer: true
    }) {
        super();
        this.coord = {...coord};
        this.tileProp = getTileProperties(coord);
        this.addAxes();
        this.options = options; //AKA props
        if (options.tracks) {
            options.tracks.forEach(t=>this.addTrack(t));
        }
    }
    addMarker() {
        const info = this.tileProp;
        if (!info) return;
        const markerMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0.5, color: 0xffffff});
        const m = new THREE.Mesh(new THREE.SphereBufferGeometry(5, 30, 30), markerMat);
        // m.position.x = this.coord.east - info.xllcorner;
        // m.position.y = this.coord.north - info.yllcorner;
        m.position.z = info.min_ele??0;
        m.scale.z = (info.max_ele! - info.min_ele!) / 10;

        this.scene.add(m);
    }
    async addTrack(track: Track) {//url: string, heightOffset = 2, color = 0xffffff) {
        const {url, heightOffset = 2, colour = 0xffffff} = track;
        this.scene.add(await loadGpxGeometry(url, heightOffset, colour));
    }
    addAxes() {
        const ax = new THREE.AxesHelper(100);
        ax.position.set(this.coord.east, this.coord.north, 0);//this.tileProp.min_ele);
        // ax.position = this.trackCtrl!.target
        
        this.scene.add(ax);
    }
    init() {
        //const info = this.tileProp;
        this.camera.near = 1;
        this.camera.far = 2000000;
        this.camera.position.x = this.coord.east;
        this.camera.position.y = this.coord.north;// - 100;
        this.camera.position.z = this.options.camZ;
        // this.camera.lookAt(this.coord.east, this.coord.north, 0); //will be overriden by trackball control
        // this.camera.quaternion._onChange(()=>{debugger});
        this.trackCtrl!.target.set(this.coord.east, this.coord.north, 0);
        
        //todo: change to OrbitControls with no screenspace panning?

        this.sunLight();
        
        this.addMarker();
        if (onlyDebugGeometry) this.planeBaseTest();
        //this.shpTest();
        if (this.options.osTerr50Layer) this.bigShpTest();
        if (this.options.defraDSMLayer && !onlyDebugGeometry) this.makeTiles().then(v => {console.log('finished making tiles')});
        if (this.options.defra10mDTMLayer) this.makeTiles(true).then(v => {console.log('finished making low-res tiles')});
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
        JP2.jp2Texture(getImageFilename(this.tileProp.source_filename), false).then(({texture, frameInfo}) => {
            mat.displacementMap = texture;
            mat.displacementScale = (this.tileProp.max_ele! - this.tileProp.min_ele!) * 10;
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
                //some of these coords won't have any data; we just swallow a few exceptions.
                const coord = {east: o.east + 10000 * i, north: o.north + 10000 * j};
                new LazyTileOS(coord, this.scene);
            }
        }
    }
    async makeTiles(lowRes = false) {
        Object.entries(lowRes ? cat10m : cat).forEach((k) => {
            const info = k[1] as DsmCatItem;
            this.tiles.push(new LazyTile(info, this.scene));
        });
    }
    update() {
        //LOD is now done with THREE.LOD, although we may benefit from a different distance function.
        //if so, we won't have a separate updateLOD() pass here.
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