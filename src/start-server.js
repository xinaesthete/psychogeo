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


app.listen(port);