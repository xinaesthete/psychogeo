import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { leafChunkDatasetPath, nodeManifestPath } from './derive.ts';
import { readMetadata, readNodeManifest } from './layout.ts';
import { gridRefToBounds } from './osgb.ts';

async function countJ2cFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += await countJ2cFiles(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.j2c')) {
        count += 1;
      }
    }
  } catch {
    return 0;
  }
  return count;
}

export async function inspectDatasetV2(datasetDir: string): Promise<string> {
  const meta = await readMetadata(datasetDir);
  const root = await readNodeManifest(datasetDir, meta.indexRoot);
  const lines: string[] = [
    `dataset: ${meta.datasetId}`,
    `schema: ${meta.schemaVersion} (${meta.format})`,
    `ingest cell: ${meta.ingestCell}`,
    `channel: ${meta.channelId}`,
    `pyramid levels: ${meta.tileMatrixSet.levels.map((level) => `L${level.level}=${level.resolutionMetres}m@${level.tierMetres}m`).join(', ')}`,
    `index root: ${meta.indexRoot}`,
    `children: ${(root.children ?? []).join(', ') || '(none)'}`,
    `coverage: ${root.coverage ?? 'unknown'}`,
  ];

  if (meta.skippedGroups && meta.skippedGroups.length > 0) {
    lines.push(`skipped groups: ${meta.skippedGroups.length}`);
    for (const entry of meta.skippedGroups) {
      lines.push(`  ${entry.tileRef} ${entry.year}: ${entry.reason}`);
    }
  }

  let leafSlots = 0;
  let missingSlots = 0;
  for (const childRef of root.children ?? []) {
    try {
      const child = await readNodeManifest(datasetDir, nodeManifestPath(meta.ingestCell, childRef));
      if (child.leaf) {
        const total = child.leaf.cols * child.leaf.rows;
        const missing = child.leaf.missing?.length ?? 0;
        leafSlots += total - missing;
        missingSlots += missing;
        lines.push(
          `  ${childRef}: ${total - missing}/${total} leaf slots, merged levels: ${Object.keys(child.levels ?? {}).join(', ') || '(none)'}`,
        );
      }
    } catch {
      lines.push(`  ${childRef}: manifest missing`);
    }
  }

  const bounds = gridRefToBounds(meta.ingestCell);
  lines.push(`bounds: E${bounds.eastMin}-${bounds.eastMax} N${bounds.northMin}-${bounds.northMax}`);
  lines.push(`leaf payloads present: ${leafSlots} (${missingSlots} missing slots)`);
  lines.push(`merged levels on root: ${Object.keys(root.levels ?? {}).join(', ') || '(none)'}`);

  const pyramidDir = path.join(datasetDir, 'pyramid', meta.ingestCell);
  const j2cCount = await countJ2cFiles(pyramidDir);
  lines.push(`j2c files under pyramid/${meta.ingestCell}: ${j2cCount}`);

  const metadataStat = await stat(path.join(datasetDir, 'metadata.json'));
  lines.push(`metadata.json: ${metadataStat.size} bytes`);

  return lines.join('\n');
}

export async function verifyDerivedPaths(datasetDir: string): Promise<string[]> {
  const meta = await readMetadata(datasetDir);
  const root = await readNodeManifest(datasetDir, meta.indexRoot);
  const errors: string[] = [];

  for (const childRef of root.children ?? []) {
    const child = await readNodeManifest(datasetDir, nodeManifestPath(meta.ingestCell, childRef));
    if (!child.leaf) continue;
    const cellBounds = gridRefToBounds(childRef);
    for (let row = 0; row < child.leaf.rows; row += 1) {
      for (let col = 0; col < child.leaf.cols; col += 1) {
        const index = col + row * child.leaf.cols;
        if (child.leaf.missing?.includes(index)) continue;
        const eastMin = cellBounds.eastMin + col * child.leaf.stepMetres;
        const northMin = cellBounds.northMin + row * child.leaf.stepMetres;
        const rel = leafChunkDatasetPath(meta.ingestCell, childRef, eastMin, northMin, meta.naming);
        try {
          await stat(path.join(datasetDir, rel));
        } catch {
          errors.push(`missing file for slot ${index} at ${rel}`);
        }
      }
    }
  }

  return errors;
}
