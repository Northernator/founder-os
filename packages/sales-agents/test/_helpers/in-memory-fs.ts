/**
 * In-memory FsAdapter used across the test suite. Stores writes in a
 * Map so tests can inspect what each agent persisted without touching
 * the real filesystem. Safe to share across tests because each test
 * constructs its own fresh instance.
 */
import type { FsAdapter } from "../../src/types.js";

export class InMemoryFs implements FsAdapter {
  public files = new Map<string, string>();
  public dirs = new Set<string>();
  public writeOrder: string[] = [];

  async readJson<T = unknown>(path: string): Promise<T | null> {
    const raw = this.files.get(path);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async writeJson(path: string, data: unknown): Promise<void> {
    this.files.set(path, JSON.stringify(data, null, 2));
    this.writeOrder.push(path);
  }

  async ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  pathJoin(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }
}
