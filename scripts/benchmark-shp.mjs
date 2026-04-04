import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import Delaunator from 'delaunator';
import { LatLon as GeodesyLatLon } from 'geodesy/osgridref.js';

globalThis.self = globalThis;

const { default: shp } = await import('shpjs');
const wasmModule = await import('../rust/shp_processor_wasm/pkg/shp_processor_wasm.js');

const {
  initSync,
  triangulate_coordinates3d,
  triangulate_shp_zip,
} = wasmModule;

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = {
    file: 'public/data/su42_OST50CONT_20190530.zip',
    iterations: 20,
    warmup: 5,
    json: false,
    mode: undefined,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--file') {
      options.file = argv[index + 1] ?? options.file;
      index += 1;
      continue;
    }
    if (arg === '--iterations') {
      options.iterations = Number(argv[index + 1] ?? options.iterations);
      index += 1;
      continue;
    }
    if (arg === '--warmup') {
      options.warmup = Number(argv[index + 1] ?? options.warmup);
      index += 1;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--mode') {
      options.mode = argv[index + 1] ?? options.mode;
      index += 1;
    }
  }

  if (!Number.isInteger(options.iterations) || options.iterations <= 0) {
    throw new Error(`invalid --iterations value '${options.iterations}'`);
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error(`invalid --warmup value '${options.warmup}'`);
  }

  return options;
}

function readNumericHeight(properties) {
  const rawHeight = properties?.PROP_VALUE;
  if (typeof rawHeight === 'number' && Number.isFinite(rawHeight)) {
    return rawHeight;
  }
  if (typeof rawHeight === 'string') {
    const parsed = Number(rawHeight);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function pushPosition(position, properties, sink) {
  const [x, y, z] = position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  const height = readNumericHeight(properties) ?? z;
  if (typeof height !== 'number' || !Number.isFinite(height)) {
    return;
  }
  sink.push(x, y, height);
}

function pushGeometryPoints(geometry, properties, sink) {
  if (!geometry) {
    return;
  }
  switch (geometry.type) {
    case 'Point':
      pushPosition(geometry.coordinates, properties, sink);
      return;
    case 'MultiPoint':
    case 'LineString':
      geometry.coordinates.forEach(position => {
        pushPosition(position, properties, sink);
      });
      return;
    case 'MultiLineString':
    case 'Polygon':
      geometry.coordinates.forEach(line => {
        line.forEach(position => {
          pushPosition(position, properties, sink);
        });
      });
      return;
    case 'MultiPolygon':
      geometry.coordinates.forEach(polygon => {
        polygon.forEach(line => {
          line.forEach(position => {
            pushPosition(position, properties, sink);
          });
        });
      });
      return;
    case 'GeometryCollection':
      geometry.geometries.forEach(childGeometry => {
        pushGeometryPoints(childGeometry, properties, sink);
      });
      return;
    default:
      return;
  }
}

function collectShpPoints(source) {
  const points = [];
  const collections = Array.isArray(source) ? source : [source];
  collections.forEach(collection => {
    collection.features.forEach(feature => {
      pushGeometryPoints(feature.geometry, feature.properties, points);
    });
  });
  return new Float64Array(points);
}

async function parseShpPointsWithJavascript(zipArrayBuffer) {
  const source = await shp(zipArrayBuffer);
  const points = collectShpPoints(source);
  if (points.length === 0) {
    throw new Error('no geometry found in shapefile archive');
  }
  return points;
}

function projectJavascriptPointsToOSGB(pointsWgs) {
  const pointsOsgb = new Float64Array(pointsWgs.length);
  for (let pointIndex = 0; pointIndex < pointsWgs.length; pointIndex += 3) {
    const latLon = new GeodesyLatLon(pointsWgs[pointIndex + 1], pointsWgs[pointIndex]);
    const grid = latLon.toOsGrid();
    pointsOsgb[pointIndex] = grid.easting;
    pointsOsgb[pointIndex + 1] = grid.northing;
    pointsOsgb[pointIndex + 2] = pointsWgs[pointIndex + 2];
  }
  return pointsOsgb;
}

function triangulateWithJavascript(pointsXYZ) {
  const pointCount = pointsXYZ.length / 3;
  const coordinates = new Float32Array(pointsXYZ.length);
  const coordinates2d = new Float64Array(pointCount * 2);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    const sourceOffset = pointIndex * 3;
    const targetOffset = pointIndex * 2;
    coordinates[sourceOffset] = pointsXYZ[sourceOffset];
    coordinates[sourceOffset + 1] = pointsXYZ[sourceOffset + 1];
    coordinates[sourceOffset + 2] = pointsXYZ[sourceOffset + 2];
    coordinates2d[targetOffset] = pointsXYZ[sourceOffset];
    coordinates2d[targetOffset + 1] = pointsXYZ[sourceOffset + 1];
  }
  const delaunay = new Delaunator(coordinates2d);
  return {
    coordinates,
    triangles: delaunay.triangles,
  };
}

function readRustTriangulationResult(result) {
  const coordinates = Reflect.get(result, 'coordinates');
  const triangles = Reflect.get(result, 'triangles');
  if (!(coordinates instanceof Float32Array) || !(triangles instanceof Uint32Array)) {
    throw new Error('Rust SHP triangulation returned invalid buffers');
  }
  return { coordinates, triangles };
}

function computeStats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const mean = total / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const middleIndex = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middleIndex - 1] + sorted[middleIndex]) / 2
    : sorted[middleIndex];
  return {
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: mean,
    medianMs: median,
    stdevMs: Math.sqrt(variance),
  };
}

function roundStats(stats) {
  return Object.fromEntries(
    Object.entries(stats).map(([key, value]) => [key, Number(value.toFixed(3))]),
  );
}

