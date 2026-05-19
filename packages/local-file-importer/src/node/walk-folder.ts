/**
 * Recursive folder walker. Skips dot-files and OS junk (Thumbs.db,
 * desktop.ini, .DS_Store) via shouldIngest from the client-safe walk.ts.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type DiscoveredFile, shouldIngest } from "../walk";

export async function walkFolder(rootPath: string): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  await visit(rootPath, out);
  return out;
}

async function visit(dir: string, out: DiscoveredFile[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!shouldIngest(name)) continue;
    const absolutePath = join(dir, name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(absolutePath);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await visit(absolutePath, out);
      continue;
    }
    if (s.isFile()) {
      out.push({ absolutePath, originalName: basename(absolutePath) });
    }
  }
}
