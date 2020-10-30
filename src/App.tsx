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
  const winchester = convertWgsToOSGB({lat: 51.064, lon: -1.3098227});
  const beinnSgrithael = {east: 183786, north: 812828};
  const branscombe = {east: 320709, north: 88243};
  const geoScene = new TerrainRenderer(beinnSgrithael, {camZ: 15000, osTerr50Layer: true});
  geoScene.addTrack("data/scot1.gpx", 10, 0x902030);
  threeBits.push(geoScene);
  
  const geoScene2 = new TerrainRenderer(winchester, {defraDSMLayer: false, osTerr50Layer: true, camZ: 20000});
  geoScene2.addTrack("data/stgiles.gpx", 5, 0xff0000); //why not add both?
  geoScene2.addTrack("data/palestine.gpx", 20, 0x70f0f0);
  threeBits.push(geoScene2);
  threeBits.push(new TerrainRenderer(branscombe, {defraDSMLayer: true, camZ: 1500}));
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
