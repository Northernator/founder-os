/**
 * NodeFsAdapter -- the FsAdapter implementation for Node runtimes (CLI,
 * sidecar, server). The desktop renderer should NOT import this -- use a
 * Tauri-backed adapter that round-trips through invoke() instead.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import type { FsAdapter } from "../types.js";

export class NodeFsAdapter implements FsAdapter {
  async readJson<T = unknown>(path: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(path, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async writeJson(path: string, data: unknown): Promise<void> {
    await this.ensureDir(dirname(path));
    await fs.writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  }

  async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  pathJoin(...parts: string[]): string {
    return join(...parts);
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
