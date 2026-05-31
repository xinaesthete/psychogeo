import { useControls } from 'leva';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import {
  DEFAULT_SENSITIVITY,
  setSensitivityTuning,
} from './camera/cameraSensitivity';
import { DEFAULT_PAN_INERTIA, setPanInertiaTuning } from './camera/panInertia';
import { DEFAULT_SMOOTH_ZOOM, setSmoothZoomTuning } from './camera/smoothZoom';
import { convertWgsToOSGB, EastNorth } from './geo/Coordinates';
import { CompressionAnalysisPanel } from './geo/CompressionAnalysisPanel';
import { newGLContext, TerrainOptions, Track } from './geo/TileLoaderUK';
import {
  DEFAULT_VIEWSHED_EFFECTIVE_EARTH_RADIUS,
  DEFAULT_VIEWSHED_REFRACTION_FACTOR,
  DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
  DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE,
  DEFAULT_VIEWSHED_SHADOW_RADIUS,
  DEFAULT_VIEWSHED_SOURCE_HEIGHT,
} from './geo/viewshedConfig';
import { TerrainHost, TerrainRenderMode } from './terrain/TerrainHost';
import { CameraViewControls } from './camera/CameraViewControls';
import { TrackCatalogPanel } from './tracks/TrackCatalogPanel';
import { tracksFromCatalogSelection } from './tracks/trackCatalog';
import { TileShaderControls } from './geo/TileShaderControls';

if (!import.meta.hot?.data.glInited) {
  newGLContext();
  if (import.meta.hot) {
    import.meta.hot.data.glInited = true;
  }
}

/**
 * UI / data roadmap
 *
 * - Location picker: named places → { east, north } + default camZ (see DEV_LOCATIONS).
 * - Layer panel: Leva for now; move to app chrome later.
 * - Track panel: TrackCatalogPanel + fetchTrackCatalog() stub (→ GET /tracks).
 * - Optional multi-view: several TerrainHost instances (Threact shared GL).
 */
const DEV_LOCATIONS = {
  winchester: () => convertWgsToOSGB({ lat: 51.064, lon: -1.3098227 }),
  beinnSgrithael: (): EastNorth => ({ east: 183786, north: 812828 }),
  cornwall: (): EastNorth => ({ east: 201582, north: 43954 }),
  branscombe: (): EastNorth => ({ east: 320709, north: 88243 }),
} as const;

