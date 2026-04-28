/**
 * Tauri-backed Filesystem adapter for the pipeline-runner.
 *
 * The pipeline-runner package defines an async `Filesystem` port so its
 * orchestrator can run in any environment. The seed script uses `nodeFs`;
 * the desktop WebView has no fs at all, so we bridge each call to a Rust
 * Tauri command. Tilde expansion happens Rust-side, so callers can pass
 * paths with `~` and they'll be resolved against the user's home dir.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Filesystem } from "@founder-os/pipeline-runner";

export const tauriFs: Filesystem = {
  async mkdir(path) {
    await invoke("mkdir_p", { path });
  },
  async exists(path) {
    return invoke<boolean>("path_exists", { path });
  },
  async readFile(path) {
    return invoke<string>("read_file", { path });
  },
  async writeFile(path, content) {
    await invoke("write_file", { path, content });
  },
};
