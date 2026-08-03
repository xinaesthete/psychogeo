import * as THREE from 'three';
import * as JP2 from '../openjpegjs/jp2kloader';
import {
    configureTerrainZoomLimits,
    setTerrainCameraTarget,
} from '../camera/mapControls';
import type { TerrainAnchorSource } from '../camera/MapCameraControls';
import {
    OBLIQUE_PITCH,
    applySphericalToCamera,
    type TerrainViewState,
} from '../camera/viewState';
import {
    createGeometryWorldPickMaterial,
    getLastTerrainPickDebug,
    pickTerrainWorldAtClient,
} from '../terrain/terrainPicking';
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
import { setContourPickElevation } from './contourSets';
import { configureHeightTextureFormat } from './heightTextureFormat';
import {
    collectGeoLodDebugSnapshot,
    geoLodShadowStateKey,
    getTileMesh,
} from './LodUtils';
import {
    DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
    DEFAULT_VIEWSHED_SHADOW_RADIUS,
    DEFAULT_VIEWSHED_SOURCE_HEIGHT,
    resolveViewshedShadowConfig,
    type ViewshedShadowConfig,
} from './viewshedConfig';
import {
    loadTerrainDatasetCatalog,
    type TerrainDatasetConfig,
} from './terrainDatasetCatalog';
import {
    PyramidTileTree,
    type PyramidDebugSnapshot,
    type PyramidTileNode,
} from './PyramidTileTree';
import {
    loadPyramidDataset,
    PyramidCatalogResolver,
} from './pyramidCatalog';
import { PyramidHeightChannel } from './pyramidHeightChannel';
import { TileLayerManagerImpl } from './tileLayerManager';


