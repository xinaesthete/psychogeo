import { useControls } from 'leva';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import {
  DEFAULT_SENSITIVITY,
  setSensitivityTuning,
} from './camera/cameraSensitivity';
import { DEFAULT_SMOOTH_ZOOM, setSmoothZoomTuning } from './camera/smoothZoom';
import { convertWgsToOSGB, EastNorth } from './geo/Coordinates';
import { newGLContext, TerrainOptions, Track } from './geo/TileLoaderUK';
import { TerrainHost, TerrainRenderMode } from './terrain/TerrainHost';
import { CameraViewControls } from './camera/CameraViewControls';
import { TrackCatalogPanel } from './tracks/TrackCatalogPanel';
import { tracksFromCatalogSelection } from './tracks/trackCatalog';

newGLContext();

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
  const {defra10mDTMLayer, defraDSMLayer, osTerr50Layer, inspectionLight, r3f} = useControls({
    defra10mDTMLayer: false, defraDSMLayer: true, osTerr50Layer: false, inspectionLight: true, r3f: false
  });
  const {zoomSpeed, zoomSmoothMs, panGain, zoomGain} = useControls('Camera', {
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
  });
  useEffect(() => {
    setSmoothZoomTuning({speed: zoomSpeed, smoothMs: zoomSmoothMs});
    setSensitivityTuning({panGain, zoomGain});
  }, [zoomSpeed, zoomSmoothMs, panGain, zoomGain]);

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
      sun: inspectionLight,
      camZ: 3000,
      tracks: overlayTracks,
    }),
    [defra10mDTMLayer, defraDSMLayer, osTerr50Layer, inspectionLight, overlayTracks],
  );

  const renderMode: TerrainRenderMode = r3f ? 'r3f' : 'threact';

  return (
    <div className="App">
      <TerrainHost
        coord={winchester}
        options={terrainOptions}
        renderMode={renderMode}
      />
      <TrackCatalogPanel
        selectedIds={selectedTrackIds}
        onSelectionChange={onTrackSelectionChange}
      />
      <CameraViewControls />
    </div>
  );
}

export default App;
export { DEV_LOCATIONS, tracksFromCatalogSelection };
