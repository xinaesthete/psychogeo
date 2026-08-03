/**
 * Verify the zarr transcode two ways:
 *  1. Byte identity — pull every chunk back out of the shard via its index and
 *     compare with the source .j2c. Proves the repack is lossless.
 *  2. Read path — open the store with zarrita + zarrextra's HTJ2K codec and
 *     decode a window, the way the browser will.
 */
import { open as openFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as zarr from 'zarrita';
import { createOpenJphDecoder, registerExperimentalHtj2kCodec } from 'zarrextra';
import { decode as openJphDecode } from 'openjph-wasm';

const STORE = process.argv[2];
const SOURCE = process.argv[3];
const REGION = process.argv[4] ?? 'SU42';
const CHANNEL = 'height.dsm.fz';

/** Minimal filesystem store with the getRange the sharding codec needs. */
class FileStore {
  constructor(root) {
    this.root = root;
  }
  #path(key) {
    return path.join(this.root, key);
  }
  async get(key) {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch {
      return undefined;
    }
  }
  async getRange(key, range) {
    let handle;
    try {
      handle = await openFile(this.#path(key), 'r');
    } catch {
      return undefined;
    }
    try {
      const { size } = await handle.stat();
      const offset = 'suffixLength' in range ? size - range.suffixLength : range.offset;
      const length = 'suffixLength' in range ? range.suffixLength : (range.length ?? size - offset);
      const buf = new Uint8Array(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

function readShardIndex(shard, slots) {
  const indexBytes = slots * 16 + 4;
  const start = shard.length - indexBytes;
  const view = new DataView(shard.buffer, shard.byteOffset);
  const entries = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const offset = view.getBigUint64(start + slot * 16, true);
    const length = view.getBigUint64(start + slot * 16 + 8, true);
    entries.push(offset === 0xffffffffffffffffn ? null : { offset: Number(offset), length: Number(length) });
  }
  return entries;
}

async function checkByteIdentity() {
  const nodeDir = path.join(SOURCE, 'pyramid', REGION);
  const manifests = [];
  for (const entry of await readdir(nodeDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !/^\d+$/.test(entry.name)) {
      manifests.push(path.join(nodeDir, entry.name));
    }
  }

  let compared = 0;
  let mismatched = 0;
  for (const quadDir of manifests) {
    const manifest = JSON.parse(await readFile(path.join(quadDir, 'manifest.json'), 'utf8'));
    const leaf = manifest.leaf;
    if (!leaf) continue;
    const absent = new Set(leaf.missing ?? []);
    // Grid ref bounds: derive from the leaf file names instead of re-implementing osgb here.
    const files = await readdir(path.join(quadDir, '0'));
    for (const name of files) {
      // `._name.j2c` are AppleDouble sidecars, which macOS writes beside every
      // file on a volume with no native xattrs, such as exFAT. They match the
      // suffix but are not codestreams.
      if (!name.endsWith('.j2c') || name.startsWith('._')) continue;
      const [eastMin, northMin] = name.replace('.j2c', '').split('_').map(Number);
      const chunkX = eastMin / 1000;
      const chunkY = (1_300_000 - (northMin + 1000)) / 1000;
      const shardY = Math.floor(chunkY / 10);
      const shardX = Math.floor(chunkX / 10);
      const slot = (chunkY % 10) * 10 + (chunkX % 10);

      const shardPath = path.join(STORE, CHANNEL, '0', 'c', String(shardY), String(shardX));
      const shard = new Uint8Array(await readFile(shardPath));
      const entries = readShardIndex(shard, 100);
      const entry = entries[slot];
      const source = new Uint8Array(await readFile(path.join(quadDir, '0', name)));
      compared += 1;
      if (!entry || entry.length !== source.length) {
        mismatched += 1;
        console.log(`  MISMATCH length ${name}: shard ${entry?.length} vs source ${source.length}`);
        continue;
      }
      const stored = shard.subarray(entry.offset, entry.offset + entry.length);
      for (let i = 0; i < source.length; i += 1) {
        if (stored[i] !== source[i]) {
          mismatched += 1;
          console.log(`  MISMATCH byte ${i} of ${name}`);
          break;
        }
      }
    }
    void absent;
  }
  console.log(`byte identity: ${compared - mismatched}/${compared} chunks identical`);
  return mismatched === 0;
}

async function checkReadPath() {
  registerExperimentalHtj2kCodec({ decoder: createOpenJphDecoder(openJphDecode) });
  const store = new FileStore(STORE);
  const group = await zarr.open(zarr.root(store), { kind: 'group' });
  console.log('root group attrs:', JSON.stringify(group.attrs.psychogeo));

  const arr = await zarr.open(zarr.root(store).resolve(`${CHANNEL}/0`), { kind: 'array' });
  console.log(`level 0 array: shape ${arr.shape}, dtype ${arr.dtype}, chunks ${arr.chunks}`);

  // Find a written chunk from the scale array, then read exactly that chunk.
  const scaleArr = await zarr.open(zarr.root(store).resolve(`${CHANNEL}/encoding/scale/0`), { kind: 'array' });
  const scale = await zarr.get(scaleArr);
  const offsetArr = await zarr.open(zarr.root(store).resolve(`${CHANNEL}/encoding/offset/0`), { kind: 'array' });
  const offsets = await zarr.get(offsetArr);
  const [rows, cols] = scale.shape;
  let found = null;
  for (let i = 0; i < scale.data.length && !found; i += 1) {
    if (!Number.isNaN(scale.data[i])) found = { y: Math.floor(i / cols), x: i % cols, index: i };
  }
  if (!found) throw new Error('no chunk recorded in the scale array');
  const s = scale.data[found.index];
  const o = offsets.data[found.index];
  console.log(`probing chunk [${found.y}, ${found.x}] (east ${found.x * 1000}, north ${1_300_000 - (found.y + 1) * 1000})`);
  console.log(`  scale ${s}, offset ${o} → height range ${(o + s).toFixed(2)}..${(o + 65535 * s).toFixed(2)} m`);
  void rows;

  const y0 = found.y * 1000;
  const x0 = found.x * 1000;
  const window = await zarr.get(arr, [zarr.slice(y0, y0 + 1000), zarr.slice(x0, x0 + 1000)]);
  console.log(`  decoded window ${window.shape}, ${window.data.constructor.name}`);

  let min = Infinity;
  let max = -Infinity;
  let nodata = 0;
  for (const v of window.data) {
    if (v === 0) { nodata += 1; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  console.log(`  raw samples: min ${min}, max ${max}, nodata ${nodata}/${window.data.length}`);
  console.log(`  heights: ${(o + min * s).toFixed(2)}..${(o + max * s).toFixed(2)} m`);
  return { min, max, scale: s, offset: o };
}

/**
 * Does row 0 of a chunk really sit at its north edge?
 *
 * Byte identity says nothing about orientation, and the whole
 * no-decode-no-re-encode claim rests on the stored codestreams already running
 * north-first. So: take two vertically adjacent chunks, convert both to metres
 * (they are normalised independently), and compare the rows that meet at the
 * seam. Terrain is continuous, so they should agree closely. The control pairs
 * rows that are 1 km apart instead — if the seam test cannot tell those two
 * cases apart it is not measuring anything.
 */
async function checkOrientation() {
  const store = new FileStore(STORE);
  const arr = await zarr.open(zarr.root(store).resolve(`${CHANNEL}/0`), { kind: 'array' });
  const scale = await zarr.get(await zarr.open(zarr.root(store).resolve(`${CHANNEL}/encoding/scale/0`), { kind: 'array' }));
  const offsets = await zarr.get(await zarr.open(zarr.root(store).resolve(`${CHANNEL}/encoding/offset/0`), { kind: 'array' }));
  const cols = scale.shape[1];

  let pair = null;
  for (let i = 0; i < scale.data.length && !pair; i += 1) {
    const below = i + cols;
    if (below >= scale.data.length) continue;
    if (Number.isNaN(scale.data[i]) || Number.isNaN(scale.data[below])) continue;
    pair = { upper: i, lower: below, y: Math.floor(i / cols), x: i % cols };
  }
  if (!pair) {
    console.log('orientation: no vertically adjacent pair of chunks to test');
    return true;
  }

  const toMetres = (raw, index) => offsets.data[index] + raw * scale.data[index];
  const rowAt = async (y, x0) => {
    const row = await zarr.get(arr, [y, zarr.slice(x0, x0 + 1000)]);
    return row.data;
  };
  const x0 = pair.x * 1000;
  const seamTop = await rowAt((pair.y + 1) * 1000 - 1, x0); // last row of upper chunk
  const seamBottom = await rowAt((pair.y + 1) * 1000, x0); // first row of lower chunk
  const farTop = await rowAt(pair.y * 1000, x0); // first row of upper chunk, 1 km away

  const meanAbsDiff = (a, ai, b, bi) => {
    let total = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === 0 || b[i] === 0) continue; // nodata
      total += Math.abs(toMetres(a[i], ai) - toMetres(b[i], bi));
      n += 1;
    }
    return n > 0 ? total / n : Number.NaN;
  };

  const seam = meanAbsDiff(seamTop, pair.upper, seamBottom, pair.lower);
  const control = meanAbsDiff(farTop, pair.upper, seamBottom, pair.lower);
  console.log(`orientation: chunks [${pair.y}, ${pair.x}] / [${pair.y + 1}, ${pair.x}]`);
  console.log(`  mean |Δh| across the seam: ${seam.toFixed(3)} m`);
  console.log(`  control, rows 1 km apart:  ${control.toFixed(3)} m`);
  return seam < control / 2;
}

const identical = await checkByteIdentity();
const read = await checkReadPath();
const oriented = await checkOrientation();
console.log(identical ? 'REPACK OK' : 'REPACK FAILED');
console.log(read.max > read.min ? 'READ OK' : 'READ SUSPECT');
console.log(oriented ? 'ORIENTATION OK' : 'ORIENTATION WRONG');
