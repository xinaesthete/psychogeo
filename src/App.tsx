import React from 'react';
import './App.css';
import { convertWgsToOSGB, EastNorth } from './geo/Coordinates';
import { TerrainRenderer, newGLContext, TerrainOptions, Track } from './geo/TileLoaderUK';
import { IThree, Threact } from './threact/threact';

newGLContext();

/// refactor in process... we need to go a bit further & add UI controls etc.
function Terrain(opt: {coord: EastNorth, options?: TerrainOptions}) {
  const {coord, options} = {...opt};
  const [renderer] = React.useState(new TerrainRenderer(coord, options));
  return <Threact gfx={renderer} />
}

function App() {
  
  const beinnSgrithael = {east: 183786, north: 812828};
  const winchester = convertWgsToOSGB({lat: 51.064, lon: -1.3098227});
  const branscombe = {east: 320709, north: 88243};
  
  const stGiles: Track = {url: "data/stgiles.gpx", heightOffset: 2, colour: 0x902020};
  const palestine: Track = { url: "data/palestine.gpx", heightOffset: 2, colour: 0x70f0f0};
  //TODO GPX parser to handle 'routes' vs tracks. 
  // <rte>
  // <name>King Alfreds Way 2020 Final Route</name>
  // <rtept lat="51.0636310" lon="-1.3190900">
  //   <ele>55.5</ele>
  //   <name>Winchester - Westgate</name>
  //   <desc>Route Starts at the Western gate of Winchester City, Close to the medieval Great Hall and site of the ancient Winchester Castle </desc>
  // </rtept>
  // <rtept lat="51.0636690" lon="-1.3196130">
  //   <ele>59.1</ele>
  // </rtept>
  // <rtept lat="51.0648300" lon="-1.3204540">
  //   <ele>66</ele>
  // </rtept>
  // </rte>
  //Also, this particular file has a lot of interesting metadata in waypoints
  //eg:
  // <wpt lat="51.0636310" lon="-1.3190900">
  //   <ele>55.5</ele>
  //   <name>Winchester - Westgate</name>
  //   <desc>Route Starts at the Western gate of Winchester City, Close to the medieval Great Hall and site of the ancient Winchester Castle </desc>
  // </wpt>
  // const kaw: Track = { url: "gpx/king_alfreds_way_2020_final_route.gpx", heightOffset: 20, colour: 0x70f0f0};
  const bart: Track = { url: "gpx/Kings-Barton-Walking-1-Apr-2021-at-17-55.gpx", heightOffset: 2, colour: 0x70f0f0};
  fetch('/ping');
  return (
    <div className="App">
      {/* <header className="App-header">
        {JSON.stringify(winchester, undefined, 2)}
      </header> */}
      <Terrain coord={winchester} options={{defra10mDTMLayer: true, osTerr50Layer: false, camZ: 30000, tracks: [
      //  stGiles, palestine
      // bart,
      // kaw
      ]}} />
      {/* <Terrain coord={beinnSgrithael} options={{defraDSMLayer: false, osTerr50Layer: true, camZ: 30000}} /> */}
      {/* <Terrain coord={branscombe} options={{defraDSMLayer: true, osTerr50Layer: false, camZ: 10000}} /> */}
      {/* {renderers.map((t, i) => <Threact key={i} gfx={t} />)} */}
    </div>
  );
}

export default App;
