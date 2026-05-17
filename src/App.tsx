import { useControls } from 'leva';
import React, { useEffect, useMemo } from 'react';
import './App.css';
import {
  DEFAULT_SENSITIVITY,
  setSensitivityTuning,
} from './camera/cameraSensitivity';
import { DEFAULT_SMOOTH_ZOOM, setSmoothZoomTuning } from './camera/smoothZoom';
import { convertWgsToOSGB, EastNorth } from './geo/Coordinates';
import { newGLContext, TerrainOptions, Track } from './geo/TileLoaderUK';
import { TerrainHost, TerrainRenderMode } from './terrain/TerrainHost';

newGLContext();

/**
 * UI / data roadmap (replaces ad-hoc commented JSX that used to live below).
 *
 * Previously we switched views by commenting alternate <Terrain coord=… options=… />
 * blocks and hard-coded GPX paths. That should become real UI, fed by an API later:
 *
 * - Location picker: named places → { east, north } + default camZ (see DEV_LOCATIONS).
 * - Layer panel: already in Leva; move to app chrome when we drop dev-only controls.
 * - Track list: toggle overlays from a catalog (url, colour, heightOffset) — see DEV_TRACKS.
 * - Optional multi-view: several TerrainHost instances on one page (Threact shared GL).
 *
 * Backend sketch: GET /places, GET /tracks?bbox=…, POST session state; client holds
 * TerrainViewState + selected track ids. Until then, wire DEV_* into Leva or a slim
 * MapLayersGUI rather than duplicating TerrainHost in JSX.
 */
const DEV_LOCATIONS = {
  winchester: () => convertWgsToOSGB({ lat: 51.064, lon: -1.3098227 }),
  beinnSgrithael: (): EastNorth => ({ east: 183786, north: 812828 }),
  cornwall: (): EastNorth => ({ east: 201582, north: 43954 }),
  branscombe: (): EastNorth => ({ east: 320709, north: 88243 }),
} as const;

/** Sample GPX overlays — pass subsets via terrainOptions.tracks. */
const DEV_TRACKS: Record<string, Track> = {
  stmawes: { url: 'gpx/Gorran_Haven_to_St_Mawe_s_tandem_solo_.gpx', heightOffset: 2, colour: 0x902020 },
  stGiles: { url: 'data/stgiles.gpx', heightOffset: 2, colour: 0x902020 },
  palestine: { url: 'data/palestine.gpx', heightOffset: 2, colour: 0x70f0f0 },
  kaw: { url: 'gpx/king_alfreds_way_2020_final_route.gpx', heightOffset: 20, colour: 0xf08050 },
  stonehenge: { url: 'gpx/Where_the_Banshees_live_and_they_do_live_well.gpx', heightOffset: 2, colour: 0xf08050 },
  bart: { url: 'gpx/Kings-Barton-Walking-1-Apr-2021-at-17-55.gpx', heightOffset: 2, colour: 0x70f0f0 },
};

// Examples for when we add pickers (not wired — avoids remounting on every Leva tweak):
//   coord={DEV_LOCATIONS.branscombe()}  camZ: 10000
//   tracks: [DEV_TRACKS.stGiles, DEV_TRACKS.palestine]
//   tracks: [DEV_TRACKS.bart, DEV_TRACKS.kaw, DEV_TRACKS.stonehenge]
// Multi-location layout (was commented duplicate Terrain components):
//   <TerrainHost coord={DEV_LOCATIONS.beinnSgrithael()} options={{…, camZ: 30000}} … />
//   <TerrainHost coord={DEV_LOCATIONS.branscombe()} options={{…, camZ: 10000}} … />

function App() {
  const {defra10mDTMLayer, defraDSMLayer, osTerr50Layer, inspectionLight, r3f} = useControls({
    defra10mDTMLayer: false, defraDSMLayer: true, osTerr50Layer: false, inspectionLight: true, r3f: false
  });
  const {zoomSpeed, zoomSmoothMs, panGain, zoomGain, sensitivityPower} = useControls('Camera', {
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
    sensitivityPower: {
      value: DEFAULT_SENSITIVITY.power,
      min: 1,
      max: 3,
      step: 0.1,
      label: 'distance power',
    },
  });
  useEffect(() => {
    setSmoothZoomTuning({speed: zoomSpeed, smoothMs: zoomSmoothMs});
    setSensitivityTuning({
      panGain,
      zoomGain,
      power: sensitivityPower,
    });
  }, [zoomSpeed, zoomSmoothMs, panGain, zoomGain, sensitivityPower]);

  const winchester = useMemo(() => DEV_LOCATIONS.winchester(), []);

  const terrainOptions: TerrainOptions = useMemo(
    () => ({
      defra10mDTMLayer,
      defraDSMLayer,
      osTerr50Layer,
      sun: inspectionLight,
      camZ: 3000,
      tracks: [],
    }),
    [defra10mDTMLayer, defraDSMLayer, osTerr50Layer, inspectionLight],
  );

  const renderMode: TerrainRenderMode = r3f ? 'r3f' : 'threact';

  return (
    <div className="App">
      <TerrainHost
        coord={winchester}
        options={terrainOptions}
        renderMode={renderMode}
      />
    </div>
  );
}

export default App;
export { DEV_LOCATIONS, DEV_TRACKS };