type DsmSources = Partial<Record<"500" | "1000" | "2000", string>>;
export interface DsmCatItem {
    min_ele?: number;
    max_ele?: number;
    valid_percent?: number,
    xllcorner: number,
    yllcorner: number,
    nrows: number,
    ncols: number,
    /** Ground extent in metres (default 1000 for legacy 1 km DSM tiles). */
    extentMetres?: number;
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
    if (source_filename.startsWith('/') || source_filename.startsWith('http://') || source_filename.startsWith('https://')) {
        return source_filename;
    }
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
    constructor(info: DsmCatItem, parent: THREE.Object3D, context?: TerrainRenderer) {
        let obj = this.object3D = new THREE.Mesh(LazyTile.loaderGeometry, LazyTile.loaderMat);
        const dx = info.xllcorner;
        const dy = info.yllcorner;
        //info should really have grid size, hacking in on the basis of what is true right now
        //but future Pete / anyone else attempting to maintain code will not be happy if not fixed
        const lowRes = info.max_ele === undefined;
        const s = info.extentMetres ?? (lowRes ? 40960 : 1000);
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
            // not relevant to pyramid, and also, we should have a corresponding disposal
            // context?.overlay.add(loadingMesh.clone());
    
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
        mesh.userData.terrainPickMaterial = createGeometryWorldPickMaterial();
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
    /** Manifest-backed local/remote terrain dataset, currently adapted onto the DSM layer. */
    terrainDataset?: TerrainDatasetConfig;
    tracks?: Track[];
    sun?: boolean;
    /** Metres above the selected terrain surface for manual viewshed point source. */
    viewshedSourceHeight?: number;
    /** Maximum manual viewshed point-light shadow distance in metres. */
    viewshedShadowRadius?: number;
    /** Per-cube-face manual viewshed shadow-map size. */
    viewshedShadowMapSize?: number;
    /** Multiplier applied to source height to derive point-light shadow near plane. */
    viewshedShadowNearScale?: number;
    /** Debug escape hatch for light leaks; not the preferred analysis path. */
    viewshedDoubleSidedShadows?: boolean;
    camZ: number;
    /** R3F / external OrbitControls own the camera; skip internal map controls. */
    externalControls?: boolean;
    /** Pyramid v2 tile inspection overlays (wireframes, labels, selection). */
    pyramidInspection?: PyramidInspectionOptions;
}
export interface Track {
    url: string;
    heightOffset?: number;
    colour?: number;
}

export type PyramidInspectionOptions = {
    enabled?: boolean;
    showBounds?: boolean;
    showLabels?: boolean;
    selectedKey?: string | null;
    onSelectedKeyChange?: (key: string | null) => void;
};
const defaultTerrainOptions: TerrainOptions = {
    osTerr50Layer: false,
    defraDSMLayer: false,
    defra10mDTMLayer: true,
    compressionExperimentEnabled: false,
    camZ: 15000,
    sun: true,
    viewshedSourceHeight: DEFAULT_VIEWSHED_SOURCE_HEIGHT,
    viewshedShadowRadius: DEFAULT_VIEWSHED_SHADOW_RADIUS,
    viewshedShadowMapSize: DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
    viewshedDoubleSidedShadows: false,
};

function terrainDatasetKey(config: TerrainDatasetConfig | undefined): string {
    if (!config) return "";
    const schema = config.schemaVersion ?? 'v1';
    return `${schema}|${config.manifestUrl}|${config.channelId}`;
}

function isPyramidV2Dataset(config: TerrainDatasetConfig | undefined): boolean {
    return config?.schemaVersion === 'v2';
}

type PivotMarkerParts = {
    group: THREE.Group;
    sphereMaterial: THREE.MeshBasicMaterial;
    ringMaterial: THREE.MeshBasicMaterial;
    poleMaterial: THREE.LineBasicMaterial;
};

type ViewshedLightParts = {
    group: THREE.Group;
    light: THREE.PointLight;
    markerMaterial: THREE.MeshBasicMaterial;
    ringMaterial: THREE.MeshBasicMaterial;
    poleMaterial: THREE.LineBasicMaterial;
};

type VectorSnapshot = {
    x: number;
    y: number;
    z: number;
};

type QuaternionSnapshot = {
    x: number;
    y: number;
    z: number;
    w: number;
};

export type TerrainDebugSnapshot = {
    coord: EastNorth;
    camera: {
        position: VectorSnapshot;
        quaternion: QuaternionSnapshot;
        up: VectorSnapshot;
        direction: VectorSnapshot;
        fov: number;
        near: number;
        far: number;
        aspect: number;
        zoom: number;
    };
    controls?: {
        target: VectorSnapshot;
        viewState: TerrainViewState;
        minDistance: number;
        maxDistance: number;
        minPitch: number;
        maxPitch: number;
    };
    pivotMarker?: {
        source: TerrainAnchorSource | null;
        position: VectorSnapshot;
        scale: VectorSnapshot;
        visible: boolean;
        colour: string;
    };
    viewshedSource?: {
        surface: VectorSnapshot;
        position: VectorSnapshot;
        heightOffset: number;
        shadowRadius: number;
        shadowMapSize: { width: number; height: number };
        shadowCameraNear: number;
        shadowCameraFar: number;
        shadowNearScale: number;
        shadowAutoUpdate: boolean;
        shadowNeedsUpdate: boolean;
        doubleSidedShadows: boolean;
        visible: boolean;
    };
    lod: ReturnType<typeof collectGeoLodDebugSnapshot>;
    pyramid?: PyramidDebugSnapshot;
    lastPick: ReturnType<typeof getLastTerrainPickDebug>;
    decodeTiming: ReturnType<typeof JP2.decodeTimingStats>;
    textureCache: ReturnType<typeof JP2.textureCacheStats>;
    layers: {
        dsmVisible: boolean;
        dtmVisible: boolean;
        osTerr50Visible: boolean;
        dsmChildren: number;
        dtmChildren: number;
        osTerr50Children: number;
    };
};

type TerrainDebugGlobal = {
    snapshot: () => TerrainDebugSnapshot;
    findTile: (query: string) => PyramidTileNode[];
    refetchTile: (key: string, channelId?: string) => boolean;
    previewTileTexture: (key: string, channelId?: string) => boolean;
    setInspectBounds: (visible: boolean) => void;
    forcePyramidReconcile: () => void;
    clearPyramidCatalogCache: () => void;
    renderer: TerrainRenderer;
    pyramidTree?: PyramidTileTree;
    tileLayerManager?: TileLayerManagerImpl;
};

const terrainDebugElementId = "terracognita-terrain-debug";

declare global {
    interface Window {
        terracognitaTerrainDebug?: TerrainDebugGlobal;
    }
}

const pivotMarkerColours: Record<TerrainAnchorSource, number> = {
    terrain: 0x00f5ff,
    "ground-plane": 0xffcc00,
    target: 0xff4bd8,
};

function createPivotMarkerParts(): PivotMarkerParts {
    const group = new THREE.Group();
    group.name = "terrain-camera-pivot-marker";
    group.visible = false;
    group.renderOrder = 10_000;

    const sphereMaterial = new THREE.MeshBasicMaterial({
        color: pivotMarkerColours.terrain,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({
        color: pivotMarkerColours.terrain,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
    });
    const poleMaterial = new THREE.LineBasicMaterial({
        color: pivotMarkerColours.terrain,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
    });

    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 20, 12),
        sphereMaterial,
    );
    sphere.renderOrder = group.renderOrder;
    group.add(sphere);

    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.65, 1, 48),
        ringMaterial,
    );
    ring.renderOrder = group.renderOrder;
    group.add(ring);

    const pole = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, -0.8),
            new THREE.Vector3(0, 0, 1.4),
        ]),
        poleMaterial,
    );
    pole.renderOrder = group.renderOrder;
    group.add(pole);

    return { group, sphereMaterial, ringMaterial, poleMaterial };
}

