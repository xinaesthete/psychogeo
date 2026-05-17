import { Canvas, useFrame, useGraph, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useControls } from 'leva';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import './App.css';
import {
  mapStyleOrbitProps,
  setTerrainCameraTarget,
} from './camera/mapControls';
import { convertWgsToOSGB, EastNorth } from './geo/Coordinates';
import { TerrainRenderer, newGLContext, TerrainOptions, Track } from './geo/TileLoaderUK';
import { useTerrain } from './TerrainContext';
import { DomAttributes, Threact } from './threact/threact';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

newGLContext();

/// refactor in process... we need to go a bit further & add UI controls etc.
function Terrain(opt: {coord: EastNorth, options?: TerrainOptions}) {
  const {coord, options} = {...opt};
  const renderer = React.useMemo(
    () => new TerrainRenderer(coord, options),
    [coord.east, coord.north, options]
  );
  const rendererKey = JSON.stringify({
    east: coord.east,
    north: coord.north,
    options
  });
  const dom: DomAttributes = {
    style: { height: "100%", width: '100%' }
  }
  return (
    <div style={{width: '100vw', height: '100vh'}}>
      <Threact key={rendererKey} gfx={renderer} domAttributes={dom}/>
    </div>
  );
}

function MapStyleOrbitControls({
  coord,
  camZ,
}: {
  coord: EastNorth;
  camZ: number;
}) {
  const ref = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  useEffect(() => {
    const controls = ref.current;
    if (!controls) return;
    if (camera instanceof THREE.PerspectiveCamera) {
      setTerrainCameraTarget(controls, camera, coord, camZ);
    }
  }, [camera, coord, camZ]);
  return (
    <OrbitControls
      ref={ref}
      target={[coord.east, coord.north, 0]}
      {...mapStyleOrbitProps}
    />
  );
}

function TerrainR3F(opt: {coord: EastNorth, options?: TerrainOptions}) {
  const {coord, options} = {...opt};
  const camZ = options?.camZ ?? 3000;
  const renderer = useTerrain(coord, { ...options, externalControls: true, camZ });
  useGraph(renderer.scene);
  useLayoutEffect(() => {
    renderer.ensureTerrainInit();
  }, [renderer]);
  useFrame(() => {
    renderer.update();
  });
  return (
    <>
      <MapStyleOrbitControls coord={coord} camZ={camZ} />
      <primitive object={renderer.scene} />
    </>
  );
}

function MapLayersGUI() {
  return (
    <div className='MapLayers'>
      <label>DEFRA 10m DTM</label><input type='checkbox' />
      <label>DEFRA DSM (0.5m / 1m mixed)</label><input type='checkbox' />
      <label>OS Terr50 </label><input type='checkbox' />
    </div>
  )
}

function App() {
  const {defra10mDTMLayer, defraDSMLayer, osTerr50Layer, inspectionLight, r3f} = useControls({
    defra10mDTMLayer: false, defraDSMLayer: true, osTerr50Layer: false, inspectionLight: true, r3f: false
  });
  const beinnSgrithael = {east: 183786, north: 812828};
  const winchester = convertWgsToOSGB({lat: 51.064, lon: -1.3098227});
  const cornwall = {east: 201582, north: 43954};
  const branscombe = {east: 320709, north: 88243};
  
  const stmawes: Track = {url: "gpx/Gorran_Haven_to_St_Mawe_s_tandem_solo_.gpx", heightOffset: 2, colour: 0x902020};
  const stGiles: Track = {url: "data/stgiles.gpx", heightOffset: 2, colour: 0x902020};
  const palestine: Track = { url: "data/palestine.gpx", heightOffset: 2, colour: 0x70f0f0};
  const kaw: Track = { url: "gpx/king_alfreds_way_2020_final_route.gpx", heightOffset: 20, colour: 0xf08050};
  const stonehenge: Track = { url: "gpx/Where_the_Banshees_live_and_they_do_live_well.gpx", heightOffset: 2, colour: 0xf08050};
  const bart: Track = { url: "gpx/Kings-Barton-Walking-1-Apr-2021-at-17-55.gpx", heightOffset: 2, colour: 0x70f0f0};
  // fetch('/ping');
  return (
    <div className="App">
      {/* <MapLayersGUI /> */}
        {!r3f&& <Terrain coord={winchester} options={{
          defra10mDTMLayer, defraDSMLayer, osTerr50Layer, sun: inspectionLight, camZ: 3000, tracks: [
        //  stGiles, palestine
        // bart,
        // kaw,
        // stonehenge
        ]}} />}
        {r3f && <Canvas camera={{ up: [0, 0, 1] }}>
          <TerrainR3F coord={winchester} options={{
            defra10mDTMLayer, defraDSMLayer, osTerr50Layer, sun: inspectionLight, camZ: 3000, tracks: []
          }} />
        </Canvas>}
      {/* <Terrain coord={beinnSgrithael} options={{defraDSMLayer: false, osTerr50Layer: true, camZ: 30000}} /> */}
      {/* <Terrain coord={branscombe} options={{defraDSMLayer: true, osTerr50Layer: false, camZ: 10000}} /> */}
      {/* <Terrain coord={winchester} options={{defra10mDTMLayer: true, defraDSMLayer: false, osTerr50Layer: false, camZ: 10000}} /> */}
    </div>
  );
}

export default App;
