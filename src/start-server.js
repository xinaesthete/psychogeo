//https://dev.to/loujaybee/using-create-react-app-with-express
const tileFolder = "C:/Users/peter/Dropbox/BlenderGIS/pyUtil/images/web/";
const tileSuffix = "_normalised_60db.jpx";

console.log('starting express server on port ' + 8080);
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

app.get('/tile', function(req, res) {
  console.log('tile request');
  const name = req.path.substring(6);
  const p = path.join(tileFolder, name + tileSuffix);
  console.log('serving tile ' + p);
  res.sendFile(p);
});

app.get('/', function (req, res) {
  console.log('serving index');
  //res.sendFile(path.join(__dirname, '../build', 'index.html'));
});


app.listen(8080);