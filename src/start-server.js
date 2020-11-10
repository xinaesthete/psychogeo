//https://dev.to/loujaybee/using-create-react-app-with-express

console.log('starting express server on port ' + process.env.PORT || 8080);
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

const tileFolder = "C:/Users/peter/Dropbox/BlenderGIS/pyUtil/images/web/";
const tileSuffix = "_normalised_rate0.jpx";
app.get('/tile*', function(req, res) {
  const name = req.url.substring(6);
  const p = path.join(tileFolder, name + tileSuffix);
  res.sendFile(p);
});
const osFolder = "G:/GIS/OS terr50/data/";
const osSuffix = "_OST50CONT_20190530.zip";
app.get('/os*', function(req, res) {
  const name = req.url.substring(4);
  const letters = name.substring(0, 2);
  const p = path.join(osFolder, letters, name + osSuffix);
  res.sendFile(p);
});
const gpxFolder = "C:/Users/peter/Dropbox/tracklogs/";
app.get('/gpx*', function(req, res) {
  const name = req.url.substring(5);
  const p = path.join(gpxFolder, name);
  res.sendFile(p);
});

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});


app.listen(process.env.PORT || 8080);