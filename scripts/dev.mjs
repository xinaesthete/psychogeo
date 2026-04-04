import net from 'node:net';
import { spawn } from 'node:child_process';
import process from 'node:process';

const proxyPort = 8082;
const pollIntervalMs = 250;
const proxyTimeoutMs = 15000;

const children = new Set();
let shuttingDown = false;

function pnpmCommand() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath],
    };
  }
  return {
    command: 'pnpm',
    args: [],
  };
}

function killChildren(signal = 'SIGTERM') {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

function exitAfterChildren(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  killChildren();
  setTimeout(() => killChildren('SIGKILL'), 2000).unref();
  process.exitCode = code;
}

function spawnPnpmScript(scriptName) {
  const { command, args } = pnpmCommand();
  const child = spawn(command, [...args, 'run', scriptName], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) {
      return;
    }
    const exitCode = typeof code === 'number' ? code : 1;
    console.error(`${scriptName} exited${signal ? ` via ${signal}` : ''}`);
    exitAfterChildren(exitCode);
  });
  return child;
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const tryConnect = () => {
      if (shuttingDown) {
        reject(new Error('Dev launcher shutting down'));
        return;
      }
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (shuttingDown) {
          reject(new Error('Dev launcher shutting down'));
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for proxy on port ${port}`));
          return;
        }
        setTimeout(tryConnect, pollIntervalMs);
      });
    };

    tryConnect();
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    exitAfterChildren(0);
  });
}

console.log(`Starting dev proxy on port ${proxyPort}...`);
spawnPnpmScript('dev:proxy');

try {
  await waitForPort(proxyPort, proxyTimeoutMs);
  console.log('Proxy is ready, starting Vite dev server...');
  spawnPnpmScript('dev:vite');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterChildren(1);
}
