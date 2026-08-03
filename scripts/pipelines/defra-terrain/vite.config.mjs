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
    dir: resolve(pipelineRoot, '../../..'),
    include: [
      'scripts/pipelines/defra-terrain/**/*.test.ts',
      'src/geo/pyramidCatalog.test.ts',
      'src/geo/pyramidDerive.test.ts',
      'src/geo/groundViewport.test.ts',
      'src/geo/LodUtils.test.ts',
      'src/geo/tileGeometry.test.ts',
      'src/geo/tileRetention.test.ts',
      'src/geo/pyramidTileNode.test.ts',
      'src/geo/compressionFormat.test.ts',
      'src/camera/orbitClamp.test.ts',
      'src/openjpegjs/textureLruCache.test.ts',
      'src/openjpegjs/workerPool.test.ts',
      'src/util/timingStats.test.ts',
      'src/util/concurrency.test.ts',
    ],
  },
});
