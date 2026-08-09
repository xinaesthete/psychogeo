import { useControls, Leva } from 'leva';
import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import {
  DEFAULT_SENSITIVITY,
  setSensitivityTuning,
} from './camera/cameraSensitivity';
import { DEFAULT_PAN_INERTIA, setPanInertiaTuning } from './camera/panInertia';
import { DEFAULT_PITCH_LIMITS, setPitchLimitTuning } from './camera/pitchLimits';
import { DEFAULT_SMOOTH_ZOOM, setSmoothZoomTuning } from './camera/smoothZoom';
import { convertWgsToOSGB, EastNorth } from './geo/Coordinates';
import { CompressionAnalysisPanel } from './geo/CompressionAnalysisPanel';
import { newGLContext, TerrainOptions, Track, type PyramidInspectionOptions } from './geo/TileLoaderUK';
import { PyramidInspectionPanel } from './geo/PyramidInspectionPanel';
import { resolveStoreChannels } from './geo/storeChannels';
import {
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
  terracognitaDefraV1: (): EastNorth => ({ east: 455000, north: 205000 }),
  terracognitaDefraV2: (): EastNorth => ({ east: 455000, north: 215000 }),
  beinnSgrithael: (): EastNorth => ({ east: 183786, north: 812828 }),
  cornwall: (): EastNorth => ({ east: 201582, north: 43954 }),
  branscombe: (): EastNorth => ({ east: 320709, north: 88243 }),
} as const;

