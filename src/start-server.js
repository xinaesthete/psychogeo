//https://dev.to/loujaybee/using-create-react-app-with-express
const tileFolder = "C:/Users/peter/Dropbox/BlenderGIS/pyUtil/images/web/";
const tileSuffix = "_normalised_rate0.jpx";

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

app.get('/tile*', function(req, res) {
  const name = req.url.substring(6);
  const p = path.join(tileFolder, name + tileSuffix);
  res.sendFile(p);
});

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});


app.listen(process.env.PORT || 8080);