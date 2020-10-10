import React from 'react';
import './App.css';
import { IThree, Threact } from './threact/threact';
import { JP2HeightField, JP2TextureView } from './threact/threexample';

function App() {
  const threeBits: IThree[] = [];
  threeBits.push(new JP2HeightField("data/heightTileTest.jpx"));
  for (let i=0; i<10; i++) {
    //threeBits.push(new DefaultCube());
  }
  return (
    <div className="App">
      <header className="App-header">
        Hide it under a bushel?<br /> NO!<br />
        I'm gonna let it shine.
      </header>
      {threeBits.map((t, i) => <Threact key={i} gfx={t} />)}
    </div>
  );
}

export default App;
