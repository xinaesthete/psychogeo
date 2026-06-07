import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseMetadataJson, parseNodeManifestJson } from './schema.ts';
import type { PyramidNodeManifest, TerrainManifestV2 } from './types.ts';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

export async function writeJsonFile(outDir: string, relPath: string, value: unknown): Promise<void> {
  await writeJson(path.join(outDir, relPath), value);
}

export async function writeMetadata(outDir: string, metadata: TerrainManifestV2): Promise<string> {
  parseMetadataJson(metadata);
  const filePath = path.join(outDir, 'metadata.json');
  await writeJson(filePath, metadata);
  return filePath;
}

export async function writeNodeManifest(
  outDir: string,
  filePath: string,
  manifest: PyramidNodeManifest,
): Promise<void> {
  parseNodeManifestJson(manifest);
  await writeJson(path.join(outDir, filePath), manifest);
}

export async function readMetadata(outDir: string): Promise<TerrainManifestV2> {
  const content = await readFile(path.join(outDir, 'metadata.json'), 'utf8');
  return parseMetadataJson(JSON.parse(content));
}

export async function readNodeManifest(outDir: string, relPath: string): Promise<PyramidNodeManifest> {
  const content = await readFile(path.join(outDir, relPath), 'utf8');
  return parseNodeManifestJson(JSON.parse(content));
}
