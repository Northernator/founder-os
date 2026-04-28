/**
 * Desktop-side reader/writer for ~/.founder-os/config.json.
 *
 * Mirrors packages/prompt-master/src/config.ts on the runner side. The two
 * read/write the same file with the same shape - desktop UI is the canonical
 * writer (via this module), the VS Code BuildRunners are the readers (via
 * the prompt-master package's Node helper).
 *
 * Why a separate copy from prompt-master/src/config.ts: this file runs in the
 * Tauri webview where node:fs / node:os don't exist. It calls the Rust-side
 * `read_file` / `write_file` Tauri commands (which already handle tilde
 * expansion + mkdir parent) so we get cross-platform behaviour without
 * pulling in @tauri-apps/plugin-fs scope config.
 */
import { invoke } from "@tauri-apps/api/core";

export interface PromptMasterConfig {
  streamingProgress: boolean;
}

export interface SharedConfig {
  promptMaster: PromptMasterConfig;
}

const DEFAULT_CONFIG: SharedConfig = {
  promptMaster: {
    streamingProgress: false,
  },
};

const CONFIG_PATH = "~/.founder-os/config.json";

export async function readSharedConfig(): Promise<SharedConfig> {
  try {
    const raw = await invoke<string>("read_file", { path: CONFIG_PATH });
    const parsed = JSON.parse(raw) as Partial<SharedConfig>;
    return {
      promptMaster: {
        ...DEFAULT_CONFIG.promptMaster,
        ...(parsed.promptMaster ?? {}),
      },
    };
  } catch {
    // Missing file, malformed JSON, permission denied - all fall back to
    // defaults. The runner side has the same behaviour, so the file may
    // legitimately not exist yet.
    return DEFAULT_CONFIG;
  }
}

export async function writeSharedConfig(
  update: Partial<SharedConfig>,
): Promise<void> {
  const existing = await readSharedConfig();
  const next: SharedConfig = {
    promptMaster: {
      ...existing.promptMaster,
      ...(update.promptMaster ?? {}),
    },
  };
  await invoke("write_file", {
    path: CONFIG_PATH,
    content: JSON.stringify(next, null, 2) + "\n",
  });
}
