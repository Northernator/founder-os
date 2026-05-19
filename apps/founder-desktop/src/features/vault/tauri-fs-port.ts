/**
 * Tauri-backed VaultFsPort for the renderer side.
 *
 * `@founder-os/markdown-vault`'s `writeVaultNote` takes a `VaultFsPort`
 * with three methods (ensureDir / writeFile / fileExists). The
 * in-session runner constructs one via `createMemoryFsPort` because
 * its writes don't actually land on disk -- the runner's `finalize()`
 * is only ever called from inside the VaultStageRunner which itself
 * runs renderer-side and ends up calling Tauri commands anyway.
 *
 * The resumed-finalize path (boot-hydration.ts) calls `writeVaultNote`
 * directly when the reviewer picks a different ventureSlug than the
 * draft's suggested slug, so the markdown gets re-rendered with the
 * correct slug instead of byte-copying the persisted preview. This
 * module provides the Tauri port that wires the markdown-vault writes
 * onto the existing `mkdir_p` / `write_file` / `path_exists` desktop
 * commands.
 */
import type { VaultFsPort } from "@founder-os/markdown-vault";
import { invoke } from "@tauri-apps/api/core";

/**
 * Tauri-backed VaultFsPort. Every method delegates to a desktop
 * command that already existed before the Rust IPC arc (see lib.rs)
 * so no new Rust surface is needed for this feature.
 */
export function createTauriFsPort(): VaultFsPort {
  return {
    ensureDir: async (absolutePath) => {
      await invoke<void>("mkdir_p", { path: absolutePath });
    },
    writeFile: async (absolutePath, content) => {
      await invoke<void>("write_file", { path: absolutePath, content });
    },
    fileExists: async (absolutePath) => {
      return await invoke<boolean>("path_exists", { path: absolutePath });
    },
  };
}
