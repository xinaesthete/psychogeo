import { defineConfig } from 'vite';
import typegpuPlugin from 'unplugin-typegpu/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pipelineRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: pipelineRoot,
  plugins: [typegpuPlugin()],
  resolve: {
    alias: {
      geotiff: resolve(pipelineRoot, '../../../node_modules/geotiff/dist-module/geotiff.js'),
    },
  },
  build: {
    ssr: 'cli.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      input: resolve(pipelineRoot, 'cli.ts'),
      output: {
        entryFileNames: 'cli.mjs',
        format: 'esm',
      },
    },
  },
  ssr: {
    target: 'node',
    noExternal: true,
    external: ['webgpu', 'unzipper'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
