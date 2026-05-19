/**
 * Pure-TS folder walker shape. The Node implementation lives in
 * ./node/walk-folder.ts and is injected via a port so unit tests
 * stub the filesystem with an in-memory tree.
 */

export interface DiscoveredFile {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Filename (no directory component). */
  originalName: string;
  /** Optional pre-computed mime (from the OS / Tauri layer). */
  mimeType?: string;
}

export type WalkFolderFn = (rootPath: string) => Promise<DiscoveredFile[]>;

export interface ResolveAbsoluteFileFn {
  /**
   * Turns an arbitrary string into a fully-described candidate file. The
   * Node impl checks the file exists and pulls its mime when possible.
   */
  (path: string): Promise<DiscoveredFile>;
}

/** Filter applied before staging -- skips hidden files and common junk. */
export function shouldIngest(name: string): boolean {
  if (!name) return false;
  if (name.startsWith(".")) return false;
  if (name === "Thumbs.db" || name === "desktop.ini") return false;
  if (name === ".DS_Store") return false;
  return true;
}
