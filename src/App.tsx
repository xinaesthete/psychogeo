import React from 'react';
import './App.css';
import { OpenJ2KImage } from './openjpegjs/OpenJ2KImage';
import { IThree, Threact } from './threact/threact';
import { DefaultCube } from './threact/threexample';

function App() {
  const threeBits: IThree[] = [];
  for (let i=0; i<10; i++) {
    threeBits.push(new DefaultCube());
  }
  return (
    <div className="App">
      <header className="App-header">
        Hello World!
        {/* <OpenJ2KImage src="data/heightTileTest.jpx" />
        <OpenJ2KImage src="data/OSTN/ostnHShift-90.jpx" />
        <OpenJ2KImage src="data/OSTN/ostnEShift-90.jpx" />
      <OpenJ2KImage src="data/OSTN/ostnNShift-90.jpx" /> */}
      </header>
      {threeBits.map((t, i) => <Threact key={i} gfx={t} />)}
    </div>
  );
}

export default App;
