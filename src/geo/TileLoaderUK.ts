import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import {
    configureTerrainZoomLimits,
    setTerrainCameraTarget,
} from '../camera/mapControls';
import { OBLIQUE_PITCH, applySphericalToCamera } from '../camera/viewState';
import { ThreactTrackballBase } from '../threact/threexample';
import { EastNorth } from './Coordinates';
import dsmCatalog from './dsm_catalog.json';
import dtm10mCatalog from './10m_dtm_catalog.json';
import { threeGeometryFromShpZip } from './ShpProcessor';
import {
    applyCustomDepthForViewshed,
    getTileLoadingMaterial,
    tickTileShader,
} from './tileShaderRuntime';
import { loadGpxGeometry } from './TrackVis';
import { syncCompressionExperiment } from './compressionExperiment';
import { getTileMesh } from './LodUtils';


type DsmSources = Partial<Record<"500" | "1000" | "2000", string>>;
export interface DsmCatItem {
    min_ele?: number;
    max_ele?: number;
    valid_percent?: number,
    xllcorner: number,
    yllcorner: number,
    nrows: number,
    ncols: number,
    source_filename: string,
    sources?: DsmSources,
    mesh?: THREE.Object3D //nb, one caveat is that having a given Object3D expects to appear once in one scenegraph
}

const cat: Record<string, DsmCatItem> = dsmCatalog;
const cat10m: Record<string, DsmCatItem> = dtm10mCatalog;


/** 
 * return the lower-left corner of the grid cell containing coord
 * used to derive index for looking up in catalog / cache.
 */
function truncateEastNorth(coord: EastNorth, lowRes = false) {
    //XXX: tried passing 4096 instead of 1000, but WRONG.
    const s = lowRes ? 1000 : 40960; //is this properly tested (no)?
    const e = Math.floor(coord.east /s) * s;
    const n = Math.floor(coord.north/s) * s;
    return {east: e, north: n};
}
/**
 * Given coordinates (in the form found in dsm_cat...), see if we can find a corresponding tile and return some info about it.
 * @param x 
 * @param y 
 */
export function getTileProperties(coord: EastNorth, lowRes = false) {
    const low = truncateEastNorth(coord, lowRes);
    const k = low.east + ", " + low.north;

    return (lowRes ? cat10m[k] : cat[k]);
}

/** @param useJ2k When true on 10m DTM, fetch HTJ2K via `/ltile/` (required for worker recode). */
export function getImageFilename(source_filename: string, lowRes = false, useJ2k = false) {
    if (lowRes) return (useJ2k ? "/ltile/" : "/ttile/") + source_filename;
    return "/tile/" + source_filename; // /tile/ interpreted as url for fetch, tile: uses electron api
}



//make this false to use PlaneBufferGeometry
//should allow us to use more standard shaders, with displacement map for terrain
//but not working.
export const onlyDebugGeometry = false;


const nullInfo: DsmCatItem = {
    xllcorner:0, yllcorner: 0, min_ele:0, max_ele:0, ncols:0, nrows:0, 
    source_filename: "no", sources: {"500": "no"}, valid_percent: 0, mesh: new THREE.Object3D()
};
nullInfo.mesh!.userData.isNull = true;


//may consider throttling how many tiles load at a time & having a status to indicate that.
enum TileStatus { UnTouched, Loading, Loaded, Error } 
class LazyTile {
    static loaderGeometry = new THREE.BoxGeometry();
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
            const loadingMesh = new THREE.Mesh(obj.geometry, getTileLoadingMaterial());
            loadingMesh.position.x = dx + s/2;
            loadingMesh.position.y = dy + s/2;
            loadingMesh.position.z = info.min_ele??0;
            loadingMesh.scale.set(s, s, eleScale);
            parent.add(loadingMesh);
    
