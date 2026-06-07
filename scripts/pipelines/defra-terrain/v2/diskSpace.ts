import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { formatBytes } from './metrics.ts';

export const DEFAULT_MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024;

export async function freeSpaceBytes(targetPath: string): Promise<number> {
  const resolved = path.resolve(targetPath);
  const stats = await statfs(resolved);
  return stats.bavail * stats.bsize;
}

export async function assertMinFreeSpace(
  targetPath: string,
  minFreeBytes: number,
  context?: string,
): Promise<void> {
  const freeBytes = await freeSpaceBytes(targetPath);
  if (freeBytes < minFreeBytes) {
    const label = context ? `${context}: ` : '';
    throw new Error(
      `${label}insufficient disk space at ${path.resolve(targetPath)} ` +
        `(free ${formatBytes(freeBytes)}, need at least ${formatBytes(minFreeBytes)})`,
    );
  }
}
