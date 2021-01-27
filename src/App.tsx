import React from 'react';
import './App.css';
import { convertWgsToOSGB } from './geo/Coordinates';
import { TerrainRenderer, newGLContext } from './geo/TileLoaderUK';
import { IThree, Threact } from './threact/threact';

function App() {
  newGLContext();
  const threeBits: IThree[] = [];
  //448467 , 129634 :: 51.064000 , -1.3097227
  //320709 , 088243
  //const winchester = {east: 448475, north: 129631};
  
  // const beinnSgrithael = {east: 183786, north: 812828};
  // const geoScene = new TerrainRenderer(beinnSgrithael, {camZ: 10000, osTerr50Layer: true});
  // geoScene.addTrack("data/scot1.gpx", 30, 0x902030);
  // threeBits.push(geoScene);
  
  const winchester = convertWgsToOSGB({lat: 51.064, lon: -1.3098227});
  const geoScene2 = new TerrainRenderer(winchester, {defraDSMLayer: false, osTerr50Layer: true, camZ: 3000});
  geoScene2.addTrack("data/stgiles.gpx", 5, 0x902020);
  // geoScene2.addTrack("data/palestine.gpx", 2, 0x70f0f0);
  // geoScene2.addTrack("gpx/Back_to_Cowes_.gpx", 50, 0xff5060);
  // geoScene2.addTrack("gpx/To_the_potting_shed_.gpx", 50, 0x70a0f0);
  threeBits.push(geoScene2);
  
  const branscombe = {east: 320709, north: 88243};
  const branscombeRenderer = new TerrainRenderer(branscombe, {osTerr50Layer: false, defraDSMLayer: true, camZ: 1500});
  // branscombeRenderer.addTrack("gpx/2020-07-05 Branscombe_Beer_loop_.gpx", 3, 0x809070);
  // threeBits.push(branscombeRenderer);
  
  return (
    <div className="App">
      {/* <header className="App-header">
        {JSON.stringify(winchester, undefined, 2)}
      </header> */}
      {threeBits.map((t, i) => <Threact key={i} gfx={t} />)}
    </div>
  );
}

export default App;