            //TODO: add intermediate 'loading' graphic & 'error' debug info.
            //potentially pass something with the ability to cancel loading.
            //(take some inspiration from goroutines)
            getTileMesh(info, lowRes).then(m => {
                this.status = TileStatus.Loaded;
                parent.remove(loadingMesh);
                m.mesh!.position.x = dx + s/2;
                m.mesh!.position.y = dy + s/2;
                this.object3D = m.mesh!;
                // if (lowRes) this.object3D.position.z = -100;
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
    static loaderGeometry = new THREE.BoxGeometry(10000, 10000, 200);
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
            const loadingMesh = new THREE.Mesh(obj.geometry, getTileLoadingMaterial());
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
        
        applyCustomDepthForViewshed(mesh);
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
    /** Runtime JP2 recode + dual-height shader experiment (off by default). */
    compressionExperimentEnabled?: boolean;
    tracks?: Track[];
    sun?: boolean;
    camZ: number;
    /** R3F / external OrbitControls own the camera; skip internal map controls. */
    externalControls?: boolean;
}
export interface Track {
    url: string;
    heightOffset?: number;
    colour?: number;
}
const defaultTerrainOptions: TerrainOptions = {
    osTerr50Layer: false,
    defraDSMLayer: false,
    defra10mDTMLayer: true,
    compressionExperimentEnabled: false,
    camZ: 15000,
    sun: true,
};
export class TerrainRenderer extends ThreactTrackballBase {
    coord: EastNorth;
    tileProp: DsmCatItem;
    tiles: LazyTile[] = [];
    options: TerrainOptions;
    lightRig?: THREE.Group;
    readonly dsmLayer = new THREE.Group();
    readonly dtmLayer = new THREE.Group();
    readonly osTerr50Layer = new THREE.Group();
    private terrainInited = false;
    private markerAdded = false;
    private dsmTilesLoaded = false;
    private dtmTilesLoaded = false;
    private osTerr50Loaded = false;
    private readonly loadedTracks = new Map<string, THREE.Group>();
    private desiredTrackUrls = new Set<string>();

    isTerrainInited(): boolean {
        return this.terrainInited;
    }

    /** Merge Leva / React options without resetting the camera. */
    updateOptions(patch: Partial<TerrainOptions>): void {
        this.options = {
            ...this.options,
            ...patch,
            camZ: patch.camZ ?? this.options.camZ,
            sun: patch.sun ?? this.options.sun,
        };
        if (patch.externalControls) {
            this.externalControls = true;
        }
        this.mapControlsOptions = {
            initialDistance: this.options.camZ,
            referenceDistance: this.options.camZ,
        };
        syncCompressionExperiment(!!this.options.compressionExperimentEnabled);
        if (this.terrainInited) {
            this.applyTerrainOptions();
        }
        this.syncTracks(this.options.tracks ?? []);
    }

    /** Call when using external controls (R3F) instead of Threact initThree. */
    ensureTerrainInit(): void {
        if (this.terrainInited) return;
        this.init();
    }
    constructor(coord: EastNorth, options: TerrainOptions = defaultTerrainOptions) {
        super();
        this.externalControls = options.externalControls ?? false;
        this.mapControlsOptions = {
            initialDistance: options.camZ,
            referenceDistance: options.camZ,
        };
        this.options = {
            ...defaultTerrainOptions,
            ...options,
            sun: options.sun ?? defaultTerrainOptions.sun,
        };
        syncCompressionExperiment(!!this.options.compressionExperimentEnabled);
        console.table(this.options);
        this.coord = {...coord};
        this.tileProp = getTileProperties(coord);
        this.scene.add(this.dsmLayer);
        this.scene.add(this.dtmLayer);
        this.scene.add(this.osTerr50Layer);
        this.syncLayerVisibility();
        this.addAxes();
        if (this.options.tracks?.length) {
            this.syncTracks(this.options.tracks);
        }
    }
    addMarker() {
        const info = this.tileProp;
        if (!info) return;
        const markerMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0.5, color: 0xffffff});
        const m = new THREE.Mesh(new THREE.SphereGeometry(5, 30, 30), markerMat);
        // m.position.x = this.coord.east - info.xllcorner;
        // m.position.y = this.coord.north - info.yllcorner;
        m.position.z = info.min_ele??0;
        m.scale.z = (info.max_ele! - info.min_ele!) / 10;

        this.scene.add(m);
    }
    async addTrack(track: Track): Promise<THREE.Group | null> {
        const {url, heightOffset = 2, colour = 0xffffff} = track;
        const group = await loadGpxGeometry(url, heightOffset, colour);
        if (!this.desiredTrackUrls.has(url)) {
            return null;
        }
        this.scene.add(group);
        this.loadedTracks.set(url, group);
        return group;
    }

    removeTrack(url: string): void {
        const group = this.loadedTracks.get(url);
        if (!group) return;
        this.scene.remove(group);
        this.loadedTracks.delete(url);
    }

