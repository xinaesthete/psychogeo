/**
 * Verify a renormalised zarr store against the v2 dataset it came from.
 *
 * Unlike the repack, this pass rewrites every sample, so byte identity is not
 * available as a check. Three things can be verified instead:
 *
 *   1. Heights survive the requantisation, within the predicted bound.
 *   2. Row 0 is still the north edge.
 *   3. Coarse levels sit where they claim to — an off-by-one in child
 *      placement would shift a level by a whole chunk and still look
 *      plausible, so the alignment test scores neighbouring shifts as its own
 *      control.
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
const NORTH_ORIGIN = 1_300_000;

class FileStore {
  constructor(root) {
    this.root = root;
  }
  async get(key) {
    try {
      return new Uint8Array(await readFile(path.join(this.root, key)));
    } catch {
      return undefined;
    }
  }
  async getRange(key, range) {
    let handle;
    try {
      handle = await openFile(path.join(this.root, key), 'r');
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

async function findLeaf() {
  const nodeDir = path.join(SOURCE, 'pyramid', REGION);
  for (const entry of await readdir(nodeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || /^\d+$/.test(entry.name)) continue;
    const quadDir = path.join(nodeDir, entry.name);
    const manifest = JSON.parse(await readFile(path.join(quadDir, 'manifest.json'), 'utf8'));
    if (!manifest.leaf) continue;
    const files = (await readdir(path.join(quadDir, '0'))).filter((n) => n.endsWith('.j2c'));
    if (files.length === 0) continue;
    const name = files[0];
    const [eastMin, northMin] = name.replace('.j2c', '').split('_').map(Number);
    const leaf = manifest.leaf;
    const col = (eastMin - Math.min(...files.map((f) => Number(f.split('_')[0])))) / leaf.stepMetres;
    void col;
    // Recover this slot's scalars by matching the file's grid position.
    const bounds = { eastMin, northMin };
    const originEast = eastMin - ((eastMin / 1000) % 5) * 1000;
    const originNorth = northMin - ((northMin / 1000) % 5) * 1000;
    const slot =
      ((northMin - originNorth) / leaf.stepMetres) * leaf.cols +
      (eastMin - originEast) / leaf.stepMetres;
    return {
      file: path.join(quadDir, '0', name),
      bounds,
      scale: leaf.enc.scale[slot],
      offset: leaf.enc.offset[slot],
    };
  }
  throw new Error('no leaf chunk found');
}

async function main() {
  registerExperimentalHtj2kCodec({ decoder: createOpenJphDecoder(openJphDecode) });
  const store = new FileStore(STORE);

  const l0 = await zarr.open(zarr.root(store).resolve(`${CHANNEL}/0`), { kind: 'array' });
  const enc = l0.attrs.psychogeo;
  console.log(`level 0: shape ${l0.shape}, chunks ${l0.chunks}`);
  console.log(`  scale ${(enc.scale * 1000).toFixed(3)} mm, offset ${enc.offset.toFixed(4)} m`);

  // 1. Heights survive requantisation.
  const leaf = await findLeaf();
  const sourceImage = await openJphDecode(new Uint8Array(await readFile(leaf.file)));
  const x0 = leaf.bounds.eastMin;
  const y0 = NORTH_ORIGIN - (leaf.bounds.northMin + 1000);
  const window = await zarr.get(l0, [zarr.slice(y0, y0 + 1000), zarr.slice(x0, x0 + 1000)]);

  let maxErr = 0;
  let sumSq = 0;
  let counted = 0;
  for (let i = 0; i < window.data.length; i += 1) {
    const stored = window.data[i];
    const original = sourceImage.data[i];
    if (stored === 0 || original === 0) continue;
    const a = original * leaf.scale + leaf.offset;
    const b = stored * enc.scale + enc.offset;
    const delta = Math.abs(a - b);
    if (delta > maxErr) maxErr = delta;
    sumSq += delta * delta;
    counted += 1;
  }
  const halfStep = (enc.scale / 2 + leaf.scale / 2) * 1000;
  console.log(`  vs source chunk ${path.basename(leaf.file)} over ${counted} samples:`);
  console.log(
    `    max ${(maxErr * 1000).toFixed(2)} mm, rms ${(Math.sqrt(sumSq / counted) * 1000).toFixed(2)} mm ` +
      `(bound ${halfStep.toFixed(2)} mm)`,
  );
  const withinBound = maxErr * 1000 <= halfStep + 1e-6;

  // 2. Orientation, by continuity across a chunk seam against a 1 km control.
  const rowAt = async (arr, y, xStart, width) =>
    (await zarr.get(arr, [y, zarr.slice(xStart, xStart + width)])).data;
  const toM = (raw) => (raw === 0 ? Number.NaN : raw * enc.scale + enc.offset);
  const meanAbs = (a, b) => {
    let total = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += 1) {
      const p = toM(a[i]);
      const q = toM(b[i]);
      if (Number.isNaN(p) || Number.isNaN(q)) continue;
      total += Math.abs(p - q);
      n += 1;
    }
    return n > 0 ? total / n : Number.NaN;
  };
  const seamTop = await rowAt(l0, y0 + 999, x0, 1000);
  const seamBottom = await rowAt(l0, y0 + 1000, x0, 1000);
  const control = await rowAt(l0, y0, x0, 1000);
  const seam = meanAbs(seamTop, seamBottom);
  const far = meanAbs(control, seamBottom);
  console.log(`  orientation: seam ${seam.toFixed(3)} m vs 1 km control ${far.toFixed(3)} m`);

  // 3. Coarse level alignment, scored against neighbouring shifts.
  const l1 = await zarr.open(zarr.root(store).resolve(`${CHANNEL}/1`), { kind: 'array' });
  const coarseY = Math.floor(y0 / 4);
  const coarseX = Math.floor(x0 / 4);
  const fine = await zarr.get(l0, [zarr.slice(y0, y0 + 1000), zarr.slice(x0, x0 + 1000)]);
  const boxMean = new Float64Array(250 * 250);
  for (let y = 0; y < 250; y += 1) {
    for (let x = 0; x < 250; x += 1) {
      let total = 0;
      let n = 0;
      for (let dy = 0; dy < 4; dy += 1) {
        for (let dx = 0; dx < 4; dx += 1) {
          const v = toM(fine.data[(y * 4 + dy) * 1000 + x * 4 + dx]);
          if (!Number.isNaN(v)) {
            total += v;
            n += 1;
          }
        }
      }
      boxMean[y * 250 + x] = n > 0 ? total / n : Number.NaN;
    }
  }
  const scores = [];
  for (let sy = -1; sy <= 1; sy += 1) {
    for (let sx = -1; sx <= 1; sx += 1) {
      const patch = await zarr.get(l1, [
        zarr.slice(coarseY + sy * 250, coarseY + sy * 250 + 250),
        zarr.slice(coarseX + sx * 250, coarseX + sx * 250 + 250),
      ]);
      let total = 0;
      let n = 0;
      for (let i = 0; i < boxMean.length; i += 1) {
        const a = boxMean[i];
        const b = toM(patch.data[i]);
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        total += Math.abs(a - b);
        n += 1;
      }
      scores.push({ sy, sx, score: n > 0 ? total / n : Infinity });
    }
  }
  scores.sort((a, b) => a.score - b.score);
  const best = scores[0];
  const runnerUp = scores.find((s) => s.sy !== 0 || s.sx !== 0);
  console.log(
    `  level 1 alignment: best shift (${best.sy}, ${best.sx}) at ${best.score.toFixed(3)} m; ` +
      `nearest wrong shift ${runnerUp.score.toFixed(3)} m`,
  );
  const aligned = best.sy === 0 && best.sx === 0 && runnerUp.score > best.score * 2;

  console.log(withinBound ? 'REQUANTISATION OK' : 'REQUANTISATION OUT OF BOUND');
  console.log(seam < far / 2 ? 'ORIENTATION OK' : 'ORIENTATION WRONG');
  console.log(aligned ? 'LEVEL ALIGNMENT OK' : 'LEVEL ALIGNMENT SUSPECT');
}

await main();
