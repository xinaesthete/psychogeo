// Snowpack Configuration File
// See all supported options: https://www.snowpack.dev/reference/configuration

// src/index.tsx - main entry point.
// CRA seems to obscure how this gets loaded into the HTML, added relevant script tag.

console.log(`snowpack config...`);
const httpProxy = require("http-proxy");
const proxy = httpProxy.createServer({target: 'http://localhost:8082' });

// Move on to figuring out how to piece other bits together better.
// start.js (node thing that starts electron)
// start-server.js, start.js, electron-preload.js, workers, wasm bits.

/** @type {import("snowpack").SnowpackUserConfig } */
module.exports = {
  mount: {
    public: { url: '/', static: true },
    src: { url: '/dist' },
  },
  plugins: [
    // '@snowpack/plugin-react-refresh',
    // '@snowpack/plugin-dotenv',
    // '@snowpack/plugin-typescript',
  ],
  routes: [
    {
      src: '/(tile|os|gpx|ltile|ttile|ping)/.*',
      dest: (req, res) => proxy.web(req, res),
    }
    
    /* Enable an SPA Fallback in development: */
    // {"match": "routes", "src": ".*", "dest": "/index.html"},
  ],
  optimize: {
    /* Example: Bundle your final build: */
    // "bundle": true,
  },
  packageOptions: {
    /* ... */
  },
  devOptions: {
    port: 3000
  },
  buildOptions: {
    sourcemap: true
  },
};
