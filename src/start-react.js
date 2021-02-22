//https://flaviocopes.com/react-electron/
// import * as net from 'net'
// import * as childProcess from 'child_process'
const net = require('net');
const childProcess = require('child_process');


//declare const process: NodeJS.Process;
//may want to have another look at this file in general, fix how ports are working with Snowpack.
//how about getting rid of nf / Procfile?
const port = process.env.PORT ? parseInt(process.env.PORT) - 100 : 3000;
process.env.ELECTRON_START_URL = `http://localhost:${port}`;
console.log(`PORT env variable: ${process.env.PORT}`);
console.log(`electron url: ${process.env.ELECTRON_START_URL}`);

const client = new net.Socket();

let startedElectron = false;
const tryConnection = () => {
  client.connect({ port }, () => {
    client.end();
    if (!startedElectron) {
      console.log('starting electron');
      startedElectron = true;
      const exec = childProcess.exec;
      exec('npm run electron');
    }
  });
}

tryConnection();

client.on('error', () => {
  setTimeout(tryConnection, 1000);
});