function App() {
  const [compressionExperimentEnabled, setCompressionExperimentEnabled] = useState(false);

  const {defra10mDTMLayer, terrainHeightSource, osTerr50Layer, inspectionLight, r3f} = useControls({
    defra10mDTMLayer: false,
    terrainHeightSource: {
      value: 'v2',
      options: {
        'legacy DEFRA DSM prototype': 'legacy',
        'v1 dataset FZ DSM': 'v1',
        'v2 pyramid DSM': 'v2',
        off: 'off',
      },
      label: 'DSM source',
    },
    osTerr50Layer: false,
    inspectionLight: true,
    r3f: false,
  });
  const { terrainDatasetManifestUrl } = useControls('Terrain dataset', {
    terrainDatasetManifestUrl: {
      // The renormalised zarr store: 1,655 objects against the v2 tree's
      // 160,750, one national scale, and a 4x pyramid to 256 m. A URL ending in
      // zarr.json selects the zarr reader, anything else the v2 manifest tree —
      // see docs/planning/zarr-transcode.md. Point it at a channel group
      // (.../height.dsm.fz/zarr.json) to open that channel specifically.
      value: '/terrain-datasets/terra-cognita.zarr/zarr.json',
      label: 'dataset URL (metadata.json or zarr.json)',
    },
  });

  // The store root names its channels; a v2 manifest tree has one and no list,
  // in which case the picker below collapses to that single option.
  const [storeChannels, setStoreChannels] = useState<{ channels: string[]; addressed?: string }>({
    channels: [],
  });
  useEffect(() => {
    let cancelled = false;
    void resolveStoreChannels(terrainDatasetManifestUrl).then((found) => {
      if (cancelled) return;
      setStoreChannels({ channels: [...found.channels], addressed: found.addressed });
    });
    return () => {
      cancelled = true;
    };
  }, [terrainDatasetManifestUrl]);

  const channelOptions = storeChannels.channels.length > 0
    ? storeChannels.channels
    : ['height.dsm.fz'];
  // Defaults to the channel the URL names, so pointing at a channel group and
  // using the picker cannot disagree about what is on screen.
  const { channelId } = useControls(
    'Terrain dataset',
    {
      channelId: {
        value: storeChannels.addressed ?? channelOptions[0],
        options: channelOptions,
        label: 'channel',
      },
    },
    [channelOptions.join('|'), storeChannels.addressed],
  );
  const {
    zoomSpeed,
    zoomSmoothMs,
    panGain,
    zoomGain,
    panDamping,
    minViewPitchDeg,
    minCameraElevationDeg,
  } = useControls('Camera', {
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
    minViewPitchDeg: {
      value: DEFAULT_PITCH_LIMITS.minViewPitchDeg,
      min: -45,
      max: 45,
      step: 0.5,
      label: 'min view pitch (°)',
    },
    minCameraElevationDeg: {
      value: DEFAULT_PITCH_LIMITS.minCameraElevationDeg,
      min: -45,
      max: 45,
      step: 0.5,
      label: 'min cam elevation (°)',
    },
  });
  const {
    viewshedSourceHeight,
    viewshedShadowRadius,
    viewshedShadowMapSize,
    viewshedShadowNearScale,
    viewshedDoubleSidedShadows,
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
  });
  useEffect(() => {
    setSmoothZoomTuning({speed: zoomSpeed, smoothMs: zoomSmoothMs});
    setSensitivityTuning({panGain, zoomGain});
    setPanInertiaTuning({damping: panDamping});
    setPitchLimitTuning({minViewPitchDeg, minCameraElevationDeg});
  }, [
    zoomSpeed,
    zoomSmoothMs,
    panGain,
    zoomGain,
    panDamping,
    minViewPitchDeg,
    minCameraElevationDeg,
  ]);

  const winchester = useMemo(() => DEV_LOCATIONS.winchester(), []);
  const terrainDatasetV1 = terrainHeightSource === 'v1';
  const terrainDatasetV2 = terrainHeightSource === 'v2';
  const terrainDatasetActive = terrainDatasetV1 || terrainDatasetV2;
  const defraDSMLayer = terrainHeightSource !== 'off';
  const terrainCoord = terrainDatasetV2
    ? DEV_LOCATIONS.terracognitaDefraV2()
    : terrainDatasetV1
      ? DEV_LOCATIONS.terracognitaDefraV1()
      : winchester;

  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(() => new Set());
  const [overlayTracks, setOverlayTracks] = useState<Track[]>([]);
  const [pyramidInspection, setPyramidInspection] = useState<PyramidInspectionOptions>({
    enabled: false,
    showBounds: true,
    showLabels: false,
    selectedKey: null,
  });

  const onTrackSelectionChange = useCallback((ids: Set<string>, tracks: Track[]) => {
    setSelectedTrackIds(ids);
    setOverlayTracks(tracks);
  }, []);

  const onPyramidInspectionChange = useCallback((patch: Partial<PyramidInspectionOptions>) => {
    setPyramidInspection((prev) => ({ ...prev, ...patch }));
  }, []);

  const onPyramidTileSelected = useCallback((key: string | null) => {
    setPyramidInspection((prev) => ({ ...prev, selectedKey: key }));
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
      terrainDataset: terrainDatasetActive
        ? {
            manifestUrl: terrainDatasetManifestUrl,
            channelId,
            schemaVersion: terrainDatasetV2 ? 'v2' : 'v1',
          }
        : undefined,
      camZ: terrainDatasetV2 ? 8000 : 3000,
      tracks: overlayTracks,
      pyramidInspection: {
        ...pyramidInspection,
        onSelectedKeyChange: onPyramidTileSelected,
      },
    }),
    [defra10mDTMLayer, defraDSMLayer, osTerr50Layer, compressionExperimentEnabled, inspectionLight, viewshedSourceHeight, viewshedShadowRadius, viewshedShadowMapSize, viewshedShadowNearScale, viewshedDoubleSidedShadows, terrainDatasetActive, terrainDatasetV2, terrainDatasetManifestUrl, channelId, overlayTracks, pyramidInspection, onPyramidTileSelected],
  );

  const renderMode: TerrainRenderMode = r3f ? 'r3f' : 'threact';

  return (
    <div className="App">
      <TerrainHost
        coord={terrainCoord}
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
      <PyramidInspectionPanel
        coord={terrainCoord}
        active={terrainDatasetV2}
        inspection={pyramidInspection}
        onInspectionChange={onPyramidInspectionChange}
      />
      <CameraViewControls />
      <TileShaderControls />
      <Leva collapsed />
    </div>
  );
}

export default App;
export { DEV_LOCATIONS, tracksFromCatalogSelection };