async function benchmark(name, warmup, iterations, fn) {
  for (let runIndex = 0; runIndex < warmup; runIndex++) {
    globalThis.gc?.();
    await fn();
  }

  const samples = [];
  let lastResult;
  for (let runIndex = 0; runIndex < iterations; runIndex++) {
    globalThis.gc?.();
    const startedAt = performance.now();
    lastResult = await fn();
    samples.push(performance.now() - startedAt);
  }

  if (!lastResult) {
    throw new Error(`benchmark '${name}' produced no result`);
  }

  const coordinatesLength = lastResult.coordinates instanceof Float32Array
    ? lastResult.coordinates.length
    : lastResult.coordinatesLength;
  const trianglesLength = lastResult.triangles instanceof Uint32Array
    ? lastResult.triangles.length
    : lastResult.trianglesLength;

  if (!Number.isFinite(coordinatesLength) || !Number.isFinite(trianglesLength)) {
    throw new Error(`benchmark '${name}' returned invalid geometry sizes`);
  }

  return {
    name,
    iterations,
    warmup,
    ...roundStats(computeStats(samples)),
    pointCount: coordinatesLength / 3,
    triangleCount: trianglesLength / 3,
  };
}

function formatNumber(value) {
  return value.toFixed(3).padStart(9);
}

function printTable(results, referenceName) {
  console.log('');
  console.log('name                  mean ms   median ms      min      max    stdev   speedup');
  const reference = results.find(result => result.name === referenceName);
  results.forEach(result => {
    const speedup = reference ? reference.meanMs / result.meanMs : 1;
    console.log(
      `${result.name.padEnd(20)} ${formatNumber(result.meanMs)} ${formatNumber(result.medianMs)} ${formatNumber(result.minMs)} ${formatNumber(result.maxMs)} ${formatNumber(result.stdevMs)} ${speedup.toFixed(2).padStart(8)}x`,
    );
  });
  console.log('');
}

const options = parseArgs(process.argv.slice(2));
const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const workspaceRoot = resolve(scriptDirectory, '..');
const zipPath = resolve(workspaceRoot, options.file);
const wasmPath = resolve(workspaceRoot, 'rust/shp_processor_wasm/pkg/shp_processor_wasm_bg.wasm');

const [zipBytes, wasmBytes] = await Promise.all([
  readFile(zipPath),
  readFile(wasmPath),
]);

initSync(wasmBytes);

const zipArrayBuffer = zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength);
const jsPointsReference = await parseShpPointsWithJavascript(zipArrayBuffer);
const jsProjectedPointsReference = projectJavascriptPointsToOSGB(jsPointsReference);
const jsReference = triangulateWithJavascript(jsProjectedPointsReference);
const rustReference = readRustTriangulationResult(triangulate_shp_zip(zipBytes));

if (jsReference.coordinates.length !== rustReference.coordinates.length) {
  throw new Error('JS and Rust coordinate counts do not match');
}

const benchmarkFactories = {
  'js-parse': async () => {
    const points = await parseShpPointsWithJavascript(zipArrayBuffer);
    return { coordinatesLength: points.length, trianglesLength: 0 };
  },
  'js-project': () => {
    const points = projectJavascriptPointsToOSGB(jsPointsReference);
    return { coordinatesLength: points.length, trianglesLength: 0 };
  },
  'js-triangulate': () => {
    return triangulateWithJavascript(jsProjectedPointsReference);
  },
  'js-total': async () => {
    const points = await parseShpPointsWithJavascript(zipArrayBuffer);
    const projectedPoints = projectJavascriptPointsToOSGB(points);
    return triangulateWithJavascript(projectedPoints);
  },
  'rust-triangulate': () => {
    return readRustTriangulationResult(triangulate_coordinates3d(jsProjectedPointsReference));
  },
  'rust-total': () => {
    return readRustTriangulationResult(triangulate_shp_zip(zipBytes));
  },
};

const baseSummary = {
  file: basename(zipPath),
  iterations: options.iterations,
  warmup: options.warmup,
  pointCount: jsReference.coordinates.length / 3,
  jsTriangleCount: jsReference.triangles.length / 3,
  rustTriangleCount: rustReference.triangles.length / 3,
};

if (options.mode) {
  const benchmarkFactory = benchmarkFactories[options.mode];
  if (!benchmarkFactory) {
    throw new Error(`unknown benchmark mode '${options.mode}'`);
  }
  const result = await benchmark(options.mode, options.warmup, options.iterations, benchmarkFactory);
  console.log(JSON.stringify({ ...baseSummary, result }));
  process.exit(0);
}

const benchmarkNames = Object.keys(benchmarkFactories);
const benchmarkScriptPath = fileURLToPath(import.meta.url);
const results = [];

for (const benchmarkName of benchmarkNames) {
  const { stdout } = await execFileAsync(process.execPath, [
    '--expose-gc',
    benchmarkScriptPath,
    '--json',
    '--file',
    options.file,
    '--iterations',
    String(options.iterations),
    '--warmup',
    String(options.warmup),
    '--mode',
    benchmarkName,
  ], {
    cwd: workspaceRoot,
    maxBuffer: 1024 * 1024 * 8,
  });
  const payload = JSON.parse(stdout.trim());
  results.push(payload.result);
}

const summary = {
  ...baseSummary,
  results,
};

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Benchmark file: ${summary.file}`);
  console.log(`Points: ${summary.pointCount}`);
  console.log(`JS triangles: ${summary.jsTriangleCount}`);
  console.log(`Rust triangles: ${summary.rustTriangleCount}`);
  printTable(results, 'js-total');
}
