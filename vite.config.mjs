import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  publicDir: 'public',
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: resolve('node_modules/buffer/index.js'),
    },
  },
  optimizeDeps: {
    rolldownOptions: {
      transform: {
        define: {
          global: 'globalThis',
        },
      },
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/tile': 'http://localhost:8082',
      '/os': 'http://localhost:8082',
      '/gpx': 'http://localhost:8082',
      '/ltile': 'http://localhost:8082',
      '/ttile': 'http://localhost:8082',
      '/ping': 'http://localhost:8082',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
