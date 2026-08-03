import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';
import { parseMetadataJson } from '../v2/schema.ts';
import type { TerrainManifestV2 } from '../v2/types.ts';

/**
 * Read-only access to a v2 dataset, whether it is an extracted tree or still
 * inside its archive.
 *
 * The zarr passes only ever read four things — `metadata.json`, the node
 * manifests, the level-0 codestreams and a check that a codestream exists — so
 * the seam is small enough that the archive case costs nothing in the
 * directory case.
 *
 * Reading from the archive is the preferred path at national scale.
 * `terra-cognita-winchester.zip` is 160,750 files; extracted onto a 1 MiB
 * allocation unit that is 239 GiB against 144 GiB of actual data, and the
 * directory walk the tree case needs takes over two minutes before the first
 * chunk is read. The archive's central directory answers the same questions in
 * about three seconds.
 *
 * Paths are dataset-relative and always POSIX-separated, because that is what
 * a zip stores; the directory case converts on the way out.
 */
export interface SourceStore {
  /** For error messages and progress output. */
  readonly label: string;
  readBytes(relPath: string): Promise<Uint8Array | undefined>;
  readText(relPath: string): Promise<string | undefined>;
  /**
   * Uncompressed size, or undefined if there is no such entry.
   *
   * Doubles as the existence check, so a scan can total the source bytes it is
   * about to read without reading them — which keeps the run summary honest
   * when a resumed run skips most of the work.
   */
  size(relPath: string): Promise<number | undefined>;
  /**
   * Directories under `pyramid/` that hold a `manifest.json`, relative to
   * `pyramid/` itself, in a stable order.
   *
   * Sorted rather than in whatever order the source enumerates, so that the
   * shards come out in the same sequence every run. That is what lets an
   * interrupted run be compared byte for byte against an uninterrupted one.
   */
  nodeDirs(): Promise<string[]>;
  close(): Promise<void>;
}

/** Path of something inside a pyramid node, dataset-relative. */
export function nodePath(relDir: string, ...rest: string[]): string {
  return ['pyramid', ...(relDir ? [relDir] : []), ...rest].join('/');
}

export async function readSourceMetadata(store: SourceStore): Promise<TerrainManifestV2> {
  const content = await store.readText('metadata.json');
  if (content === undefined) throw new Error(`no metadata.json in ${store.label}`);
  return parseMetadataJson(JSON.parse(content));
}

/** A `.zip` is read in place; anything else is treated as an extracted tree. */
export async function openSourceStore(datasetPath: string): Promise<SourceStore> {
  const info = await stat(datasetPath).catch(() => undefined);
  if (!info) throw new Error(`dataset not found: ${datasetPath}`);
  if (info.isDirectory()) return new DirectorySource(datasetPath);
  if (datasetPath.toLowerCase().endsWith('.zip')) return ZipSource.open(datasetPath);
  throw new Error(`dataset must be a directory or a .zip archive: ${datasetPath}`);
}

export class DirectorySource implements SourceStore {
  readonly label: string;

  constructor(private readonly root: string) {
    this.label = root;
  }

  private resolve(relPath: string): string {
    return path.join(this.root, ...relPath.split('/'));
  }

  async readBytes(relPath: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.resolve(relPath)));
    } catch {
      return undefined;
    }
  }

  async readText(relPath: string): Promise<string | undefined> {
    try {
      return await readFile(this.resolve(relPath), 'utf8');
    } catch {
      return undefined;
    }
  }

  async size(relPath: string): Promise<number | undefined> {
    try {
      return (await stat(this.resolve(relPath))).size;
    } catch {
      return undefined;
    }
  }

  async nodeDirs(): Promise<string[]> {
    const found: string[] = [];
    await this.walk('', found);
    found.sort();
    return found;
  }

  /**
   * Numeric directories are the level payload dirs — thousands of `.j2c` files
   * with no manifest below them, so they are not descended into.
   */
  private async walk(relDir: string, found: string[]): Promise<void> {
    const absDir = path.join(this.root, 'pyramid', ...(relDir ? relDir.split('/') : []));
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'manifest.json')) {
      found.push(relDir);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (/^\d+$/.test(entry.name)) continue;
      await this.walk(relDir ? `${relDir}/${entry.name}` : entry.name, found);
    }
  }

  async close(): Promise<void> {}
}

type ZipEntry = { uncompressedSize: number; buffer(): Promise<Buffer> };

export class ZipSource implements SourceStore {
  readonly label: string;

  private constructor(
    zipPath: string,
    private readonly entries: Map<string, ZipEntry>,
  ) {
    this.label = zipPath;
  }

  static async open(zipPath: string): Promise<ZipSource> {
    const directory = await unzipper.Open.file(zipPath);
    // Archives made by zipping the dataset folder carry a single root
    // component; ones made from inside it do not. Anchor on `metadata.json`,
    // which sits at the dataset root either way, and take the shallowest match
    // so a stray copy deeper in the tree cannot claim the root.
    let prefix: string | undefined;
    for (const file of directory.files) {
      const at = file.path.replace(/\\/g, '/');
      if (!at.endsWith('metadata.json')) continue;
      const candidate = at.slice(0, at.length - 'metadata.json'.length);
      if (prefix === undefined || candidate.length < prefix.length) prefix = candidate;
    }
    if (prefix === undefined) {
      throw new Error(`no metadata.json in ${zipPath} — not a v2 dataset archive`);
    }

    const entries = new Map<string, ZipEntry>();
    for (const file of directory.files) {
      const at = file.path.replace(/\\/g, '/');
      if (!at.startsWith(prefix) || at.endsWith('/')) continue;
      entries.set(at.slice(prefix.length), file as unknown as ZipEntry);
    }
    return new ZipSource(zipPath, entries);
  }

  async readBytes(relPath: string): Promise<Uint8Array | undefined> {
    const entry = this.entries.get(relPath);
    if (!entry) return undefined;
    return new Uint8Array(await entry.buffer());
  }

  async readText(relPath: string): Promise<string | undefined> {
    const bytes = await this.readBytes(relPath);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
  }

  /** An index lookup, where the directory case pays a `stat` per chunk. */
  async size(relPath: string): Promise<number | undefined> {
    return this.entries.get(relPath)?.uncompressedSize;
  }

  async nodeDirs(): Promise<string[]> {
    const found: string[] = [];
    for (const relPath of this.entries.keys()) {
      if (!relPath.startsWith('pyramid/') || !relPath.endsWith('/manifest.json')) continue;
      found.push(relPath.slice('pyramid/'.length, relPath.length - '/manifest.json'.length));
    }
    found.sort();
    return found;
  }

  async close(): Promise<void> {}
}
