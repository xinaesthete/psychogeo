import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function listZipEntries(zipPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function extractZipEntry(zipPath: string, entryPath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('unzip', ['-p', zipPath, entryPath], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  return Buffer.from(stdout);
}

export function findFirstEntry(entries: string[], pattern: RegExp): string | null {
  return entries.find((entry) => pattern.test(entry)) ?? null;
}
