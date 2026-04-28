/**
 * Shared user-config reader/writer for prompt-master features that cross
 * app boundaries (desktop UI -> VS Code BuildRunner).
 *
 * Storage: ~/.founder-os/config.json. Both the desktop (via Tauri fs
 * plugin) and the VS Code extensions (via Node fs) read/write this same
 * file. Single source of truth, no IPC required.
 *
 * Schema is forward-compatible: unknown keys are preserved on write,
 * missing keys fall back to defaults on read. Adding a new toggle is a
 * one-line change.
 *
 * NOTE: This module uses node:fs and node:os. Don't import it from
 * browser/Tauri-renderer code. The desktop has its own helper at
 * apps/founder-desktop/src/lib/prompt-master-config.ts that reads/writes
 * the same file via @tauri-apps/plugin-fs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PromptMasterConfig {
  /**
   * When true, code-gen handoff runs spawn `claude -p --output-format
   * stream-json` and parse ndjson events for fine-grained progress.
   *
   * Trade-off: token-by-token progress (smoother UX) vs. extra parse
   * overhead (~1-2% CPU). Default false.
   */
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

export function getSharedConfigPath(): string {
  return join(homedir(), ".founder-os", "config.json");
}

/**
 * Read the config from disk. Always returns a valid object - missing file,
 * malformed JSON, or missing keys all degrade to defaults rather than throw.
 * Runners call this on every run; it must not be a failure mode.
 */
export function readSharedConfig(): SharedConfig {
  try {
    const raw = readFileSync(getSharedConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SharedConfig>;
    return {
      promptMaster: {
        ...DEFAULT_CONFIG.promptMaster,
        ...(parsed.promptMaster ?? {}),
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Write a partial config update to disk. Preserves existing keys at the
 * top level (so adding a new section doesn't blow away other tools'
 * settings if they share this file).
 */
export function writeSharedConfig(update: Partial<SharedConfig>): void {
  const existing = readSharedConfig();
  const next: SharedConfig = {
    promptMaster: {
      ...existing.promptMaster,
      ...(update.promptMaster ?? {}),
    },
  };
  const path = getSharedConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
}
