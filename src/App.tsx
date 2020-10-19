import React from 'react';
import './App.css';
import { JP2HeightField, newGLContext } from './geo/TileLoaderUK';
//import { OpenJ2KImage } from './openjpegjs/OpenJ2KImage';
import { IThree, Threact } from './threact/threact';

function App() {
  newGLContext();
  const threeBits: IThree[] = [];
  //threeBits.push(new JP2HeightField("data/heightTileTest.jpx"));
  //448475 , 129631
  //320709 , 088243
  const winchester = {east: 448475, north: 129631};
  //const branscombe = {east: 320709, north: 88243};
  threeBits.push(new JP2HeightField(winchester));
  //threeBits.push(new JP2HeightField(branscombe));
  return (
    <div className="App">
      <header className="App-header">
        {/* {(window as any).electron.ping} */}
      </header>
      {threeBits.map((t, i) => <Threact key={i} gfx={t} />)}
    </div>
  );
}

export default App;
