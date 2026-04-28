import { createLogger } from "@founder-os/logger";
import { VENTURE_DIR_SKELETON } from "@founder-os/workspace-core";
/**
 * Tauri file system adapter used by the desktop app.
 * All desktop-side file IO goes through this package so the Tauri capabilities
 * surface area stays small and auditable.
 */
import {
  BaseDirectory,
  mkdir,
  readDir,
  readTextFile,
  rename,
  exists as tauriExists,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const logger = createLogger("workspace-tauri");

/** Options passed through to Tauri fs plugin calls (absolute paths are used by default). */
export interface FsOpts {
  baseDir?: BaseDirectory;
}

export async function ensureDir(dirPath: string, opts: FsOpts = {}): Promise<void> {
  await mkdir(dirPath, { recursive: true, baseDir: opts.baseDir });
}

export async function exists(filePath: string, opts: FsOpts = {}): Promise<boolean> {
  try {
    return await tauriExists(filePath, { baseDir: opts.baseDir });
  } catch {
    return false;
  }
}

export async function writeJson(
  filePath: string,
  value: unknown,
  opts: FsOpts = {}
): Promise<void> {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash > 0) {
    await ensureDir(filePath.slice(0, lastSlash), opts);
  }
  await writeTextFile(filePath, JSON.stringify(value, null, 2), { baseDir: opts.baseDir });
}

export async function readJson<T>(filePath: string, opts: FsOpts = {}): Promise<T> {
  const raw = await readTextFile(filePath, { baseDir: opts.baseDir });
  return JSON.parse(raw) as T;
}

export async function writeText(
  filePath: string,
  contents: string,
  opts: FsOpts = {}
): Promise<void> {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash > 0) {
    await ensureDir(filePath.slice(0, lastSlash), opts);
  }
  await writeTextFile(filePath, contents, { baseDir: opts.baseDir });
}

export async function readText(filePath: string, opts: FsOpts = {}): Promise<string> {
  return readTextFile(filePath, { baseDir: opts.baseDir });
}

export async function moveFile(from: string, to: string, opts: FsOpts = {}): Promise<void> {
  await rename(from, to, { oldPathBaseDir: opts.baseDir, newPathBaseDir: opts.baseDir });
}

export async function listFiles(dir: string, opts: FsOpts = {}): Promise<string[]> {
  try {
    const entries = await readDir(dir, { baseDir: opts.baseDir });
    return entries.filter((e) => e.isFile).map((e) => `${dir}/${e.name}`);
  } catch {
    return [];
  }
}

export async function scaffoldVentureDirs(ventureRoot: string, opts: FsOpts = {}): Promise<void> {
  for (const rel of VENTURE_DIR_SKELETON) {
    await ensureDir(`${ventureRoot}/${rel}`, opts);
  }
  logger.info("workspace.scaffold.complete", { ventureRoot });
}

export { BaseDirectory };