function createViewshedLightParts(): ViewshedLightParts {
    const group = new THREE.Group();
    group.name = "viewshed-source";
    group.visible = false;
    group.renderOrder = 10_001;

    const light = new THREE.PointLight(0xfff1c7);
    light.name = "viewshed-source-light";
    light.intensity = 3;
    light.power = 100;
    light.decay = 0.1;
    light.distance = DEFAULT_VIEWSHED_SHADOW_RADIUS;
    light.castShadow = true;
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = true;
    light.shadow.mapSize.width = DEFAULT_VIEWSHED_SHADOW_MAP_SIZE;
    light.shadow.mapSize.height = DEFAULT_VIEWSHED_SHADOW_MAP_SIZE;
    light.shadow.bias = -0.0002;
    light.shadow.camera.near = 1;
    light.shadow.camera.far = DEFAULT_VIEWSHED_SHADOW_RADIUS;
    light.shadow.camera.updateProjectionMatrix();
    group.add(light);

    const markerMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.72,
        color: 0xfff1c7,
        depthTest: false,
        depthWrite: false,
    });
    const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 20, 12),
        markerMaterial,
    );
    marker.renderOrder = group.renderOrder;
    group.add(marker);

    const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0xfff1c7,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.45,
    });
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.7, 1.05, 48),
        ringMaterial,
    );
    ring.renderOrder = group.renderOrder;
    group.add(ring);

    const poleMaterial = new THREE.LineBasicMaterial({
        color: 0xfff1c7,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.65,
    });
    const pole = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, -1),
            new THREE.Vector3(0, 0, 1),
        ]),
        poleMaterial,
    );
    pole.renderOrder = group.renderOrder;
    group.add(pole);

    return { group, light, markerMaterial, ringMaterial, poleMaterial };
}

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
    private pivotMarkerParts?: PivotMarkerParts;
    private lastPivotMarkerSource: TerrainAnchorSource | null = null;
    private viewshedLightParts?: ViewshedLightParts;
    private viewshedSurfacePoint?: THREE.Vector3;
    private lastViewshedLodStateKey = "";
    private lastSyncedDoubleSidedShadows: boolean | undefined;
    private terrainDatasetKey = "";
    private pyramidResolver?: PyramidCatalogResolver;
    private pyramidTree?: PyramidTileTree;
    private tileLayerManager?: TileLayerManagerImpl;
    private inspectTexturePreview?: THREE.Object3D;

    isTerrainInited(): boolean {
        return this.terrainInited;
    }

    /** Merge Leva / React options without resetting the camera. */
    updateOptions(patch: Partial<TerrainOptions>): void {
        const nextTerrainDatasetKey = terrainDatasetKey(patch.terrainDataset ?? this.options.terrainDataset);
        const terrainDatasetChanged = nextTerrainDatasetKey !== this.terrainDatasetKey;
        this.options = {
            ...this.options,
            ...patch,
            camZ: patch.camZ ?? this.options.camZ,
            sun: patch.sun ?? this.options.sun,
        };
        if (terrainDatasetChanged) {
            this.terrainDatasetKey = nextTerrainDatasetKey;
            this.disposePyramid();
            this.clearLayer(this.dsmLayer);
            this.dsmTilesLoaded = false;
        }
        if (patch.externalControls) {
            this.externalControls = true;
        }
        this.mapControlsOptions = {
            initialDistance: this.options.camZ,
            referenceDistance: this.options.camZ,
        };
        syncCompressionExperiment(!!this.options.compressionExperimentEnabled);
        this.syncPyramidInspection();
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
        this.terrainDatasetKey = terrainDatasetKey(this.options.terrainDataset);
        syncCompressionExperiment(!!this.options.compressionExperimentEnabled);
        console.table(this.options);
        this.coord = {...coord};
        this.tileProp = getTileProperties(coord);
        this.scene.name = `TerrainRenderer ${options.terrainDataset?.manifestUrl}`;
        this.overlay.name = `TerrainRenderer overlay ${options.terrainDataset?.manifestUrl}`;
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
    private clearLayer(layer: THREE.Group): void {
        while (layer.children.length > 0) {
            layer.remove(layer.children[0]);
        }
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
        this.syncViewshedLightSource();
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
            if (isPyramidV2Dataset(this.options.terrainDataset)) {
                void this.initPyramidDataset().then(() => console.log('finished pyramid v2 init'));
            } else {
                void this.makeTiles().then(() => console.log('finished making tiles'));
            }
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
        const catalog = !lowRes && this.options.terrainDataset
            ? await loadTerrainDatasetCatalog(this.options.terrainDataset)
            : lowRes ? cat10m : cat;
        Object.entries(catalog).forEach((k) => {
            const info = k[1];
            this.tiles.push(new LazyTile(info, parent, this));
        });
    }

    private disposePyramid(): void {
        this.pyramidTree?.dispose();
        this.pyramidTree = undefined;
        this.tileLayerManager?.dispose();
        this.tileLayerManager = undefined;
        this.pyramidResolver?.clearCache();
        this.pyramidResolver = undefined;
    }

    private async initPyramidDataset(): Promise<void> {
        const config = this.options.terrainDataset;
        if (!config) return;
        this.disposePyramid();
        const catalog = await loadPyramidDataset(config.manifestUrl);
        this.pyramidResolver = new PyramidCatalogResolver(catalog);
        this.tileLayerManager = new TileLayerManagerImpl();
        this.tileLayerManager.attachChannel(new PyramidHeightChannel());
        this.dsmLayer.name = `DSM PyramidTileTree '${config.manifestUrl}'`
        this.pyramidTree = new PyramidTileTree(
            this.dsmLayer,
            this.pyramidResolver,
            this.tileLayerManager,
            {
                previewTexture: (texture, label) => this.previewInspectTexture(texture, label),
            },
        );
        this.pyramidTree.reconcile(this.camera);
        this.syncPyramidInspection();
    }

    private ensurePivotMarker(): PivotMarkerParts {
        if (!this.pivotMarkerParts) {
            this.pivotMarkerParts = createPivotMarkerParts();
            this.scene.add(this.pivotMarkerParts.group);
        }
        return this.pivotMarkerParts;
    }

    private updatePivotMarkerScale(): void {
        if (!this.pivotMarkerParts?.group.visible) return;
        const distance = this.camera.position.distanceTo(
            this.pivotMarkerParts.group.position,
        );
        const scale = Math.max(5, Math.min(120, distance * 0.018));
        this.pivotMarkerParts.group.scale.setScalar(scale);
    }

    showTerrainPivotMarker(
        point: THREE.Vector3,
        source: TerrainAnchorSource,
    ): void {
        const marker = this.ensurePivotMarker();
        const colour = pivotMarkerColours[source];
        marker.sphereMaterial.color.setHex(colour);
        marker.ringMaterial.color.setHex(colour);
        marker.poleMaterial.color.setHex(colour);
        marker.group.position.copy(point);
        marker.group.visible = true;
        // World Z is metres above datum, the same scale the contour shader
        // works in, so a follow-pick set can take it straight as its anchor.
        setContourPickElevation(point.z);
        this.lastPivotMarkerSource = source;
        this.updatePivotMarkerScale();
    }

    private ensureViewshedLight(): ViewshedLightParts {
        if (!this.viewshedLightParts) {
            this.viewshedLightParts = createViewshedLightParts();
            this.scene.add(this.viewshedLightParts.group);
        }
        return this.viewshedLightParts;
    }

    private viewshedSourceHeight(): number {
        return this.options.viewshedSourceHeight ?? DEFAULT_VIEWSHED_SOURCE_HEIGHT;
    }

    private viewshedShadowConfig(): ViewshedShadowConfig {
        return resolveViewshedShadowConfig({
            radius: this.options.viewshedShadowRadius,
            mapSize: this.options.viewshedShadowMapSize,
            sourceHeight: this.viewshedSourceHeight(),
            nearScale: this.options.viewshedShadowNearScale,
        });
    }

    private syncViewshedShadowSide(): void {
        const enabled = !!this.options.viewshedDoubleSidedShadows;
        if (this.lastSyncedDoubleSidedShadows === enabled) return;
        this.lastSyncedDoubleSidedShadows = enabled;
        const shadowSide = this.options.viewshedDoubleSidedShadows
            ? THREE.DoubleSide
            : null;
        for (const root of [this.dsmLayer, this.dtmLayer]) {
            root.traverse((object) => {
                if (!(object instanceof THREE.Mesh)) return;
                const material = object.material;
                const materials = Array.isArray(material) ? material : [material];
                for (const entry of materials) {
                    entry.shadowSide = shadowSide;
                }
            });
        }
    }

    private applyViewshedShadowConfig(parts: ViewshedLightParts): void {
        const config = this.viewshedShadowConfig();
        const { light } = parts;
        const shadowCamera = light.shadow.camera;
        const changed =
            light.distance !== config.radius ||
            shadowCamera.near !== config.near ||
            shadowCamera.far !== config.radius ||
            light.shadow.mapSize.width !== config.mapSize ||
            light.shadow.mapSize.height !== config.mapSize ||
            light.shadow.autoUpdate !== false;

        light.distance = config.radius;
        shadowCamera.near = config.near;
        shadowCamera.far = config.radius;
        light.shadow.mapSize.set(config.mapSize, config.mapSize);
        light.shadow.autoUpdate = false;

        if (changed) {
            shadowCamera.updateProjectionMatrix();
            light.shadow.needsUpdate = true;
        }
    }

    private requestViewshedShadowUpdate(): void {
        if (!this.viewshedLightParts) return;
        this.viewshedLightParts.light.shadow.needsUpdate = true;
    }

    private markViewshedShadowIfLodStateChanged(): void {
        if (!this.viewshedLightParts?.group.visible) return;
        const key = geoLodShadowStateKey(
            [this.dsmLayer, this.dtmLayer, this.osTerr50Layer],
            this.viewshedLightParts.group.position,
        );
        if (key === this.lastViewshedLodStateKey) return;
        this.lastViewshedLodStateKey = key;
        this.lastSyncedDoubleSidedShadows = undefined;
        this.syncViewshedShadowSide();
        this.requestViewshedShadowUpdate();
    }

    private updateViewshedMarkerScale(): void {
        if (!this.viewshedLightParts?.group.visible) return;
        const distance = this.camera.position.distanceTo(
            this.viewshedLightParts.group.position,
        );
        const scale = Math.max(5, Math.min(140, distance * 0.016));
        this.viewshedLightParts.group.scale.setScalar(scale);
    }

    private syncViewshedLightSource(): void {
        if (!this.viewshedSurfacePoint) {
            return;
        }
        const parts = this.ensureViewshedLight();
        this.syncViewshedShadowSide();
        this.applyViewshedShadowConfig(parts);
        parts.group.position
            .copy(this.viewshedSurfacePoint)
            .add(new THREE.Vector3(0, 0, this.viewshedSourceHeight()));
        parts.group.visible = true;
        this.requestViewshedShadowUpdate();
        this.updateViewshedMarkerScale();
    }

    setViewshedLightSource(surfacePoint: THREE.Vector3): void {
        this.viewshedSurfacePoint = surfacePoint.clone();
        this.syncViewshedLightSource();
        this.showTerrainPivotMarker(surfacePoint, "terrain");
    }

    private vectorSnapshot(v: THREE.Vector3): VectorSnapshot {
        return { x: v.x, y: v.y, z: v.z };
    }

    getTerrainDebugSnapshot(): TerrainDebugSnapshot {
        const direction = new THREE.Vector3();
        this.camera.getWorldDirection(direction);
        const marker = this.pivotMarkerParts;
        const snapshot: TerrainDebugSnapshot = {
            coord: { ...this.coord },
            camera: {
                position: this.vectorSnapshot(this.camera.position),
                quaternion: {
                    x: this.camera.quaternion.x,
                    y: this.camera.quaternion.y,
                    z: this.camera.quaternion.z,
                    w: this.camera.quaternion.w,
                },
                up: this.vectorSnapshot(this.camera.up),
                direction: this.vectorSnapshot(direction),
                fov: this.camera.fov,
                near: this.camera.near,
                far: this.camera.far,
                aspect: this.camera.aspect,
                zoom: this.camera.zoom,
            },
            layers: {
                dsmVisible: this.dsmLayer.visible,
                dtmVisible: this.dtmLayer.visible,
                osTerr50Visible: this.osTerr50Layer.visible,
                dsmChildren: this.dsmLayer.children.length,
                dtmChildren: this.dtmLayer.children.length,
                osTerr50Children: this.osTerr50Layer.children.length,
            },
            lod: collectGeoLodDebugSnapshot([
                this.dsmLayer,
                this.dtmLayer,
                this.osTerr50Layer,
            ]),
            pyramid: this.pyramidTree?.debugSnapshot(),
            lastPick: getLastTerrainPickDebug(),
            decodeTiming: JP2.decodeTimingStats(),
            textureCache: JP2.textureCacheStats(),
        };
        if (this.mapCtrl) {
            snapshot.controls = {
                target: this.vectorSnapshot(this.mapCtrl.target),
                viewState: this.mapCtrl.getViewState(),
                minDistance: this.mapCtrl.minDistance,
                maxDistance: this.mapCtrl.maxDistance,
                minPitch: this.mapCtrl.minPitch,
                maxPitch: this.mapCtrl.maxPitch,
            };
        }
        if (marker) {
            snapshot.pivotMarker = {
                source: this.lastPivotMarkerSource,
                position: this.vectorSnapshot(marker.group.position),
                scale: this.vectorSnapshot(marker.group.scale),
                visible: marker.group.visible,
                colour: marker.sphereMaterial.color.getHexString(),
            };
        }
        if (this.viewshedLightParts && this.viewshedSurfacePoint) {
            const { light } = this.viewshedLightParts;
            const config = this.viewshedShadowConfig();
            snapshot.viewshedSource = {
                surface: this.vectorSnapshot(this.viewshedSurfacePoint),
                position: this.vectorSnapshot(this.viewshedLightParts.group.position),
                heightOffset: this.viewshedSourceHeight(),
                shadowRadius: config.radius,
                shadowMapSize: {
                    width: light.shadow.mapSize.width,
                    height: light.shadow.mapSize.height,
                },
                shadowCameraNear: light.shadow.camera.near,
                shadowCameraFar: light.shadow.camera.far,
                shadowNearScale: config.nearScale,
                shadowAutoUpdate: light.shadow.autoUpdate,
                shadowNeedsUpdate: light.shadow.needsUpdate,
                doubleSidedShadows: !!this.options.viewshedDoubleSidedShadows,
                visible: this.viewshedLightParts.group.visible,
            };
        }
        return snapshot;
    }

    previewInspectTexture(texture: THREE.Texture, label: string): void {
        if (this.inspectTexturePreview) {
            this.overlay.remove(this.inspectTexturePreview);
            this.inspectTexturePreview.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry.dispose();
                    const { material } = child;
                    if (Array.isArray(material)) {
                        material.forEach((entry) => entry.dispose());
                    } else {
                        material.dispose();
                    }
                }
            });
            this.inspectTexturePreview = undefined;
        }
        const mat = new THREE.MeshBasicMaterial({ map: texture });
        const geo = new THREE.PlaneGeometry(0.28, 0.28, 1, 1);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `inspect-texture ${label}`;
        mesh.position.set(0.16, 0.84, 0);
        this.overlay.add(mesh);
        this.inspectTexturePreview = mesh;
    }

    refetchPyramidTile(key: string): boolean {
        return this.pyramidTree?.refetchNode(key) ?? false;
    }

    previewPyramidTileTexture(key: string): boolean {
        return this.pyramidTree?.previewNodeTexture(key) ?? false;
    }

    private syncPyramidInspection(): void {
        const config = this.options.pyramidInspection;
        if (!this.pyramidTree) return;
        this.pyramidTree.configureInspection({
            enabled: !!config?.enabled,
            showBounds: config?.showBounds ?? true,
            showLabels: config?.showLabels ?? false,
            selectedKey: config?.selectedKey ?? null,
        });
        this.pyramidTree.configureInspectionPointer(
            this.dom ?? null,
            this.camera,
            !!config?.enabled,
            (key) => this.options.pyramidInspection?.onSelectedKeyChange?.(key),
        );
    }

    private syncTerrainDebugGlobal(): void {
        if (typeof window === "undefined") return;
        const snapshot = this.getTerrainDebugSnapshot();
        window.terracognitaTerrainDebug = {
            snapshot: () => this.getTerrainDebugSnapshot(),
            findTile: (query) => this.pyramidTree?.findNodes(query) ?? [],
            refetchTile: (key, channelId) => this.pyramidTree?.refetchNode(key, channelId) ?? false,
            previewTileTexture: (key, channelId) =>
                this.pyramidTree?.previewNodeTexture(key, channelId) ?? false,
            setInspectBounds: (visible) => this.pyramidTree?.setInspectBoundsVisible(visible),
            forcePyramidReconcile: () => this.pyramidTree?.forceReconcile(),
            clearPyramidCatalogCache: () => this.pyramidTree?.clearCatalogCache(),
            renderer: this,
            pyramidTree: this.pyramidTree,
            tileLayerManager: this.tileLayerManager,
        };
        const existing = document.getElementById(terrainDebugElementId);
        let debugElement: HTMLScriptElement;
        if (existing instanceof HTMLScriptElement) {
            debugElement = existing;
        } else {
            existing?.remove();
            debugElement = document.createElement("script");
            debugElement.id = terrainDebugElementId;
            debugElement.type = "application/json";
            document.body.appendChild(debugElement);
        }
        debugElement.textContent = JSON.stringify(snapshot);
    }

    update() {
        super.update();
        tickTileShader();
        this.syncLightRig();
        this.syncViewshedShadowSide();
        this.markViewshedShadowIfLodStateChanged();
        this.updatePivotMarkerScale();
        this.updateViewshedMarkerScale();
        if (this.pyramidTree && this.tileLayerManager) {
            this.pyramidTree.reconcile(this.camera);
            this.tileLayerManager.observeVisibility(this.camera);
            this.pyramidTree.onVisibilityUpdated();
        }
    }

    pickTerrainWorldAtClient(
        renderer: THREE.WebGLRenderer,
        clientX: number,
        clientY: number,
    ): THREE.Vector3 | null {
        if (!this.dom) return null;
        return pickTerrainWorldAtClient(
            renderer,
            this.scene,
            this.camera,
            this.dom,
            [this.dsmLayer, this.dtmLayer, this.osTerr50Layer],
            clientX,
            clientY,
        );
    }

    render(renderer: THREE.WebGLRenderer) {
        // Before anything can upload a height chunk: the R16 path needs its
        // extension enabled on this context, and three needs to be able to
        // name the internal format.
        configureHeightTextureFormat(renderer);
        this.syncTerrainDebugGlobal();
        this.mapCtrl?.setWorldPickProvider((clientX, clientY) =>
            this.pickTerrainWorldAtClient(renderer, clientX, clientY),
        );
        this.mapCtrl?.setAnchorPointListener((point, source) =>
            this.showTerrainPivotMarker(point, source),
        );
        this.mapCtrl?.setDoubleClickAnchorPointListener((point) =>
            this.setViewshedLightSource(point),
        );
        super.render(renderer);
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
