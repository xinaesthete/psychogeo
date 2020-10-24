import React from 'react';
import './App.css';
import { convertWgsToOSGB } from './geo/Coordinates';
import { JP2HeightField, newGLContext } from './geo/TileLoaderUK';
import { IThree, Threact } from './threact/threact';

function App() {
  newGLContext();
  const threeBits: IThree[] = [];
  //threeBits.push(new JP2HeightField("data/heightTileTest.jpx"));
  //448467 , 129634 :: 51.064000 , -1.3097227
  //320709 , 088243
  //const winchester = {east: 448475, north: 129631};
  const winchester = convertWgsToOSGB({lat: 51.064, lon: -1.3098227});
  //const branscombe = {east: 320709, north: 88243};
  const geoScene = new JP2HeightField(winchester);
  geoScene.addTrack("data/stgiles.gpx");
  threeBits.push(geoScene);
  //threeBits.push(new JP2HeightField(branscombe));
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