function App() {
  const [compressionExperimentEnabled, setCompressionExperimentEnabled] = useState(false);

  const {defra10mDTMLayer, defraDSMLayer, osTerr50Layer, inspectionLight, r3f} = useControls({
    defra10mDTMLayer: false,
    defraDSMLayer: true,
    osTerr50Layer: false,
    inspectionLight: true,
    r3f: false,
  });
  const {zoomSpeed, zoomSmoothMs, panGain, zoomGain, panDamping} = useControls('Camera', {
    zoomSpeed: {
      value: DEFAULT_SMOOTH_ZOOM.speed,
      min: 0.005,
      max: 0.15,
      step: 0.001,
      label: 'zoom speed',
    },
    zoomSmoothMs: {
      value: DEFAULT_SMOOTH_ZOOM.smoothMs,
      min: 0,
      max: 400,
      step: 5,
      label: 'zoom smooth (ms)',
    },
    panGain: {
      value: DEFAULT_SENSITIVITY.panGain,
      min: 0.5,
      max: 20,
      step: 0.5,
      label: 'pan gain',
    },
    zoomGain: {
      value: DEFAULT_SENSITIVITY.zoomGain,
      min: 0.5,
      max: 20,
      step: 0.5,
      label: 'zoom gain',
    },
    panDamping: {
      value: DEFAULT_PAN_INERTIA.damping,
      min: 0,
      max: 24,
      step: 0.5,
      label: 'pan damping',
    },
  });
  const {
    viewshedSourceHeight,
    viewshedShadowRadius,
    viewshedShadowMapSize,
    viewshedShadowNearScale,
    viewshedDoubleSidedShadows,
    viewshedGeoidProjection,
    viewshedEffectiveEarthRadius,
    viewshedRefractionFactor,
  } = useControls('Viewshed', {
    viewshedSourceHeight: {
      value: DEFAULT_VIEWSHED_SOURCE_HEIGHT,
      min: 0,
      max: 50,
      step: 0.1,
      label: 'source height (m)',
    },
    viewshedShadowRadius: {
      value: DEFAULT_VIEWSHED_SHADOW_RADIUS,
      min: 500,
      max: 100_000,
      step: 500,
      label: 'shadow radius (m)',
    },
    viewshedShadowMapSize: {
      value: DEFAULT_VIEWSHED_SHADOW_MAP_SIZE,
      min: 512,
      max: 4096,
      step: 512,
      label: 'shadow map size',
    },
    viewshedShadowNearScale: {
      value: DEFAULT_VIEWSHED_SHADOW_NEAR_SCALE,
      min: 0.05,
      max: 2,
      step: 0.05,
      label: 'near / height',
    },
    viewshedDoubleSidedShadows: {
      value: true,
      label: 'double-sided shadows',
    },
    viewshedGeoidProjection: {
      value: false,
      label: 'geoid projection',
    },
    viewshedEffectiveEarthRadius: {
      value: DEFAULT_VIEWSHED_EFFECTIVE_EARTH_RADIUS,
      min: 1_000,
      max: 10_000_000,
      step: 1_000,
      label: 'earth radius (m)',
    },
    viewshedRefractionFactor: {
      value: DEFAULT_VIEWSHED_REFRACTION_FACTOR,
      min: 0.1,
      max: 2,
      step: 0.05,
      label: 'refraction factor',
    },
  });
  useEffect(() => {
    setSmoothZoomTuning({speed: zoomSpeed, smoothMs: zoomSmoothMs});
    setSensitivityTuning({panGain, zoomGain});
    setPanInertiaTuning({damping: panDamping});
  }, [zoomSpeed, zoomSmoothMs, panGain, zoomGain, panDamping]);

  const winchester = useMemo(() => DEV_LOCATIONS.winchester(), []);

  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(() => new Set());
  const [overlayTracks, setOverlayTracks] = useState<Track[]>([]);

  const onTrackSelectionChange = useCallback((ids: Set<string>, tracks: Track[]) => {
    setSelectedTrackIds(ids);
    setOverlayTracks(tracks);
  }, []);

  const terrainOptions: TerrainOptions = useMemo(
    () => ({
      defra10mDTMLayer,
      defraDSMLayer,
      osTerr50Layer,
      compressionExperimentEnabled: compressionExperimentEnabled,
      sun: inspectionLight,
      viewshedSourceHeight,
      viewshedShadowRadius,
      viewshedShadowMapSize,
      viewshedShadowNearScale,
      viewshedDoubleSidedShadows,
      viewshedGeoidProjection,
      viewshedEffectiveEarthRadius,
      viewshedRefractionFactor,
      camZ: 3000,
      tracks: overlayTracks,
    }),
    [defra10mDTMLayer, defraDSMLayer, osTerr50Layer, compressionExperimentEnabled, inspectionLight, viewshedSourceHeight, viewshedShadowRadius, viewshedShadowMapSize, viewshedShadowNearScale, viewshedDoubleSidedShadows, viewshedGeoidProjection, viewshedEffectiveEarthRadius, viewshedRefractionFactor, overlayTracks],
  );

  const renderMode: TerrainRenderMode = r3f ? 'r3f' : 'threact';

  return (
    <div className="App">
      <TerrainHost
        coord={winchester}
        options={terrainOptions}
        renderMode={renderMode}
      />
      <CompressionAnalysisPanel
        enabled={compressionExperimentEnabled}
        onEnabledChange={setCompressionExperimentEnabled}
      />
      <TrackCatalogPanel
        selectedIds={selectedTrackIds}
        onSelectionChange={onTrackSelectionChange}
      />
      <CameraViewControls />
      <TileShaderControls />
    </div>
  );
}

export default App;
export { DEV_LOCATIONS, tracksFromCatalogSelection };
