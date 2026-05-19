/**
 * Desktop-side DriveClient factory.
 *
 * The @founder-os/google-drive-importer package is Tauri-agnostic --
 * it takes an injected `invoke` function. This module wraps Tauri's
 * real `invoke` with the same safeInvoke pattern used in
 * run-vault-import.ts so the renderer degrades gracefully when the
 * Rust side (slice 12) hasn't shipped the commands yet.
 *
 * Falling back to "not registered" surfaces a clear toast + lets the
 * Drive screen render a banner that points the user at the import-
 * cache stub. Crucially: NEVER throw on missing commands -- the UI
 * has to keep working until the Rust side lands.
 */
import { DriveClient, type InvokeFn } from "@founder-os/google-drive-importer";
import { invoke } from "@tauri-apps/api/core";

/**
 * Sentinel thrown by `safeInvoke` when the Rust side hasn't
 * registered the command yet. The Drive screen catches this and
 * renders a "Drive IPC not wired" banner instead of crashing.
 */
export class DriveCommandNotWiredError extends Error {
  constructor(public readonly command: string) {
    super(`Tauri command "${command}" not registered yet (slice 12 Rust side lands later)`);
    this.name = "DriveCommandNotWiredError";
  }
}

function isNotRegisteredError(err: unknown, command: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /not found|not registered|unknown command|isn't defined/i.test(message) ||
    message.includes(command)
  );
}

const safeInvoke: InvokeFn = async <T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> => {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (isNotRegisteredError(err, command)) {
      throw new DriveCommandNotWiredError(command);
    }
    throw err;
  }
};

/** Shared singleton for the renderer. Tests inject their own DriveClient directly. */
export function buildDriveClient(): DriveClient {
  return new DriveClient({ invoke: safeInvoke });
}
