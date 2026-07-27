import * as unzipper from 'unzipper';

export async function listZipEntries(zipPath: string): Promise<string[]> {
  const directory = await unzipper.Open.file(zipPath);
  return directory.files.map((f) => f.path);
}

export async function extractZipEntry(
  zipPath: string,
  entryPath: string,
): Promise<Buffer> {
  const directory = await unzipper.Open.file(zipPath);

  const entry = directory.files.find((f) => f.path === entryPath);
  if (!entry) {
    throw new Error(`Entry not found: ${entryPath}`);
  }

  return await entry.buffer();
}

export function findFirstEntry(
  entries: string[],
  pattern: RegExp,
): string | null {
  return entries.find((entry) => pattern.test(entry)) ?? null;
}
