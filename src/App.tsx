import React from 'react';
import './App.css';
import { OpenJ2KImage } from './openjpegjs/OpenJ2KImage';
import { Threact } from './threact/threact';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        Hello World!
        {/* <OpenJ2KImage src="data/heightTileTest.jpx" />
        <OpenJ2KImage src="data/OSTN/ostnHShift-90.jpx" />
        <OpenJ2KImage src="data/OSTN/ostnEShift-90.jpx" />
      <OpenJ2KImage src="data/OSTN/ostnNShift-90.jpx" /> */}
      </header>
      <Threact />
      <Threact />
      <Threact />
      <Threact />
      <Threact />
      <Threact />
    </div>
  );
}

export default App;
