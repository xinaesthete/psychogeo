import * as THREE from 'three';

const tileBBox = new THREE.Box3(
  new THREE.Vector3(-0.5, -0.5, 0),
  new THREE.Vector3(0.5, 0.5, 1),
);

const _v1 = new THREE.Vector3();
const _bbox = new THREE.Box3();

export type ViewshedLodObserver = {
  position: THREE.Vector3;
  radius: number;
};

let viewshedLodObserver: ViewshedLodObserver | null = null;

export function setViewshedLodObserver(observer: ViewshedLodObserver | null): void {
  viewshedLodObserver = observer
    ? { position: observer.position.clone(), radius: observer.radius }
    : null;
}

export type GeoLodDebugTile = {
  uuid: string;
  currentLevel: number;
  renderCameraDistance: number;
  lodDistance: number;
  viewshedDistance?: number;
};

/**
 * Starting out as fairly much of a direct copy of `THREE.LOD`.
 * Distance is computed to the transformed unit tile bounding box.
 */
export class GeoLOD extends THREE.Object3D {
  _currentLevel = 0;
  autoUpdate = true;
  levels: { object: THREE.Object3D; distance: number }[];
  private lastRenderCameraDistance = 0;
  private lastLodDistance = 0;
  private lastViewshedDistance: number | undefined;
  get isLOD() {
    return true;
  }
  constructor() {
    super();
    this.levels = [];
    this.frustumCulled = false;
    this.onBeforeRender = (_renderer, _scene, camera) => {
      this.update(camera);
    };
  }
  copy(source: this) {
    super.copy(source, false);
    const levels = source.levels;
    for (let i = 0, l = levels.length; i < l; i++) {
      const level = levels[i];
      this.addLevel(level.object.clone(), level.distance);
    }
    this.autoUpdate = source.autoUpdate;
    return this;
  }
  addLevel(object: THREE.Object3D, distance = 0) {
    distance = Math.abs(distance);
    const levels = this.levels;
    let l: number;
    for (l = 0; l < levels.length; l++) {
      if (distance < levels[l].distance) {
        break;
      }
    }
    levels.splice(l, 0, { distance, object });
    this.add(object);
    return this;
  }
  getCurrentLevel() {
    return this._currentLevel;
  }
  distanceToCamera(camera: THREE.Camera): number {
    _bbox.copy(tileBBox);
    _bbox.applyMatrix4(this.matrixWorld);
    _v1.setFromMatrixPosition(camera.matrixWorld);
    const zoom = camera instanceof THREE.PerspectiveCamera ? camera.zoom : 1;
    return _bbox.distanceToPoint(_v1) / zoom;
  }
  getLevelForDistance(distance: number): number {
    const levels = this.levels;
    if (levels.length <= 1) return 0;
    let i = 1;
    const l = levels.length;
    for (; i < l; i++) {
      if (distance < levels[i].distance) break;
    }
    return i - 1;
  }
  getLevelForCamera(camera: THREE.Camera): number {
    return this.getLevelForDistance(this.distanceToCamera(camera));
  }
  getLevelForWorldPoint(point: THREE.Vector3): number {
    _bbox.copy(tileBBox);
    _bbox.applyMatrix4(this.matrixWorld);
    return this.getLevelForDistance(_bbox.distanceToPoint(point));
  }
  getObjectForDistance(distance: number) {
    const levels = this.levels;
    if (levels.length > 0) {
      let i = 1;
      const l = levels.length;
      for (; i < l; i++) {
        if (distance < levels[i].distance) {
          break;
        }
      }
      return levels[i - 1].object;
    }
    return null;
  }
  getDebugTile(): GeoLodDebugTile {
    return {
      uuid: this.uuid,
      currentLevel: this._currentLevel,
      renderCameraDistance: this.lastRenderCameraDistance,
      lodDistance: this.lastLodDistance,
      viewshedDistance: this.lastViewshedDistance,
    };
  }
  raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    const levels = this.levels;
    if (levels.length > 0) {
      _bbox.copy(tileBBox);
      _bbox.applyMatrix4(this.matrixWorld);
      const distance = _bbox.distanceToPoint(raycaster.ray.origin);
      this.getObjectForDistance(distance)?.raycast(raycaster, intersects);
    }
  }
  update(camera: THREE.Camera) {
    const levels = this.levels;
    _bbox.copy(tileBBox);
    _bbox.applyMatrix4(this.matrixWorld);
    if (levels.length > 1) {
      const distance = this.distanceToCamera(camera);
      this.lastRenderCameraDistance = distance;
      this.lastLodDistance = distance;
      this.lastViewshedDistance = viewshedLodObserver
        ? _bbox.distanceToPoint(viewshedLodObserver.position)
        : undefined;
      levels[0].object.visible = true;
      let i = 1;
      const l = levels.length;
      for (; i < l; i++) {
        if (distance >= levels[i].distance) {
          levels[i - 1].object.visible = false;
          levels[i].object.visible = true;
        } else {
          break;
        }
      }
      this._currentLevel = i - 1;
      for (; i < l; i++) {
        levels[i].object.visible = false;
      }
    }
  }
  toJSON(meta?: THREE.JSONMeta) {
    const data = super.toJSON(meta);
    const objectData = data.object as THREE.Object3DJSONObject & {
      levels: { object: string; distance: number }[];
    };
    objectData.levels = [];
    const levels = this.levels;
    for (let i = 0, l = levels.length; i < l; i++) {
      const level = levels[i];
      objectData.levels.push({
        object: level.object.uuid,
        distance: level.distance,
      });
    }
    return data;
  }
}

export function geoLodStateKey(roots: THREE.Object3D[]): string {
  const parts: string[] = [];
  for (const root of roots) {
    root.traverse((object) => {
      if (object instanceof GeoLOD) {
        parts.push(`${object.uuid}:${object.getCurrentLevel()}`);
      }
    });
  }
  return parts.join('|');
}

export function geoLodShadowStateKey(
  roots: THREE.Object3D[],
  shadowPosition: THREE.Vector3,
): string {
  const parts: string[] = [];
  for (const root of roots) {
    root.traverse((object) => {
      if (object instanceof GeoLOD) {
        parts.push(`${object.uuid}:${object.getLevelForWorldPoint(shadowPosition)}`);
      }
    });
  }
  return parts.join('|');
}

function vectorDebug(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

export type GeoLodDebugSnapshot = {
  observer: {
    position: { x: number; y: number; z: number };
    radius: number;
  } | null;
  visibleTileCount: number;
  visibleLevelCounts: Record<string, number>;
  sampleTiles: GeoLodDebugTile[];
};

export function collectGeoLodDebugSnapshot(
  roots: THREE.Object3D[],
  maxSamples = 64,
): GeoLodDebugSnapshot {
  const sampleTiles: GeoLodDebugTile[] = [];
  const visibleLevelCounts: Record<string, number> = {};
  let visibleTileCount = 0;

  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof GeoLOD) || !object.visible) return;
      visibleTileCount += 1;
      const level = object.getCurrentLevel();
      const levelKey = String(level);
      visibleLevelCounts[levelKey] = (visibleLevelCounts[levelKey] ?? 0) + 1;
      if (sampleTiles.length < maxSamples) {
        sampleTiles.push(object.getDebugTile());
      }
    });
  }

  return {
    observer: viewshedLodObserver
      ? {
          position: vectorDebug(viewshedLodObserver.position),
          radius: viewshedLodObserver.radius,
        }
      : null,
    visibleTileCount,
    visibleLevelCounts,
    sampleTiles,
  };
}
