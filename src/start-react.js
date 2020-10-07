//https://flaviocopes.com/react-electron/
// import * as net from 'net'
// import * as childProcess from 'child_process'
const net = require('net');
const childProcess = require('child_process');


//declare const process: NodeJS.Process;
const port = process.env.PORT ? parseInt(process.env.PORT) - 100 : 3000;

process.env.ELECTRON_START_URL = `http://localhost:${port}`;

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
