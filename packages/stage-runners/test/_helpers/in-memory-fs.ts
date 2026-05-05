/**
 * In-memory Filesystem adapter for the stage-runners test suite.
 *
 * Implements the Filesystem port from @founder-os/pipeline-runner so
 * tests can drive runners + orchestrator without touching the real
 * filesystem. Stores writes in a Map keyed by path; tests can read
 * back what landed via the public `files` field.
 *
 * Each test should construct its own instance so writes don't leak
 * between cases. The adapter does NO normalisation -- paths go in
 * verbatim, mirroring tauriFs' shape on the real platform side.
 */
import type { Filesystem } from "@founder-os/pipeline-runner";

export class InMemoryFs implements Filesystem {
  public files = new Map<string, string>();
  public dirs = new Set<string>();
  public writeOrder: string[] = [];

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writeOrder.push(path);
  }
}
