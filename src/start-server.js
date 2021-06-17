/**
 * There's not currently much need for a separate express server script...
 * All it does as of this writing is interpret how to look up a few static files outside the repo.
 * Might need more elaborate server with more complete data.
 */


//https://dev.to/loujaybee/using-create-react-app-with-express
const port = process.env.PORT || 8082; //changed to 8082 to not conflict with snowpack default
console.log('starting express server on port ' + port);
const express = require('express');
//const bodyParser = require('body-parser')
const path = require('path');
const app = express();
app.use(express.static(path.join(__dirname, '../build')));
console.log('using ' + path.join(__dirname, '../build'));

app.get('/ping', function (req, res) {
  console.log('ping');
  return res.send('pong ' + req.path);
});

const tileFolder = "/Users/peter/Dropbox/BlenderGIS/pyUtil/images/jph2/";
const tileSuffix = "_normalised_rate0.j2c";
app.get('/tile*', function(req, res) {
  const name = req.url.substring(6);
  const p = path.join(tileFolder, name + tileSuffix);
  res.sendFile(p);
});
const ltileFolder = '/Volumes/BlackSea/GIS/DEFRA/LIDAR_10m_DTM_Composite_2019/htj2k/';
app.get('/ltile*', function(req, res) {
  console.log('serving', req.url);
  const name = req.url.substring(7);
  const p = path.join(ltileFolder, name);
  res.sendFile(p);
});
// const osFolder = "G:/GIS/OS terr50/data/";
const osFolder = "/Users/peter/Dropbox/BlenderGIS/OS terr50/data";
const osSuffix = "_OST50CONT_20190530.zip";
app.get('/os*', function(req, res) {
  const name = req.url.substring(4);
  const letters = name.substring(0, 2);
  const p = path.join(osFolder, letters, name + osSuffix);
  res.sendFile(p);
});
const gpxFolder = "/Users/peter/Dropbox/tracklogs/";
app.get('/gpx*', function(req, res) {
  const name = req.url.substring(5);
  const p = path.join(gpxFolder, unescape(name));
  res.sendFile(p);
});

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});

// QUICK HACK (famous last words)
// using similar indexing to GET /ltile, add a GET /ttile which extracts data from tif & sends it.

const GeoTIFF = require('geotiff');
const dtmPath = '/Volumes/BlackSea/GIS/DEFRA/LIDAR_10m_DTM_Composite_2019/LIDAR_10m_DTM_Composite.tif';
GeoTIFF.fromFile(dtmPath).then(async tiff => {
  console.log('read big low-res DTM', dtmPath);
  const image = await tiff.getImage();
  const w = image.getWidth();
  const h = image.getHeight();
  const [L, T, R, B] = box = image.getBoundingBox();
  console.log('DTM bbox', L, T, R, B);
  const s = outTileSize = image.getTileWidth() * 16; //somewhat magic numbers here
  const nx = Math.floor(w/outTileSize), ny = Math.floor(h/outTileSize);
  
  function geoLLCoordFromWindowOrName(win) {
    if (typeof win === 'string') win = windowFromImgName(win);
    const [l, t, r, b] = win.map(v=>v*10);
    const xll = l+L;
    const yll = B-b; //b-T;
    return [xll, yll];
  }
  /** assuming tile size 4096, images named 'xxx_yyy-32bit.j2c' where xxx & yyy are indices based on that tile size*/
  function windowFromImgName(f) {
    const x = Number.parseInt(f.substring(0, 3));
    const y = Number.parseInt(f.substring(4, 7));
    const left = x*s, right = (x+1)*s, top = y*s, bottom = (y+1)*s;
    return [left, top, right, bottom];
  }
  function printStats(vals) {
    let t = Date.now();
    const min = vals.reduce((a,b) => Math.min(a, b), Number.MAX_VALUE);
    const max = vals.reduce((a,b) => Math.max(a, b), Number.MIN_VALUE);
    const mean = vals.reduce((a, b) => a+b, 0) / vals.length;
    // console.log('got stats in', Date.now()-t);
    
    console.log('min', min);
    console.log('max', max);
    console.log('mean', mean);
    return [min, max, mean];
  }
  
  let nextID = 0;
  const cache = new Map();
  app.get('/ttile*', async (req, res) => {
    const name = req.url.substring(7);
    if (cache.has(name)) {
      res.end(cache.get(name), 'binary');
      return;
    }
    const win = windowFromImgName(name);
    const id = ++nextID;
    console.log('serving', id);
    let t = Date.now();
    const data = await image.readRasters({window: win});
    console.log('readRaster done', id, Date.now()-t + 'ms');
    const [raw] = data;
    const d = raw.map(v=>v>3000 ? -200 : v);
    printStats(d);
    t = Date.now();
    /// this was doing some heavy work to turn into JSON or something. Getting wrong result & taking a very long time.
    // res.send(new Uint8Array(d.buffer));
    const r = Buffer.from(new Uint8Array(d.buffer));
    cache.set(name, r);
    res.end(r, 'binary');
    console.log('data sent', id, Date.now()-t + 'ms');
  });
});


app.listen(port);