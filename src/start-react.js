//https://flaviocopes.com/react-electron/
// import * as net from 'net'
// import * as childProcess from 'child_process'
const net = require('net');
const childProcess = require('child_process');


//declare const process: NodeJS.Process;
// Vite now owns the frontend dev server directly, so we default to its port.
const port = parseInt(process.env.VITE_PORT || process.env.PORT || '3000', 10);
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
      // Use Corepack so the repo does not rely on a globally installed pnpm.
      exec('corepack pnpm run electron');
    }
  });
}

tryConnection();

client.on('error', () => {
  setTimeout(tryConnection, 1000);
});
