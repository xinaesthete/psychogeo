import React from 'react';
import './App.css';
import { getImageFilename, getTileProperties } from './geo/TileLoaderUK';
//import { OpenJ2KImage } from './openjpegjs/OpenJ2KImage';
import { IThree, Threact } from './threact/threact';
import { JP2HeightField } from './threact/threexample';

function App() {
  const threeBits: IThree[] = [];
  threeBits.push(new JP2HeightField("data/heightTileTest.jpx"));
  //448475 , 129631
  const east = 448475, north = 129631;
  const t = getTileProperties(east, north);
  let s = "test";
  if (t) {
    s = getImageFilename(t.source_filename);
    threeBits.push(new JP2HeightField(s));
  }
  for (let i=0; i<10; i++) {
    //threeBits.push(new DefaultCube());
  }
  return (
    <div className="App">
      <header className="App-header">
        {(window as any).electron.ping}
      </header>
      {s}
      {/* <OpenJ2KImage src={s} /> */}
      {threeBits.map((t, i) => <Threact key={i} gfx={t} />)}
    </div>
  );
}

export default App;
