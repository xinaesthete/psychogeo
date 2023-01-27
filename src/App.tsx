import { Canvas, useFrame, useGraph } from '@react-three/fiber';
import { useControls } from 'leva';
import React, { useEffect } from 'react';
// import { Canvas, useGraph, useFrame } from '@react-three/fiber';
import './App.css';
import { convertWgsToOSGB, EastNorth } from './geo/Coordinates';
import { TerrainRenderer, newGLContext, TerrainOptions, Track } from './geo/TileLoaderUK';
import { useTerrain } from './TerrainContext';
import { DomAttributes, IThree, Threact } from './threact/threact';
import { OrbitControls } from '@react-three/drei';

newGLContext();

/// refactor in process... we need to go a bit further & add UI controls etc.
function Terrain(opt: {coord: EastNorth, options?: TerrainOptions}) {
  const {coord, options} = {...opt};
  const renderer = React.useMemo(() => new TerrainRenderer(coord, options), [options]);
  const dom: DomAttributes = {
    style: { height: "100%", width: '100%' }
  }
  return (
    <>
    <div style={{width: '100vw', height: '100vh'}}>
    <Threact gfx={renderer} domAttributes={dom}/>
    </div>
    </>
  )
}

function TerrainR3F(opt: {coord: EastNorth, options?: TerrainOptions}) {
  const {coord, options} = {...opt};
  const renderer = useTerrain(coord, options);
  const dom: DomAttributes = {
    style: { height: "100%", width: '100%' }
  }
  const {nodes, materials} = useGraph(renderer.scene);
  useFrame((state, delta) => {
    renderer.update();
  });
  return (
    <>
    <OrbitControls camera={renderer.camera} />
    <mesh position={[0, -10, -10]}>
      <boxGeometry />
      <meshBasicMaterial color="red" />
    </mesh>
    <primitive object={renderer.scene} />
    </>
  )
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
  const {defra10mDTMLayer, defraDSMLayer, osTerr50Layer, r3f} = useControls({
    defra10mDTMLayer: false, defraDSMLayer: true, osTerr50Layer: false, r3f: false
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
          defra10mDTMLayer, defraDSMLayer, osTerr50Layer, camZ: 3000, tracks: [
        //  stGiles, palestine
        // bart,
        // kaw,
        // stonehenge
        ]}} />}
        {r3f && <Canvas>
          <TerrainR3F coord={winchester} options={{
            defra10mDTMLayer, defraDSMLayer, osTerr50Layer, camZ: 3000, tracks: []
          }} />
        </Canvas>}
      {/* <Terrain coord={beinnSgrithael} options={{defraDSMLayer: false, osTerr50Layer: true, camZ: 30000}} /> */}
      {/* <Terrain coord={branscombe} options={{defraDSMLayer: true, osTerr50Layer: false, camZ: 10000}} /> */}
      {/* <Terrain coord={winchester} options={{defra10mDTMLayer: true, defraDSMLayer: false, osTerr50Layer: false, camZ: 10000}} /> */}
    </div>
  );
}

export default App;
