import { promises as fs } from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { VENTURE_DIR_SKELETON } from "@founder-os/workspace-core";
import { createLogger } from "@founder-os/logger";

const logger = createLogger("workspace-node");

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeText(filePath: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, contents, "utf8");
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export async function moveFile(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to));
  await fs.rename(from, to);
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Create the full canonical directory skeleton for a new venture root. */
export async function scaffoldVentureDirs(ventureRoot: string): Promise<void> {
  for (const rel of VENTURE_DIR_SKELETON) {
    await ensureDir(path.join(ventureRoot, rel));
  }
  logger.info("workspace.scaffold.complete", { ventureRoot });
}

export interface WatchHandle {
  close: () => Promise<void>;
}

export function watchJsonDir(
  dir: string,
  onAdd: (filePath: string) => void | Promise<void>
): WatchHandle {
  const watcher: FSWatcher = chokidar.watch(path.join(dir, "*.json"), {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  watcher.on("add", (filePath) => {
    Promise.resolve(onAdd(filePath)).catch((err) => {
      logger.error("workspace.watch.handler_failed", { filePath, err: String(err) });
    });
  });
  return {
    close: async () => {
      await watcher.close();
    },
  };
}
