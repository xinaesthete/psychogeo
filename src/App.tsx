import React from 'react';
import './App.css';
import { OpenJ2KImage } from './openjpegjs/OpenJ2KImage';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <OpenJ2KImage src="data/heightTileTest.jpx" />
        <OpenJ2KImage src="data/OSTN/ostnHShift-90.jpx" />
        <OpenJ2KImage src="data/OSTN/ostnEShift-90.jpx" />
        <OpenJ2KImage src="data/OSTN/ostnNShift-90.jpx" />
      </header>
    </div>
  );
}

export default App;
