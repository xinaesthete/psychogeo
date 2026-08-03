import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectorySource, openSourceStore, ZipSource, type SourceStore } from './sourceStore.ts';

/**
 * The dataset shape that matters to the zarr passes: a root `metadata.json`,
 * node manifests at two depths, level payload directories that hold no
 * manifest, and one leaf that a manifest could name but which is absent.
 */
const FILES: ReadonlyArray<readonly [string, string]> = [
  ['metadata.json', '{"datasetId":"tc-test"}'],
  ['index/completed-cells.json', '[]'],
  ['pyramid/SU42/manifest.json', '{"gridRef":"SU42"}'],
  ['pyramid/SU42/2/SU42.j2c', 'coarse-codestream'],
  ['pyramid/SU42/SU42ne/manifest.json', '{"gridRef":"SU42ne"}'],
  ['pyramid/SU42/SU42ne/0/445000_125000.j2c', 'leaf-codestream'],
  ['pyramid/SU43/manifest.json', '{"gridRef":"SU43"}'],
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A minimal stored-entry zip.
 *
 * Written by hand rather than shelling out to `zip` so the test proves
 * `ZipSource` against real archive bytes on any machine, and so the CRCs are
 * genuine — `unzipper` is entitled to check them.
 */
function buildZip(entries: ReadonlyArray<readonly [string, string]>, prefix: string): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(prefix + name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const created: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `tc-source-${label}-`));
  created.push(dir);
  return dir;
}

async function writeTree(root: string): Promise<void> {
  for (const [relPath, content] of FILES) {
    const target = path.join(root, ...relPath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function writeArchive(prefix: string): Promise<string> {
  const dir = await tempDir('zip');
  const zipPath = path.join(dir, 'dataset.zip');
  await writeFile(zipPath, buildZip(FILES, prefix));
  return zipPath;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The behaviour both implementations owe the zarr passes. */
async function expectDatasetBehaviour(store: SourceStore): Promise<void> {
  expect(await store.nodeDirs()).toEqual(['SU42', 'SU42/SU42ne', 'SU43']);
  expect(await store.readText('metadata.json')).toBe('{"datasetId":"tc-test"}');
  expect(await store.readText('pyramid/SU42/SU42ne/manifest.json')).toBe('{"gridRef":"SU42ne"}');
  expect(await store.size('pyramid/SU42/SU42ne/0/445000_125000.j2c')).toBe('leaf-codestream'.length);
  expect(await store.size('pyramid/SU42/SU42ne/0/999000_999000.j2c')).toBeUndefined();

  const bytes = await store.readBytes('pyramid/SU42/SU42ne/0/445000_125000.j2c');
  expect(bytes && Buffer.from(bytes).toString('utf8')).toBe('leaf-codestream');
  expect(await store.readBytes('pyramid/nope/0/1_2.j2c')).toBeUndefined();
}

describe('SourceStore', () => {
  it('reads an extracted dataset directory', async () => {
    const root = await tempDir('dir');
    await writeTree(root);
    await expectDatasetBehaviour(new DirectorySource(root));
  });

  it('reads the same dataset inside an archive', async () => {
    await expectDatasetBehaviour(await ZipSource.open(await writeArchive('terra-cognita/')));
  });

  it('reads an archive zipped from inside the dataset, with no root component', async () => {
    await expectDatasetBehaviour(await ZipSource.open(await writeArchive('')));
  });

  it('rejects an archive that is not a v2 dataset', async () => {
    const dir = await tempDir('bad');
    const zipPath = path.join(dir, 'other.zip');
    await writeFile(zipPath, buildZip([['notes.txt', 'hello']], ''));
    await expect(ZipSource.open(zipPath)).rejects.toThrow(/not a v2 dataset archive/);
  });

  it('picks the implementation from the path', async () => {
    const root = await tempDir('pick');
    await writeTree(root);
    expect(await openSourceStore(root)).toBeInstanceOf(DirectorySource);
    expect(await openSourceStore(await writeArchive(''))).toBeInstanceOf(ZipSource);
    await expect(openSourceStore(path.join(root, 'metadata.json'))).rejects.toThrow(/\.zip/);
    await expect(openSourceStore(path.join(root, 'absent'))).rejects.toThrow(/not found/);
  });
});