    /** Add/remove scene overlays to match the React track selection. */
    syncTracks(tracks: Track[]): void {
        this.desiredTrackUrls = new Set(tracks.map((t) => t.url));
        for (const url of [...this.loadedTracks.keys()]) {
            if (!this.desiredTrackUrls.has(url)) this.removeTrack(url);
        }
        for (const track of tracks) {
            if (!this.loadedTracks.has(track.url)) {
                void this.addTrack(track).catch((e) => {
                    console.error(`track load failed: ${track.url}`, e);
                    this.loadedTracks.delete(track.url);
                });
            }
        }
    }

    private syncLayerVisibility(): void {
        this.dsmLayer.visible = !!this.options.defraDSMLayer;
        this.dtmLayer.visible = !!this.options.defra10mDTMLayer;
        this.osTerr50Layer.visible = !!this.options.osTerr50Layer;
    }
    addAxes() {
        const ax = new THREE.AxesHelper(100);
        ax.position.set(this.coord.east, this.coord.north, 0);//this.tileProp.min_ele);
        // ax.position = this.mapCtrl!.target
        
        this.scene.add(ax);
    }
    init() {
        this.resetCamera();
        this.applyTerrainOptions();
        this.terrainInited = true;
    }

    resetCamera() {
        this.camera.near = 1;
        this.camera.far = 2000000;
        const camZ = this.options.camZ;
        if (this.mapCtrl) {
            configureTerrainZoomLimits(this.mapCtrl, camZ);
            setTerrainCameraTarget(this.mapCtrl, this.camera, this.coord, camZ);
        } else {
            const target = new THREE.Vector3(this.coord.east, this.coord.north, 0);
            applySphericalToCamera(this.camera, target, 0, OBLIQUE_PITCH, camZ);
        }
    }

    applyTerrainOptions() {
        syncCompressionExperiment(!!this.options.compressionExperimentEnabled);
        this.syncLightRig();
        this.syncLayerVisibility();
        if (!this.markerAdded) {
            this.addMarker();
            this.markerAdded = true;
        }
        if (this.options.osTerr50Layer && !this.osTerr50Loaded) {
            this.osTerr50Loaded = true;
            void this.bigShpTest();
        }
        if (this.options.defraDSMLayer && !this.dsmTilesLoaded) {
            this.dsmTilesLoaded = true;
            void this.makeTiles().then(() => console.log('finished making tiles'));
        }
        if (this.options.defra10mDTMLayer && !this.dtmTilesLoaded) {
            this.dtmTilesLoaded = true;
            void this.makeTiles(true).then(() => console.log('finished making low-res tiles'));
        }
    }
    private createLightRig() {
        const rig = new THREE.Group();
        // A small fill rig keeps terrain readable when we are just inspecting geometry,
        // while still preserving directional shading cues from a "sun" key light.
        const skyFill = new THREE.HemisphereLight(0xe8f3ff, 0x2d3b1f, 0.85);
        rig.add(skyFill);

        const sun = new THREE.DirectionalLight(0xffefcf, 1.15);
        sun.position.set(-12000, -7000, 16000);
        sun.target.position.set(this.coord.east, this.coord.north, 0);
        sun.castShadow = true;
        rig.add(sun.target);
        rig.add(sun);

        const rim = new THREE.DirectionalLight(0x8aa7d6, 0.3);
        rim.position.set(9000, 14000, 6000);
        rim.target.position.set(this.coord.east, this.coord.north, 0);
        rig.add(rim.target);
        rig.add(rim);
        return rig;
    }
    private syncLightRig() {
        if (this.options.sun) {
            if (!this.lightRig) {
                this.lightRig = this.createLightRig();
                this.scene.add(this.lightRig);
            }
            return;
        }
        if (this.lightRig) {
            this.scene.remove(this.lightRig);
            this.lightRig = undefined;
        }
    }
    //TODO: manage tiles differently, particularly LOD.
    async bigShpTest() {
        const o = this.coord;
        for (let i=-30; i<30; i++) {
            for (let j=-10; j<100; j++) {
                //some of these coords won't have any data; we just swallow a few exceptions.
                const coord = {east: o.east + 10000 * i, north: o.north + 10000 * j};
                new LazyTileOS(coord, this.osTerr50Layer);
            }
        }
    }
    async makeTiles(lowRes = false) {
        const parent = lowRes ? this.dtmLayer : this.dsmLayer;
        Object.entries(lowRes ? cat10m : cat).forEach((k) => {
            const info = k[1];
            this.tiles.push(new LazyTile(info, parent));
        });
    }
    update() {
        tickTileShader();
        //LOD is now done with THREE.LOD, although we may benefit from a different distance function.
        //if so, we won't have a separate updateLOD() pass here.
        this.syncLightRig();
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
