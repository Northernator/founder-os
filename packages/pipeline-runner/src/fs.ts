/**
 * Filesystem port — abstracts the small slice of fs operations the
 * pipeline steps need. Lets us run the same orchestrator under both
 * Node (seed script, CLI) and Tauri (desktop WebView, no node:fs).
 *
 * All ops are async so adapters that bridge to async Tauri IPC don't
 * have to fake sync. Path strings are passed through verbatim — both
 * adapters expect already-joined absolute paths from the caller.
 */
export interface Filesystem {
  /** mkdir -p — recursive, no-op if it already exists. */
  mkdir(path: string): Promise<void>;
  /** True if a file or directory exists at `path`. Never throws. */
  exists(path: string): Promise<boolean>;
  /** Read a file as UTF-8 text. Throws if missing. */
  readFile(path: string): Promise<string>;
  /** Write UTF-8 text. Creates parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * Node-backed adapter — used by the seed script and any other
 * Node-process consumer. Wraps node:fs/promises (async, no extra deps).
 */
export const nodeFs: Filesystem = {
  async mkdir(path) {
    const fs = await import(/* @vite-ignore */ "node:fs/promises");
    await fs.mkdir(path, { recursive: true });
  },
  async exists(path) {
    const fs = await import(/* @vite-ignore */ "node:fs/promises");
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(path) {
    const fs = await import(/* @vite-ignore */ "node:fs/promises");
    return fs.readFile(path, "utf-8");
  },
  async writeFile(path, content) {
    const fs = await import(/* @vite-ignore */ "node:fs/promises");
    const nodePath = await import(/* @vite-ignore */ "node:path");
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(path, content, "utf-8");
  },
};
